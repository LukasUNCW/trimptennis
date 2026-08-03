// worker/programs.ts
// Program catalog — the single place that knows what's enrollable, what it
// costs, and where to send a parent to pay.
//
// A QuickBooks payment link carries its amount INSIDE the link, so this site
// cannot tell QuickBooks what to charge. That one fact drives the shape of this
// file: a program with three prices needs three links, so links hang off price
// options rather than off programs. Katie creates one multi-use link per option
// in QuickBooks (All apps → Sales & Get Paid → Payment links) and pastes the
// URL here.
//
// The links must be MULTI-USE. A single-use link stops working after the first
// parent pays it, and every parent enrolling in a program is sent to the same
// URL.
//
// An option with payUrl === null is not yet purchasable: /api/enroll still saves
// the enrollment and notifies the office, but the site shows a "we'll call you
// to take payment" path instead of redirecting.

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
   * Plain hyphens and straight apostrophes only, deliberately. These names get
   * typed into QuickBooks by hand, and an em dash is the kind of character
   * nobody reproduces from a keyboard. Pasting is still safer than retyping,
   * and `/qbo/verify-items` reports anything that does not resolve, so a
   * mismatch is caught by us rather than by a parent mid-enrollment.
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
    options: [
      { id: 'standard', label: '10 classes', price: 250, qboItem: "Grom's - 10 classes", payUrl: 'https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-f4a24dfac7ce46a48793ebfee81826cfc1ac205d73b24e6a9343cae86897f2354c4e880a9ebb416c83487747896e4795?locale=EN_US&cta=saveandcopylink' }
    ]
  },
  shredders: {
    name: "Shredder's",
    ageGroups: ['9-16'],
    options: [
      { id: '8x-month',  label: '8 classes / month',  price: 240, qboItem: "Shredder's - 8 classes / month", payUrl: 'https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-dcab8ea1fc914441bc783968ec6ccf8c77b53ad8572e49fb92b68d424252da275f077e97801844e59829101c8bb46d68?locale=EN_US&cta=saveandcopylink' },
      { id: '12x-month', label: '12 classes / month', price: 330, qboItem: "Shredder's - 12 classes / month", payUrl: 'https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-f77d0594914a48d7b316e2425349ffd1578d6d1f29d4499682a59460e283f2610d0186ab339f449f87dfe80b23be787f?locale=EN_US&cta=saveandcopylink' },
      { id: 'drop-in',   label: 'Drop-in',            price: 35,  qboItem: "Shredder's - Drop-in", payUrl: 'https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-f4e0fc27cd224867b0a60db0fe508ccf508514924d6d41419a55a1701e85e8e908bb400938514a7d98ee178af374f1aa?locale=EN_US&cta=saveandcopylink' }
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
      { id: '8x-month',  label: '8 classes / month — first month',  price: 320, qboItem: 'Elite Academy - 8 classes / month', payUrl: 'https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-a83e0d0de2e74102a72ff6b102f4e0be98873bb9b0084ffeb89db13d5622b587d007dc7ac227490d9ec8fa204332d7a4?locale=EN_US&cta=saveandcopylink', autoDraftAfterFirstMonth: true },
      { id: '12x-month', label: '12 classes / month — first month', price: 420, qboItem: 'Elite Academy - 12 classes / month', payUrl: 'https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-a7aa5450e4d24b0bbd2c1d1817e2c725747ffa4501a54ec4bca5c74414de2ee39611db4b5dde4978bee4130cce76a79f?locale=EN_US&cta=saveandcopylink', autoDraftAfterFirstMonth: true },
      // Deliberately no auto-draft follow-up: a drop-in is not a first month.
      // Katie: "a stand alone thing... when they know they are coming to class
      // they can click on the link and pay".
      { id: 'drop-in',   label: 'Drop-in',                          price: 45,  qboItem: 'Elite Academy - Drop-in', payUrl: 'https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-be458f88c1044b83b925d399e6157c4acebbf77ba93f47bca9d63610b1d0424824671f08db714caa8a9bb7e8f4827625?locale=EN_US&cta=saveandcopylink' }
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

/** True when a parent can actually be sent somewhere to pay for this option. */
export const isPayable = (o: PriceOption): boolean =>
  o.payUrl !== null && payUrlProblem(o) === null;

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
