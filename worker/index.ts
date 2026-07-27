// worker/index.ts
// One Worker, two jobs:
//   1. Static site — requests matching files in ./site are served automatically
//      by the assets layer and never reach this code.
//   2. API routes — everything else lands here:
//        GET  /api/programs  catalog the enrollment form builds its menus from
//        POST /api/enroll    enrollment form → D1 + email, returns the
//                            QuickBooks payment link to redirect the parent to
//        POST /api/inquiry   free-trial / contact form → D1 + email (Turnstile-gated)
//        GET  /qbo/connect   redirects admin to Intuit authorization (ADMIN_KEY-gated)
//        GET  /qbo/callback  Intuit OAuth redirect target
//        GET  /qbo/items     lists QBO Items (ADMIN_KEY-gated)
//
// Payments are processed by QuickBooks Payments, so money and bookkeeping never
// leave Intuit — there is no payment webhook to consume and no sales receipt to
// write. This Worker owns the roster (who signed up, which player, what age
// group) because that is the part QuickBooks does not track.

import type { Env } from './types';
import { lookupProgram, listPrograms } from './programs';
import { buildAuthUrl, exchangeCodeForTokens, listItems } from './qbo';
import { notifyEnrollment, notifyInquiry } from './email';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (request.method === 'GET' && pathname === '/api/programs') {
        return json(listPrograms());
      }
      if (request.method === 'GET' && pathname === '/api/inquiry-topics') {
        return json(INQUIRY_TOPICS);
      }
      if (request.method === 'POST' && pathname === '/api/enroll') {
        return await handleEnroll(request, env, ctx);
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
        return text('QuickBooks connected. You can close this tab.');
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
  }
} satisfies ExportedHandler<Env>;

// ── Route handlers ───────────────────────────────────────────────────────

// Records the enrollment BEFORE the parent pays, then hands them off to the
// program's QuickBooks payment link. We keep the roster row either way: if the
// parent abandons checkout the office still has the lead, and QuickBooks is the
// source of truth for whether money actually arrived.
async function handleEnroll(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const human = await verifyTurnstile(env, body.turnstileToken, request.headers.get('CF-Connecting-IP'));
  if (!human) return json({ error: 'Verification failed — please retry.' }, 403);

  const program = lookupProgram(body.program);
  if (!program) return json({ error: 'Unknown program.' }, 400);

  const parent_email = str(body.parent_email, 200);
  const player_name = str(body.player_name, 100);
  if (!player_name || !parent_email || !parent_email.includes('@')) {
    return json({ error: 'A name and a valid email address are required.' }, 400);
  }

  // Adults enrol themselves, so a guardian is required only for the youth
  // programs — and is discarded outright on a self-enrol program rather than
  // trusted from the request body.
  const parent_name = program.selfEnroll ? null : str(body.parent_name, 100);
  if (!program.selfEnroll && !parent_name) {
    return json({ error: 'A parent or guardian name is required.' }, 400);
  }

  const age_group = str(body.age_group, 40);
  if (!age_group || !program.ageGroups.includes(age_group)) {
    return json({ error: `Choose an age group: ${program.ageGroups.join(', ')}` }, 400);
  }

  const row = {
    id: crypto.randomUUID(),
    parent_name,
    parent_email,
    phone: str(body.phone, 40),
    player_name,
    age_group,
    program: program.name,
    payment_status: 'awaiting_payment',
    notes: str(body.notes, 2000)
  };

  await env.DB
    .prepare(
      `INSERT INTO enrollments
       (id, parent_name, parent_email, phone, player_name, age_group, program, payment_status, notes)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`
    )
    .bind(row.id, row.parent_name, row.parent_email, row.phone, row.player_name,
          row.age_group, row.program, row.payment_status, row.notes)
    .run();

  ctx.waitUntil(notifyEnrollment(env, {
    ...row,
    autoDraftFollowUp: program.autoDraftAfterFirstMonth === true
  }));

  return json({
    ok: true,
    enrollmentId: row.id,
    // null until Katie has created this program's payment link — the site then
    // shows a "the office will follow up" confirmation instead of redirecting.
    payUrl: program.payUrl
  });
}

// Topics offered by the contact form's "Email to" menu. Served to the form at
// /api/inquiry-topics and validated against here, so the two cannot drift.
const INQUIRY_TOPICS = [
  'General Inquiry',
  'Junior Programs',
  'Adult Programs',
  'Elite Academy',
  'Summer Camp',
  'Billing & Payments'
];

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

  // Unrecognised topics are dropped rather than stored, so the value in the
  // office's inbox is always one the form actually offers.
  const topic = str(body.email_to, 60);
  const pref = body.contact_preference === 'phone' ? 'phone' : 'email';

  const record = {
    id: crypto.randomUUID(),
    kind,
    name,
    email,
    phone: str(body.phone, 40),
    player_name: str(body.player_name, 100),
    age_group: str(body.age_group, 40),
    message: str(body.message, 2000),
    email_to: topic && INQUIRY_TOPICS.includes(topic) ? topic : null,
    zip: str(body.zip, 20),
    contact_preference: kind === 'contact' ? pref : null
  };

  // Asking to be phoned back without leaving a number would strand the office.
  if (record.contact_preference === 'phone' && !record.phone) {
    return json({ error: 'Please add a phone number, or choose email instead.' }, 400);
  }

  await env.DB
    .prepare(
      `INSERT INTO inquiries
       (id, kind, name, email, phone, player_name, age_group, message,
        email_to, zip, contact_preference)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
    )
    .bind(record.id, record.kind, record.name, record.email, record.phone,
          record.player_name, record.age_group, record.message,
          record.email_to, record.zip, record.contact_preference)
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
