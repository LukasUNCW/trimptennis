// worker/index.ts
// One Worker, two jobs:
//   1. Static site — requests matching files in ./site are served automatically
//      by the assets layer and never reach this code.
//   2. API routes — everything else lands here:
//        POST /api/auth/request   email a magic sign-in link
//        GET  /auth/callback      redeem the link, open a session
//        POST /api/auth/logout    end the session
//        GET  /api/me             the signed-in account + children, or 401
//        PATCH /api/me            update the profile (never the email)
//        POST/PATCH/DELETE /api/children[/:id]   manage children
//        GET  /api/enrollments    this parent's own enrollment history
//        GET  /api/programs  catalog the enrollment form builds its menus from
//        POST /api/enroll    enrollment form → D1 + email, returns the
//                            QuickBooks payment link to redirect the parent to
//        POST /api/inquiry   free-trial / contact form → D1 + email (Turnstile-gated)
//        GET  /qbo/connect   redirects admin to Intuit authorization (ADMIN_KEY-gated)
//        GET  /qbo/callback  Intuit OAuth redirect target
//        GET  /qbo/items     lists QBO Items (ADMIN_KEY-gated)
//
// Payments are processed by QuickBooks Payments, so money and bookkeeping never
// leave Intuit — there is no payment webhook to consume and no sales receipt to
// write. This Worker owns the roster (who signed up, which player, what age
// group) because that is the part QuickBooks does not track.

import type { Env } from './types';
import { PROGRAMS, lookupProgram, lookupOption, listPrograms, payUrlFor, isEnrollable } from './programs';
import {
  buildAuthUrl, exchangeCodeForTokens, listItems, qboConfigured, consumeState,
  findOrCreateCustomer, findItemIdByName, createInvoice,
  findIncomeAccountId, createServiceItem
} from './qbo';
import { notifyEnrollment, notifyInquiry, sendMagicLink } from './email';
import {
  normaliseEmail, isRateLimited, createLoginToken, redeemLoginToken,
  createSession, getSessionUser, destroySession, sessionCookie, clearedCookie
} from './auth';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (request.method === 'GET' && pathname === '/api/programs') {
        return json(listPrograms());
      }
      if (request.method === 'GET' && pathname === '/api/inquiry-topics') {
        return json(INQUIRY_TOPICS);
      }
      if (request.method === 'POST' && pathname === '/api/enroll') {
        return await handleEnroll(request, env, ctx);
      }
      if (request.method === 'POST' && pathname === '/api/inquiry') {
        return await handleInquiry(request, env, ctx);
      }
      // ── auth (docs/ACCOUNTS.md) ──
      if (request.method === 'POST' && pathname === '/api/auth/request') {
        return await handleAuthRequest(request, env, ctx);
      }
      if (request.method === 'GET' && pathname === '/auth/callback') {
        return await handleAuthCallback(request, env, url);
      }
      if (request.method === 'POST' && pathname === '/api/auth/logout') {
        await destroySession(env, request);
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': clearedCookie(),
            'Cache-Control': 'no-store'
          }
        });
      }
      if (request.method === 'GET' && pathname === '/api/me') {
        return await handleGetMe(request, env);
      }
      if (request.method === 'PATCH' && pathname === '/api/me') {
        return await handlePatchMe(request, env);
      }
      if (request.method === 'POST' && pathname === '/api/children') {
        return await handleCreateChild(request, env);
      }
      const childRoute = pathname.match(/^\/api\/children\/([0-9a-f-]{36})$/);
      if (childRoute && (request.method === 'PATCH' || request.method === 'DELETE')) {
        return await handleChildMutation(request, env, childRoute[1]);
      }
      if (request.method === 'GET' && pathname === '/api/enrollments') {
        return await handleGetEnrollments(request, env);
      }

      // The account page is a static asset, so the session is checked here
      // before the asset layer serves it — a signed-out visitor is redirected
      // rather than shown a shell that then flashes to a login screen.
      if (request.method === 'GET' && pathname === '/account') {
        if (!(await getSessionUser(env, request))) {
          return new Response(null, {
            status: 302,
            headers: { Location: '/login', 'Cache-Control': 'no-store' }
          });
        }
      }

      if (request.method === 'GET' && pathname === '/qbo/connect') {
        requireAdmin(url, env);
        if (!qboConfigured(env)) return text(QBO_NOT_CONFIGURED, 503);
        return Response.redirect(await buildAuthUrl(env, url.origin), 302);
      }
      // Deliberately not behind ADMIN_KEY — Intuit does the redirecting here and
      // will not carry our key. The `state` check is what stands in for it: only
      // an authorization this Worker started can be completed, so a stranger
      // cannot hand us their own company file and replace the academy's
      // connection. Consumed on use, so it cannot be replayed.
      if (request.method === 'GET' && pathname === '/qbo/callback') {
        const code = url.searchParams.get('code');
        const realmId = url.searchParams.get('realmId');
        if (!(await consumeState(env, url.searchParams.get('state')))) {
          return text('Authorization did not match a request from this site — start again at /qbo/connect.', 403);
        }
        if (!code || !realmId) return text('Missing code or realmId — restart authorization.', 400);
        await exchangeCodeForTokens(env, url.origin, code, realmId);
        return text('QuickBooks connected. You can close this tab.');
      }
      if (request.method === 'GET' && pathname === '/qbo/items') {
        requireAdmin(url, env);
        if (!qboConfigured(env)) return text(QBO_NOT_CONFIGURED, 503);
        const items = await listItems(env);
        return json(items.map((i: any) => ({ id: i.Id, name: i.Name, type: i.Type })));
      }
      // Creates any catalog item the company file is missing, named from
      // programs.ts so the names match by construction — no em dash to mistype.
      //
      // Sandbox only, and the fence is not squeamishness: this writes to a chart
      // of accounts, and which income account the academy's revenue lands in is
      // their bookkeeper's call. Worth revisiting for production once Katie has
      // named the account — letting this create them would remove the one
      // failure mode this design still has.
      if (request.method === 'GET' && pathname === '/qbo/seed-items') {
        requireAdmin(url, env);
        if (!qboConfigured(env)) return text(QBO_NOT_CONFIGURED, 503);
        if (env.QBO_SANDBOX !== 'true') {
          return text('Refused: QBO_SANDBOX is not "true". This route writes to the chart of accounts.', 403);
        }

        const existing = new Set((await listItems(env)).map((i: any) => i.Name));
        const incomeAccountId = await findIncomeAccountId(env, url.searchParams.get('account'));

        const created: string[] = [];
        const alreadyThere: string[] = [];
        for (const p of Object.values(PROGRAMS)) {
          for (const o of p.options) {
            if (o.qboItem === null) continue;
            if (existing.has(o.qboItem)) { alreadyThere.push(o.qboItem); continue; }
            await createServiceItem(env, { name: o.qboItem, price: o.price, incomeAccountId });
            created.push(o.qboItem);
            // Guards against a catalog that lists the same item twice — the
            // second create would fail on QuickBooks' unique-name rule.
            existing.add(o.qboItem);
          }
        }
        return json({ incomeAccountId, created, alreadyThere });
      }
      // Exercises the failure paths in bookInQuickBooks against the real API,
      // because until something does, the catch block that protects every
      // enrolment has never once executed. "It should fall back" is a claim
      // about untested code; this turns it into an observation.
      //
      // Sandbox only. It books a real invoice for the healthy case.
      if (request.method === 'GET' && pathname === '/qbo/test-fallback') {
        requireAdmin(url, env);
        if (!qboConfigured(env)) return text(QBO_NOT_CONFIGURED, 503);
        if (env.QBO_SANDBOX !== 'true') {
          return text('Refused: QBO_SANDBOX is not "true". This route writes real records.', 403);
        }

        const program = lookupProgram('shredders');
        const healthy = program?.options.find((o) => o.id === 'drop-in');
        if (!program || !healthy) return text('Catalog changed — fix /qbo/test-fallback.', 500);

        const row = {
          parent_name: 'Fallback Probe',
          parent_email: 'fallback+qbotest@example.test',
          phone: null,
          player_name: 'Probe Player',
          age_group: '9-16'
        };

        const cases = [
          { case: 'item name missing from QuickBooks', option: { ...healthy, qboItem: 'No Such Item 000' } },
          { case: 'option has no item mapped', option: { ...healthy, qboItem: null } },
          { case: 'healthy', option: healthy }
        ];

        const results = [];
        for (const c of cases) {
          const r = await bookInQuickBooks(env, program, c.option as any, row);
          results.push({
            case: c.case,
            route: r.route,
            // The point of the whole exercise: a failure must still leave the
            // parent somewhere they can pay.
            parentCanStillPay: r.payUrl !== null,
            invoiceId: r.invoiceId
          });
        }
        return json({
          expected: {
            'item name missing from QuickBooks': 'static-link, parentCanStillPay true, no invoice',
            'option has no item mapped': 'static-link, parentCanStillPay true, no invoice',
            healthy: 'sandbox, parentCanStillPay true, invoice created'
          },
          results
        });
      }
      // Every qboItem in the catalog, checked against what actually exists in
      // QuickBooks. Read-only, and the answer to the one failure this design can
      // suffer: Katie types an item name slightly differently and enrollment
      // breaks for that option only, silently, until a parent hits it.
      //
      // Run it after she creates the Items, and again after switching to the
      // real company file — item names are per company, so a pass against the
      // sandbox proves nothing about production.
      if (request.method === 'GET' && pathname === '/qbo/verify-items') {
        requireAdmin(url, env);
        if (!qboConfigured(env)) return text(QBO_NOT_CONFIGURED, 503);

        const existing = new Set((await listItems(env)).map((i: any) => i.Name));
        const wanted = Object.entries(PROGRAMS).flatMap(([slug, p]) =>
          p.options
            .filter((o) => o.qboItem !== null)
            .map((o) => ({ option: `${slug}/${o.id}`, item: o.qboItem as string })));

        const missing = wanted.filter((w) => !existing.has(w.item));
        return json({
          ok: missing.length === 0,
          checked: wanted.length,
          missing,
          // Listed so a near-miss is obvious at a glance — "Grom's - 10 classes"
          // sitting next to "Grom's — 10 classes" explains itself.
          itemsInQuickBooks: [...existing].sort()
        });
      }

      // Anything else: let the static asset layer answer (e.g. its 404).
      return env.ASSETS.fetch(request);
    } catch (err: any) {
      if (err instanceof Response) return err; // requireAdmin throws a Response
      console.error(`Unhandled error on ${pathname}:`, err?.message ?? err);
      return text('Internal error', 500);
    }
  }
} satisfies ExportedHandler<Env>;

// ── Route handlers ───────────────────────────────────────────────────────

// Records the enrollment BEFORE the parent pays, then hands them off to the
// program's QuickBooks payment link. We keep the roster row either way: if the
// parent abandons checkout the office still has the lead, and QuickBooks is the
// source of truth for whether money actually arrived.
async function handleEnroll(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const human = await verifyTurnstile(env, body.turnstileToken, request.headers.get('CF-Connecting-IP'));
  if (!human) return json({ error: 'Verification failed — please retry.' }, 403);

  const program = lookupProgram(body.program);
  if (!program) return json({ error: 'Unknown program.' }, 400);

  // Refused server-side as well as hidden from the form. A season that has been
  // cancelled must not be bookable by a stale page still open in a tab, or by
  // anyone posting the slug directly.
  if (!isEnrollable(program)) {
    return json({
      error: `${program.name} is not taking signups at the moment — please contact the office.`
    }, 400);
  }

  // Which price the parent chose. Where a program sells more than one, this is
  // required rather than guessed: defaulting would risk charging $330 for a
  // month to somebody who wanted a $35 drop-in.
  const option = lookupOption(program, body.option);
  if (!option) {
    return json({
      error: `Choose an option: ${program.options.map((o) => o.label).join(', ')}`
    }, 400);
  }

  // Signing in is optional. A guest enrolment is a first-class path — both
  // account_id and child_id simply stay NULL.
  const user = await getSessionUser(env, request);

  let child_id: string | null = null;
  let player_name = str(body.player_name, 100);

  if (body.child_id) {
    // Only a signed-in owner may enrol a saved player, and the name is taken
    // from the stored record rather than the request. Trusting a submitted name
    // alongside a child id would let the two disagree, and trusting the id
    // without the ownership check would let anyone enrol another family's child.
    if (!user) return json({ error: 'Please sign in to use a saved player.' }, 401);
    const child = await env.DB
      .prepare('SELECT id, first_name, last_name FROM children WHERE id = ?1 AND account_id = ?2')
      .bind(String(body.child_id), user.account_id)
      .first<{ id: string; first_name: string; last_name: string | null }>();
    if (!child) return json({ error: 'That player is not on your account.' }, 400);
    child_id = child.id;
    player_name = [child.first_name, child.last_name].filter(Boolean).join(' ');
  }

  const parent_email = str(body.parent_email, 200);
  if (!player_name || !parent_email || !parent_email.includes('@')) {
    return json({ error: 'A name and a valid email address are required.' }, 400);
  }

  // Adults enrol themselves, so a guardian is required only for the youth
  // programs — and is discarded outright on a self-enrol program rather than
  // trusted from the request body.
  const parent_name = program.selfEnroll ? null : str(body.parent_name, 100);
  if (!program.selfEnroll && !parent_name) {
    return json({ error: 'A parent or guardian name is required.' }, 400);
  }

  const age_group = str(body.age_group, 40);
  if (!age_group || !program.ageGroups.includes(age_group)) {
    return json({ error: `Choose an age group: ${program.ageGroups.join(', ')}` }, 400);
  }

  const row = {
    id: crypto.randomUUID(),
    parent_name,
    parent_email,
    phone: str(body.phone, 40),
    player_name,
    age_group,
    program: program.name,
    payment_status: 'awaiting_payment',
    notes: str(body.notes, 2000),
    account_id: user?.account_id ?? null,
    child_id,
    // Which package was bought. The id is stored rather than the label so the
    // office's reporting does not break when wording is reworded; the amount is
    // stored because prices change and the roster should record what this parent
    // was actually shown — which is also how a payment gets matched back, since
    // a multi-use QuickBooks link records no customer name.
    price_option: option.id,
    price_quoted: option.price
  };

  await env.DB
    .prepare(
      `INSERT INTO enrollments
       (id, parent_name, parent_email, phone, player_name, age_group, program,
        payment_status, notes, account_id, child_id, price_option, price_quoted)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`
    )
    .bind(row.id, row.parent_name, row.parent_email, row.phone, row.player_name,
          row.age_group, row.program, row.payment_status, row.notes,
          row.account_id, row.child_id, row.price_option, row.price_quoted)
    .run();

  // Only now, with the roster row safely written, do we talk to QuickBooks. The
  // order is the whole point: a parent who gets this far is recorded whatever
  // Intuit does next.
  const payment = await bookInQuickBooks(env, program, option, row);

  // Recording the ids is for the office's benefit later, not for this parent
  // now, so it must not be able to fail their signup — the roster row is already
  // written and the invoice already exists. The realistic cause is the ALTER
  // TABLE in SETUP.md not having been run against this database yet.
  if (payment.customerId || payment.invoiceId) {
    try {
      await env.DB
        .prepare('UPDATE enrollments SET qbo_customer_id = ?2, qbo_invoice_id = ?3 WHERE id = ?1')
        .bind(row.id, payment.customerId, payment.invoiceId)
        .run();
    } catch (err) {
      console.error('Could not record QuickBooks ids on enrollment', row.id, err);
    }
  }

  ctx.waitUntil(notifyEnrollment(env, {
    ...row,
    optionLabel: option.label,
    // Set per option, not per program: Elite sells memberships AND drop-ins, and
    // telling a drop-in player to expect an auto draft would be wrong.
    autoDraftFollowUp: option.autoDraftAfterFirstMonth === true,
    paymentRoute: payment.route,
    invoiceId: payment.invoiceId
  }));

  return json({
    ok: true,
    enrollmentId: row.id,
    // Echoed back so the review panel shows what was actually recorded rather
    // than what the form thinks it sent. It matters for a saved player, where the
    // name comes from the stored child record and not from the submitted field,
    // and for a single-option program, where the option was resolved here.
    program: program.name,
    option: { id: option.id, label: option.label, price: option.price },
    playerName: player_name,
    // null means "no card page to send them to" — the site shows a "the office
    // will follow up" confirmation instead of redirecting. That covers an option
    // Katie has not set up, a link that failed checking, and the cases in
    // bookInQuickBooks where sending them anywhere would risk a double charge.
    payUrl: payment.payUrl
  });
}

/** How a parent gets to a card page, and what the office has to do about it. */
interface PaymentRouting {
  payUrl: string | null;
  route: 'invoice' | 'invoice-unsent' | 'static-link' | 'sandbox' | 'timeout' | 'none';
  customerId: string | null;
  invoiceId: string | null;
}

// Intuit gets this long to produce an invoice before we stop making the parent
// wait. Generous for three API calls, short enough that a signup does not feel
// broken.
const QBO_ENROLL_TIMEOUT_MS = 8000;

/**
 * Raises the customer and invoice in QuickBooks, and decides where to send the
 * parent. Never throws — every failure resolves to some way forward.
 *
 * The rule underneath every branch is that the parent must be sent to AT MOST
 * one place to pay. An invoice plus a shared payment link means the same $35
 * can be recorded twice, which is worse than an unattributed payment: wrong
 * rather than merely unhelpful.
 *
 * So the fallbacks split on what we know:
 *
 * - Definite failure — QuickBooks answered with an error, or the option has no
 *   Item. No invoice exists, so the old shared link is safe to use and the money
 *   still gets taken.
 * - Timeout — we do not know whether an invoice was created. Sending them to the
 *   shared link could double-charge, so we send them nowhere and tell the office
 *   to look. Losing a same-minute card payment is recoverable; billing a family
 *   twice is the kind of mistake that costs the academy a customer.
 */
async function bookInQuickBooks(
  env: Env,
  program: ReturnType<typeof lookupProgram> & {},
  option: { qboItem: string | null; price: number | null; label: string },
  row: { parent_name: string | null; parent_email: string | null; phone: string | null;
         player_name: string | null; age_group: string | null }
): Promise<PaymentRouting> {
  const staticUrl = payUrlFor(program, option as any);
  const useStaticLink = (): PaymentRouting => ({
    payUrl: staticUrl,
    route: staticUrl ? 'static-link' : 'none',
    customerId: null,
    invoiceId: null
  });

  // Nothing to invoice against: summer camp while it is off, adult programs
  // until they have a price. Both already have a null payUrl, so this lands on
  // "the office will follow up", which is the existing, correct behaviour.
  if (option.qboItem === null || typeof option.price !== 'number' || !row.parent_email) {
    return useStaticLink();
  }

  // While pointed at the sandbox, only OUR test enrolments go to QuickBooks. A
  // real family signing up in the meantime would otherwise have their name and
  // email written into a throwaway company they have no relationship with, and
  // wait an extra second for the privilege. They get the old behaviour instead,
  // unchanged and working.
  //
  // The marker is a plus-address, so a test can be run from the real form with a
  // real inbox: lukas.nilsson4321+qbotest@gmail.com. Delete this whole branch
  // when QBO_SANDBOX goes to "false".
  if (env.QBO_SANDBOX === 'true' && !/\+qbotest@/i.test(row.parent_email)) {
    return useStaticLink();
  }

  let timedOut = false;
  try {
    const work = (async () => {
      const customerId = await findOrCreateCustomer(env, {
        email: row.parent_email as string,
        // Adults enrol themselves and carry no parent_name, so they are their
        // own customer. Falling through to the email address keeps a customer
        // findable even if a name somehow arrives empty.
        name: row.parent_name ?? row.player_name ?? (row.parent_email as string),
        phone: row.phone
      });
      const itemId = await findItemIdByName(env, option.qboItem as string);
      const invoice = await createInvoice(env, {
        customerId,
        itemId,
        amount: option.price as number,
        // The player goes on the line, which is what makes per-child reporting
        // work without a second tier of customers. See docs/QBO-INTEGRATION.md.
        description: `${option.label} — ${row.player_name ?? ''} (${row.age_group ?? ''})`.trim(),
        email: row.parent_email as string
      });
      return { customerId, invoice };
    })();

    const { customerId, invoice } = await Promise.race([
      work,
      new Promise<never>((_, reject) =>
        setTimeout(() => { timedOut = true; reject(new Error('QuickBooks timed out')); },
          QBO_ENROLL_TIMEOUT_MS))
    ]);

    // In sandbox the invoice is real but the company file is not, and its pay
    // link goes to Intuit's placeholder page. A parent sent there cannot pay and
    // has no way to know why. So the invoice still gets raised — that is what
    // makes the flow testable — but the parent goes to the working static link,
    // exactly as they did before any of this existed.
    //
    // This is what makes it safe to run the invoice flow on the live site while
    // still pointed at a sandbox. Remove nothing here until QBO_SANDBOX is
    // "false" and the real company file is connected.
    if (env.QBO_SANDBOX === 'true') {
      return {
        payUrl: staticUrl,
        route: staticUrl ? 'sandbox' : 'none',
        customerId,
        invoiceId: invoice.invoiceId
      };
    }

    return {
      payUrl: invoice.payLink,
      // An invoice with no link is not a failure — QuickBooks Payments simply is
      // not connected to that company file. The record is right; somebody just
      // has to send it.
      route: invoice.payLink ? 'invoice' : 'invoice-unsent',
      customerId,
      invoiceId: invoice.invoiceId
    };
  } catch (err) {
    console.error('QuickBooks booking failed for enrollment', err);
    if (timedOut) {
      return { payUrl: null, route: 'timeout', customerId: null, invoiceId: null };
    }
    return useStaticLink();
  }
}

// ── account & children (docs/ACCOUNTS.md phase 2) ────────────────────────
//
// Every one of these is a state change behind a session cookie, which raises
// CSRF. Two things cover it: the cookie is SameSite=Lax, so it is not attached
// to cross-site POST/PATCH/DELETE at all, and each handler requires a JSON
// body — a request an HTML form could forge cannot set Content-Type to
// application/json. No token is needed on top of that.

const PROFILE_FIELDS = ['first_name', 'last_name', 'phone', 'address1', 'address2', 'city', 'state', 'zip'] as const;

/** Loads the account plus its children, or null when not signed in. */
async function loadMe(env: Env, request: Request) {
  const user = await getSessionUser(env, request);
  if (!user) return null;

  const account = await env.DB
    .prepare(
      `SELECT id, email, first_name, last_name, phone, address1, address2, city, state, zip
       FROM accounts WHERE id = ?1`
    )
    .bind(user.account_id)
    .first<Record<string, unknown>>();

  const children = await env.DB
    .prepare(
      `SELECT id, first_name, last_name, birth_year, notes
       FROM children WHERE account_id = ?1 ORDER BY birth_year DESC, first_name`
    )
    .bind(user.account_id)
    .all<Record<string, unknown>>();

  return { account, children: children.results };
}

const noStore = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });

async function handleGetMe(request: Request, env: Env): Promise<Response> {
  const me = await loadMe(env, request);
  if (!me) return json({ error: 'Not signed in' }, 401);
  return noStore(me);
}

/** Reads a JSON body, rejecting anything that is not declared as JSON. */
async function jsonBody(request: Request): Promise<any | null> {
  if (!(request.headers.get('Content-Type') ?? '').includes('application/json')) return null;
  try { return await request.json(); } catch { return null; }
}

async function handlePatchMe(request: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(env, request);
  if (!user) return json({ error: 'Not signed in' }, 401);

  const body = await jsonBody(request);
  if (!body) return json({ error: 'Expected a JSON body.' }, 400);

  // email is deliberately absent from PROFILE_FIELDS: it is the sign-in
  // identity, so changing it here would either lock someone out on a typo or
  // let a hijacked session move the account to another address. It needs a
  // confirmation link sent to the new address first — see docs/ACCOUNTS.md.
  const updates: string[] = [];
  const values: (string | null)[] = [];
  for (const f of PROFILE_FIELDS) {
    if (!(f in body)) continue;
    updates.push(`${f} = ?${updates.length + 1}`);
    values.push(str(body[f], f === 'address1' || f === 'address2' ? 200 : 100));
  }
  if (!updates.length) return json({ error: 'Nothing to update.' }, 400);

  await env.DB
    .prepare(`UPDATE accounts SET ${updates.join(', ')} WHERE id = ?${values.length + 1}`)
    .bind(...values, user.account_id)
    .run();

  return noStore((await loadMe(env, request))!);
}

/** Shared validation for a child record. */
function readChild(body: any): { first_name: string; last_name: string | null; birth_year: number | null; notes: string | null } | string {
  const first_name = str(body?.first_name, 100);
  if (!first_name) return "Please enter the child's first name.";

  let birth_year: number | null = null;
  if (body?.birth_year !== undefined && body?.birth_year !== null && body?.birth_year !== '') {
    const y = Number(body.birth_year);
    const thisYear = new Date().getUTCFullYear();
    // A tennis academy has no 3-year-olds and no 100-year-old juniors; a range
    // check turns a mistyped year into a clear message rather than a child who
    // silently matches no programme.
    if (!Number.isInteger(y) || y < thisYear - 80 || y > thisYear) {
      return `Please enter a birth year between ${thisYear - 80} and ${thisYear}.`;
    }
    birth_year = y;
  }

  return { first_name, last_name: str(body?.last_name, 100), birth_year, notes: str(body?.notes, 1000) };
}

async function handleCreateChild(request: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(env, request);
  if (!user) return json({ error: 'Not signed in' }, 401);

  const body = await jsonBody(request);
  if (!body) return json({ error: 'Expected a JSON body.' }, 400);

  const child = readChild(body);
  if (typeof child === 'string') return json({ error: child }, 400);

  await env.DB
    .prepare(
      `INSERT INTO children (id, account_id, first_name, last_name, birth_year, notes)
       VALUES (?1,?2,?3,?4,?5,?6)`
    )
    .bind(crypto.randomUUID(), user.account_id, child.first_name, child.last_name, child.birth_year, child.notes)
    .run();

  return noStore((await loadMe(env, request))!);
}

async function handleChildMutation(request: Request, env: Env, childId: string): Promise<Response> {
  const user = await getSessionUser(env, request);
  if (!user) return json({ error: 'Not signed in' }, 401);

  // Ownership is checked before anything is touched, and every statement below
  // is scoped by account_id too. Without this, knowing a child's id would be
  // enough to read or edit another family's record.
  const owned = await env.DB
    .prepare('SELECT id FROM children WHERE id = ?1 AND account_id = ?2')
    .bind(childId, user.account_id)
    .first<{ id: string }>();
  // 404 rather than 403: confirming that an id exists but belongs to somebody
  // else is itself a disclosure.
  if (!owned) return json({ error: 'Not found.' }, 404);

  if (request.method === 'DELETE') {
    // Detach any enrolments first. SQLite does not enforce the REFERENCES
    // clause unless foreign keys are switched on, so deleting the child alone
    // left enrolments pointing at a row that no longer existed.
    //
    // Detaching rather than cascading is deliberate: an enrolment is a record of
    // something that happened, and it already stores player_name in its own
    // right, so clearing child_id loses the link without losing who played.
    // Deleting the enrolment would destroy roster and payment history because a
    // parent tidied up their account.
    await env.DB
      .prepare('UPDATE enrollments SET child_id = NULL WHERE child_id = ?1 AND account_id = ?2')
      .bind(childId, user.account_id)
      .run();
    await env.DB
      .prepare('DELETE FROM children WHERE id = ?1 AND account_id = ?2')
      .bind(childId, user.account_id)
      .run();
    return noStore((await loadMe(env, request))!);
  }

  const body = await jsonBody(request);
  if (!body) return json({ error: 'Expected a JSON body.' }, 400);

  const child = readChild(body);
  if (typeof child === 'string') return json({ error: child }, 400);

  await env.DB
    .prepare(
      `UPDATE children SET first_name=?1, last_name=?2, birth_year=?3, notes=?4
       WHERE id=?5 AND account_id=?6`
    )
    .bind(child.first_name, child.last_name, child.birth_year, child.notes, childId, user.account_id)
    .run();

  return noStore((await loadMe(env, request))!);
}

// ── enrollment history (docs/ACCOUNTS.md phase 4) ────────────────────────

// A parent's own enrollments. Read-only, and deliberately NOT folded into
// /api/me: every profile and child mutation returns loadMe(), and not one of
// them can change this list, so putting it there would buy a third query on
// each of those writes for nothing.
//
// Matched on the account id OR the address typed on the form. That second arm
// is what makes guest enrollment visible: enrolling without an account is a
// supported path rather than a fallback, so a parent who did that and signed up
// afterwards must not be told they have no enrollments. It discloses nothing
// extra — holding an account at all means having received a magic link at that
// address, which is the same proof of possession the email arm relies on.
//
// The rows are read, not rewritten. Stamping account_id onto matched guest rows
// would be tidier to query but bakes the guess into the roster permanently, and
// a wrong guess would be unrecoverable; matching at read time is reversible.
//
// Only what the account page shows is selected. parent_email and phone are the
// parent's own details and would be harmless, but the narrower the row the less
// there is to leak if this ever grows a wider matching rule.
async function handleGetEnrollments(request: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(env, request);
  if (!user) return json({ error: 'Not signed in' }, 401);

  // created_at has one-second resolution, so enrolling two children in quick
  // succession ties. rowid breaks it by insertion order, which keeps the list
  // stable across reloads instead of shuffling.
  const rows = await env.DB
    .prepare(
      `SELECT created_at, program, player_name, age_group, payment_status,
              price_option, price_quoted
       FROM enrollments
       WHERE account_id = ?1 OR lower(parent_email) = ?2
       ORDER BY created_at DESC, rowid DESC
       LIMIT 50`
    )
    .bind(user.account_id, user.email)
    .all<Record<string, unknown>>();

  return noStore({ enrollments: rows.results });
}

// Emails a sign-in link. The response is identical no matter what happens —
// unknown address, rate limited, delivery failure — because an anonymous caller
// must not be able to use this endpoint to discover who has an account.
async function handleAuthRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const human = await verifyTurnstile(env, body.turnstileToken, request.headers.get('CF-Connecting-IP'));
  if (!human) return json({ error: 'Verification failed — please retry.' }, 403);

  const email = normaliseEmail(body.email);
  // A malformed address is worth reporting: it is the visitor's own typo, not a
  // fact about someone else's account.
  if (!email) return json({ error: 'Please enter a valid email address.' }, 400);

  if (!(await isRateLimited(env, email))) {
    const token = await createLoginToken(env, email);
    const link = `${new URL(request.url).origin}/auth/callback?token=${token}`;
    ctx.waitUntil(sendMagicLink(env, email, link).then(() => undefined));
  }

  return json({ ok: true });
}

// Redeems the link and opens a session. Referrer-Policy stops the token leaking
// to third parties through a Referer header on the redirect.
async function handleAuthCallback(request: Request, env: Env, url: URL): Promise<Response> {
  const accountId = await redeemLoginToken(env, url.searchParams.get('token'));
  const headers: Record<string, string> = {
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
  };

  if (!accountId) {
    // Expired, already used, or never existed — the visitor is told the same
    // thing either way.
    return new Response(null, { status: 302, headers: { ...headers, Location: '/login?e=expired' } });
  }

  const sid = await createSession(env, accountId, request.headers.get('User-Agent'));
  return new Response(null, {
    status: 302,
    headers: { ...headers, Location: '/?signedin=1', 'Set-Cookie': sessionCookie(sid) }
  });
}

// Both QBO secrets exist but hold placeholder text, so `wrangler secret list`
// makes them look configured. Said out loud here rather than letting Intuit
// answer with an error about a client id nobody knew was fake.
const QBO_NOT_CONFIGURED =
  'QuickBooks is not connected yet.\n\n' +
  'QBO_CLIENT_ID and QBO_CLIENT_SECRET exist as Worker secrets but hold\n' +
  'placeholder values, so they will look set in `wrangler secret list`.\n\n' +
  'To connect: create an app at developer.intuit.com, add this Worker\'s\n' +
  '/qbo/callback as a redirect URI, then set both secrets with\n' +
  '`npx wrangler secret put QBO_CLIENT_ID` and the same for the secret.\n\n' +
  'Nothing on the site needs this — it is read-side groundwork only. See SETUP.md.';

// Topics offered by the contact form's "Email to" menu. Served to the form at
// /api/inquiry-topics and validated against here, so the two cannot drift.
const INQUIRY_TOPICS = [
  'General Inquiry',
  'Junior Programs',
  'Adult Programs',
  'Elite Academy',
  'Summer Camp',
  'Billing & Payments'
];

async function handleInquiry(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  // Bot gate: Cloudflare Turnstile
  const human = await verifyTurnstile(env, body.turnstileToken, request.headers.get('CF-Connecting-IP'));
  if (!human) return json({ error: 'Verification failed — please retry.' }, 403);

  const kind = body.kind === 'contact' ? 'contact' : 'free_trial';
  const name = str(body.name, 100);
  const email = str(body.email, 200);
  if (!name || !email || !email.includes('@')) {
    return json({ error: 'Name and a valid email are required.' }, 400);
  }

  // Unrecognised topics are dropped rather than stored, so the value in the
  // office's inbox is always one the form actually offers.
  const topic = str(body.email_to, 60);
  const pref = body.contact_preference === 'phone' ? 'phone' : 'email';

  const record = {
    id: crypto.randomUUID(),
    kind,
    name,
    email,
    phone: str(body.phone, 40),
    player_name: str(body.player_name, 100),
    age_group: str(body.age_group, 40),
    message: str(body.message, 2000),
    email_to: topic && INQUIRY_TOPICS.includes(topic) ? topic : null,
    zip: str(body.zip, 20),
    // Kept for a free trial as well as a contact message. It used to be stored
    // only for 'contact', so a parent claiming a trial could ask to be phoned and
    // the office would never see it — and the "asked for a call but left no
    // number" check below could not fire either.
    contact_preference: pref
  };

  // Asking to be phoned back without leaving a number would strand the office.
  if (record.contact_preference === 'phone' && !record.phone) {
    return json({ error: 'Please add a phone number, or choose email instead.' }, 400);
  }

  await env.DB
    .prepare(
      `INSERT INTO inquiries
       (id, kind, name, email, phone, player_name, age_group, message,
        email_to, zip, contact_preference)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
    )
    .bind(record.id, record.kind, record.name, record.email, record.phone,
          record.player_name, record.age_group, record.message,
          record.email_to, record.zip, record.contact_preference)
    .run();

  ctx.waitUntil(notifyInquiry(env, record));
  return json({ ok: true });
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function verifyTurnstile(env: Env, token: unknown, ip: string | null): Promise<boolean> {
  if (typeof token !== 'string' || !token) return false;
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip ?? undefined })
  });
  const data: any = await res.json();
  return data.success === true;
}

function requireAdmin(url: URL, env: Env): void {
  if (url.searchParams.get('key') !== env.ADMIN_KEY) {
    throw json({ error: 'Unauthorized' }, 401);
  }
}

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

const text = (s: string, status = 200) =>
  new Response(s, { status, headers: { 'Content-Type': 'text/plain' } });

// Cache-Control: no-store on every JSON response, not just the signed-in ones.
// The 401 from /api/me carried no cache directives, so it was cacheable by
// heuristic — a visitor who loaded the site signed out got that 401 stored, and
// after signing in the nav read the cached copy and still showed "Log in" even
// though the session was real. Any response whose body depends on a cookie must
// say so explicitly.
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
