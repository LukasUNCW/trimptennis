-- schema.sql — run once against the D1 database (see SETUP.md)

-- Enrollments captured by our own form, BEFORE the parent is handed off to a
-- QuickBooks payment link. QuickBooks Payments processes the money and records
-- the sale, so this table is the roster — who signed up, which player, what age
-- group — which is precisely what QuickBooks does not track.
--
-- payment_status is our best knowledge, not the source of truth:
--   awaiting_payment — sent to a QuickBooks payment link, not yet confirmed
--   paid             — matched to a QuickBooks Payment
--   abandoned        — never paid (set by hand, or by a future sweep)
--
-- Elite Academy is no different here: the payment link covers month one, then
-- the office sets up auto draft in QuickBooks.
CREATE TABLE IF NOT EXISTS enrollments (
  id TEXT PRIMARY KEY,              -- crypto.randomUUID()
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  parent_name TEXT,
  parent_email TEXT,
  phone TEXT,
  player_name TEXT,
  age_group TEXT,
  program TEXT NOT NULL,            -- display name from worker/programs.ts
  payment_status TEXT NOT NULL DEFAULT 'awaiting_payment',
  qbo_payment_id TEXT,              -- QuickBooks Payment id, once reconciled
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_enrollments_payment ON enrollments (payment_status);
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
  message TEXT,
  -- Contact-form only: which topic the sender picked, so the office can route
  -- it, plus how they would rather be reached.
  email_to TEXT,
  zip TEXT,
  contact_preference TEXT           -- 'email' | 'phone'
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
