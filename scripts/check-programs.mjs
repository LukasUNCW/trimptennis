// scripts/check-programs.mjs — run with: npm run check:programs
//
// Checks the five QuickBooks payment links in worker/programs.ts before they
// reach production. `npm run deploy` runs this first and refuses to deploy if
// anything is wrong.
//
// It is offline and reads no secrets: the point is to catch a bad paste, which
// is a text problem, not a QuickBooks one. Whether the link charges the right
// amount is something only a human opening it can tell — see the checklist in
// SETUP.md.
//
// IMPORTANT: Cloudflare's Git integration runs `wrangler deploy` directly, so a
// push to main does NOT run this. That is why worker/programs.ts re-checks at
// request time and treats an unusable link as a missing one.
//
// Imports the TypeScript module directly — Node strips the types.

import { PROGRAMS, payUrlProblem, isPayable, hasUnexpectedPayHost }
  from '../worker/programs.ts';

const entries = Object.entries(PROGRAMS);
const errors = [];
const warnings = [];

const pad = (s, n) => String(s).padEnd(n);
const w = Math.max(...entries.map(([slug]) => slug.length)) + 2;

console.log('\nProgram payment links — worker/programs.ts\n');

for (const [slug, p] of entries) {
  const problem = payUrlProblem(p);

  let state;
  if (problem) {
    state = `BROKEN    ${problem}`;
    errors.push(`${slug}: payUrl ${problem}`);
  } else if (p.payUrl === null) {
    // Not an error. Four of these being empty is the normal state right now, and
    // the site already handles it by showing "the office will follow up".
    state = 'not set   the office has not sent this link yet';
  } else {
    state = `ok        ${p.payUrl}`;
    if (hasUnexpectedPayHost(p)) {
      const host = new URL(p.payUrl).hostname;
      warnings.push(`${slug}: host "${host}" is not one payment links are expected on — open it and confirm it is really the QuickBooks payment page, then add the host to KNOWN_PAY_HOST in worker/programs.ts`);
    }
  }

  console.log(`  ${pad(slug, w)}${state}`);
  if (isPayable(p) !== (problem === null && p.payUrl !== null)) {
    // Guards the two helpers against drifting apart; they are used in different
    // places and disagreeing would mean the form offers payment the route then
    // refuses to deliver.
    errors.push(`${slug}: isPayable disagrees with payUrlProblem — that is a bug in programs.ts, not in the link`);
  }
}

const payable = entries.filter(([, p]) => isPayable(p)).length;
console.log(`\n  ${payable} of ${entries.length} programs can take payment.`);

for (const warning of warnings) console.log(`\n  WARNING  ${warning}`);

if (errors.length) {
  console.log('');
  for (const e of errors) console.log(`  ERROR    ${e}`);
  console.log(`\n${errors.length} problem${errors.length === 1 ? '' : 's'} — not safe to deploy.\n`);
  process.exit(1);
}

console.log(warnings.length ? '\nNo errors, but read the warning above.\n' : '\nNo problems.\n');
