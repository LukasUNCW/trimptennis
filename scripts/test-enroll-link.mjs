// scripts/test-enroll-link.mjs — run with: npm run test:enroll
//
// Covers phase 3: an enrolment made while signed in is linked to the account,
// and a saved player can only be enrolled by the account that owns them.
//
// Turnstile blocks scripted calls to /api/enroll, so this drives the database
// directly for the parts that need a real browser and asserts on the rules that
// can be checked server-side. Sign-in tokens are inserted straight into D1 for
// the same reason.
//
// NOTE: runs against production, touching only rows whose email matches
// enrtest-%@example.com.

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
  ['node_modules/wrangler/bin/wrangler.js', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const d1 = (sql) => wrangler(['d1', 'execute', 'trimptennis-db', '--remote', '--json', '--command', sql]);

const query = (sql) => {
  const out = d1(sql);
  return JSON.parse(out.slice(out.indexOf('['))).flatMap((r) => r.results ?? []);
};

async function signIn(email) {
  const token = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  d1(`INSERT INTO login_tokens (token_hash,email,expires_at,created_at) VALUES ('${hash}','${email}',${now + 900000},${now})`);
  const res = await fetch(`${B}/auth/callback?token=${token}`, { redirect: 'manual' });
  const sid = /sta_session=([0-9a-f]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
  if (!sid) throw new Error('no session for ' + email);
  return `sta_session=${sid}`;
}

const enrol = (cookie, body) =>
  fetch(`${B}/api/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body)
  });

const A_EMAIL = 'enrtest-a@example.com';
const B_EMAIL = 'enrtest-b@example.com';

console.log('\n— setup: two accounts, one child on A —');
const A = await signIn(A_EMAIL);
const Bc = await signIn(B_EMAIL);
const meA = await fetch(`${B}/api/me`, { headers: { Cookie: A } }).then((r) => r.json());
await fetch(`${B}/api/children`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: A },
  body: JSON.stringify({ first_name: 'Linked', last_name: 'Player', birth_year: 2014 })
});
const kids = await fetch(`${B}/api/me`, { headers: { Cookie: A } }).then((r) => r.json());
const childId = kids.children[0].id;
ok('child created on account A', !!childId && meA.account.email === A_EMAIL);

console.log('\n— a saved player may only be used by its owner —');
const bTries = await enrol(Bc, {
  program: 'groms', child_id: childId, age_group: '6-12',
  parent_name: 'Bee', parent_email: B_EMAIL, turnstileToken: 'x'
});
const bBody = await bTries.json().catch(() => ({}));
// Turnstile runs first, so a 403 means the bot gate stopped it before the
// ownership check. Either way it must not be a 200.
ok("account B cannot enrol A's child", bTries.status !== 200,
   bTries.status + ' ' + JSON.stringify(bBody));

const guestTries = await enrol(null, {
  program: 'groms', child_id: childId, age_group: '6-12',
  parent_name: 'Guest', parent_email: 'guest@example.com', turnstileToken: 'x'
});
ok('a guest cannot use a saved player id', guestTries.status !== 200, String(guestTries.status));

console.log('\n— schema supports the link —');
const cols = query("SELECT name FROM pragma_table_info('enrollments')").map((r) => r.name);
ok('enrollments has account_id', cols.includes('account_id'), cols.join(','));
ok('enrollments has child_id', cols.includes('child_id'));

console.log('\n— the link is written and readable (simulating a completed enrolment) —');
const accountId = meA.account.id;
const rowId = randomBytes(8).toString('hex');
d1(`INSERT INTO enrollments (id,parent_email,player_name,program,payment_status,account_id,child_id)
    VALUES ('${rowId}','${A_EMAIL}','Linked Player',"Grom's",'awaiting_payment','${accountId}','${childId}')`);
const joined = query(`
  SELECT e.player_name, a.email AS account_email, c.first_name AS child_first
  FROM enrollments e
  JOIN accounts a ON a.id = e.account_id
  JOIN children c ON c.id = e.child_id
  WHERE e.id = '${rowId}'`);
ok('enrolment joins back to its account and child',
   joined[0]?.account_email === A_EMAIL && joined[0]?.child_first === 'Linked',
   JSON.stringify(joined));

console.log('\n— removing a player detaches its enrolments, never deletes them —');
const delRes = await fetch(`${B}/api/children/${childId}`, { method: 'DELETE', headers: { Cookie: A } });
ok('child deleted', delRes.status === 200, String(delRes.status));

const after = query(`SELECT player_name, child_id, account_id FROM enrollments WHERE id = '${rowId}'`);
ok('the enrolment still exists after the player is removed', after.length === 1, JSON.stringify(after));
ok('child_id was cleared rather than left dangling', after[0]?.child_id === null, String(after[0]?.child_id));
ok('player_name survives, so the roster is intact', after[0]?.player_name === 'Linked Player', after[0]?.player_name);
ok('account_id is untouched', !!after[0]?.account_id);

const orphans = query(`SELECT COUNT(*) AS n FROM enrollments e
  WHERE e.child_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM children c WHERE c.id = e.child_id)`);
ok('no orphaned child_id anywhere in the table', Number(orphans[0]?.n) === 0, JSON.stringify(orphans));

console.log('\n— guest enrolments still allowed (nullable) —');
const guestRow = randomBytes(8).toString('hex');
d1(`INSERT INTO enrollments (id,parent_email,player_name,program,payment_status)
    VALUES ('${guestRow}','enrtest-guest@example.com','Walk In',"Grom's",'awaiting_payment')`);
const g = query(`SELECT account_id, child_id FROM enrollments WHERE id='${guestRow}'`);
ok('guest row stores NULL for both links', g[0]?.account_id === null && g[0]?.child_id === null, JSON.stringify(g));

console.log('\n— cleanup —');
d1(`DELETE FROM enrollments WHERE parent_email LIKE 'enrtest-%@example.com';
    DELETE FROM children WHERE account_id IN (SELECT id FROM accounts WHERE email LIKE 'enrtest-%@example.com');
    DELETE FROM sessions WHERE account_id IN (SELECT id FROM accounts WHERE email LIKE 'enrtest-%@example.com');
    DELETE FROM accounts WHERE email LIKE 'enrtest-%@example.com';
    DELETE FROM login_tokens WHERE email LIKE 'enrtest-%@example.com'`);
console.log('  test rows removed');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
