// worker/email.ts
// Notification emails via Resend (free tier: 100/day).
// Until the academy's domain is verified in Resend, FROM_EMAIL stays
// onboarding@resend.dev (Resend's shared sender for development).

import type { Env } from './types';

async function send(env: Env, subject: string, html: string): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: `${env.SITE_NAME} <${env.FROM_EMAIL}>`,
      to: [env.NOTIFY_EMAIL],
      subject,
      html
    })
  });
  if (!res.ok) console.error('Resend failed:', res.status, await res.text());
}

const esc = (s: unknown) =>
  String(s ?? '—').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export async function notifyEnrollment(env: Env, e: {
  parent_name: string | null; parent_email: string | null;
  player_name: string | null; age_group: string | null;
  program: string; amount_cents: number; mode: string;
}): Promise<void> {
  const amount = `$${(e.amount_cents / 100).toFixed(2)}`;
  const kind = e.mode === 'subscription' ? 'New membership' : 'New enrollment';
  await send(env, `${kind}: ${e.player_name ?? e.parent_name ?? 'Unknown'} — ${e.program} (${amount})`, `
    <h2 style="margin:0 0 12px">${esc(kind)} 🎾</h2>
    <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:4px 12px 4px 0"><b>Program</b></td><td>${esc(e.program)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0"><b>Player</b></td><td>${esc(e.player_name)} (${esc(e.age_group)})</td></tr>
      <tr><td style="padding:4px 12px 4px 0"><b>Parent</b></td><td>${esc(e.parent_name)} — ${esc(e.parent_email)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0"><b>Amount</b></td><td>${amount}${e.mode === 'subscription' ? ' / month' : ''}</td></tr>
    </table>
    <p style="font-family:sans-serif;font-size:13px;color:#666">Full details are in the Stripe dashboard. Bookkeeping syncs to QuickBooks automatically.</p>`);
}

export async function notifyInquiry(env: Env, q: {
  kind: string; name: string; email: string; phone?: string | null;
  player_name?: string | null; age_group?: string | null; message?: string | null;
}): Promise<void> {
  const label = q.kind === 'free_trial' ? 'Free trial request' : 'Website contact';
  await send(env, `${label}: ${q.name}`, `
    <h2 style="margin:0 0 12px">${esc(label)}</h2>
    <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:4px 12px 4px 0"><b>Name</b></td><td>${esc(q.name)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0"><b>Email</b></td><td>${esc(q.email)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0"><b>Phone</b></td><td>${esc(q.phone)}</td></tr>
      ${q.player_name ? `<tr><td style="padding:4px 12px 4px 0"><b>Player</b></td><td>${esc(q.player_name)} (${esc(q.age_group)})</td></tr>` : ''}
      ${q.message ? `<tr><td style="padding:4px 12px 4px 0;vertical-align:top"><b>Message</b></td><td>${esc(q.message)}</td></tr>` : ''}
    </table>
    <p style="font-family:sans-serif;font-size:13px;color:#666">Reply directly to reach them: ${esc(q.email)}</p>`);
}
