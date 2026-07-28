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

- Each program has a **QuickBooks payment link**, created by the office in
  QuickBooks and pasted into `worker/programs.ts`.
- The site captures the enrolment (player, age group, parent, contact) into D1
  **before** handing the parent to that link — because QuickBooks tracks the
  money, not the roster.
- The Worker therefore has **no payment webhook**. Whether money actually arrived
  is answered in QuickBooks.
- Elite Academy's link covers **month one**; the office sets up auto-draft in
  QuickBooks afterwards. The enrolment email says so, so it is not forgotten.

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
| QuickBooks read API | Not connected — `QBO_CLIENT_ID`/`SECRET` are still `TODO` |

## Outstanding — the office

**1. Turn on QuickBooks Payments** (needs the academy's EIN and bank details).

**2. Create five payment links** and send them over: Grom's, Shredder's, Summer
Camp, Elite (one month), Adult. They go into `payUrl` in `worker/programs.ts` —
until then the form saves the enrolment and shows "the office will follow up"
instead of redirecting. Our side is ready: see "Prove the first real link" below,
and send them **one at a time** if that is easier, because a program with no link
simply keeps the follow-up path.

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

### Add a program's payment link

Edit `payUrl` for that program in `worker/programs.ts`, then `npm run deploy`.
Nothing else changes: the form builds its menus from `GET /api/programs`, so the
program list, age groups and the adult self-enrol rule all follow from that file.

`npm run deploy` runs `npm run check:programs` first and refuses to deploy if a
link is malformed, still has its quotes attached, is not https, or **is pasted
onto two programs** — that last one would silently charge a parent the wrong
program's price. Run it on its own any time:

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

1. Paste the link into that one program's `payUrl`. Leave the others `null`.
2. `npm run check:programs` — expect `1 of 5 programs can take payment`.
3. `npm run deploy`, then wait ~30 seconds.
4. Confirm the catalog agrees, and that only that program flipped:

   ```powershell
   node -e "fetch('https://trimptennis.lukas-nilsson4321.workers.dev/api/programs').then(r=>r.json()).then(p=>console.table(p.map(x=>({slug:x.slug,payable:x.payable}))))"
   ```

5. Enrol through the real form for that program, using an address you can read.
   The dialog should say "Continue to payment" and redirect to QuickBooks.
6. **On the QuickBooks page, check the program name and the amount, then stop.
   Do not pay.** A wrong amount here is the whole reason for this checklist.
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
```

`test:payurl` is offline — no deploy, no database, no secrets. It checks the
payment-link rules described above, including that one link pasted onto two
programs is caught and that an unfamiliar host cannot block payment. 26
assertions, safe to run any time.

The other two run against the **deployed** Worker and create throwaway accounts under
`acctest-*@example.com` and `enrtest-*@example.com`, deleting them at the end.
41 assertions, including that one account cannot read or modify another's
children, that a parent's enrolment history contains their rows and nobody
else's, and that removing a player detaches its enrolments instead of deleting
them.

## Reference

### Secrets — `npx wrangler secret put NAME`

| Secret | State | Where it comes from |
|---|---|---|
| `RESEND_API_KEY` | set | resend.com → API Keys |
| `TURNSTILE_SECRET` | set | Cloudflare → Turnstile → the "Seahawks Tennis Academy" widget |
| `ADMIN_KEY` | set | Invented. Gates `/qbo/*`. In Lukas's password manager. |
| `QBO_CLIENT_ID` | `TODO` | developer.intuit.com app → keys |
| `QBO_CLIENT_SECRET` | `TODO` | same app |

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
