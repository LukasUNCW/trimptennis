// scripts/test-account.mjs — run with: npm run test:account
//
// Exercises the account API against the DEPLOYED Worker, including the checks
// that matter most: that one account cannot read or modify another account's
// children, that the sign-in email cannot be changed through the profile
// endpoint, and that /account redirects when signed out.
//
// It creates two throwaway accounts (acctest-*@example.com) and deletes them at
// the end. Sign-in tokens are inserted straight into D1 because Turnstile
// blocks scripted requests to /api/auth/request.
//
// NOTE: this runs against production data. It only ever touches rows whose
// email matches acctest-%@example.com.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const B = 'https://trimptennis.lukas-nilsson4321.workers.dev';
let pass = 0, fail = 0;

const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <- ' + extra : '')); }
};

// Routed through a .sql file: passing SQL as --command through a shell gets
// word-split on Windows, which mangles every statement containing a space.
const SQL_FILE = join(tmpdir(), 'sta-test-query.sql');
const d1 = (sql) => {
  writeFileSync(SQL_FILE, sql, 'utf8');
  return execFileSync('npx',
    ['wrangler', 'd1', 'execute', 'trimptennis-db', '--remote', '--file', SQL_FILE],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true });
};

/** Mint a session for an email by inserting a token and redeeming it. */
async function signIn(email) {
  const token = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  d1(`INSERT INTO login_tokens (token_hash,email,expires_at,created_at) VALUES ('${hash}','${email}',${now + 900000},${now})`);
  const res = await fetch(`${B}/auth/callback?token=${token}`, { redirect: 'manual' });
  const sid = /sta_session=([0-9a-f]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
  if (!sid) throw new Error('no session cookie for ' + email);
  return `sta_session=${sid}`;
}

const req = (path, cookie, options = {}) =>
  fetch(B + path, { ...options, headers: { ...(options.headers ?? {}), Cookie: cookie } });

const A_EMAIL = 'acctest-a@example.com';
const B_EMAIL = 'acctest-b@example.com';

console.log('\n— signing in two separate accounts —');
const A = await signIn(A_EMAIL);
const Bc = await signIn(B_EMAIL);
ok('two independent sessions created', A !== Bc);

console.log('\n— GET /api/me —');
let me = await req('/api/me', A).then((r) => r.json());
ok('returns the right account', me.account?.email === A_EMAIL, me.account?.email);
ok('children starts empty', Array.isArray(me.children) && me.children.length === 0);

console.log('\n— unauthenticated —');
ok('GET /api/me without cookie is 401', (await fetch(`${B}/api/me`)).status === 401);
const noAuth = await fetch(`${B}/api/children`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"first_name":"X"}' });
ok('POST /api/children without cookie is 401', noAuth.status === 401);
const acct = await fetch(`${B}/account`, { redirect: 'manual' });
ok('/account without a session redirects to /login',
   acct.status === 302 && (acct.headers.get('location') ?? '').includes('/login'),
   acct.status + ' ' + acct.headers.get('location'));

console.log('\n— PATCH /api/me —');
me = await req('/api/me', A, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ first_name: 'Ada', last_name: 'Lovelace', city: 'Wilmington', state: 'NC', zip: '28403' })
}).then((r) => r.json());
ok('profile fields saved', me.account?.first_name === 'Ada' && me.account?.city === 'Wilmington', JSON.stringify(me.account));

const emailAttempt = await req('/api/me', A, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'hijack@example.com', first_name: 'Ada' })
}).then((r) => r.json());
ok('email cannot be changed via PATCH', emailAttempt.account?.email === A_EMAIL, emailAttempt.account?.email);

const notJson = await req('/api/me', A, { method: 'PATCH', headers: { 'Content-Type': 'text/plain' }, body: '{"first_name":"Nope"}' });
ok('non-JSON content-type rejected (CSRF guard)', notJson.status === 400, String(notJson.status));

console.log('\n— children CRUD —');
me = await req('/api/children', A, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ first_name: 'Junior', last_name: 'Ace', birth_year: 2014, notes: 'left handed' })
}).then((r) => r.json());
const childId = me.children?.[0]?.id;
ok('child created', me.children?.length === 1 && me.children[0].first_name === 'Junior');
ok('birth year stored as a number', me.children?.[0]?.birth_year === 2014, String(me.children?.[0]?.birth_year));

const badYear = await req('/api/children', A, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ first_name: 'Wrong', birth_year: 1234 })
});
ok('implausible birth year rejected', badYear.status === 400, String(badYear.status));

const noName = await req('/api/children', A, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ first_name: '   ' })
});
ok('blank first name rejected', noName.status === 400, String(noName.status));

me = await req(`/api/children/${childId}`, A, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ first_name: 'Junior', last_name: 'Ace', birth_year: 2015, notes: 'right handed' })
}).then((r) => r.json());
ok('child updated', me.children?.[0]?.birth_year === 2015 && me.children?.[0]?.notes === 'right handed');

console.log('\n— cross-account isolation (the important one) —');
const bSees = await req('/api/me', Bc).then((r) => r.json());
ok("account B cannot see A's children", (bSees.children ?? []).length === 0, JSON.stringify(bSees.children));

const bPatch = await req(`/api/children/${childId}`, Bc, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ first_name: 'Hijacked' })
});
ok("account B cannot PATCH A's child (404)", bPatch.status === 404, String(bPatch.status));

const bDelete = await req(`/api/children/${childId}`, Bc, { method: 'DELETE' });
ok("account B cannot DELETE A's child (404)", bDelete.status === 404, String(bDelete.status));

const stillThere = await req('/api/me', A).then((r) => r.json());
ok("A's child survived B's attempts", stillThere.children?.[0]?.first_name === 'Junior', JSON.stringify(stillThere.children));

console.log('\n— delete own child —');
me = await req(`/api/children/${childId}`, A, { method: 'DELETE' }).then((r) => r.json());
ok('own child deleted', (me.children ?? []).length === 0);

console.log('\n— cleanup —');
d1(`DELETE FROM children WHERE account_id IN (SELECT id FROM accounts WHERE email LIKE 'acctest-%@example.com');
    DELETE FROM sessions WHERE account_id IN (SELECT id FROM accounts WHERE email LIKE 'acctest-%@example.com');
    DELETE FROM accounts WHERE email LIKE 'acctest-%@example.com';
    DELETE FROM login_tokens WHERE email LIKE 'acctest-%@example.com'`);
console.log('  test accounts removed');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
