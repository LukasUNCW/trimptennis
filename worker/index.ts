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
import { lookupProgram, listPrograms, payUrlFor } from './programs';
import { buildAuthUrl, exchangeCodeForTokens, listItems } from './qbo';
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
        return Response.redirect(buildAuthUrl(env, url.origin), 302);
      }
      if (request.method === 'GET' && pathname === '/qbo/callback') {
        const code = url.searchParams.get('code');
        const realmId = url.searchParams.get('realmId');
        if (!code || !realmId) return text('Missing code or realmId — restart authorization.', 400);
        await exchangeCodeForTokens(env, url.origin, code, realmId);
        return text('QuickBooks connected. You can close this tab.');
      }
      if (request.method === 'GET' && pathname === '/qbo/items') {
        requireAdmin(url, env);
        const items = await listItems(env);
        return json(items.map((i: any) => ({ id: i.Id, name: i.Name, type: i.Type })));
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
    child_id
  };

  await env.DB
    .prepare(
      `INSERT INTO enrollments
       (id, parent_name, parent_email, phone, player_name, age_group, program,
        payment_status, notes, account_id, child_id)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
    )
    .bind(row.id, row.parent_name, row.parent_email, row.phone, row.player_name,
          row.age_group, row.program, row.payment_status, row.notes,
          row.account_id, row.child_id)
    .run();

  ctx.waitUntil(notifyEnrollment(env, {
    ...row,
    autoDraftFollowUp: program.autoDraftAfterFirstMonth === true
  }));

  return json({
    ok: true,
    enrollmentId: row.id,
    // null until Katie has created this program's payment link — the site then
    // shows a "the office will follow up" confirmation instead of redirecting.
    // Also null if the pasted link does not survive checking, which is the same
    // situation from the parent's side and logs loudly for us. See payUrlFor.
    payUrl: payUrlFor(program)
  });
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
      `SELECT created_at, program, player_name, age_group, payment_status
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
    contact_preference: kind === 'contact' ? pref : null
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
