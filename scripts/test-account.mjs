// scripts/test-account.mjs — run with: npm run test:account
//
// Exercises the account API against the DEPLOYED Worker, including the checks
// that matter most: that one account cannot read or modify another account's
// children or enrolments, that the sign-in email cannot be changed through the
// profile endpoint, and that /account redirects when signed out.
//
// It creates two throwaway accounts (acctest-*@example.com), plus enrolment rows
// against those addresses, and deletes them at the end. Sign-in tokens and
// enrolments are inserted straight into D1 because Turnstile blocks scripted
// requests to /api/auth/request and /api/enroll.
//
// NOTE: this runs against production data. It only ever touches rows whose
// email matches acctest-%@example.com.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

const B = 'https://trimptennis.lukas-nilsson4321.workers.dev';
let pass = 0, fail = 0;

const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <- ' + extra : '')); }
};

// wrangler is invoked as a JS file rather than through npx: on Windows a .cmd
// shim needs shell:true, and a shell word-splits the SQL. --command also returns
// real result rows, whereas --file returns only an import summary.
const wrangler = (args) => execFileSync(process.execPath,
  ["node_modules/wrangler/bin/wrangler.js", ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const d1 = (sql) => wrangler(["d1", "execute", "trimptennis-db", "--remote", "--json", "--command", sql]);

const query = (sql) => {
  const out = d1(sql);
  return JSON.parse(out.slice(out.indexOf("["))).flatMap((r) => r.results ?? []);
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

console.log('\n— enrollment history (phase 4) —');
// Written straight into D1: Turnstile blocks a scripted POST to /api/enroll, and
// created_at is set explicitly so the ordering assertion is not at the mercy of
// two inserts landing in the same second.
const idA = (await req('/api/me', A).then((r) => r.json())).account.id;
const idB = (await req('/api/me', Bc).then((r) => r.json())).account.id;

d1(`INSERT INTO enrollments (id,created_at,parent_email,player_name,age_group,program,payment_status,account_id)
      VALUES ('${randomBytes(8).toString('hex')}','2026-01-05 10:00:00','${A_EMAIL}','Linked Kid','10-18','Elite Academy','paid','${idA}');
    INSERT INTO enrollments (id,created_at,parent_email,player_name,age_group,program,payment_status,account_id)
      VALUES ('${randomBytes(8).toString('hex')}','2026-03-09 10:00:00','${A_EMAIL.toUpperCase()}','Guest Kid','6-12','Summer Morning Camp','awaiting_payment',NULL);
    INSERT INTO enrollments (id,created_at,parent_email,player_name,age_group,program,payment_status,account_id)
      VALUES ('${randomBytes(8).toString('hex')}','2026-02-02 10:00:00','${B_EMAIL}','Bees Kid','9-16',"Shredder's",'paid','${idB}');
    INSERT INTO enrollments (id,created_at,parent_email,player_name,age_group,program,payment_status,account_id)
      VALUES ('${randomBytes(8).toString('hex')}','2026-04-04 10:00:00','acctest-stranger@example.com','Nobodys Kid','6-12','Elite Academy','paid',NULL)`);

ok('GET /api/enrollments without cookie is 401', (await fetch(`${B}/api/enrollments`)).status === 401);

const histRes = await req('/api/enrollments', A);
ok('history sets Cache-Control: no-store',
   (histRes.headers.get('cache-control') ?? '').includes('no-store'),
   histRes.headers.get('cache-control'));

const histA = (await histRes.json()).enrollments ?? [];
ok('A sees both its own rows — linked and guest', histA.length === 2, JSON.stringify(histA));
// The guest row carries no account_id, so it can only have been matched on the
// email — and it was stored uppercased, which is what lower() is there for.
ok('a guest enrolment is matched by email, case-insensitively',
   histA.some((r) => r.player_name === 'Guest Kid'), JSON.stringify(histA.map((r) => r.player_name)));
ok('newest first', histA[0]?.program === 'Summer Morning Camp' && histA[1]?.program === 'Elite Academy',
   histA.map((r) => r.program).join(' | '));
ok('a row for a different email is not included',
   !histA.some((r) => r.player_name === 'Nobodys Kid'), JSON.stringify(histA.map((r) => r.player_name)));
ok('the fields the page needs are present',
   histA[0]?.age_group === '6-12' && histA[0]?.payment_status === 'awaiting_payment' && !!histA[0]?.created_at,
   JSON.stringify(histA[0]));
// Nothing here would be a leak — they are this parent's own details — but the
// row stays narrow so a future change to the matching rule has less to expose.
ok('nothing beyond that is returned',
   Object.keys(histA[0] ?? {}).sort().join(',') === 'age_group,created_at,payment_status,player_name,program',
   Object.keys(histA[0] ?? {}).join(','));

const histB = (await req('/api/enrollments', Bc).then((r) => r.json())).enrollments ?? [];
ok("account B sees only its own enrolment", histB.length === 1 && histB[0].player_name === 'Bees Kid',
   JSON.stringify(histB));

console.log('\n— cleanup —');
d1(`DELETE FROM enrollments WHERE lower(parent_email) LIKE 'acctest-%@example.com';
    DELETE FROM children WHERE account_id IN (SELECT id FROM accounts WHERE email LIKE 'acctest-%@example.com');
    DELETE FROM sessions WHERE account_id IN (SELECT id FROM accounts WHERE email LIKE 'acctest-%@example.com');
    DELETE FROM accounts WHERE email LIKE 'acctest-%@example.com';
    DELETE FROM login_tokens WHERE email LIKE 'acctest-%@example.com'`);
console.log('  test accounts removed');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
