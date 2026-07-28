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

-- ── Parent accounts (see docs/ACCOUNTS.md) ──────────────────────────────
-- Sign-in is by emailed magic link, so there is no password column anywhere.

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,              -- crypto.randomUUID()
  email TEXT NOT NULL UNIQUE,       -- always stored lowercased and trimmed
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  address1 TEXT,
  address2 TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- birth_year rather than a full date: enough to derive the age group, stays
-- correct as the child ages up, and is less data about a minor than we need.
CREATE TABLE IF NOT EXISTS children (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  first_name TEXT NOT NULL,
  last_name TEXT,
  birth_year INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_children_account ON children (account_id);

-- Only the SHA-256 of the emailed token is stored, so a copy of this table
-- cannot be used to sign in as anyone. Rows are deleted on redemption.
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,      -- epoch ms
  created_at INTEGER NOT NULL       -- epoch ms, used for rate limiting
);
CREATE INDEX IF NOT EXISTS idx_login_tokens_email ON login_tokens (email, created_at);

-- Opaque session ids rather than signed tokens: revocable, no signing secret
-- to manage, and this table is the audit trail of who signed in when.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,              -- the value held in the cookie
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL,      -- epoch ms
  expires_at INTEGER NOT NULL,      -- epoch ms
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_id);

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
