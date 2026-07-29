# Seahawks Tennis Academy — setup & operations

Everything runs in **one Cloudflare Worker** (`trimptennis`). It serves the static
site from `site/` and handles the API routes from `worker/`.

- Live: https://trimptennis.lukas-nilsson4321.workers.dev
- Pushing to `main` auto-deploys via Cloudflare's Git integration.
- Commands are PowerShell, run from the repo root. One per line — no `&&`.

> This replaces the academy's FoundationTennis site. Their old one is still up at
> seahawkstennisacademy.com; nothing here reads from it.

## How payment works — read this first

**QuickBooks Payments processes the money. There is no Stripe and no Square.**

That is a deliberate decision, made because the office wants records in one
place: Intuit is both the processor and the ledger, so there is no connector to
maintain and no second system to check when asking "who paid this?". An earlier
Square setup posted consolidated deposits without customer names, which is the
confusion this avoids.

What that means in practice:

- **A payment link carries its amount inside the link.** This site cannot tell
  QuickBooks what to charge, which is why links hang off *price options* rather
  than programs: Shredder's sells three prices, so it needs three links. There
  are **nine** links, not five. See `PROGRAMS` in `worker/programs.ts`.
- Links must be **multi-use**. A single-use link stops working after the first
  parent pays it, and every parent enrolling in an option is sent to the same
  URL. In QuickBooks: All apps → Sales & Get Paid → Payment links → Create a
  link → *Multi-use payment link*.
- The site captures the enrolment (player, age group, parent, contact, **which
  option**) into D1 **before** handing the parent to that link — because
  QuickBooks tracks the money, not the roster.
- The Worker therefore has **no payment webhook**. Whether money actually arrived
  is answered in QuickBooks.
- Elite's and Shredder's **membership** options cover month one; the office sets
  up auto-draft in QuickBooks afterwards, and the enrolment email says so.
  `autoDraftAfterFirstMonth` sits on the *option*, not the program, because a
  drop-in is a one-off and must not promise an auto-draft.

### The one wrinkle in this arrangement

A **multi-use payment link records no customer** — Intuit's docs say the sales
receipt posts with the customer "not specified". That is uncomfortably close to
the nameless-deposits problem this whole setup exists to avoid.

It is survivable because the names are here instead: the enrolment row holds
player, parent, email, program, option and timestamp, written before the handoff.
What it costs is that "who paid this?" is answered by matching the **amount and
time** against the enrolment list, not by reading a name off the transaction.

Which is why **every price in the catalog is deliberately distinct** — $250, $240,
$330, $35, $350, $320, $420, $45. One amount means exactly one option, so a
nameless payment is still identifiable. `npm run check:programs` warns if two
options ever share a price. Keep it that way when Adult gets priced.

**Not yet confirmed:** whether a multi-use link still records the payer's name
and email that they type at checkout, even with the Customer field blank. If it
does, none of the above matters much. Check this on the first real payment.

## Current status

| Area | State |
|---|---|
| Static site | Live — `/`, `/juniors`, `/elite`, `/adults`, `/contact`, `/login`, `/account` |
| D1 database | Live — `trimptennis-db`, 7 tables |
| Enrolment form | Live, writes to D1 and emails the office |
| Contact form | Live, writes to D1 and emails the office |
| Turnstile | **Real widget**, both forms protected |
| Email (Resend) | Working, but see the domain caveat below |
| Parent accounts | Live — magic-link sign-in, profile, children, linked enrolments, enrolment history |
| **Taking payment** | **Blocked** — no payment links exist yet |
| Schedule page | Not built — needs a decision, see below |
| QuickBooks read API | Not connected — the `QBO_*` secrets exist but hold placeholders |

## Outstanding — the office

**1. Turn on QuickBooks Payments** (needs the academy's EIN and bank details).

Katie is the QuickBooks admin, so she is the one who enables Payments, creates
the links, and — if the read-side connection is ever set up — clicks Authorize on
Intuit's consent screen. Nothing in that list requires her password leaving her:
the developer app should be created under **our** Intuit developer account so the
client id and secret are ours, and she only ever authorizes.

**2. Create nine payment links** — one per price option, all **multi-use**. Katie
confirmed this list on 2026-07-29:

| Option | Price |
|---|---|
| Grom's — 10 classes | $250 |
| Shredder's — 8x/month | $240 |
| Shredder's — 12x/month | $330 |
| Shredder's — drop-in | $35 |
| Summer Morning Camp — 5-day week | $350 *(awaiting her confirmation; it is what her own camp page publishes)* |
| Elite — 8x/month, first month | $320 |
| Elite — 12x/month, first month | $420 |
| Elite — drop-in | $45 |
| Adult Programs | **unpriced** — still to be decided |

They go into the matching option's `payUrl` in `worker/programs.ts` — until then
the form saves the enrolment and shows "the office will follow up" instead of
redirecting. Send them **one at a time** if that is easier: an option with no link
simply keeps the follow-up path. See "Prove the first real link" below.

**3. Answer three questions:**

- **Schedule** — is the calendar informational, or do parents register for
  specific sessions? Informational means the office maintains it in Google
  Calendar and the site renders the feed; per-session registration means a D1
  table plus an admin page. This decides whether the Schedule page is a small job
  or a large one.
- **Adult rates** — their old page publishes none, so `/adults` says "ask us".
- **Autumn Grom's dates** — the page still shows a summer session ending 20 Aug.

**"Mait DuBois" is settled — do not ask them.** The photo they sent was filed as
"matt", but UNCW's own athletics site spells it Mait in the men's tennis roster,
the staff directory and its press releases. The site, the source photo and the
image job already use Mait, so nothing needs changing.

## Outstanding — DNS

**Verify `seahawkstennisacademy.com` in Resend** (SPF/DKIM records).

The academy owns the domain, but **does not host its own DNS**: the nameservers
are `ns1`/`ns2.mytenniscenter.com`, their old tennis-website vendor. Records get
added through that vendor's panel if Katie has the login, or by asking the vendor
to add them. Owning the domain is not the same as being able to edit the zone —
budget time for this.

What is already in the zone, as of 2026-07-28:

```
A       52.167.12.19                    (the old FoundationTennis site)
MX      tennismail.srvr.media3.us
TXT     v=spf1 mx a ip4:52.167.12.19 ip4:52.177.245.183 ~all
_dmarc  v=DMARC1; p=reject; rua=mailto:postmaster@seahawkstennisacademy.com; pct=100
```

Two traps in there:

- **There is already an SPF record, and a domain may only have one.** A second
  SPF TXT record makes SPF fail outright and takes the academy's existing email
  down with it. Whatever Resend asks for must be *merged* into that line — or put
  on a sending subdomain (`send.seahawkstennisacademy.com`), which leaves the
  root SPF untouched. The subdomain route still satisfies DMARC, because relaxed
  alignment counts a subdomain's DKIM as aligned with the root domain. Prefer it.
- **DMARC is `p=reject`, not `quarantine`.** Mail from the domain that is not
  correctly DKIM-signed is *rejected*, not spam-foldered. A half-finished Resend
  setup is therefore worse than the current stopgap: magic links would hard
  bounce rather than arrive late. Do not point `FROM_EMAIL` at the academy's
  domain until Resend reports the domain verified. It is safe today only because
  `onboarding@resend.dev` is Resend's own domain, so this policy does not apply.

Take the exact record values from the Resend dashboard — do not hand-write them.
(The zone also contains a stray `google-site-verification=goes here`, i.e. a
placeholder somebody pasted literally. Harmless, but a fair indication that the
zone is edited by copy-paste, so send exact values and check afterwards.)

The same nameservers are what the eventual cutover of the domain to this Worker
has to go through. **`docs/DNS-CUTOVER.md` is the runbook** — the full zone as it
stands, an ordered set of stages, how to verify their email still flows at each
one, and how to roll back. Read it before touching the zone.

The key idea there: **moving DNS and switching the website are two separate
events.** Recreate the zone in Cloudflare *including the old server's A records*,
switch nameservers, and nothing user-visible changes — email flows, the old site
still loads — so it can all be verified calmly before the site flips over later.

Until then the shared sender `onboarding@resend.dev` only delivers to the Resend
account owner. `NOTIFY_EMAIL` is therefore pointed at a personal address as a
stopgap — see the comment in `wrangler.jsonc`. Consequences while unverified:

- office notifications go to that address, not `info@seahawkstennisacademy.com`
- **magic-link sign-in only works for that one address**, so parent accounts
  cannot ship to real parents yet

Once verified: set `NOTIFY_EMAIL` back to `info@seahawkstennisacademy.com` and
`FROM_EMAIL` to an address on the academy's domain, then deploy.

## Local setup

```powershell
git pull
npm install
npx wrangler login
```

That is enough to deploy and to run the test suites. The D1 database, secrets and
Turnstile widget already exist — do not recreate them.

## Day-to-day

### Add a payment link

Edit `payUrl` on that **option** in `worker/programs.ts`, then `npm run deploy`.
Nothing else changes: the form builds its menus from `GET /api/programs`, so the
program list, the price options, age groups and the adult self-enrol rule all
follow from that file.

Adding a whole new price is the same job — add an option to the program's
`options` array with an `id`, `label`, `price` and `payUrl`. The dialog shows the
option menu automatically once a program has more than one, and `price_option` on
the enrolment row records which was bought.

`npm run deploy` runs `npm run check:programs` first and refuses to deploy if a
link is malformed, still has its quotes attached, is not https, or **is pasted
onto two options** — that last one would silently charge a parent a different
option's price, e.g. $330 for a $35 drop-in. Run it on its own any time:

```powershell
npm run check:programs
```

Two things it cannot tell you, and one hole:

- Whether the link charges the right **amount**, or is even the right program.
  Only opening it can answer that — hence the checklist below.
- Whether the host is right. Intuit lets the link's URL be customised, so there
  is no domain to match on. An unfamiliar host is a **warning, not an error**:
  guessing wrong and blocking a real link would be worse than the mistake. Once
  the first genuine link arrives, add its host to `KNOWN_PAY_HOST` in
  `worker/programs.ts` and the warning goes quiet.
- **A push to main does not run the check** — Cloudflare's Git integration runs
  `wrangler deploy` directly, same as `npm run images`. That is why the enrol
  route re-checks at request time and treats an unusable link exactly like a
  missing one: the enrolment still saves, the office is still emailed, and the
  parent sees "we'll follow up" rather than being redirected to whatever was
  pasted. Check the Worker logs for `payUrl for "…"` if a program that should be
  payable is not offering payment.

### Prove the first real link before adding the rest

Do this once, with **one** program, before the other four go in. It is the only
way to catch a link that is valid but points at the wrong thing.

1. Paste the link into that one option's `payUrl`. Leave the others `null`.
2. `npm run check:programs` — expect `1 of 9 payment links are set up`.
3. `npm run deploy`, then wait ~30 seconds.
4. Confirm the catalog agrees, and that only that program flipped:

   ```powershell
   node -e "fetch('https://trimptennis.lukas-nilsson4321.workers.dev/api/programs').then(r=>r.json()).then(p=>console.table(p.map(x=>({slug:x.slug,payable:x.payable}))))"
   ```

5. Enrol through the real form for that program, using an address you can read.
   The dialog saves the enrolment and then shows the **review panel** — program,
   option, player and amount — with a "Continue to payment →" button.

   **This is the first chance anyone gets to look at that panel.** It appears only
   when an option has a working `payUrl`, so while every link is `null` it is
   unreachable, and Turnstile does not accept `localhost` so it cannot be
   exercised locally either. Check that the amount matches the option's `price` in
   `worker/programs.ts`, and that the player name is right — for a saved player it
   comes from the stored child record, not from the form.
6. **On the QuickBooks page, check the program, the option and the amount against
   what the site displayed, then stop. Do not pay.** Nothing automated can verify
   this: the site shows the price from `worker/programs.ts` while QuickBooks
   charges whatever is inside the link, so a link built for the wrong amount looks
   perfectly fine on the site. A human reading both numbers is the only check.
7. **If Katie is willing, pay one real link a dollar or two** and look at the
   resulting transaction in QuickBooks: does it show the payer's name and email,
   or is it genuinely anonymous? That answers the open question above and decides
   how much month-end reconciliation work the office is in for.
7. Confirm the enrolment was captured anyway — it is saved before the handoff, so
   abandoning payment must still leave a row:

   ```powershell
   npx wrangler d1 execute trimptennis-db --remote --command "SELECT created_at, program, player_name, payment_status FROM enrollments ORDER BY created_at DESC LIMIT 3"
   ```

8. Delete the test row, then add the remaining four links and repeat steps 2-4.

Elite Academy is the one to read twice: its link covers **month one only**, and
the office sets up auto-draft in QuickBooks afterwards. If that link is a
one-off charge for a full term, it is the wrong link.

### Add or replace a photo

Put the original in `assets-src/`, add an entry to `JOBS` in
`scripts/optimize-images.mjs`, then:

```powershell
npm run images
```

It writes only the sizes the page displays into `site/images/`, never enlarges a
small source, bakes in EXIF rotation, and prints which markup each image needs —
`<picture>` when WebP actually wins, plain `<img>` when it does not. Set `ratio`
on a job when the image sits in a grid that must line up, and `focusY` when a
centred crop cuts through the subject. **Commit the generated files**: the
Cloudflare build runs `wrangler deploy`, not this script.

### Look something up

```powershell
npx wrangler d1 execute trimptennis-db --remote --command "SELECT created_at, program, player_name, parent_email, payment_status FROM enrollments ORDER BY created_at DESC LIMIT 20"
```

Or use the D1 console in the Cloudflare dashboard (**Workers & Pages → D1 →
trimptennis-db → Console**) — that box takes **SQL only**, not `npx` commands.

### Sign a parent out of every device

```powershell
npx wrangler d1 execute trimptennis-db --remote --command "DELETE FROM sessions WHERE account_id = (SELECT id FROM accounts WHERE email = 'them@example.com')"
```

### Run the tests

```powershell
npm run test:account
npm run test:enroll
npm run test:payurl
npm run test:links
```

`test:payurl` is offline — no deploy, no database, no secrets. It checks the
payment-link and price-option rules: that one link pasted onto two options is
caught, that an unfamiliar host cannot block payment, that no two options share a
price, that an Elite drop-in never promises an auto-draft, and that a missing
option id is **refused rather than guessed** when a program sells more than one
price. 40 assertions, safe to run any time.

The other two run against the **deployed** Worker and create throwaway accounts under
`acctest-*@example.com` and `enrtest-*@example.com`, deleting them at the end.
43 assertions, including that one account cannot read or modify another's
children, that a parent's enrolment history contains their rows and nobody
else's, that a row written before price options existed still reads back, and
that removing a player detaches its enrolments instead of deleting them.

`test:links` fetches the deployed pages and checks that no `<a class="btn">`
points at `href="#"`, that the free-trial form is reachable, and that the footers
agree with each other. It exists because the homepage advertised a free trial in
two places and **both were dead links** for as long as the site had been live,
while the Worker supported free-trial requests the whole time. A dead primary
call to action is invisible in code review. 20 assertions.

103 assertions across all four.

## Reference

### Secrets — `npx wrangler secret put NAME`

| Secret | State | Where it comes from |
|---|---|---|
| `RESEND_API_KEY` | set | resend.com → API Keys |
| `TURNSTILE_SECRET` | set | Cloudflare → Turnstile → the "Seahawks Tennis Academy" widget |
| `ADMIN_KEY` | set | Invented. Gates `/qbo/*`. In Lukas's password manager. |
| `QBO_CLIENT_ID` | **exists, placeholder value** | developer.intuit.com app → keys |
| `QBO_CLIENT_SECRET` | **exists, placeholder value** | same app |

Careful with those last two: they are *set*, so `npx wrangler secret list` shows
them alongside the real ones and they read as configured. They hold placeholder
text. `/qbo/connect` and `/qbo/items` check for that and answer with a 503
explaining it, rather than handing a fake client id to Intuit and surfacing
Intuit's error instead.

Non-secret settings (`QBO_SANDBOX`, `NOTIFY_EMAIL`, `FROM_EMAIL`, `SITE_NAME`)
live in `wrangler.jsonc`. **Do not edit those in the Cloudflare dashboard** — the
next deploy overwrites them from the file.

The Turnstile site key is public and appears in the page source. The widget
already allows `seahawkstennisacademy.com` and `www.` alongside the workers.dev
host, so the forms keep working at domain cutover.

### Routes

| Route | Purpose |
|---|---|
| `POST /api/enroll` | Enrolment → D1 + email; returns the payment link to redirect to |
| `POST /api/inquiry` | Contact / free-trial → D1 + email |
| `GET /api/programs` | Program catalog the enrol form builds its menus from |
| `GET /api/inquiry-topics` | Contact form's "Email to" options |
| `POST /api/auth/request` | Email a magic sign-in link |
| `GET /auth/callback` | Redeem the link, open a session |
| `POST /api/auth/logout` | End the session |
| `GET`/`PATCH /api/me` | The signed-in account + children |
| `POST`/`PATCH`/`DELETE /api/children[/:id]` | Manage saved players |
| `GET /api/enrollments` | The signed-in parent's own enrolment history |
| `GET /qbo/connect`, `/qbo/callback`, `/qbo/items` | One-time QuickBooks OAuth, `?key=ADMIN_KEY` |

### The free trial

`/contact?trial=1` is the contact page reshaped, not a second page: it asks for
the child's first name and age instead of a department, makes the message
optional, and posts `kind: 'free_trial'` so the office can tell a trial request
apart from a general enquiry. Both homepage trial CTAs point at it.

One form rather than two because a second form would mean a second Turnstile
widget, a second set of validation, and two places to fix anything. The
`inquiries` table already had `player_name` and `age_group` columns for exactly
this — the server side was built and never reached.

`contact_preference` is now stored for a free trial as well as a contact message.
It used to be kept only for `'contact'`, so a parent could ask to be phoned about
a trial and the office would never see it.

All forms are Turnstile-gated. `/account` is gated server-side, which needs
`assets.run_worker_first` in `wrangler.jsonc` — without it Cloudflare serves the
static file and the Worker never runs.

### Tables

`enrollments` · `inquiries` · `accounts` · `children` · `sessions` ·
`login_tokens` · `qbo_tokens`

`schema.sql` is the source of truth and is safe to re-run — everything is
`IF NOT EXISTS`. Columns added later were applied with `ALTER TABLE`, so a fresh
database built from `schema.sql` matches production.

### Accounts

Sign-in is by emailed magic link; **there is no password anywhere in the
schema**. Only the SHA-256 of a token is stored, tokens are single-use and expire
in 15 minutes, and sessions are opaque ids in D1 rather than signed tokens so
they can be revoked. Design notes and the phase plan are in `docs/ACCOUNTS.md`.

## Deliberately not built

- **Stripe or Square.** See the payment section.
- **Invoices, ledger, statements, payment history.** QuickBooks owns billing and
  has its own customer portal. Rebuilding it recreates the two-places problem.
- **Passwords**, password reset, "retrieve password".
- **Subscription renewal receipts.** Elite renewals are auto-draft in QuickBooks.
- **A staff/admin login.** If the office needs a roster page, Cloudflare Access
  in front of an `/admin` route is the answer rather than building staff auth.
- **Schedule calendar.** Blocked on the question above, not on effort.
- Profile pictures, tennis profiles, preferences, activity logs, member IDs —
  all present in FoundationTennis, none of them change what a parent can do.

## Gotchas worth knowing

- **Wait ~30 seconds after a deploy before believing what you see.** Cloudflare's
  edge nodes disagree with each other briefly, so a page can serve stale HTML or
  a just-uploaded image can 404. It settles.
- **A `<dialog>` must not have `display` set outside `[open]`.** Author styles
  beat the UA rule that hides a closed dialog, so it will sit on screen
  permanently.
- **In-page anchors need `scroll-margin-top`** to clear the sticky header, or the
  heading lands underneath it.
- **`sharp().metadata()` reports stored dimensions, not displayed ones.** Flatten
  EXIF rotation before measuring or a portrait phone photo measures as landscape.
- **Any response that depends on a cookie needs `Cache-Control: no-store`.** A
  cached 401 from `/api/me` makes a signed-in visitor look signed out.
- **SQLite does not enforce `REFERENCES` unless foreign keys are switched on.**
  Deleting a row that others point at succeeds and leaves them dangling, so the
  code has to detach dependents itself — see the child delete handler.
- **Layout-critical image cropping belongs in the file, not in CSS.** Tiles that
  must line up are pre-cropped by `npm run images`; leaving it to `object-fit`
  produced three different heights.
