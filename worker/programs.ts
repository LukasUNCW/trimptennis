// worker/programs.ts
// Program catalog — the single place that knows what's enrollable, what it
// costs, and which QuickBooks item it books to.
//
// HOW PAYMENT WORKS NOW. An enrolment raises a real invoice against a real
// customer in the academy's QuickBooks, and the parent is sent to that
// invoice's own pay page. See docs/QBO-INTEGRATION.md.
//
// Every payUrl is null, and that is the finished state rather than an unfinished
// one. They used to hold multi-use QuickBooks payment links, which carried their
// amount inside the URL and could say nothing about who was paying — so money
// arrived as an anonymous figure that somebody had to attribute by hand. They
// were retired on 2026-08-05, once a real card payment had been watched landing
// on a real invoice.
//
// DO NOT paste them back in to "fix" a QuickBooks outage. A parent reaching a
// shared link pays an amount that applies to no invoice, which is the precise
// problem this replaced. If invoices cannot be raised, the right answer is the
// one the site already gives: record the enrolment, tell the parent the office
// will follow up, and email the office to say so.
//
// The link machinery below stays because it still guards anything ever pasted
// back deliberately, and because npm run check:programs uses it.

export interface PriceOption {
  /**
   * Submitted by the form and stored on the enrollment row, so it must stay
   * stable — changing an id orphans the meaning of rows already written.
   */
  id: string;
  /** Customer-facing, shown in the enrol dialog next to the price. */
  label: string;
  /**
   * Whole dollars, for DISPLAY only.
   *
   * QuickBooks is authoritative: the real amount is whatever the payment link
   * charges, and nothing here can verify it. So a link created for the wrong
   * amount shows the right price on the site and charges a different one, and no
   * automated check will catch it — only a human opening the link. That is why
   * SETUP.md's checklist says to read the amount off the QuickBooks page.
   *
   * null means "not priced yet" — the page says to ask the office.
   */
  price: number | null;
  /** QuickBooks multi-use payment link, or null until Katie creates it. */
  payUrl: string | null;
  /**
   * Name of the QuickBooks Item this option bills against, matched EXACTLY.
   *
   * A name rather than an id, because ids are assigned per company file and
   * every id read off the sandbox is wrong against the academy's real books.
   *
   * Exact means exact: QuickBooks' query language has no fuzzy match, so any
   * difference in spacing or punctuation is a different item and the lookup
   * fails.
   *
   * These are the academy's OWN item names, not ones invented here. Their
   * company file already tracked every program, and creating a parallel set
   * would split each program across two lines in every report depending on
   * whether the sale came through the site or the office invoiced it by hand.
   * Their names win, however they are punctuated.
   *
   * So do not tidy these. "Shredder's 8x/mo." is not a typo, and neither is the
   * missing apostrophe in "Groms Tennis". `/qbo/verify-items` reports anything
   * that does not resolve, so a mismatch is caught by us rather than by a parent
   * mid-enrollment.
   *
   * null for an option nobody can buy yet.
   */
  qboItem: string | null;
  /**
   * This option buys the FIRST MONTH of a membership; the office sets up auto
   * draft in QuickBooks afterwards, so the enrollment email has to say so or the
   * follow-up gets forgotten.
   *
   * Lives on the option rather than the program because Elite sells both
   * memberships and drop-ins: a drop-in is a one-off, and telling that player to
   * expect an auto draft would be wrong.
   */
  autoDraftAfterFirstMonth?: boolean;
}

export interface Program {
  /** Customer-facing name; also what we store on the enrollment row. */
  name: string;
  /** Valid age_group values for this program. */
  ageGroups: string[];
  /** At least one. A program with a single option needs no choice from the parent. */
  options: PriceOption[];
  /**
   * Adult programs: the person signing up IS the player, so no guardian is
   * collected and the form asks for their own name. parent_name stays null on
   * these rows; parent_email is still the contact address.
   */
  selfEnroll?: boolean;
  /**
   * The parent chooses which weekdays their child attends, and each weekday is a
   * separate class with its own cap. Grom's runs Monday to Thursday.
   *
   * Days drive both capacity and price. Each weekday is its own eight week
   * session at its own $200, so picking two days is two sessions and $400. See
   * priceIsPerDay, and charge through priceFor() rather than option.price.
   *
   * The days themselves live in the program_sessions table rather than in this
   * file, because a cancelled Wednesday or a cap moving to 20 is a fact about
   * the season that should not need a deploy.
   */
  picksDays?: boolean;
  /**
   * `price` on each option is PER DAY, not the total. A parent picking Monday and
   * Wednesday owes twice it.
   *
   * John Trimp, 2026-08-05: "$200 for an 8 week session, if you want two days a
   * week, must sign up for two sessions = 2 x 200 = 400." Each weekday is its own
   * eight week session that happens to be sold through one form.
   *
   * Only meaningful alongside picksDays: without days to count there is nothing
   * to multiply. Everything that charges or displays money has to go through
   * priceFor(), never straight to option.price, or a four day child gets billed
   * for one.
   */
  priceIsPerDay?: boolean;
  /**
   * False when the program exists but is not currently taking signups — a season
   * that has finished, or one cancelled for lack of numbers.
   *
   * The program stays in the catalog rather than being deleted, for two reasons:
   * enrolments already taken store the option id, and the account page resolves
   * that id to a readable label through this catalog, so removing the entry would
   * turn a parent's history into raw ids. And it comes back next season by
   * flipping one flag rather than rewriting the file from memory.
   *
   * Absent means enrollable. Only ever set it to false explicitly.
   */
  enrollable?: boolean;
}

// Age ranges match the academy's own programme pages, which overlap
// deliberately: a 10-year-old could be in either Grom's or Shredder's depending
// on whether they can rally and keep score.
//
// Prices are Katie's list of 2026-07-29. Every amount is deliberately DISTINCT:
// multi-use payment links record no customer, so at month end the amount is the
// office's main clue about what a payment was for, and two options sharing a
// price would be indistinguishable. Keep it that way when Adult gets priced.
export const PROGRAMS: Record<string, Program> = {
  groms: {
    name: "Grom's",
    ageGroups: ['6-12'],
    picksDays: true,
    priceIsPerDay: true,
    options: [
      // $200 buys ONE weekday for the eight week session. Two days is two
      // sessions and $400. See priceIsPerDay.
      { id: 'standard', label: '8 week session', price: 200, qboItem: "Groms Tennis", payUrl: null }
    ]
  },
  shredders: {
    name: "Shredder's",
    ageGroups: ['9-16'],
    options: [
      { id: '8x-month',  label: '8 classes / month',  price: 240, qboItem: "Shredder's 8x/mo.", payUrl: null },
      { id: '12x-month', label: '12 classes / month', price: 330, qboItem: "Shredder's 12x/mo.", payUrl: null },
      { id: 'drop-in',   label: 'Drop-in',            price: 35,  qboItem: "Shredder's drop in", payUrl: null }
    ]
  },
  'summer-camp': {
    name: 'Summer Morning Camp',
    // Camp takes 7-18, wider at the top than either clinic and starting a year
    // later at the bottom. Both ends had to be handled: without '13-18' a 16- or
    // 17-year-old had no group to choose and /api/enroll rejected them, and
    // borrowing Grom's '6-12' let a 6-year-old sign up for a camp starting at 7.
    // NEEDS CONFIRMING with the office — these are the bands they read off rows.
    ageGroups: ['7-12', '9-16', '13-18'],
    // Off, on Katie's instruction of 2026-07-29: the two remaining August weeks
    // are being cancelled for lack of numbers, so nothing should be sold and the
    // dates must not stay on the page. Set this back to true — and put next
    // season's dates and price on /juniors — when camp runs again.
    enrollable: false,
    options: [
      // $350 was the 5-day week price on the academy's own camp page. Kept as a
      // record of what was last charged; not offered while enrollable is false.
      { id: 'week', label: '5-day week', price: 350, qboItem: null, payUrl: null }
    ]
  },
  elite: {
    name: 'Elite Academy',
    ageGroups: ['10-18'],
    options: [
      { id: '8x-month',  label: '8 classes / month — first month',  price: 320, qboItem: 'Elite Academy 8x/mo. -First Month', payUrl: null, autoDraftAfterFirstMonth: true },
      { id: '12x-month', label: '12 classes / month — first month', price: 420, qboItem: 'Elite Academy 12x/mo. -First Month', payUrl: null, autoDraftAfterFirstMonth: true },
      // Deliberately no auto-draft follow-up: a drop-in is not a first month.
      // Katie: "a stand alone thing... when they know they are coming to class
      // they can click on the link and pay".
      { id: 'drop-in',   label: 'Drop-in',                          price: 45,  qboItem: 'Elite Academy Drop In Class', payUrl: null }
    ]
  },
  adult: {
    name: 'Adult Programs',
    ageGroups: ['Adult'],
    // Unpriced: the academy's old site publishes no adult rates, so /adults says
    // to ask. price stays null until Katie sets one, and the option exists so
    // adults can still enrol and be followed up by phone.
    options: [
      { id: 'standard', label: 'Adult programs', price: null, qboItem: null, payUrl: null }
    ],
    selfEnroll: true
  }
};

export const lookupProgram = (slug: unknown): Program | null =>
  typeof slug === 'string' && Object.hasOwn(PROGRAMS, slug) ? PROGRAMS[slug] : null;

/**
 * What to actually charge, given how many days were chosen.
 *
 * The single place that knows whether a price is a total or a unit. Every
 * caller that shows money or bills for it goes through here: the enrol dialog,
 * the review panel, the roster, the invoice. Reading option.price directly is
 * how a four day Grom's child gets billed $200 instead of $800.
 *
 * dayCount is ignored for everything except a per-day program, so callers do
 * not have to know which is which.
 */
export function priceFor(p: Program, o: PriceOption, dayCount: number): number | null {
  if (typeof o.price !== 'number') return null;
  if (!p.priceIsPerDay) return o.price;
  // Zero days is refused at /api/enroll long before this, but returning the
  // unit price here would quietly make a broken request look like a $200 sale.
  return dayCount > 0 ? o.price * dayCount : null;
}

/** Whether this program is currently taking signups. Absent flag means yes. */
export const isEnrollable = (p: Program): boolean => p.enrollable !== false;

/**
 * Resolves the option a request asked for.
 *
 * A program with exactly one option needs no choice, so an absent id resolves to
 * it — that keeps a single-price program working without the form having to send
 * anything. Where there is a real choice, an absent or unknown id is an error
 * rather than a guess: picking a price on the parent's behalf could charge them
 * $330 when they wanted $35.
 */
export function lookupOption(program: Program, id: unknown): PriceOption | null {
  if (id === undefined || id === null || id === '') {
    return program.options.length === 1 ? program.options[0] : null;
  }
  return typeof id === 'string' ? program.options.find((o) => o.id === id) ?? null : null;
}

// ── checking a pasted payUrl ──────────────────────────────────────────────
//
// These links are created by hand in QuickBooks and pasted into the catalog
// above, and every plausible slip is silent. Quotes left attached, a dashboard
// URL copied instead of a payment link, http instead of https — and the
// expensive one, the same link pasted onto two options, so a parent buying a $35
// drop-in is charged $330 for a month. Nothing downstream would notice; the
// enrollment row looks perfect and QuickBooks shows a payment for the wrong
// thing.
//
// Checked in two places because there are two ways to deploy:
// `npm run check:programs`, which `npm run deploy` runs first, and the enrol
// route at request time — because Cloudflare's Git integration runs `wrangler
// deploy` directly and never runs that script.

/**
 * Hosts a QuickBooks payment link is expected on. Deliberately NOT enforced:
 * Intuit lets the link's URL be customised, so this list cannot be assumed
 * complete, and rejecting an unrecognised host would let a link the office
 * legitimately created stop payment dead — much worse than the mistake being
 * guarded against. An unfamiliar host is reported as a warning to be eyeballed.
 * Once the first real link arrives, add its host here so the warning goes quiet.
 */
const KNOWN_PAY_HOST = /(^|\.)intuit\.com$/i;

/** Values that mean "not filled in yet" but are not null. */
const PLACEHOLDERS = /^(todo|tbd|xxx|https?:\/\/)$/i;

/**
 * A hard problem with one pasted URL, or null when it looks usable. Pure: no
 * logging and no network, so the pre-deploy script and the request path agree.
 */
export function payUrlError(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'is not a string';
  if (raw !== raw.trim()) return 'has whitespace around it';
  if (!raw) return 'is empty — use null rather than an empty string';
  if (PLACEHOLDERS.test(raw)) return `is still the placeholder "${raw}"`;
  if (/["'<>]/.test(raw)) return 'still has quotes or angle brackets around it';
  if (/\s/.test(raw)) return 'contains a space';

  let url: URL;
  try { url = new URL(raw); } catch { return 'is not a valid URL'; }

  if (url.protocol !== 'https:') return `is ${url.protocol}// rather than https://`;
  // A card number typed into a plain http page is the one outcome worth being
  // absolute about, hence the check above being an error and this one not.
  if (/(^|\.)example\.(com|org|net)$/i.test(url.hostname)) return 'points at example.com';
  return null;
}

/**
 * payUrls appearing on more than one option, anywhere in the catalog. Takes the
 * catalog as an argument rather than closing over PROGRAMS so it can be checked
 * against a fabricated one — every real link is null today, so a duplicate is
 * not reproducible from the real catalog.
 */
export function findDuplicatePayUrls(programs: Record<string, Program>): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const p of Object.values(programs)) {
    for (const o of p.options ?? []) {
      if (o.payUrl === null) continue;
      if (seen.has(o.payUrl)) dupes.add(o.payUrl);
      seen.add(o.payUrl);
    }
  }
  return dupes;
}

// Computed once: PROGRAMS is a static table in this file, not runtime state.
const DUPLICATE_PAY_URLS: ReadonlySet<string> = findDuplicatePayUrls(PROGRAMS);

/**
 * Why this option's link cannot be used, or null when it can.
 * A null payUrl is not a problem — it is an option the office has not set up
 * yet, which the site already handles.
 */
export function payUrlProblem(o: PriceOption): string | null {
  if (o.payUrl === null) return null;
  return payUrlError(o.payUrl)
    ?? (DUPLICATE_PAY_URLS.has(o.payUrl) ? 'is also used by another option' : null);
}

/**
 * True when a parent can actually be sent somewhere to pay for this option.
 *
 * The meaning of this changed when invoices replaced the shared payment links.
 * It used to mean "somebody pasted a URL here". It now means "an invoice can be
 * raised", which needs a price to charge and a QuickBooks item to book it to.
 *
 * Getting this wrong is not subtle: the enrol dialog reads it to decide whether
 * to say "the office will confirm the price and take payment by phone". Leaving
 * it keyed to payUrl after retiring the links would have told every parent, on
 * every program, that nobody could take their money.
 *
 * A valid payUrl still counts, so an option can be sold the old way if one is
 * ever pasted back in.
 */
export const isPayable = (o: PriceOption): boolean =>
  (o.qboItem !== null && typeof o.price === 'number')
  || (o.payUrl !== null && payUrlProblem(o) === null);

/** True when the host is not one payment links are expected on — advisory only. */
export const hasUnexpectedPayHost = (o: PriceOption): boolean => {
  if (o.payUrl === null || payUrlError(o.payUrl)) return false;
  try { return !KNOWN_PAY_HOST.test(new URL(o.payUrl).hostname); } catch { return false; }
};

/**
 * The link to hand a parent, or null. A broken link is treated exactly like a
 * missing one: the enrollment is still saved and the office still emailed, and
 * the parent sees "we'll follow up" instead of being redirected to whatever got
 * pasted. Failing this way round means a typo costs a phone call, not a payment
 * taken for the wrong amount.
 */
export function payUrlFor(program: Program, o: PriceOption): string | null {
  const problem = payUrlProblem(o);
  if (problem) {
    console.error(
      `payUrl for "${program.name} — ${o.label}" ${problem} — treating it as not ` +
      'yet payable. Fix worker/programs.ts, run `npm run check:programs`, and redeploy.'
    );
    return null;
  }
  return o.payUrl;
}

/**
 * Public catalog for the enrollment form. The form builds its program, option and
 * age-group menus from this, so the values it submits always match what
 * /api/enroll validates against — no duplicated list in the HTML to drift.
 * payUrl is deliberately withheld: it is only needed in the POST response.
 */
export const listPrograms = () =>
  Object.entries(PROGRAMS).map(([slug, p]) => ({
    slug,
    name: p.name,
    ageGroups: p.ageGroups,
    selfEnroll: p.selfEnroll === true,
    picksDays: p.picksDays === true,
    priceIsPerDay: p.priceIsPerDay === true,
    // Still listed even when false, because the account page resolves a stored
    // option id to its label through this response. The enrol form filters on it.
    enrollable: isEnrollable(p),
    options: p.options.map((o) => ({
      id: o.id,
      label: o.label,
      price: o.price,
      // isPayable rather than a null check, so the dialog cannot offer payment
      // the enrol route will then refuse to deliver.
      payable: isPayable(o)
    })),
    /** True when at least one option can take money — drives the dialog's copy. */
    payable: p.options.some(isPayable)
  }));
