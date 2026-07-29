// scripts/check-prices.mjs — run with: npm run check:prices
//
// Opens every QuickBooks payment link in worker/programs.ts and checks that the
// page charges what the site says it charges, and that it belongs to the program
// it is filed under.
//
// SETUP.md used to say this could not be automated: the site displays `price` from
// the catalog while QuickBooks charges whatever is inside the link, so a link
// created for the wrong amount looks perfectly fine on the site. It turns out
// Intuit renders both the amount and the item name into the page HTML, so both are
// checkable — which catches the two mistakes that cost real money:
//
//   1. a link built for the wrong amount
//   2. a link pasted onto the wrong option
//
// A GET on a payment page charges nothing; it is exactly what a parent's browser
// does on arrival. Nothing is submitted.
//
// NOT wired into `npm run deploy`, deliberately: it depends on Intuit being
// reachable, and a network blip must not be able to block a deploy. Run it
// whenever a link changes, and before going live.

import { PROGRAMS } from '../worker/programs.ts';

let pass = 0, fail = 0, warn = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <- ' + extra : '')); }
};

// First word of the program name, minus any possessive: Grom's -> Grom,
// Shredder's -> Shredder, Elite Academy -> Elite. Derived rather than kept in a
// table here, so renaming a program in the catalog cannot leave this stale.
const keyword = (name) => name.split(/[\s'’]/)[0];

const rows = Object.entries(PROGRAMS).flatMap(([slug, p]) =>
  p.options.map((o) => ({ key: `${slug}/${o.id}`, program: p, option: o })));

const live = rows.filter((r) => r.option.payUrl);
const allKeywords = [...new Set(Object.values(PROGRAMS).map((p) => keyword(p.name)))];

console.log(`\nChecking ${live.length} of ${rows.length} payment links against QuickBooks\n`);

if (!live.length) {
  console.log('  No links set yet — nothing to check.\n');
  process.exit(0);
}

for (const { key, program, option } of live) {
  let res, body;
  try {
    res = await fetch(option.payUrl, { redirect: 'follow' });
    body = await res.text();
  } catch (err) {
    ok(`${key} loads`, false, err.message);
    continue;
  }

  console.log(`  ${key}`);
  ok(`  page loads (HTTP ${res.status})`, res.status === 200, String(res.status));
  ok('  served by connect.intuit.com',
     new URL(res.url).hostname === 'connect.intuit.com', new URL(res.url).hostname);

  // The amount, as QuickBooks will charge it — not as our catalog claims.
  const found = [...new Set(body.match(/\$\s?[\d,]+\.\d{2}/g) ?? [])];
  const expected = `$${option.price}.00`;
  ok(`  charges ${expected}`, found.includes(expected),
     found.length ? `page shows ${found.join(' ')}` : 'no amount found in the page');

  // Right program. Catches a link pasted onto the wrong option even if two
  // options ever shared a price.
  const mine = keyword(program.name);
  ok(`  page mentions "${mine}"`, body.includes(mine), 'the item may be filed under another program');

  const strangers = allKeywords.filter((k) => k !== mine && body.includes(k));
  if (strangers.length) {
    warn++;
    console.log(`  WARN    page also mentions ${strangers.join(', ')} — check it is the right item`);
  }
}

// Distinct amounts are what make a nameless payment identifiable at month end,
// since a multi-use link records no customer.
const prices = live.map((r) => r.option.price);
ok('every live link has a distinct amount', new Set(prices).size === prices.length,
   prices.join(','));
const urls = live.map((r) => r.option.payUrl);
ok('no link is used twice', new Set(urls).size === urls.length);

console.log(`\n${pass} passed, ${fail} failed${warn ? `, ${warn} warning(s)` : ''}\n`);
process.exit(fail ? 1 : 0);
