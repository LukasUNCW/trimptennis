# Seahawks Tennis Academy — website: scope of work

Prepared for John and Logan Trimp · Seahawks Tennis Academy, Wilmington NC
Prepared by Lukas Nilsson · 2026-07-29

This document sets out what has been built, what it replaces, what was
deliberately left out, and what remains outstanding — including which items sit
with the academy rather than with me.

---

## 1. What this is

A replacement for the academy's FoundationTennis website. It is not a template or
a page builder: it is a custom-built site with its own enrollment system, parent
accounts and database, running on Cloudflare's global network.

**Live now:** `trimptennis.lukas-nilsson4321.workers.dev`
It moves to `seahawkstennisacademy.com` at launch — see §7.

The whole site runs as a single service, which is why hosting costs almost
nothing (§8) and why there is no server for the academy to maintain, patch or
back up.

---

## 2. What has been delivered

### Public website — 7 pages
Home, Grom's & Shredder's (with Summer Camp), Elite Academy, Adult Programs,
Contact, Sign in, My Account. Written by hand, mobile-first, using the academy's
own photographs and the UNCW Seahawk mark.

- **Photograph pipeline.** The academy's original photos are kept at full size,
  and the exact sizes each page displays are generated from them automatically —
  including retina versions, correct orientation for phone photos, and crops
  baked into the files so tiles line up. Pages load small images without anyone
  hand-resizing anything. Adding a new photo is one command.
- **Accessibility and structure.** Proper headings, labelled form fields,
  descriptive alternative text on every photograph, keyboard-usable dialogs.

### Enrollment system
- Parents enroll for any program directly on the site.
- **Nine price options** across the five programs — Grom's, Shredder's (8x, 12x,
  drop-in), Summer Camp, Elite (8x, 12x, drop-in), Adult — each with its own
  price and its own QuickBooks payment link. The form asks which package only
  when a program actually sells more than one.
- Every enrollment is recorded in the academy's own database **before** the parent
  is handed to payment, so an abandoned checkout still leaves you the lead.
- The office is emailed immediately, with the program, package, price, player,
  age group and contact details.
- Elite and Shredder's monthly options carry a reminder in that email that the
  payment covers the first month and auto-draft needs setting up in QuickBooks.
- Adults enroll themselves — no guardian is requested where it makes no sense.

### Free trial requests
The homepage's free-trial offer collects the child's name and age and records the
request separately from general enquiries, so the office can tell them apart.

### Contact form
Routed by topic, with a stated preference for a call or an email, and a check that
somebody asking to be phoned actually left a number.

### Parent accounts
Passwordless sign-in by emailed link — **no password is stored anywhere in the
system**, so there is nothing to leak and no "forgot password" process to run.

- A parent saves each of their children once, then enrolls them in a couple of
  clicks instead of retyping everything.
- Their own contact details, editable by them.
- Their enrollment history: program, package, price, date and payment status.
- Enrolling without an account remains fully supported — an account is a
  convenience, never a barrier to signing up.

### Spam and abuse protection
Cloudflare Turnstile on every form. Sign-in links expire in 15 minutes, work once,
and are rate-limited so the system cannot be used to flood somebody's inbox.
Sessions can be revoked, so the office can sign a parent out of every device.

### Payment handling
Payments are processed by **QuickBooks Payments**, so money and bookkeeping never
leave Intuit — there is no second system to reconcile and no separate processor's
records to cross-check. Card details never touch this site.

The site includes automated checks that refuse to publish a payment link that is
malformed, or — the expensive mistake — pasted onto two different price options,
which would silently charge a parent the wrong amount.

### Testing
Four automated test suites, **103 checks**, run against the live system. They
cover, among other things, that one family cannot read or alter another family's
records, that removing a child never destroys enrollment history, that a payment
link cannot be misconfigured unnoticed, and that no button on the site leads
nowhere.

### Documentation
Written for whoever maintains this next, including if that is not me:
- `SETUP.md` — how it all fits together, day-to-day operations, and the traps
  this project already hit
- `docs/ACCOUNTS.md` — how sign-in works and why it was designed that way
- `docs/DNS-CUTOVER.md` — a staged procedure for moving the domain without
  interrupting the academy's email

---

## 3. What this replaces

Their FoundationTennis parent portal had ten sections. Each was assessed rather
than copied:

| Their feature | Decision | Reason |
|---|---|---|
| Children | **Rebuilt, better** | The reason accounts exist. Enroll a saved child in two clicks. |
| Contact info | **Rebuilt** | Parents maintain their own details. |
| Join groups | **Rebuilt as enrollment** | Now takes payment rather than just registering interest. |
| Web invoices, ledger, statement | **Deliberately not rebuilt** | QuickBooks owns billing and has its own customer portal. Rebuilding it recreates the two-places-to-look problem. |
| Membership & login, retrieve password | **Not applicable** | Both exist only because passwords exist. There are none. |
| Member ID | **Not rebuilt** | An artefact of their platform. Nothing needs it. |
| Tennis profile, preferences, activity log, profile picture | **Not rebuilt** | None of it changes what a parent can accomplish. |

---

## 4. Deliberately not built

Listed so it is explicit, not discovered later:

- **A second payment processor.** QuickBooks Payments only, by decision.
- **Invoices, statements or payment history on the site.** QuickBooks issues these.
- **Passwords.**
- **A staff or admin login.** If the office later wants a roster page, the right
  answer is Cloudflare Access in front of it rather than building staff accounts.
- **A schedule page.** Blocked on a decision from the academy, not on effort —
  see §7.
- **Privacy policy and terms pages.** These need the academy's own wording.

---

## 5. Ongoing running costs

Paid by the academy directly, not through me. Current published tiers:

| Service | What it does | Cost at this size |
|---|---|---|
| Cloudflare Workers | Hosts the entire site and database | Free tier covers this comfortably; $5/month if usage grows |
| Cloudflare D1 | The database | Free tier |
| Resend | Sends the notification and sign-in emails | Free tier, 100 emails/day |
| Domain renewal | Already theirs | Unchanged |
| QuickBooks Payments | Card processing | Intuit's standard rates, paid to Intuit |

There is no server, no hosting bill in the traditional sense, and no software
licence. Expect **$0–5/month** plus Intuit's processing fees.

This replaces whatever the academy currently pays mytenniscenter /
FoundationTennis, which should be counted as a saving against this project.

---

## 6. Investment

**[ Fee to be inserted ]**

Suggested structure:

- **A one-time project fee** covering everything in §2, delivered and live on the
  academy's domain.
- **Changes after launch**, one of:
  - an hourly rate for ad-hoc requests, or
  - a small monthly retainer covering routine updates — session dates, prices,
    photographs, copy changes — which is the realistic pattern for a site like
    this.

Worth agreeing the second point now rather than later.

---

## 7. Outstanding, and who owns it

Nothing below is waiting on development work. Each item is either a decision or an
action that only the academy can take.

### With the academy
1. **Create the nine QuickBooks payment links** (multi-use), and confirm the
   Summer Camp price. Until then, enrollments are captured and the form tells the
   parent the office will follow up — nothing is lost, but no card is charged.
2. **Set the Adult Programs price.** Their old site publishes none, so the adults
   page currently says to get in touch, and the ninth payment link cannot exist
   without it.
3. **DNS access**, so the sending domain can be verified and the site can move to
   `seahawkstennisacademy.com`. Their domain records are currently managed by
   their previous website provider. **Until this is done, parent accounts cannot
   be released to real families**, because the sign-in emails cannot be delivered
   from the academy's own domain.
4. **Decide the schedule page.** An informational calendar the office keeps
   updated is a small job; parents registering for individual sessions is a
   substantially larger one. This is the single biggest open question about the
   remaining scope.
5. **Autumn Grom's dates**, and confirmation of the **street address** — their camp
   page says 748 Hamilton Drive, the site footer says 751.
6. **Privacy policy and terms wording**, if wanted.
7. **Confirm when to stop using the old provider**, since the domain cutover makes
   the old site unreachable.

### With me, once the above land
- Install the payment links and verify each one against the real QuickBooks page.
- Move the domain, following the staged procedure already written, and verify the
  academy's email is unaffected at each stage.
- Verify the sending domain and switch notifications to
  `info@seahawkstennisacademy.com`.
- Build the schedule page once its shape is decided — quoted separately, since the
  two options differ substantially in size.

---

## 8. A note on what this is worth

The parts a visitor sees are a fraction of it. What sits underneath is a working
enrollment and payments path, a parent account system with no passwords to leak,
a database the academy owns outright, automated tests that make changes safe to
make, and written procedures so none of it depends on any single person's memory.

That is the difference between a website and a system the academy runs its
enrollments on.
