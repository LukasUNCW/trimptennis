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
  notes TEXT,
  -- Set when the enrolment came from a signed-in account. Both stay NULL for
  -- guest enrolments, which remain supported on purpose: requiring an account
  -- before payment would cost real signups.
  account_id TEXT REFERENCES accounts(id),
  child_id TEXT REFERENCES children(id),
  -- Which price option was bought, e.g. '8x-month' or 'drop-in'. Several
  -- programs sell more than one, so the program name alone does not say what
  -- somebody signed up for. The id is stored rather than the label so reporting
  -- survives a rewording. NULL on rows written before options existed.
  price_option TEXT,
  -- Whole dollars, as displayed to this parent at the time. Prices change, and
  -- QuickBooks is authoritative for what was actually charged — this records
  -- what we quoted. It is also how a payment is matched back to a person: a
  -- multi-use QuickBooks payment link records no customer name, so the amount is
  -- the strongest signal the office has.
  price_quoted INTEGER,
  -- Set when the enrolment was written into QuickBooks as a customer and an
  -- invoice. Both stay NULL when QuickBooks was unreachable and the parent went
  -- to a static payment link instead, which is precisely the case the office
  -- needs to find later: an enrolment with no invoice id is one whose payment
  -- will arrive anonymously and have to be attributed by hand.
  qbo_customer_id TEXT,
  qbo_invoice_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_enrollments_account ON enrollments (account_id);

CREATE INDEX IF NOT EXISTS idx_enrollments_payment ON enrollments (payment_status);
CREATE INDEX IF NOT EXISTS idx_enrollments_program ON enrollments (program);

-- The account page reads a parent's history by account_id OR by the address
-- typed on the form, so guest enrolments made before signing up still show. The
-- expression has to be indexed the same way it is queried — an index on
-- parent_email alone would not be used by lower(parent_email) = ?.
CREATE INDEX IF NOT EXISTS idx_enrollments_parent_email ON enrollments (lower(parent_email));

-- ── weekday sessions and their capacity ─────────────────────────────────
--
-- Grom's runs Monday to Thursday and a parent chooses which days their child
-- attends. Each weekday is its own class with its own 18 places, so Monday
-- filling up says nothing about Wednesday.
--
-- Rows rather than code, unlike the program catalog in worker/programs.ts,
-- because capacity is a fact about the world that changes mid-season: a coach
-- calls in sick, a day gets added, the cap moves to 20. None of that should need
-- a deploy.
--
-- Only Grom's uses this today. The table is keyed by program anyway, because
-- Shredder's asking for the same thing next month is the obvious next request.
CREATE TABLE IF NOT EXISTS program_sessions (
  id TEXT PRIMARY KEY,              -- 'groms-mon'; stable, stored on enrolments
  program TEXT NOT NULL,            -- slug, matches worker/programs.ts
  weekday TEXT NOT NULL,            -- 'Monday'
  time_label TEXT,                  -- '4:00 – 5:00 PM', display only
  capacity INTEGER NOT NULL,
  -- A session that has stopped running but must not be deleted: enrolments
  -- reference it, and the account page resolves the id to a readable label.
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0   -- Monday before Tuesday, not alphabetical
);
CREATE INDEX IF NOT EXISTS idx_sessions_program ON program_sessions (program, active);

-- Which days a given enrolment holds a place on. One row per day chosen.
--
-- The primary key is what enforces the cap safely: capacity is checked by an
-- INSERT ... SELECT WHERE count < capacity, which is a single statement and so
-- cannot be raced by two parents taking the last place at once. A check followed
-- by an insert can be, and would be, eventually.
CREATE TABLE IF NOT EXISTS enrollment_sessions (
  enrollment_id TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES program_sessions(id),
  PRIMARY KEY (enrollment_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_enrollment_sessions_session ON enrollment_sessions (session_id);

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
  last_login_at TEXT,
  -- Staff. Set by hand in the database, never by anything the site exposes:
  -- there is no route that grants it and no form that sets it, so the only way
  -- to become an admin is for somebody with database access to say so.
  --
  -- This is authorisation, not authentication. Sign-in is the same single-use
  -- emailed link every parent uses, so an admin still has no password to leak.
  -- All this flag decides is what an already-proven identity may see.
  is_admin INTEGER NOT NULL DEFAULT 0
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
  realm_id TEXT,
  -- The OAuth `state` issued by the last /qbo/connect, cleared as soon as the
  -- callback consumes it. Without somewhere to keep it there is nothing to
  -- compare against on the way back, and /qbo/callback would accept an
  -- authorization code from anyone — overwriting the academy's connection with
  -- a stranger's company file.
  pending_state TEXT
);
