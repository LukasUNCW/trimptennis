// scripts/check-programs.mjs — run with: npm run check:programs
//
// Checks the catalog in worker/programs.ts before it reaches production, one
// price option at a time. `npm run deploy` runs this first and refuses to deploy
// if anything is wrong.
//
// Since payment links were retired it mostly guards the QuickBooks item mapping:
// an option on sale with no item cannot be invoiced, and two options sharing an
// item makes revenue-by-program meaningless. It also warns about any static link
// pasted back in, which is a regression rather than a fix.
//
// Offline and reads no secrets. Whether an item of that name actually exists in
// QuickBooks is a question only QuickBooks can answer, and /qbo/verify-items
// answers it.
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
    // The finished state. Links were retired on 2026-08-05 once invoices were
    // proven; see the header of worker/programs.ts for why pasting one back is a
    // regression rather than a fix.
    state = 'retired   invoiced instead';
  } else {
    state = `ok        ${option.payUrl}`;
    if (hasUnexpectedPayHost(option)) {
      const host = new URL(option.payUrl).hostname;
      warnings.push(`${key}: host "${host}" is not one payment links are expected on — open it and confirm it really is the QuickBooks payment page, then add the host to KNOWN_PAY_HOST in worker/programs.ts`);
    }
  }

  console.log(`  ${pad(key, w)}${pad(price, 10)}${state}`);

  // Payable now means "an invoice can be raised" — a price to charge and an item
  // to book it to — or a valid legacy link. It used to mean only the second, and
  // this assertion is what caught the change.
  const invoiceable = option.qboItem !== null && typeof option.price === 'number';
  const linkable = option.payUrl !== null && problem === null;
  if (isPayable(option) !== (invoiceable || linkable)) {
    errors.push(`${key}: isPayable disagrees with the catalog — that is a bug in programs.ts`);
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

// ── QuickBooks items ──────────────────────────────────────────────────────
//
// Offline, like the rest of this script: whether an item of that name actually
// exists in QuickBooks is a question only QuickBooks can answer, and
// /qbo/verify-items answers it. What can be caught here is the catalog
// contradicting itself.

console.log('\nQuickBooks items — worker/programs.ts\n');

const byItem = new Map();
for (const r of rows) {
  const { key, program, option } = r;
  const enrollable = program.enrollable !== false;
  const priced = typeof option.price === 'number';

  console.log(`  ${pad(key, w)}${option.qboItem ?? '—'}`);

  if (option.qboItem === null) {
    // Fine while the option cannot be sold. Once it is both enrollable and
    // priced, a missing item means every enrolment silently falls back to the
    // old shared payment link and arrives in QuickBooks with no customer — the
    // exact problem the invoice flow exists to remove.
    if (enrollable && priced) {
      errors.push(`${key}: is on sale at $${option.price} but has no qboItem, so it cannot be invoiced`);
    }
    continue;
  }

  if (option.qboItem.trim() !== option.qboItem) {
    errors.push(`${key}: qboItem has leading or trailing whitespace, which will never match in QuickBooks`);
  }
  if (!byItem.has(option.qboItem)) byItem.set(option.qboItem, []);
  byItem.get(option.qboItem).push(key);
}

for (const [item, keys] of byItem) {
  if (keys.length > 1) {
    errors.push(`"${item}" is used by ${keys.join(' and ')} — two options billing to one item makes revenue-by-program meaningless`);
  }
}

const withItem = rows.filter((r) => r.option.qboItem !== null).length;
console.log(`\n  ${withItem} of ${rows.length} options are mapped to a QuickBooks item.`);
console.log('  Run /qbo/verify-items to confirm those names exist in QuickBooks.');

const payable = rows.filter((r) => isPayable(r.option)).length;
console.log(`\n  ${payable} of ${rows.length} options can be paid for.`);
for (const r of rows.filter((x) => x.option.payUrl !== null)) {
  warnings.push(`${r.key} still has a static payUrl. Links were retired once invoices were proven — a parent reaching one pays an amount that applies to no invoice, which is the problem invoices removed. See the header of worker/programs.ts.`);
}

for (const warning of warnings) console.log(`\n  WARNING  ${warning}`);

if (errors.length) {
  console.log('');
  for (const e of errors) console.log(`  ERROR    ${e}`);
  console.log(`\n${errors.length} problem${errors.length === 1 ? '' : 's'} — not safe to deploy.\n`);
  process.exit(1);
}

console.log(warnings.length ? '\nNo errors, but read the warning above.\n' : '\nNo problems.\n');
