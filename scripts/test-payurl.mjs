// scripts/test-payurl.mjs — run with: npm run test:payurl
//
// Checks the payment-link validation in worker/programs.ts. Unlike the other two
// suites this is entirely offline: no deploy, no database, no secrets. It exists
// because these rules are the only thing between a mis-pasted link and a parent
// being charged for the wrong program, and they are exactly the kind of regex
// somebody loosens later to make a stubborn URL go through.

import {
  payUrlError, findDuplicatePayUrls, payUrlProblem, isPayable, hasUnexpectedPayHost,
  lookupOption, isEnrollable, PROGRAMS
} from '../worker/programs.ts';

/** An option literal, so the tests below read as prices rather than plumbing. */
const opt = (payUrl, extra = {}) => ({ id: 'x', label: 'X', price: 1, payUrl, ...extra });

let pass = 0, fail = 0;

const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <- ' + extra : '')); }
};

// A plausible link. The real host is unknown until the office sends one — see
// KNOWN_PAY_HOST in worker/programs.ts — so this is only a shape, not a promise.
const GOOD = 'https://connect.intuit.com/pay/seahawks-tennis/groms-summer';

console.log('\n— a well-formed link is accepted —');
ok('a plausible QuickBooks link passes', payUrlError(GOOD) === null, payUrlError(GOOD));
ok('a query string is allowed', payUrlError(GOOD + '?ref=web') === null);

console.log('\n— the pastes that actually happen —');
const rejected = {
  'whitespace around it': `  ${GOOD} `,
  'quotes left attached': `"${GOOD}"`,
  'a space inside': 'https://connect.intuit.com/pay/seahawks tennis',
  'http rather than https': GOOD.replace('https:', 'http:'),
  'not a URL at all': 'ask Katie for the link',
  'an empty string': '',
  'the TODO placeholder': 'TODO',
  'a bare scheme': 'https://',
  'an example.com stand-in': 'https://example.com/pay/groms'
};
for (const [what, value] of Object.entries(rejected)) {
  ok(`rejects ${what}`, payUrlError(value) !== null, JSON.stringify(value));
}
// Not a string at all — only reachable by editing the file carelessly, but the
// runtime path must not throw on it.
ok('rejects a non-string without throwing', payUrlError(12345) !== null);
ok('rejects null without throwing', payUrlError(null) !== null);

console.log('\n— every rejection explains itself —');
// A message like "payUrl for Grom's is not a valid URL" is the whole point; a
// bare boolean would leave whoever pasted it guessing.
ok('the message names the problem',
   /whitespace/i.test(payUrlError(` ${GOOD}`) ?? ''), payUrlError(` ${GOOD}`));
ok('the placeholder message quotes what was found',
   (payUrlError('TODO') ?? '').includes('TODO'), payUrlError('TODO'));

console.log('\n— one link on two options (the expensive mistake) —');
// Now the mistake is worse than before: two options within ONE program sharing a
// link means a parent buying a $35 drop-in is charged $330 for a month.
const catalog = {
  shredders: {
    name: "Shredder's", ageGroups: ['9-16'],
    options: [
      { id: '8x', label: '8 / month', price: 240, payUrl: GOOD },
      { id: 'drop-in', label: 'Drop-in', price: 35, payUrl: GOOD },
      { id: '12x', label: '12 / month', price: 330, payUrl: GOOD + '-12x' }
    ]
  },
  adult: { name: 'Adult Programs', ageGroups: ['Adult'], options: [opt(null)] }
};
const dupes = findDuplicatePayUrls(catalog);
ok('a link shared by two options is flagged', dupes.has(GOOD), [...dupes].join(','));
ok('the unique link is not flagged', !dupes.has(GOOD + '-12x'));
ok('unset links are not duplicates of each other',
   !findDuplicatePayUrls({ a: { options: [opt(null), opt(null)] } }).size);
ok('a program with no options does not throw',
   findDuplicatePayUrls({ a: { name: 'X' } }) instanceof Set);

console.log('\n— an unset link is not an error —');
ok('a null payUrl reports no problem', payUrlProblem(opt(null)) === null);
ok('but is not payable either', isPayable(opt(null)) === false);
ok('a good link is payable', isPayable(opt(GOOD)) === true);
ok('a broken link is not payable', isPayable(opt('nonsense')) === false);

console.log('\n— host check warns, never blocks —');
const offHost = opt('https://pay.example-processor.com/abc');
ok('an unfamiliar host is only a warning', hasUnexpectedPayHost(offHost) === true);
// The whole reason the host list is advisory: Intuit lets the URL be customised,
// so a wrong guess here must not be able to stop payment.
ok('and does not make the option unpayable', isPayable(offHost) === true);
ok('an intuit.com host raises no warning', hasUnexpectedPayHost(opt(GOOD)) === false);
ok('a broken link raises no host warning on top', hasUnexpectedPayHost(opt('nonsense')) === false);

console.log('\n— resolving which option was asked for —');
const shred = catalog.shredders;
const single = { name: 'Grom\'s', ageGroups: ['6-12'], options: [{ id: 'standard', label: '10 classes', price: 250, payUrl: null }] };
ok('a named option resolves', lookupOption(shred, 'drop-in')?.id === 'drop-in');
ok('an unknown id is refused, not guessed', lookupOption(shred, 'nope') === null);
// The important one: never pick a price on the parent's behalf when there is a
// real choice, or somebody wanting a $35 drop-in gets charged $330.
ok('a missing id is refused when there is a choice', lookupOption(shred, undefined) === null);
ok('an empty id is refused when there is a choice', lookupOption(shred, '') === null);
ok('a non-string id is refused', lookupOption(shred, 42) === null);
ok('a single-option program resolves without an id',
   lookupOption(single, undefined)?.id === 'standard');
ok('a single-option program still refuses a wrong id', lookupOption(single, 'drop-in') === null);

console.log('\n— the real catalog —');
const allOptions = Object.values(PROGRAMS).flatMap((p) => p.options);
ok('every program has at least one option',
   Object.values(PROGRAMS).every((p) => p.options.length >= 1));
ok('every option has a stable id and a label',
   allOptions.every((o) => o.id && o.label));
ok('option ids are unique within each program',
   Object.values(PROGRAMS).every((p) => new Set(p.options.map((o) => o.id)).size === p.options.length));
// Distinct prices are what make a nameless payment identifiable at month end.
const priced = allOptions.map((o) => o.price).filter((p) => typeof p === 'number');
ok('no two priced options share an amount', new Set(priced).size === priced.length,
   priced.join(','));
console.log('\n— a cancelled season is not sellable —');
// Camp was pulled 2026-07-29: the remaining August weeks did not fill. It stays
// in the catalog so a parent's past enrolment still resolves to a readable label,
// but nothing may be sold.
ok('summer camp is not enrollable', isEnrollable(PROGRAMS['summer-camp']) === false);
ok('every other program is', ['groms', 'shredders', 'elite', 'adult']
   .every((s) => isEnrollable(PROGRAMS[s]) === true));
ok('an absent flag means enrollable', isEnrollable({ options: [] }) === true);
ok('camp is still in the catalog, so old rows keep their labels',
   PROGRAMS['summer-camp'].options.some((o) => o.id === 'week' && o.label));

// Elite sells memberships and drop-ins; only the memberships lead to auto draft.
const eliteDropIn = PROGRAMS.elite.options.find((o) => o.id === 'drop-in');
ok('an Elite drop-in does not promise an auto draft',
   eliteDropIn && eliteDropIn.autoDraftAfterFirstMonth !== true);
ok('Elite memberships do', PROGRAMS.elite.options
   .filter((o) => o.id.endsWith('-month')).every((o) => o.autoDraftAfterFirstMonth === true));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
