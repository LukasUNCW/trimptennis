# trimptennis

Website, enrolment and QuickBooks integration for **Seahawks Tennis Academy**,
Wilmington NC — replacing their FoundationTennis site.

One Cloudflare Worker serves the static site from `site/` and the API from
`worker/`, backed by D1. Payments are taken by **QuickBooks Payments** (no
Stripe, no Square) so that money and records stay in one place.

**Live:** https://trimptennis.lukas-nilsson4321.workers.dev

- **[SETUP.md](SETUP.md)** — how it works, what is outstanding, and day-to-day
  operations. Start here.
- **[docs/ACCOUNTS.md](docs/ACCOUNTS.md)** — parent accounts: magic-link sign-in,
  what was deliberately left out, and why.

```
site/        static pages, shared styles.css and scripts
worker/      Worker: router, auth, programmes, email, QuickBooks
schema.sql   D1 schema (source of truth, safe to re-run)
assets-src/  original photos — version-controlled, never served
scripts/     image pipeline and the test suites
```
