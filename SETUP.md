# Backend setup — Stripe enrollments, D1, email, QBO

Everything runs in ONE Worker (`trimptennis`): it serves the site from `site/`
and handles `/webhook`, `/api/inquiry`, and the `/qbo/*` routes.

All commands are PowerShell, run from the repo root
(`C:\Users\lukasn\Desktop\seahawk mock\trimptennis`). One command per line — no `&&`.

## 1. Install files + tooling

Copy this package's files into the repo root (`wrangler.jsonc` REPLACES the
bot-generated config — delete the old one; also `package.json`, `tsconfig.json`,
`schema.sql`, and the `worker/` folder). Then:

```powershell
git pull
npm install
npx wrangler login
```

`wrangler login` opens a browser — approve as lukas.nilsson4321.

## 2. Create the database

```powershell
npx wrangler d1 create trimptennis-db
```

Copy the `database_id` from the output and paste it into `wrangler.jsonc`
(replacing PASTE_DATABASE_ID_HERE). Then create the tables:

```powershell
npm run db:schema
```

## 3. Set the secrets

Run each; it prompts for the value (nothing is stored in the repo):

```powershell
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put QBO_CLIENT_ID
npx wrangler secret put QBO_CLIENT_SECRET
npx wrangler secret put ADMIN_KEY
```

Where each value comes from:
- **STRIPE_WEBHOOK_SECRET** — step 5 below (whsec_...)
- **RESEND_API_KEY** — resend.com → free account → API Keys. (Until the academy's
  domain is verified in Resend, notifications go out from onboarding@resend.dev.
  Temporarily set NOTIFY_EMAIL in wrangler.jsonc to YOUR email for testing —
  Resend's dev sender can only email the account owner until a domain is verified.)
- **TURNSTILE_SECRET** — Cloudflare dashboard → Turnstile → Add site →
  domain: trimptennis.lukas-nilsson4321.workers.dev (add the real domain later)
  → copy the SECRET key here; the SITE key goes in the site's form HTML later.
- **QBO_CLIENT_ID / SECRET** — developer.intuit.com → create app (QuickBooks
  Online Accounting scope) → Development keys. Redirect URI (must be EXACT):
  `https://trimptennis.lukas-nilsson4321.workers.dev/qbo/callback`
- **ADMIN_KEY** — invent a long random string; it gates /qbo/connect and /qbo/items.

Don't have Stripe/Resend/QBO values yet? Set placeholders (e.g. "TODO") so
deploys work, and update them later — `wrangler secret put` overwrites.

## 4. Deploy

```powershell
npx wrangler deploy
```

(Or just `git push` — the Git integration deploys automatically. Both work.)
Verify: the site still renders at the workers.dev URL. Visit /api/inquiry in a
browser and you should get a 405-ish response instead of the site — routes live.

## 5. Stripe wiring (test mode first)

1. Academy creates its Stripe account (their EIN + bank). Meanwhile, use
   **test mode** (toggle in the Stripe dashboard) — full functionality, fake cards.
2. **Products**: Product per program. Elite Academy = recurring monthly price;
   Grom's / Shredder's / camp = one-time prices.
3. **Payment Links**: create one per program. On each:
   - Add custom fields: `player_name` (text, "Player's full name") and
     `age_group` (dropdown: 6-10, 11-16, 10-18, Adult)
   - Metadata: key `program`, value EXACTLY matching PLAN_ITEM_MAP keys in
     worker/qbo.ts (e.g. `Elite Academy`, `Grom's`)
4. **Webhook**: Developers → Webhooks → Add endpoint →
   `https://trimptennis.lukas-nilsson4321.workers.dev/webhook`
   → event: `checkout.session.completed` → copy the signing secret (whsec_...)
   → `npx wrangler secret put STRIPE_WEBHOOK_SECRET`
5. **Test**: open a Payment Link, pay with card `4242 4242 4242 4242` (any
   future expiry/CVC). Expect: Stripe shows the payment → an email notification
   arrives → the row is in D1:
   ```powershell
   npx wrangler d1 execute trimptennis-db --remote --command "SELECT program, player_name, amount_cents, qbo_status FROM enrollments"
   ```
   qbo_status stays `pending` until QBO is connected — the nightly cron
   backfills automatically once it is. Enrollments are never lost.

## 6. QBO connection (can happen after launch)

1. Intuit dev account + app (step 3 above), sandbox company for testing.
2. Visit `https://trimptennis.lukas-nilsson4321.workers.dev/qbo/connect?key=YOUR_ADMIN_KEY`
   while logged into the sandbox QuickBooks → approve → "QuickBooks connected."
3. Create Items in QBO (Sales → Products & services) per program — ask the
   academy's bookkeeper which income account each posts to.
4. List them: `/qbo/items?key=YOUR_ADMIN_KEY` → fill PLAN_ITEM_MAP in
   worker/qbo.ts with the real IDs → commit + push (auto-deploys).
5. Make a test purchase → row goes qbo_status=success → receipt in sandbox QBO.
6. Go-live later: production Intuit keys (update both secrets), set
   QBO_SANDBOX to "false" in wrangler.jsonc, re-run /qbo/connect with the
   academy's REAL QuickBooks login, refill PLAN_ITEM_MAP with production IDs
   (they differ from sandbox!).

## 7. Commit

```powershell
git add .
git commit -m "Backend: Stripe webhook, inquiry API, D1, QBO sync, email notifications"
git push
```

## What's deliberately NOT here yet
- The site's free-trial FORM (HTML + Turnstile widget + fetch to /api/inquiry) —
  next session, when the mockup splits into real pages with real Enroll buttons.
- Subscription RENEWAL receipts in QBO (invoice.paid) — v2, needs a Stripe API key.
- Katie's roster page behind Cloudflare Access — post-launch.
