// scripts/test-payurl.mjs — run with: npm run test:payurl
//
// Checks the payment-link validation in worker/programs.ts. Unlike the other two
// suites this is entirely offline: no deploy, no database, no secrets. It exists
// because these rules are the only thing between a mis-pasted link and a parent
// being charged for the wrong program, and they are exactly the kind of regex
// somebody loosens later to make a stubborn URL go through.

import { payUrlError, findDuplicatePayUrls, payUrlProblem, isPayable, hasUnexpectedPayHost }
  from '../worker/programs.ts';

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

console.log('\n— one link on two programs (the expensive mistake) —');
const catalog = {
  groms:      { name: "Grom's",       ageGroups: ['6-12'],  payUrl: GOOD },
  elite:      { name: 'Elite Academy', ageGroups: ['10-18'], payUrl: GOOD },
  shredders:  { name: "Shredder's",   ageGroups: ['9-16'],  payUrl: GOOD + '-shredders' },
  unset:      { name: 'Adult Programs', ageGroups: ['Adult'], payUrl: null }
};
const dupes = findDuplicatePayUrls(catalog);
ok('the shared link is flagged', dupes.has(GOOD), [...dupes].join(','));
ok('the unique link is not flagged', !dupes.has(GOOD + '-shredders'));
ok('two unset programs are not a duplicate of each other',
   !findDuplicatePayUrls({ a: { payUrl: null }, b: { payUrl: null } }).size);

console.log('\n— an unset link is not an error —');
const unset = { name: 'Adult Programs', ageGroups: ['Adult'], payUrl: null };
ok('a null payUrl reports no problem', payUrlProblem(unset) === null);
ok('but is not payable either', isPayable(unset) === false);
ok('a good link is payable', isPayable({ name: 'X', ageGroups: [], payUrl: GOOD }) === true);
ok('a broken link is not payable',
   isPayable({ name: 'X', ageGroups: [], payUrl: 'nonsense' }) === false);

console.log('\n— host check warns, never blocks —');
const offHost = { name: 'X', ageGroups: [], payUrl: 'https://pay.example-processor.com/abc' };
ok('an unfamiliar host is only a warning', hasUnexpectedPayHost(offHost) === true);
// The whole reason the host list is advisory: Intuit lets the URL be customised,
// so a wrong guess here must not be able to stop payment.
ok('and does not make the program unpayable', isPayable(offHost) === true);
ok('an intuit.com host raises no warning',
   hasUnexpectedPayHost({ name: 'X', ageGroups: [], payUrl: GOOD }) === false);
ok('a broken link raises no host warning on top',
   hasUnexpectedPayHost({ name: 'X', ageGroups: [], payUrl: 'nonsense' }) === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
