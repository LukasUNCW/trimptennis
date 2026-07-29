// scripts/check-programs.mjs — run with: npm run check:programs
//
// Checks the QuickBooks payment links in worker/programs.ts before they reach
// production — one per price option, not one per program. `npm run deploy` runs
// this first and refuses to deploy if anything is wrong.
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

// Every option in the catalog, flattened — one payment link each.
const rows = entries.flatMap(([slug, p]) =>
  p.options.map((o) => ({ slug, program: p, option: o, key: `${slug}/${o.id}` })));

const pad = (s, n) => String(s).padEnd(n);
const w = Math.max(...rows.map((r) => r.key.length)) + 2;

console.log('\nPayment links — worker/programs.ts\n');

// Two options sharing a price would be indistinguishable at month end, because a
// multi-use QuickBooks link records no customer name and the amount is all the
// office has to go on. Cheap to check here, expensive to discover in a ledger.
const byPrice = new Map();
for (const r of rows) {
  if (typeof r.option.price !== 'number') continue;
  if (!byPrice.has(r.option.price)) byPrice.set(r.option.price, []);
  byPrice.get(r.option.price).push(r.key);
}

for (const r of rows) {
  const { key, program, option } = r;
  const problem = payUrlProblem(option);
  const price = typeof option.price === 'number' ? `$${option.price}` : 'unpriced';

  let state;
  if (problem) {
    state = `BROKEN    ${problem}`;
    errors.push(`${key}: payUrl ${problem}`);
  } else if (option.payUrl === null) {
    // Not an error. Every one being empty is the normal state right now, and the
    // site already handles it by showing "the office will follow up".
    state = 'not set   no link yet';
  } else {
    state = `ok        ${option.payUrl}`;
    if (hasUnexpectedPayHost(option)) {
      const host = new URL(option.payUrl).hostname;
      warnings.push(`${key}: host "${host}" is not one payment links are expected on — open it and confirm it really is the QuickBooks payment page, then add the host to KNOWN_PAY_HOST in worker/programs.ts`);
    }
  }

  console.log(`  ${pad(key, w)}${pad(price, 10)}${state}`);

  if (isPayable(option) !== (problem === null && option.payUrl !== null)) {
    // Guards the two helpers against drifting apart; they are used in different
    // places and disagreeing would mean the form offers payment the route then
    // refuses to deliver.
    errors.push(`${key}: isPayable disagrees with payUrlProblem — that is a bug in programs.ts, not in the link`);
  }
  if (!option.id || !option.label) {
    errors.push(`${key}: every option needs an id and a label`);
  }
}

for (const [price, keys] of byPrice) {
  if (keys.length > 1) {
    warnings.push(`$${price} is used by ${keys.join(' and ')} — a payment for that amount cannot be told apart at month end, because a multi-use link records no customer. Give them different prices if you can.`);
  }
}

for (const [slug, p] of entries) {
  if (!p.options?.length) errors.push(`${slug}: has no price options, so nobody can enrol`);
}

const payable = rows.filter((r) => isPayable(r.option)).length;
console.log(`\n  ${payable} of ${rows.length} payment links are set up.`);

for (const warning of warnings) console.log(`\n  WARNING  ${warning}`);

if (errors.length) {
  console.log('');
  for (const e of errors) console.log(`  ERROR    ${e}`);
  console.log(`\n${errors.length} problem${errors.length === 1 ? '' : 's'} — not safe to deploy.\n`);
  process.exit(1);
}

console.log(warnings.length ? '\nNo errors, but read the warning above.\n' : '\nNo problems.\n');
