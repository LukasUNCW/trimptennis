// scripts/test-links.mjs — run with: npm run test:links
//
// Checks the deployed pages for buttons that go nowhere, and that the free-trial
// path is wired up.
//
// This exists because the homepage advertised a free trial in two places — the
// hero's primary call to action and a whole section — and both were href="#" for
// as long as the site had been live. The server side supported free-trial
// requests the whole time; nothing reached it. A dead primary CTA is invisible in
// code review and costs real signups, so it is worth a test rather than a habit.
//
// Fetches the deployed site. No database, no secrets.

const B = 'https://trimptennis.lukas-nilsson4321.workers.dev';
const PAGES = ['/', '/juniors', '/elite', '/adults', '/contact', '/login'];

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <- ' + extra : '')); }
};

const html = {};
for (const p of PAGES) {
  const res = await fetch(B + p);
  html[p] = await res.text();
  if (res.status !== 200) ok(`${p} loads`, false, String(res.status));
}

console.log('\n— no button goes nowhere —');
// An <a class="btn ..."> with href="#" is a dead button, UNLESS it carries
// data-enroll: those are opened by enroll.js, and the href is only a fallback.
const DEAD_BTN = /<a[^>]*class="[^"]*\bbtn\b[^"]*"[^>]*href="#"[^>]*>/g;
for (const p of PAGES) {
  const dead = (html[p].match(DEAD_BTN) ?? []).filter((tag) => !tag.includes('data-enroll'));
  ok(`${p} has no dead buttons`, dead.length === 0, dead.join(' | '));
}

console.log('\n— the free trial is reachable —');
const trialLinks = (html['/'].match(/href="\/contact\?trial=1"/g) ?? []).length;
// The hero CTA and the "first clinic is on us" section — both of which were dead
// links — plus the announcement bar, which took over the trial once summer camp
// was pulled. A floor rather than an exact count: the number is a marketing
// decision, and "no dead buttons" above is what actually guards the wiring.
ok('the homepage links to the trial form at least twice', trialLinks >= 2, String(trialLinks));
ok('the contact page has a trial mode', html['/contact'].includes("get('trial')"));
ok('trial mode posts kind free_trial', html['/contact'].includes("'free_trial'"));
ok("trial mode asks for the child's name and age",
   html['/contact'].includes('cf-player') && html['/contact'].includes('cf-age'));
ok('the trial URL serves the contact page',
   (await fetch(`${B}/contact?trial=1`)).status === 200);

console.log('\n— nothing sells summer camp —');
// Camp was pulled on 2026-07-29 for lack of numbers. The homepage banner used to
// say "enrollment is live" with a Save a spot button, and /juniors listed two
// August weeks at $350 with a working Enroll button. Advertising a cancelled
// programme is the one failure here that costs someone money and trust.
for (const p of PAGES) {
  ok(`${p} has no camp enrol button`, !html[p].includes('data-enroll="summer-camp"'),
     'a Save a spot / Enroll in summer camp button is back');
}
ok('/juniors no longer lists camp dates',
   !/August · 5 days/.test(html['/juniors']) && !/\$350/.test(html['/juniors']),
   'dated camp sessions or the $350 price are back on the page');
ok('the catalog refuses camp signups',
   (await (await fetch(B + '/api/programs')).json())
     .find((p) => p.slug === 'summer-camp')?.enrollable === false);
// Kept listed rather than deleted, so a past enrolment still resolves its label.
ok('camp is still in the catalog',
   !!(await (await fetch(B + '/api/programs')).json()).find((p) => p.slug === 'summer-camp'));

console.log('\n— every page has the favicon —');
// Easy to add to six pages and forget the seventh, and the symptom is a generic
// icon on one tab that nobody notices.
for (const p of PAGES) {
  ok(`${p} declares the icon`,
     html[p].includes('rel="icon" href="images/uncw-logo.svg"')
     && html[p].includes('images/favicon-32.png')
     && html[p].includes('rel="apple-touch-icon"'));
}
for (const f of ['/images/uncw-logo.svg', '/images/favicon-32.png', '/images/apple-touch-icon.png']) {
  const res = await fetch(B + f);
  ok(`${f} is served`, res.status === 200, String(res.status));
}

console.log('\n— footers agree with each other —');
for (const p of PAGES) {
  if (!html[p].includes('Summer camp')) continue;
  ok(`${p} points summer camp at the section`,
     html[p].includes('/juniors#summer-camp'));
}
// These drifted once: the contact page footer advertised Grom's as 6-10 and
// Shredder's as 11-16 while every other page said 6-12 and 9-16.
for (const p of PAGES) {
  if (!/Grom's \(/.test(html[p])) continue;
  ok(`${p} states the junior age ranges correctly`,
     html[p].includes("Grom's (6–12)") && html[p].includes("Shredder's (9–16)"),
     (html[p].match(/(Grom's|Shredder's) \([^)]*\)/g) ?? []).join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
