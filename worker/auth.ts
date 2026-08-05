// worker/auth.ts
// Magic-link sign-in. See docs/ACCOUNTS.md for why there are no passwords.
//
// Shape of the flow:
//   request  → generate a token, store only its SHA-256, email the link
//   callback → hash the presented token, look it up, DELETE it, open a session
//   session  → opaque random id in an HttpOnly cookie, backed by a D1 row
//
// Nothing here is reversible: the database holds hashes and session ids, never
// a credential that could be replayed off a backup.

import type { Env } from './types';

export const COOKIE_NAME = 'sta_session';

const TOKEN_TTL_MS = 15 * 60 * 1000;             // 15 minutes
const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const MAX_REQUESTS_PER_HOUR = 5;

export interface SessionUser {
  account_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  /** Staff. Read fresh from the account on every request, never from the cookie. */
  is_admin: boolean;
}

// ── primitives ───────────────────────────────────────────────────────────

const hex = (buf: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(buf as ArrayBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return hex(a);
}

async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

export const normaliseEmail = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  return e.length > 3 && e.length <= 200 && e.includes('@') && !e.includes(' ') ? e : null;
};

// ── login tokens ─────────────────────────────────────────────────────────

/** True when this address has asked for too many links in the last hour. */
export async function isRateLimited(env: Env, email: string): Promise<boolean> {
  const row = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM login_tokens WHERE email = ?1 AND created_at > ?2')
    .bind(email, Date.now() - 60 * 60 * 1000)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= MAX_REQUESTS_PER_HOUR;
}

/** Returns the raw token to email. Only its hash is persisted. */
export async function createLoginToken(env: Env, email: string): Promise<string> {
  const token = randomHex(32);
  const now = Date.now();
  await env.DB
    .prepare('INSERT INTO login_tokens (token_hash, email, expires_at, created_at) VALUES (?1,?2,?3,?4)')
    .bind(await sha256Hex(token), email, now + TOKEN_TTL_MS, now)
    .run();
  // Opportunistic sweep so expired rows do not accumulate; no cron needed.
  await env.DB.prepare('DELETE FROM login_tokens WHERE expires_at < ?1').bind(now).run();
  return token;
}

/**
 * Redeems a token and returns the account id, creating the account on first
 * sign-in. Returns null for anything unknown, expired or already used — the
 * caller must not distinguish between those cases to the visitor.
 */
export async function redeemLoginToken(env: Env, token: unknown): Promise<string | null> {
  if (typeof token !== 'string' || token.length !== 64 || !/^[0-9a-f]+$/.test(token)) return null;

  const hash = await sha256Hex(token);
  const row = await env.DB
    .prepare('SELECT email, expires_at FROM login_tokens WHERE token_hash = ?1')
    .bind(hash)
    .first<{ email: string; expires_at: number }>();

  // Single use: consumed whether or not it turned out to be valid, so a leaked
  // link cannot be retried.
  await env.DB.prepare('DELETE FROM login_tokens WHERE token_hash = ?1').bind(hash).run();

  if (!row || row.expires_at < Date.now()) return null;

  const existing = await env.DB
    .prepare('SELECT id FROM accounts WHERE email = ?1')
    .bind(row.email)
    .first<{ id: string }>();

  if (existing) {
    await env.DB
      .prepare("UPDATE accounts SET last_login_at = datetime('now') WHERE id = ?1")
      .bind(existing.id)
      .run();
    return existing.id;
  }

  // First sign-in doubles as signup — there is no separate registration step.
  const id = crypto.randomUUID();
  await env.DB
    .prepare("INSERT INTO accounts (id, email, last_login_at) VALUES (?1, ?2, datetime('now'))")
    .bind(id, row.email)
    .run();
  return id;
}

// ── sessions ─────────────────────────────────────────────────────────────

export async function createSession(env: Env, accountId: string, userAgent: string | null): Promise<string> {
  const id = randomHex(32);
  const now = Date.now();
  await env.DB
    .prepare('INSERT INTO sessions (id, account_id, created_at, expires_at, user_agent) VALUES (?1,?2,?3,?4,?5)')
    .bind(id, accountId, now, now + SESSION_TTL_MS, (userAgent ?? '').slice(0, 300))
    .run();
  return id;
}

const readCookie = (request: Request, name: string): string | null => {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
};

/** The signed-in account, or null. Expired sessions are deleted as they are hit. */
export async function getSessionUser(env: Env, request: Request): Promise<SessionUser | null> {
  const id = readCookie(request, COOKIE_NAME);
  if (!id || !/^[0-9a-f]{64}$/.test(id)) return null;

  const row = await env.DB
    .prepare(
      // is_admin is read here, on every request, rather than being baked into
      // the session at sign-in. Revoking staff access is then a single UPDATE
      // that takes effect on the next click, instead of waiting out however long
      // that person's session has left.
      `SELECT s.expires_at, a.id AS account_id, a.email, a.first_name, a.last_name, a.is_admin
       FROM sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.id = ?1`
    )
    .bind(id)
    .first<{ expires_at: number; account_id: string; email: string; first_name: string | null;
             last_name: string | null; is_admin: number }>();

  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(id).run();
    return null;
  }
  return {
    account_id: row.account_id,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    is_admin: row.is_admin === 1
  };
}

export async function destroySession(env: Env, request: Request): Promise<void> {
  const id = readCookie(request, COOKIE_NAME);
  if (id) await env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(id).run();
}

// ── cookies ──────────────────────────────────────────────────────────────
// SameSite=Lax rather than Strict: the magic link arrives as a top-level
// navigation from an email client, and Strict would drop the cookie on that
// first hop.

export const sessionCookie = (id: string): string =>
  `${COOKIE_NAME}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;

export const clearedCookie = (): string =>
  `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
