// worker/qbo.ts
// QuickBooks Online — OAuth, plus the customer and invoice writes that make a
// payment attributable.
//
// Static payment links carry their amount inside the URL and can say nothing
// about who is paying, so money arrived as an anonymous figure with no Customer
// behind it. See docs/QBO-INTEGRATION.md. The replacement: create the Customer
// and the Invoice here first, then send the parent to that invoice's own
// QuickBooks pay page. The payment lands against a record that already exists,
// which is also why it cannot be double-counted.
//
// The card is still handled entirely by Intuit. Nothing in this file touches
// card data and nothing should ever be added that does.
//
// Tokens live in D1 (qbo_tokens, single row) because Intuit rotates the refresh
// token and Worker secrets aren't writable at runtime.

import type { Env } from './types';

// Last-known-good values, used when discovery is unreachable. See endpoints().
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';

const discoveryUrl = (env: Env) =>
  env.QBO_SANDBOX === 'true'
    ? 'https://developer.api.intuit.com/.well-known/openid_sandbox_configuration'
    : 'https://developer.api.intuit.com/.well-known/openid_configuration';

/**
 * Cached for the life of the isolate. QBO_SANDBOX only changes on a deploy, and
 * a deploy replaces isolates, so a cached value can never outlive the flag that
 * chose it.
 */
let cachedEndpoints: { auth: string; token: string } | null = null;

/**
 * The OAuth endpoints, read from Intuit's discovery document.
 *
 * These were hardcoded, which works right up until Intuit moves one. Reading
 * discovery is what they ask for and it costs one cached request.
 *
 * On any failure it returns the hardcoded pair rather than throwing, and does
 * not cache that result so the next call tries discovery again. The reasoning is
 * that discovery being down is not a reason to refuse to authenticate with
 * endpoints we know work today. This is strictly no worse than hardcoding, which
 * is the bar a change like this has to clear.
 */
async function endpoints(env: Env): Promise<{ auth: string; token: string }> {
  if (cachedEndpoints) return cachedEndpoints;

  try {
    const res = await fetch(discoveryUrl(env), { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const doc: any = await res.json();
      if (typeof doc.authorization_endpoint === 'string' && typeof doc.token_endpoint === 'string') {
        cachedEndpoints = { auth: doc.authorization_endpoint, token: doc.token_endpoint };
        return cachedEndpoints;
      }
      console.warn('QBO discovery document missing expected endpoints — using known values');
    } else {
      console.warn(`QBO discovery returned ${res.status} — using known values`);
    }
  } catch (err) {
    console.warn('QBO discovery unreachable — using known values', err);
  }

  return { auth: AUTH_URL, token: TOKEN_URL };
}

const apiBase = (env: Env) =>
  env.QBO_SANDBOX === 'true'
    ? 'https://sandbox-quickbooks.api.intuit.com/v3/company'
    : 'https://quickbooks.api.intuit.com/v3/company';

const redirectUri = (origin: string) => `${origin}/qbo/callback`;

function basicAuth(env: Env): string {
  return 'Basic ' + btoa(`${env.QBO_CLIENT_ID}:${env.QBO_CLIENT_SECRET}`);
}

/**
 * Whether real Intuit credentials have been set.
 *
 * Both secrets EXIST but hold placeholder text, which is worse than being unset:
 * `wrangler secret list` shows them as present, so they read as configured. Left
 * unchecked, /qbo/connect would hand a placeholder client id to Intuit and the
 * admin would get Intuit's own error about it, which says nothing about the
 * actual cause. This turns that into a sentence naming the fix.
 *
 * Deliberately not a format check: the shape of a real Intuit client id is not
 * something to guess at, and rejecting a valid credential would be worse than
 * letting a wrong one through to Intuit's own validation.
 */
export function qboConfigured(env: Env): boolean {
  const placeholder = /^(|todo|tbd|xxx|changeme)$/i;
  return !placeholder.test((env.QBO_CLIENT_ID ?? '').trim())
      && !placeholder.test((env.QBO_CLIENT_SECRET ?? '').trim());
}

/**
 * URL the QuickBooks admin visits once to authorize the app.
 *
 * The `state` is random and stored, so the callback can prove the authorization
 * it is handed came from a round trip we started. It used to be a timestamp and
 * nothing checked it on the way back, which meant /qbo/callback would accept an
 * authorization code from anyone and overwrite the stored connection with
 * whichever company file they authorized. Against the academy's real books that
 * would send parents' invoices into a stranger's QuickBooks.
 */
export async function buildAuthUrl(env: Env, origin: string): Promise<string> {
  const state = crypto.randomUUID();

  // Touches only pending_state: this runs before the tokens exist on a first
  // connect, and must not disturb them on a re-authorization.
  await env.DB
    .prepare(
      `INSERT INTO qbo_tokens (id, pending_state) VALUES (1, ?1)
       ON CONFLICT(id) DO UPDATE SET pending_state = ?1`
    )
    .bind(state)
    .run();

  const params = new URLSearchParams({
    client_id: env.QBO_CLIENT_ID,
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    state
  });
  return `${(await endpoints(env)).auth}?${params}`;
}

/**
 * True if `state` matches the one issued by the last /qbo/connect. Consumes it
 * either way, so a state cannot be replayed and a failed attempt cannot be
 * retried against the same value.
 */
export async function consumeState(env: Env, state: string | null): Promise<boolean> {
  const row = await env.DB
    .prepare('SELECT pending_state FROM qbo_tokens WHERE id = 1')
    .first<{ pending_state: string | null }>();

  await env.DB.prepare('UPDATE qbo_tokens SET pending_state = NULL WHERE id = 1').run();

  return !!state && !!row?.pending_state && row.pending_state === state;
}

export async function exchangeCodeForTokens(
  env: Env, origin: string, code: string, realmId: string
): Promise<void> {
  const res = await fetch((await endpoints(env)).token, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(env),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(origin)
    })
  });
  if (!res.ok) throw new Error(`QBO token exchange failed: ${res.status} ${await res.text()}`);
  await saveTokens(env, await res.json(), realmId);
}

/** Valid access token, auto-refreshing. CRITICAL: persists the rotated refresh token. */
async function getAccessToken(env: Env): Promise<{ accessToken: string; realmId: string }> {
  const row = await env.DB
    .prepare('SELECT access_token, refresh_token, expires_at, realm_id FROM qbo_tokens WHERE id = 1')
    .first<{ access_token: string; refresh_token: string; expires_at: number; realm_id: string }>();

  if (!row?.refresh_token) {
    throw new Error('QBO not connected — visit /qbo/connect?key=ADMIN_KEY to authorize.');
  }
  if (Date.now() < row.expires_at - 60_000) {
    return { accessToken: row.access_token, realmId: row.realm_id };
  }

  const res = await fetch((await endpoints(env)).token, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(env),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refresh_token })
  });
  if (!res.ok) throw new Error(`QBO token refresh failed: ${res.status} ${await res.text()}`);
  const t: any = await res.json();
  await saveTokens(env, t, row.realm_id);
  return { accessToken: t.access_token, realmId: row.realm_id };
}

async function saveTokens(env: Env, t: any, realmId: string): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO qbo_tokens (id, access_token, refresh_token, expires_at, realm_id)
       VALUES (1, ?1, ?2, ?3, ?4)
       ON CONFLICT(id) DO UPDATE SET
         access_token = ?1, refresh_token = ?2, expires_at = ?3, realm_id = ?4`
    )
    .bind(t.access_token, t.refresh_token, Date.now() + t.expires_in * 1000, realmId)
    .run();
}

/**
 * Retries for a transient failure, but ONLY for reads.
 *
 * This is the constraint that shapes the whole thing: creating a customer or an
 * invoice is not idempotent. If a POST times out or returns a 502 we do not know
 * whether QuickBooks acted on it, and retrying can produce two invoices for one
 * enrolment. A family billed twice is a worse outcome than a retry we did not
 * attempt, so writes get exactly one attempt and fall back instead.
 *
 * Reads are safe to repeat, and repeating them is worth it: a query that blips
 * would otherwise push a perfectly good enrolment down the fallback path.
 *
 * Delays are small on purpose. /api/enroll gives QuickBooks eight seconds total
 * before it stops making the parent wait, and a retry budget that eats it just
 * converts one failure mode into another.
 */
const RETRY_DELAYS_MS = [200, 600];

const isRetryableStatus = (status: number) => status === 429 || status >= 500;

async function qboFetch(env: Env, path: string, init: RequestInit = {}): Promise<any> {
  const method = (init.method ?? 'GET').toUpperCase();
  const retryable = method === 'GET';

  let res: Response | undefined;
  let networkError: unknown;

  for (let attempt = 0; ; attempt++) {
    // Fetched inside the loop so a retry that follows a refresh does not reuse a
    // token that expired while we were waiting.
    const { accessToken, realmId } = await getAccessToken(env);

    networkError = undefined;
    try {
      res = await fetch(`${apiBase(env)}/${realmId}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(init.headers ?? {})
        }
      });
    } catch (err) {
      networkError = err;
    }

    const shouldRetry =
      retryable &&
      attempt < RETRY_DELAYS_MS.length &&
      (networkError !== undefined || (res !== undefined && isRetryableStatus(res.status)));

    if (!shouldRetry) break;

    console.warn(
      `QBO ${path}: attempt ${attempt + 1} failed ` +
      `(${networkError !== undefined ? 'network error' : res!.status}), retrying`
    );
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
  }

  if (res === undefined) {
    throw new Error(`QBO ${path}: request failed — ${String(networkError)}`);
  }
  const body: any = await res.json();
  if (!res.ok || body.Fault) {
    // intuit_tid identifies this exact request in Intuit's own logs. Without it
    // a support ticket starts with them trying to find the call; with it they
    // can look it up. Costs one header read, and the moment it matters is the
    // moment something has already gone wrong against the academy's real books.
    const tid = res.headers.get('intuit_tid');
    throw new Error(
      `QBO ${path}: ${body.Fault ? JSON.stringify(body.Fault.Error) : res.status}` +
      (tid ? ` [intuit_tid ${tid}]` : '')
    );
  }
  return body;
}

/**
 * Setup helper: lists QBO Items, so the office can confirm each program exists.
 *
 * IncomeAccountRef is included because an item's name says what it is and its
 * income account says where the money lands, and only the second one matters to
 * the P&L. Reusing a company's existing item is only safe once you can see it
 * books where the bookkeeper said revenue should book.
 */
export async function listItems(env: Env): Promise<any[]> {
  const q = encodeURIComponent(
    'select Id, Name, Type, IncomeAccountRef, Active from Item maxresults 500'
  );
  const res = await qboFetch(env, `/query?query=${q}`);
  return res.QueryResponse?.Item ?? [];
}

// ── writing customers and invoices ────────────────────────────────────────

/**
 * Escapes a value for QuickBooks' query language, which is SQL-shaped and has
 * SQL's quoting problem with it.
 *
 * Not paranoia about injection — the realistic input is O'Brien. An unescaped
 * apostrophe in a parent's surname terminates the string literal and the query
 * fails with a parse error that says nothing about names, so a family gets
 * turned away at enrollment for having the wrong surname.
 */
const qq = (s: string) => s.replace(/'/g, "\\'");

/**
 * Resolves a QuickBooks Item by name.
 *
 * By NAME rather than by a stored id, deliberately: item ids are assigned per
 * company file, so every id captured against the sandbox is wrong the moment we
 * point at the academy's real company. Names are what Katie types and what
 * survives the switch.
 *
 * Throws rather than inventing an item. A missing item means the catalog and
 * QuickBooks disagree, and the honest failure is louder than an invoice quietly
 * booked to the wrong line of the P&L.
 */
export async function findItemIdByName(env: Env, name: string): Promise<string> {
  const q = encodeURIComponent(`select Id, Name from Item where Name = '${qq(name)}'`);
  const res = await qboFetch(env, `/query?query=${q}`);
  const id = res.QueryResponse?.Item?.[0]?.Id;
  if (!id) {
    throw new Error(
      `QuickBooks has no Item named "${name}". Create it under Sales → ` +
      `Products & services, or correct qboItem in worker/programs.ts.`
    );
  }
  return id;
}

/**
 * An income account to book new Service items against, by name if one is given
 * and otherwise whichever the company file lists first.
 *
 * Guessing is acceptable in a sandbox and is not acceptable against the
 * academy's real books, which is why the only caller is fenced behind
 * QBO_SANDBOX. Where the revenue lands is the bookkeeper's decision, not one to
 * infer from a query ordering.
 */
/** Every income account in the company file. Ordering is QuickBooks' own. */
export async function listIncomeAccounts(env: Env): Promise<any[]> {
  const q = encodeURIComponent(
    "select Id, Name, AcctNum, FullyQualifiedName from Account where AccountType = 'Income' maxresults 200"
  );
  const res = await qboFetch(env, `/query?query=${q}`);
  return res.QueryResponse?.Account ?? [];
}

export async function findIncomeAccountId(env: Env, name?: string | null): Promise<string> {
  const accounts = await listIncomeAccounts(env);
  if (accounts.length === 0) {
    throw new Error('This company file has no income account to book items against.');
  }
  if (!name) return accounts[0].Id;

  // Katie answered "7010 Income", which is how QuickBooks DISPLAYS an account
  // when account numbers are switched on: the number and the name are separate
  // fields, concatenated for the screen. A plain `Name = '7010 Income'` query
  // finds nothing, and the failure would look like a missing account rather than
  // a naming convention.
  //
  // So match the ways a human might reasonably write it, in descending order of
  // how sure we are, and refuse rather than guess if nothing fits.
  const want = name.trim().toLowerCase();
  const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
  const combined = (a: any) => `${norm(a.AcctNum)} ${norm(a.Name)}`.trim();

  const match =
    accounts.find((a) => norm(a.Name) === want) ??
    accounts.find((a) => combined(a) === want) ??
    accounts.find((a) => norm(a.FullyQualifiedName) === want) ??
    accounts.find((a) => norm(a.AcctNum) === want);

  if (!match) {
    // Naming what IS there turns a dead end into a one-line answer, and this
    // error will be read mid-switch against the academy's real books, which is
    // the worst possible time to go hunting.
    const available = accounts
      .map((a) => `${a.AcctNum ? a.AcctNum + ' ' : ''}${a.Name}`)
      .join(', ');
    throw new Error(
      `No income account matching "${name}". This company file has: ${available}`
    );
  }
  return match.Id;
}

/** Creates a Service item. Returns its new id. */
export async function createServiceItem(
  env: Env,
  input: { name: string; price: number | null; incomeAccountId: string }
): Promise<string> {
  const res = await qboFetch(env, '/item', {
    method: 'POST',
    body: JSON.stringify({
      Name: input.name,
      Type: 'Service',
      IncomeAccountRef: { value: input.incomeAccountId },
      // Convenience for whoever raises an invoice by hand in QuickBooks. Our own
      // invoices set UnitPrice explicitly from the catalog, so this figure never
      // decides what a parent is charged.
      ...(typeof input.price === 'number' ? { UnitPrice: input.price } : {})
    })
  });
  return res.Item.Id;
}

/**
 * The pay page for an invoice that already exists.
 *
 * The link is handed to the parent once, in the response to /api/enroll, and
 * then it is gone — we store the invoice id, not the URL. That is fine until
 * somebody needs it again: a parent who closed the tab, an office chasing an
 * abandoned checkout, or a test payment somebody has to hand to the bookkeeper.
 *
 * Null when QuickBooks issues no link, which means Payments is not connected to
 * that company file. The invoice is still real.
 */
export async function getInvoiceLink(env: Env, invoiceId: string): Promise<string | null> {
  return (await getInvoice(env, invoiceId)).payLink;
}

export interface InvoiceState {
  id: string;
  /** The number a human sees. Blank when custom transaction numbers were on. */
  number: string | null;
  customer: string | null;
  total: number | null;
  /** 0 means settled. This is the only field that answers "did they pay?" */
  balance: number | null;
  paid: boolean;
  /**
   * Payments and credits attached to this invoice. An empty list next to a zero
   * balance would mean the invoice was written off rather than paid.
   */
  linked: Array<{ id: string; type: string }>;
  payLink: string | null;
}

/**
 * What actually happened to an invoice.
 *
 * Written for one question that turned out to be hard to answer any other way:
 * did a payment land ON this invoice, or merely near it? Money arriving in the
 * bank proves neither, and an unapplied payment sitting beside an open invoice
 * is exactly the state this whole project exists to stop producing.
 *
 * Balance zero with a linked payment is the answer. Either one alone is not.
 */
export async function getInvoice(env: Env, invoiceRef: string): Promise<InvoiceState> {
  // Accepts either the internal Id or the number a human reads off the invoice.
  //
  // These are different, and confusingly so: our enrolments store Id (29453),
  // while QuickBooks, the pay page and Katie all say DocNumber (15463). Anyone
  // holding an invoice has the second one, so looking up only the first turns a
  // reasonable request into an error about a record that does exist.
  let inv: any = null;

  try {
    const res = await qboFetch(env, `/invoice/${encodeURIComponent(invoiceRef)}?include=invoiceLink`);
    inv = res.Invoice ?? null;
  } catch {
    // Falls through to the number lookup rather than reporting a miss: an Id
    // that does not resolve is the expected case when somebody passed a number.
  }

  if (!inv) {
    const q = encodeURIComponent(`select * from Invoice where DocNumber = '${qq(invoiceRef)}'`);
    const res = await qboFetch(env, `/query?query=${q}`);
    const found = res.QueryResponse?.Invoice?.[0];
    if (!found) {
      throw new Error(
        `No invoice with id or number "${invoiceRef}". Note these differ: our ` +
        `enrolment rows store the internal id, QuickBooks shows the number.`
      );
    }
    // The query response carries no InvoiceLink, so re-read by the real id to
    // get one. Cheap, and it keeps the shape identical either way in.
    const full = await qboFetch(env, `/invoice/${encodeURIComponent(found.Id)}?include=invoiceLink`);
    inv = full.Invoice ?? found;
  }
  const balance = typeof inv.Balance === 'number' ? inv.Balance : null;
  return {
    id: String(inv.Id ?? invoiceRef),
    number: inv.DocNumber ?? null,
    customer: inv.CustomerRef?.name ?? inv.CustomerRef?.value ?? null,
    total: typeof inv.TotalAmt === 'number' ? inv.TotalAmt : null,
    balance,
    paid: balance === 0,
    linked: (inv.LinkedTxn ?? []).map((t: any) => ({
      id: String(t.TxnId ?? ''), type: String(t.TxnType ?? '')
    })),
    payLink: inv.InvoiceLink ?? null
  };
}

export interface CustomerInput {
  email: string;
  /** Parent's full name as they typed it. Display only — never the match key. */
  name: string;
  phone?: string | null;
}

/**
 * Finds the Customer for this parent, creating one if this is their first
 * enrollment. Returns the QuickBooks Customer id.
 *
 * Matched on PrimaryEmailAddr, never on DisplayName. Two "John Smith" families
 * are not hypothetical in a junior sports club with siblings and cousins, and
 * matching on name would either fail the create or — much worse — silently
 * attach one family's invoice to another family's account. Email is what we
 * collect on every enrollment, what accounts are keyed on, and what is actually
 * unique.
 */
export async function findOrCreateCustomer(env: Env, input: CustomerInput): Promise<string> {
  const email = input.email.trim();

  const q = encodeURIComponent(
    `select Id, DisplayName from Customer where PrimaryEmailAddr = '${qq(email)}'`
  );
  const found = await qboFetch(env, `/query?query=${q}`);
  const existing = found.QueryResponse?.Customer?.[0]?.Id;
  if (existing) return existing;

  const body: Record<string, unknown> = {
    DisplayName: input.name,
    PrimaryEmailAddr: { Address: email }
  };
  if (input.phone) body.PrimaryPhone = { FreeFormNumber: input.phone };

  try {
    const created = await qboFetch(env, '/customer', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    return created.Customer.Id;
  } catch (err) {
    // QuickBooks requires DisplayName to be unique across the company file, and
    // rejects a duplicate with fault code 6240. We already know this is a
    // different family — the email did not match — so the name alone cannot
    // identify them. Qualify it and retry once.
    //
    // The alternative, appending a number, produces "John Smith 2" and leaves
    // the office guessing which family that is. The email is the thing that
    // actually tells them apart, so it goes in the name.
    if (!/6240|Duplicate Name/i.test(String(err))) throw err;

    const created = await qboFetch(env, '/customer', {
      method: 'POST',
      body: JSON.stringify({ ...body, DisplayName: `${input.name} (${email})` })
    });
    return created.Customer.Id;
  }
}

export interface InvoiceInput {
  customerId: string;
  itemId: string;
  /** Whole dollars PER UNIT. The line total is amount x quantity. */
  amount: number;
  /**
   * How many of the thing. One for everything except Grom's, where each weekday
   * chosen is a separate eight week session at its own price.
   *
   * Sent as a real quantity rather than folded into a single line total, so the
   * invoice reads "4 x $200" and reconciles against a register of four classes.
   * A lump $800 with no quantity is the version somebody queries in November.
   */
  quantity?: number;
  /** Appears on the invoice line — carries the player, e.g. "Test (9-16)". */
  description: string;
  /** Where QuickBooks emails the invoice. */
  email: string;
}

export interface InvoiceResult {
  invoiceId: string;
  /**
   * The invoice's own QuickBooks pay page, or null when QuickBooks declined to
   * issue one — see createInvoice.
   */
  payLink: string | null;
}

/**
 * Creates an invoice for one enrollment and returns its pay page.
 *
 * `include=invoiceLink` asks QuickBooks for the shareable payment URL in the
 * create response, which saves a second round trip.
 *
 * payLink comes back null when QuickBooks Payments is not connected to the
 * company file — the invoice still exists and is still correct, there is just
 * nowhere to send the parent to pay it. That is the expected state in the
 * sandbox, and it must not be mistaken for a failure: the caller falls back to
 * "the office will follow up", exactly as it already does for an option with no
 * payment link. A parent must never be blocked from enrolling by the state of a
 * third party's API.
 */
export async function createInvoice(env: Env, input: InvoiceInput): Promise<InvoiceResult> {
  const res = await qboFetch(env, '/invoice?include=invoiceLink', {
    method: 'POST',
    body: JSON.stringify({
      CustomerRef: { value: input.customerId },
      BillEmail: { Address: input.email },
      // Card only. ACH on a $35 drop-in costs more in reconciliation than the
      // processing fee saves, and the academy asked for one way to pay.
      AllowOnlineCreditCardPayment: true,
      AllowOnlineACHPayment: false,
      Line: [
        {
          DetailType: 'SalesItemLineDetail',
          Amount: input.amount * (input.quantity ?? 1),
          Description: input.description,
          SalesItemLineDetail: {
            ItemRef: { value: input.itemId },
            Qty: input.quantity ?? 1,
            UnitPrice: input.amount,
            // Katie, 2026-08-05: "No we do not charge sales tax ever." Their
            // company file has sales tax configured, so without this the line
            // inherits whatever the item or customer defaults to and the taxable
            // box can come through ticked. Saying NON explicitly means the answer
            // does not depend on a setting nobody here controls.
            //
            // If the academy ever does start charging tax, this is the line to
            // change, and it should change because somebody decided to rather
            // than because a default drifted.
            TaxCodeRef: { value: 'NON' }
          }
        }
      ]
    })
  });

  return {
    invoiceId: res.Invoice.Id,
    payLink: res.Invoice.InvoiceLink ?? null
  };
}
