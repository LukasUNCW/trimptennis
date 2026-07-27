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
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_API_KEY: string;
  TURNSTILE_SECRET: string;
  QBO_CLIENT_ID: string;
  QBO_CLIENT_SECRET: string;
  ADMIN_KEY: string; // simple shared secret protecting /qbo/connect
}

export interface EnrollmentRow {
  id: string;
  parent_name: string | null;
  parent_email: string | null;
  player_name: string | null;
  age_group: string | null;
  program: string;
  amount_cents: number;
  currency: string;
  mode: string;
  stripe_customer_id: string | null;
  qbo_status: string;
  qbo_attempts: number;
}
