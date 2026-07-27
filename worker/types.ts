// worker/types.ts

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  // vars (wrangler.jsonc)
  QBO_SANDBOX: string;
  NOTIFY_EMAIL: string;
  FROM_EMAIL: string;
  SITE_NAME: string;

  // secrets (`wrangler secret put <NAME>`)
  RESEND_API_KEY: string;
  TURNSTILE_SECRET: string;
  QBO_CLIENT_ID: string;
  QBO_CLIENT_SECRET: string;
  ADMIN_KEY: string; // simple shared secret protecting the /qbo/* setup routes
}

export interface EnrollmentRow {
  id: string;
  created_at: string;
  parent_name: string | null;
  parent_email: string | null;
  phone: string | null;
  player_name: string | null;
  age_group: string | null;
  program: string;
  /** awaiting_payment | paid | office_billed | abandoned */
  payment_status: string;
  /** QuickBooks Payment id, once the payment has been matched to this row. */
  qbo_payment_id: string | null;
  notes: string | null;
}
