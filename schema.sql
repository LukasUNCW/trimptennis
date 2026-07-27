-- schema.sql — run once against the D1 database (see SETUP.md)

-- Paid signups, mirrored from Stripe checkout.session.completed webhooks.
-- QBO sync status lives on the row itself: 'pending' → 'success' | 'failed'.
-- Rows stuck at pending/failed are retried by the nightly cron — which means
-- enrollments taken BEFORE QuickBooks is connected backfill automatically.
CREATE TABLE IF NOT EXISTS enrollments (
  id TEXT PRIMARY KEY,              -- Stripe checkout session id (idempotency key)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  parent_name TEXT,
  parent_email TEXT,
  player_name TEXT,
  age_group TEXT,
  program TEXT NOT NULL,            -- from Payment Link metadata: "Grom's", "Elite Academy", ...
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  mode TEXT NOT NULL,               -- 'payment' (one-time) | 'subscription'
  stripe_customer_id TEXT,
  qbo_status TEXT NOT NULL DEFAULT 'pending',   -- pending | success | failed | skipped
  qbo_receipt_id TEXT,
  qbo_attempts INTEGER NOT NULL DEFAULT 0,
  qbo_last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_enrollments_qbo ON enrollments (qbo_status);
CREATE INDEX IF NOT EXISTS idx_enrollments_program ON enrollments (program);

-- Non-payment form submissions: free trial requests, contact form.
CREATE TABLE IF NOT EXISTS inquiries (
  id TEXT PRIMARY KEY,              -- crypto.randomUUID()
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL,               -- 'free_trial' | 'contact'
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  player_name TEXT,
  age_group TEXT,
  message TEXT
);

-- QuickBooks OAuth tokens. Single row (id = 1), updated on every refresh.
-- Lives in D1 rather than Worker secrets because Intuit ROTATES the refresh
-- token and secrets aren't writable at runtime.
CREATE TABLE IF NOT EXISTS qbo_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER,               -- epoch ms
  realm_id TEXT
);
