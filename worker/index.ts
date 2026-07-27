// worker/index.ts
// One Worker, two jobs:
//   1. Static site — requests matching files in ./site are served automatically
//      by the assets layer and never reach this code.
//   2. API routes — everything else lands here:
//        POST /webhook       Stripe events → D1 + QBO sync + email to Katie
//        POST /api/inquiry   free-trial / contact form → D1 + email (Turnstile-gated)
//        GET  /qbo/connect   redirects admin to Intuit authorization (ADMIN_KEY-gated)
//        GET  /qbo/callback  Intuit OAuth redirect target
//        GET  /qbo/items     lists QBO Items to fill PLAN_ITEM_MAP (ADMIN_KEY-gated)
//   Cron (nightly): retries unsynced enrollments.

import type { Env } from './types';
import { verifyStripeSignature, extractEnrollment } from './stripe';
import { buildAuthUrl, exchangeCodeForTokens, syncEnrollment, retryUnsynced, listItems } from './qbo';
import { notifyEnrollment, notifyInquiry } from './email';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (request.method === 'POST' && pathname === '/webhook') {
        return await handleStripeWebhook(request, env, ctx);
      }
      if (request.method === 'POST' && pathname === '/api/inquiry') {
        return await handleInquiry(request, env, ctx);
      }
      if (request.method === 'GET' && pathname === '/qbo/connect') {
        requireAdmin(url, env);
        return Response.redirect(buildAuthUrl(env, url.origin), 302);
      }
      if (request.method === 'GET' && pathname === '/qbo/callback') {
        const code = url.searchParams.get('code');
        const realmId = url.searchParams.get('realmId');
        if (!code || !realmId) return text('Missing code or realmId — restart authorization.', 400);
        await exchangeCodeForTokens(env, url.origin, code, realmId);
        return text('QuickBooks connected. You can close this tab — enrollments now sync automatically.');
      }
      if (request.method === 'GET' && pathname === '/qbo/items') {
        requireAdmin(url, env);
        const items = await listItems(env);
        return json(items.map((i: any) => ({ id: i.Id, name: i.Name, type: i.Type })));
      }

      // Anything else: let the static asset layer answer (e.g. its 404).
      return env.ASSETS.fetch(request);
    } catch (err: any) {
      if (err instanceof Response) return err; // requireAdmin throws a Response
      console.error(`Unhandled error on ${pathname}:`, err?.message ?? err);
      return text('Internal error', 500);
    }
  },

  // Nightly QBO retry sweep (cron in wrangler.jsonc)
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      retryUnsynced(env).then((n) => console.log(`QBO retry sweep processed ${n} rows`))
    );
  }
} satisfies ExportedHandler<Env>;

// ── Route handlers ───────────────────────────────────────────────────────

async function handleStripeWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const rawBody = await request.text();
  const valid = await verifyStripeSignature(
    rawBody, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET
  );
  if (!valid) return text('Invalid signature', 400);

  const event = JSON.parse(rawBody);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status !== 'paid') return text('ok (not paid yet)');

    const e = extractEnrollment(session);

    // Idempotent insert — Stripe retries webhooks, and that's fine.
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO enrollments
         (id, parent_name, parent_email, player_name, age_group, program,
          amount_cents, currency, mode, stripe_customer_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`
      )
      .bind(e.id, e.parent_name, e.parent_email, e.player_name, e.age_group,
            e.program, e.amount_cents, e.currency, e.mode, e.stripe_customer_id)
      .run();

    // Email + QBO happen after we ACK Stripe — never block or fail the webhook.
    ctx.waitUntil(notifyEnrollment(env, e));
    ctx.waitUntil(
      env.DB.prepare('SELECT * FROM enrollments WHERE id = ?1').bind(e.id).first<any>()
        .then((row) => (row ? syncEnrollment(env, row) : undefined))
    );
  }

  // Other event types (invoice.paid renewals, refunds) are acknowledged and
  // ignored in v1 — logged so we can see what's flowing before we handle them.
  else {
    console.log('Unhandled Stripe event type:', event.type);
  }

  return text('ok');
}

async function handleInquiry(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  // Bot gate: Cloudflare Turnstile
  const human = await verifyTurnstile(env, body.turnstileToken, request.headers.get('CF-Connecting-IP'));
  if (!human) return json({ error: 'Verification failed — please retry.' }, 403);

  const kind = body.kind === 'contact' ? 'contact' : 'free_trial';
  const name = str(body.name, 100);
  const email = str(body.email, 200);
  if (!name || !email || !email.includes('@')) {
    return json({ error: 'Name and a valid email are required.' }, 400);
  }

  const record = {
    id: crypto.randomUUID(),
    kind,
    name,
    email,
    phone: str(body.phone, 40),
    player_name: str(body.player_name, 100),
    age_group: str(body.age_group, 40),
    message: str(body.message, 2000)
  };

  await env.DB
    .prepare(
      `INSERT INTO inquiries (id, kind, name, email, phone, player_name, age_group, message)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`
    )
    .bind(record.id, record.kind, record.name, record.email, record.phone,
          record.player_name, record.age_group, record.message)
    .run();

  ctx.waitUntil(notifyInquiry(env, record));
  return json({ ok: true });
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function verifyTurnstile(env: Env, token: unknown, ip: string | null): Promise<boolean> {
  if (typeof token !== 'string' || !token) return false;
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip ?? undefined })
  });
  const data: any = await res.json();
  return data.success === true;
}

function requireAdmin(url: URL, env: Env): void {
  if (url.searchParams.get('key') !== env.ADMIN_KEY) {
    throw json({ error: 'Unauthorized' }, 401);
  }
}

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

const text = (s: string, status = 200) =>
  new Response(s, { status, headers: { 'Content-Type': 'text/plain' } });

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
