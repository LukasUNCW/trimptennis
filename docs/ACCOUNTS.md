# Parent accounts — scope

Status: **all four phases built and deployed.** Written 2026-07-27, updated
2026-07-28.

- Phase 1 (magic-link sign-in) — done. `npm run test:account`
- Phase 2 (profile + children at /account) — done. `npm run test:account`
- Phase 3 (enrolment linked to account + child) — done. `npm run test:enroll`
- Phase 4 (enrolment history on the account page) — done. `npm run test:account`

Still outstanding: changing the sign-in email needs a confirmation link to the
new address before it can be offered, and the sending domain must be verified in
Resend before any of this reaches a real parent.

## Why an account exists at all

Their FoundationTennis portal has ten tabs. Most should not be rebuilt:

| Their tab | Decision | Reason |
|---|---|---|
| Web Invoices, Ledger, Statement | **Out** | QuickBooks owns billing. QB Payments has its own customer portal for viewing and paying invoices. Rebuilding this recreates the "two places to look up who paid" problem Katie explicitly objected to. |
| Children | **In** | The reason to have accounts at all. A parent with three kids should not retype everything three times. |
| Contact Info | **In** | Small, and we already collect most of it at enrollment. |
| Join Groups | **Out** | This is enrollment. Already built. |
| Tennis Profile, Preferences, Activity, Profile Picture | **Out (later)** | Nice-to-have. None of it changes what a parent can accomplish. |
| Membership & Login, Retrieve Password | **Out** | Only exist because passwords exist. See below. |
| Member ID | **Out** | An artefact of their platform. Nothing needs it. |

So the account is: **remembers you and your children, so enrolling is one click instead of a form.**

## Sign-in: magic links, not passwords

Parent types their email, gets a sign-in link, clicks it, is signed in.

This is not a shortcut — it is the better design here:

- No password storage, no hashing decisions, no reset flow, no lockout logic
- Nothing to leak. A database dump contains no credentials.
- Removes the risk that made a password form objectionable: someone typing a
  password they reuse elsewhere into a small site's form
- People sign in a handful of times a year. There is no password worth
  remembering, and "forgot password" would be the most-used feature.

Trade-off: sign-in requires inbox access, and a slow email feels slow. Acceptable
for this audience and frequency.

### Flow

1. `POST /api/auth/request` — email + Turnstile. Generates a 32-byte token,
   stores **only its SHA-256 hash** in `login_tokens`, emails the link.
   Always returns success, whether or not the email is known — otherwise the
   endpoint tells an attacker which parents have accounts.
2. `GET /auth/callback?token=…` — hashes the token, looks it up, checks expiry,
   **deletes it** (single use), creates a session, sets the cookie, redirects.
   The account is created here on first sign-in, so there is no separate signup.
3. Session cookie: `HttpOnly; Secure; SameSite=Lax; Path=/`.
4. `POST /api/auth/logout` — deletes the session row and clears the cookie.

### Decisions taken

- **Tokens expire in 15 minutes** and are single-use.
- **Sessions are opaque random ids stored in D1**, not signed JWTs. Revocable
  (Katie can sign someone out), no signing secret to manage, and the session
  table is the audit trail. Costs one D1 read per authenticated request, which
  is fine at this traffic.
- **Session length 60 days**, refreshed on use.
- **Rate limit**: max 5 link requests per email per hour, so the endpoint cannot
  be used to flood someone's inbox. Turnstile already blocks bots; this blocks a
  determined human.
- `Referrer-Policy: no-referrer` on the callback so the token does not leak
  through a Referer header, and it is redeemed and discarded immediately.

## Data model

New tables. Nothing existing changes destructively.

```sql
accounts (
  id, email UNIQUE (lowercased), first_name, last_name, phone,
  address1, address2, city, state, zip,
  created_at, last_login_at
)

children (
  id, account_id -> accounts.id,
  first_name, last_name, birth_year, notes, created_at
)

login_tokens (
  token_hash PRIMARY KEY,   -- sha256, never the token itself
  email, expires_at, created_at
)

sessions (
  id PRIMARY KEY,           -- the value in the cookie
  account_id -> accounts.id,
  created_at, expires_at, user_agent
)
```

`enrollments` gains nullable `account_id` and `child_id`. Nullable matters:
**guest enrollment stays supported.** Forcing signup before payment would cost
real enrolments, and the academy wants signups more than it wants accounts.

### Open question: how much do we store about a child?

`birth_year` is proposed rather than a full date of birth. A year is enough to
derive the age group and keeps it accurate as the child ages — storing
`age_group` directly goes stale the moment they age out of Grom's. Full DOB is
more data about a minor than we need unless the academy requires it for USTA
registration or insurance. **Ask Katie whether a full date is needed.**

## Routes

Public:
- `GET  /login` — email form
- `POST /api/auth/request`
- `GET  /auth/callback?token=…`
- `POST /api/auth/logout`

Signed in:
- `GET   /account` — the page. The Worker checks the session **before** the
  static asset is served and redirects to `/login` when absent, so there is no
  flash of a logged-out page.
- `GET   /api/me` — account + children
- `PATCH /api/me`
- `POST /api/children`, `PATCH /api/children/:id`, `DELETE /api/children/:id`
- `GET   /api/enrollments` — this parent's own enrolment history (read-only)

### Why enrolment history is its own endpoint

Every mutation above returns `loadMe()`, and none of them can change the
enrolment list, so folding it into `/api/me` would buy an extra query on each
of those writes for nothing. It is also the least important thing on the page:
on its own request, a failure shows one message in that card instead of taking
the profile and players down with it.

### Which enrolments count as yours

Matched on `account_id` **or** the address typed on the enrolment form
(`lower(parent_email) = accounts.email`).

The second arm exists because guest enrolment is a supported path, not a
fallback. Without it, a parent who enrolled before creating an account is shown
"nothing here yet", which reads as data loss. It discloses nothing extra:
holding an account means having received a magic link at that address, which is
the same proof of possession the match relies on.

The rows are matched at read time rather than having `account_id` stamped onto
them at sign-in. Claiming them would be tidier to query, but it writes a guess
permanently into the roster, and a wrong guess could not be undone.

## Phases

1. **Auth spine** — the four auth routes, `accounts`, `login_tokens`,
   `sessions`, the `/login` page, and the utility-bar link becoming
   "Log in" / "Hi Lukas · Log out". Nothing else visible yet.
2. **Account page** — profile form and add/edit/remove children.
3. **Enrollment prefill** — the enrol dialog offers your saved children, and
   writes `account_id`/`child_id` onto the row. This is the actual payoff.
4. **Enrolment history** — a read-only list on the account page: programme,
   player, date, payment status. Deliberately not invoices or receipts, which
   QuickBooks issues and emails.

Roughly: phase 1 is comparable in size to the enrollment form; phase 2 similar;
phase 3 is small. Not a single sitting, but not months either.

## Hard dependency: email must actually work

Magic links are email. `RESEND_API_KEY` is set and email sends, so what is left
is the domain:

**The domain must be verified in Resend.** Until then Resend's shared sender can
only deliver to the Resend account owner — so magic links reach Lukas and nobody
else. Verifying `seahawkstennisacademy.com` needs DNS records added, which means
the academy's domain access.

That is not a coding task, and it is the whole blocker. **Auth cannot ship to
real parents before the sending domain is verified.**

## Things deliberately not in this plan

- Passwords, password reset, "retrieve password"
- Invoices, ledger, statements, payment history — QuickBooks
- Profile pictures, tennis profiles, preferences, activity logs
- Coach or admin logins. Katie's roster view is a separate question, and
  Cloudflare Access in front of an `/admin` page is probably the answer there
  rather than building staff auth into this system.
- Social sign-in. One more dependency to no benefit here.
