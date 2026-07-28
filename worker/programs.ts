// worker/programs.ts
// Program catalog — the single place that knows what's enrollable and where to
// send a parent to pay.
//
// payUrl is a QuickBooks payment link. Katie creates one per program inside
// QuickBooks (Sales → Payment links) and pastes the URL here; payments then
// record natively in QuickBooks with no integration to maintain.
//
// A program with payUrl === null is not yet purchasable: /api/enroll still
// saves the enrollment and notifies the office, but the site shows a
// "we'll call you to take payment" path instead of redirecting.

export interface Program {
  /** Customer-facing name; also what we store on the enrollment row. */
  name: string;
  /** Valid age_group values for this program. */
  ageGroups: string[];
  /** QuickBooks payment link, or null until Katie creates it. */
  payUrl: string | null;
  /**
   * Elite Academy: the payment link covers the FIRST MONTH only. The office
   * sets up auto draft in QuickBooks once the player has attended a month, so
   * the enrollment email has to say so or the follow-up gets forgotten.
   */
  autoDraftAfterFirstMonth?: boolean;
  /**
   * Adult programs: the person signing up IS the player, so no guardian is
   * collected and the form asks for their own name. parent_name stays null on
   * these rows; parent_email is still the contact address.
   */
  selfEnroll?: boolean;
}

// Age ranges match the academy's own programme pages, which overlap
// deliberately: a 10-year-old could be in either Grom's or Shredder's depending
// on whether they can rally and keep score.
export const PROGRAMS: Record<string, Program> = {
  groms: {
    name: "Grom's",
    ageGroups: ['6-12'],
    payUrl: null
  },
  shredders: {
    name: "Shredder's",
    ageGroups: ['9-16'],
    payUrl: null
  },
  'summer-camp': {
    name: 'Summer Morning Camp',
    // Camp takes 7-18, which is wider at the top than either clinic and starts
    // a year later at the bottom. Both ends had to be fixed: without '13-18' a
    // 16- or 17-year-old had no group to choose and /api/enroll rejected them,
    // and borrowing Grom's '6-12' let a 6-year-old sign up for a camp that
    // starts at 7. Bands are per-program, so '7-12' here leaves Grom's alone.
    // NEEDS CONFIRMING with the office — these are the bands they read off
    // enrolment rows, and they may split camp differently.
    ageGroups: ['7-12', '9-16', '13-18'],
    payUrl: null
  },
  elite: {
    name: 'Elite Academy',
    ageGroups: ['10-18'],
    payUrl: null, // one month of membership
    autoDraftAfterFirstMonth: true
  },
  adult: {
    name: 'Adult Programs',
    ageGroups: ['Adult'],
    payUrl: null,
    selfEnroll: true
  }
};

export const lookupProgram = (slug: unknown): Program | null =>
  typeof slug === 'string' && Object.hasOwn(PROGRAMS, slug) ? PROGRAMS[slug] : null;

// ── checking a pasted payUrl ──────────────────────────────────────────────
//
// These five links are created by hand in QuickBooks and pasted into the file
// above, and every plausible slip is silent: a link pasted with the quotes still
// attached, a dashboard URL copied instead of a payment link, or — the expensive
// one — the same link pasted onto two programs, so a parent enrolling for Grom's
// is charged Elite's price. Nothing downstream would notice; the enrolment row
// would look perfect and QuickBooks would show a payment for the wrong thing.
//
// So a payUrl is checked rather than trusted, in two places for two reasons:
// `npm run check:programs` catches it before a deploy, and the enrol route
// re-checks at runtime because Cloudflare's Git integration runs `wrangler
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
 * The catalog's own mistake: one link serving two programs. Takes the catalog as
 * an argument rather than closing over PROGRAMS so it can be checked against a
 * fabricated one — the real catalog has every link empty today, so a duplicate
 * is not reproducible from it.
 */
export function findDuplicatePayUrls(programs: Record<string, Program>): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const p of Object.values(programs)) {
    if (p.payUrl === null) continue;
    if (seen.has(p.payUrl)) dupes.add(p.payUrl);
    seen.add(p.payUrl);
  }
  return dupes;
}

// Computed once: PROGRAMS is a static table in this file, not runtime state.
const DUPLICATE_PAY_URLS: ReadonlySet<string> = findDuplicatePayUrls(PROGRAMS);

/**
 * Why this program's link cannot be used, or null when it can.
 * A null payUrl is not a problem — it is a program the office has not set up
 * yet, which the site already handles.
 */
export function payUrlProblem(p: Program): string | null {
  if (p.payUrl === null) return null;
  return payUrlError(p.payUrl)
    ?? (DUPLICATE_PAY_URLS.has(p.payUrl) ? 'is also used by another program' : null);
}

/** True when a parent can actually be sent somewhere to pay for this program. */
export const isPayable = (p: Program): boolean =>
  p.payUrl !== null && payUrlProblem(p) === null;

/** True when the host is not one payment links are expected on — advisory only. */
export const hasUnexpectedPayHost = (p: Program): boolean => {
  if (p.payUrl === null || payUrlError(p.payUrl)) return false;
  try { return !KNOWN_PAY_HOST.test(new URL(p.payUrl).hostname); } catch { return false; }
};

/**
 * The link to hand a parent, or null. A broken link is treated exactly like a
 * missing one: the enrolment is still saved and the office still emailed, and
 * the parent sees "we'll follow up" instead of being redirected to whatever got
 * pasted. Failing this way round means a typo costs a phone call, not a payment
 * taken for the wrong program.
 */
export function payUrlFor(p: Program): string | null {
  const problem = payUrlProblem(p);
  if (problem) {
    console.error(
      `payUrl for "${p.name}" ${problem} — treating it as not yet payable. ` +
      'Fix worker/programs.ts, run `npm run check:programs`, and redeploy.'
    );
    return null;
  }
  return p.payUrl;
}

/**
 * Public catalog for the enrollment form. The form builds its program and
 * age-group menus from this, so the values it submits always match what
 * /api/enroll validates against — no duplicated list in the HTML to drift.
 * payUrl is deliberately withheld: it is only needed in the POST response.
 */
export const listPrograms = () =>
  Object.entries(PROGRAMS).map(([slug, p]) => ({
    slug,
    name: p.name,
    ageGroups: p.ageGroups,
    // isPayable rather than a null check, so the dialog's copy matches what the
    // enrol route will actually do with a link that turns out to be unusable.
    payable: isPayable(p),
    selfEnroll: p.selfEnroll === true
  }));
