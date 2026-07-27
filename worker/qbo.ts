// worker/qbo.ts
// QuickBooks Online sync — the Velo package ported to Workers.
// Tokens live in D1 (qbo_tokens, single row) because Intuit rotates the
// refresh token and Worker secrets aren't writable at runtime.

import type { Env, EnrollmentRow } from './types';

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';

// ── Plan → QBO Item mapping ─────────────────────────────────────────────
// Fill after creating Items in QBO (run /qbo/items?key=ADMIN_KEY to list).
// Keys must match the `program` metadata set on each Stripe Payment Link.
const PLAN_ITEM_MAP: Record<string, { itemId: string; description: string }> = {
  'Elite Academy':       { itemId: 'REPLACE_ME', description: 'Elite Academy membership' },
  "Grom's":              { itemId: 'REPLACE_ME', description: "Grom's 10-week clinic (ages 6-10)" },
  "Shredder's":          { itemId: 'REPLACE_ME', description: "Shredder's 10-week clinic (ages 11-16)" },
  'Summer Morning Camp': { itemId: 'REPLACE_ME', description: 'Summer morning camp' }
};
const FALLBACK_ITEM = { itemId: 'REPLACE_ME', description: 'Tennis program enrollment' };
// ────────────────────────────────────────────────────────────────────────

const apiBase = (env: Env) =>
  env.QBO_SANDBOX === 'true'
    ? 'https://sandbox-quickbooks.api.intuit.com/v3/company'
    : 'https://quickbooks.api.intuit.com/v3/company';

const redirectUri = (origin: string) => `${origin}/qbo/callback`;

function basicAuth(env: Env): string {
  return 'Basic ' + btoa(`${env.QBO_CLIENT_ID}:${env.QBO_CLIENT_SECRET}`);
}

/** URL the QuickBooks admin visits once to authorize the app. */
export function buildAuthUrl(env: Env, origin: string): string {
  const params = new URLSearchParams({
    client_id: env.QBO_CLIENT_ID,
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    state: 'trimptennis-' + Date.now()
  });
  return `${AUTH_URL}?${params}`;
}

export async function exchangeCodeForTokens(
  env: Env, origin: string, code: string, realmId: string
): Promise<void> {
  const res = await fetch(TOKEN_URL, {
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

  const res = await fetch(TOKEN_URL, {
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

async function qboFetch(env: Env, path: string, init: RequestInit = {}): Promise<any> {
  const { accessToken, realmId } = await getAccessToken(env);
  const res = await fetch(`${apiBase(env)}/${realmId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers ?? {})
    }
  });
  const body: any = await res.json();
  if (!res.ok || body.Fault) {
    throw new Error(`QBO ${path}: ${body.Fault ? JSON.stringify(body.Fault.Error) : res.status}`);
  }
  return body;
}

async function findOrCreateCustomer(env: Env, e: EnrollmentRow): Promise<string> {
  const email = (e.parent_email ?? '').replace(/'/g, "\\'");
  if (email) {
    const q = encodeURIComponent(`select Id from Customer where PrimaryEmailAddr = '${email}'`);
    const found = await qboFetch(env, `/query?query=${q}`);
    const hit = found.QueryResponse?.Customer?.[0];
    if (hit) return hit.Id;
  }
  const created = await qboFetch(env, '/customer', {
    method: 'POST',
    body: JSON.stringify({
      DisplayName: `${e.parent_name ?? 'Unknown'} (${e.parent_email ?? e.id})`,
      PrimaryEmailAddr: e.parent_email ? { Address: e.parent_email } : undefined
    })
  });
  return created.Customer.Id;
}

async function createSalesReceipt(env: Env, e: EnrollmentRow, customerId: string): Promise<string> {
  const item = PLAN_ITEM_MAP[e.program] ?? FALLBACK_ITEM;
  const amount = e.amount_cents / 100;
  const created = await qboFetch(env, '/salesreceipt', {
    method: 'POST',
    body: JSON.stringify({
      CustomerRef: { value: customerId },
      TxnDate: new Date().toISOString().slice(0, 10),
      PrivateNote: `Stripe ${e.id} — ${e.program}${e.player_name ? ` — player: ${e.player_name}` : ''}`,
      Line: [{
        Amount: amount,
        Description: item.description,
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: { ItemRef: { value: item.itemId }, Qty: 1, UnitPrice: amount }
      }]
    })
  });
  return created.SalesReceipt.Id;
}

/** Sync one enrollment row. Never throws; records outcome on the row. */
export async function syncEnrollment(env: Env, e: EnrollmentRow): Promise<void> {
  try {
    const customerId = await findOrCreateCustomer(env, e);
    const receiptId = await createSalesReceipt(env, e, customerId);
    await env.DB
      .prepare(
        `UPDATE enrollments SET qbo_status='success', qbo_receipt_id=?1,
         qbo_attempts=qbo_attempts+1, qbo_last_error=NULL WHERE id=?2`
      )
      .bind(receiptId, e.id).run();
  } catch (err: any) {
    const notConnected = String(err?.message ?? '').includes('QBO not connected');
    await env.DB
      .prepare(
        `UPDATE enrollments SET qbo_status=?1, qbo_attempts=qbo_attempts+?2,
         qbo_last_error=?3 WHERE id=?4`
      )
      // Stay 'pending' with no attempt burned if QBO simply isn't connected yet.
      .bind(notConnected ? 'pending' : 'failed', notConnected ? 0 : 1,
            String(err?.message ?? err), e.id)
      .run();
  }
}

/** Nightly sweep: retry failed (<5 attempts) and pending rows. */
export async function retryUnsynced(env: Env): Promise<number> {
  const rows = await env.DB
    .prepare(
      `SELECT * FROM enrollments
       WHERE (qbo_status='failed' AND qbo_attempts < 5) OR qbo_status='pending'
       LIMIT 50`
    )
    .all<EnrollmentRow>();
  for (const row of rows.results) await syncEnrollment(env, row);
  return rows.results.length;
}

/** Setup helper: lists QBO Items so PLAN_ITEM_MAP can be filled in. */
export async function listItems(env: Env): Promise<any[]> {
  const q = encodeURIComponent('select Id, Name, Type from Item maxresults 200');
  const res = await qboFetch(env, `/query?query=${q}`);
  return res.QueryResponse?.Item ?? [];
}
