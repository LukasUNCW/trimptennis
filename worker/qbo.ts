// worker/qbo.ts
// QuickBooks Online connection — OAuth only.
//
// Payments are taken by QuickBooks Payments, so QuickBooks records the sale
// itself; nothing here writes customers or sales receipts. What remains is the
// authorized connection, kept for read-side work: listing Items during setup
// and (next) matching QuickBooks Payments back to enrollment rows so the roster
// can show who has actually paid.
//
// Tokens live in D1 (qbo_tokens, single row) because Intuit rotates the refresh
// token and Worker secrets aren't writable at runtime.

import type { Env } from './types';

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';

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

/** Setup helper: lists QBO Items, so the office can confirm each program exists. */
export async function listItems(env: Env): Promise<any[]> {
  const q = encodeURIComponent('select Id, Name, Type from Item maxresults 200');
  const res = await qboFetch(env, `/query?query=${q}`);
  return res.QueryResponse?.Item ?? [];
}
