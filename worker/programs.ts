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
}

export const PROGRAMS: Record<string, Program> = {
  groms: {
    name: "Grom's",
    ageGroups: ['6-10'],
    payUrl: null
  },
  shredders: {
    name: "Shredder's",
    ageGroups: ['11-16'],
    payUrl: null
  },
  'summer-camp': {
    name: 'Summer Morning Camp',
    ageGroups: ['6-10', '11-16'],
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
    payUrl: null
  }
};

export const lookupProgram = (slug: unknown): Program | null =>
  typeof slug === 'string' && Object.hasOwn(PROGRAMS, slug) ? PROGRAMS[slug] : null;

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
    payable: p.payUrl !== null
  }));
