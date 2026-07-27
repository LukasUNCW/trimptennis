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

const row = (label: string, value: string) =>
  `<tr><td style="padding:4px 12px 4px 0;vertical-align:top"><b>${label}</b></td><td>${value}</td></tr>`;

/**
 * Sent the moment an enrollment form is submitted — which is BEFORE the parent
 * has paid, because QuickBooks (not this Worker) processes the payment. The
 * status line says plainly whether money is expected via a payment link or a
 * monthly invoice from the office, so nobody mistakes this for a receipt.
 */
export async function notifyEnrollment(env: Env, e: {
  parent_name: string | null; parent_email: string | null; phone: string | null;
  player_name: string | null; age_group: string | null;
  program: string; payment_status: string; notes: string | null;
  /** Elite Academy — the payment link covered month one only. */
  autoDraftFollowUp?: boolean;
}): Promise<void> {
  await send(env, `New enrollment: ${e.player_name ?? e.parent_name ?? 'Unknown'} — ${e.program}`, `
    <h2 style="margin:0 0 12px">New enrollment 🎾</h2>
    <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
      ${row('Program', esc(e.program))}
      ${row('Player', `${esc(e.player_name)} (${esc(e.age_group)})`)}
      ${row('Parent', `${esc(e.parent_name)} — ${esc(e.parent_email)}`)}
      ${row('Phone', esc(e.phone))}
      ${e.notes ? row('Notes', esc(e.notes)) : ''}
      ${row('Payment', 'Sent to the QuickBooks payment link — confirm in QuickBooks that it arrived.')}
    </table>
    ${e.autoDraftFollowUp ? `
    <p style="font-family:sans-serif;font-size:14px;background:#FFF4D6;border-left:4px solid #F5B72E;padding:12px 14px;margin:16px 0 0">
      <b>Follow-up:</b> this payment covers the first month only. Set up auto draft
      in QuickBooks once ${esc(e.player_name)} has attended a month.</p>` : ''}
    <p style="font-family:sans-serif;font-size:13px;color:#666">
      This is a signup notification, not a payment confirmation. QuickBooks is the
      record of what was actually paid.</p>`);
}

export async function notifyInquiry(env: Env, q: {
  kind: string; name: string; email: string; phone?: string | null;
  player_name?: string | null; age_group?: string | null; message?: string | null;
}): Promise<void> {
  const label = q.kind === 'free_trial' ? 'Free trial request' : 'Website contact';
  await send(env, `${label}: ${q.name}`, `
    <h2 style="margin:0 0 12px">${esc(label)}</h2>
    <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
      ${row('Name', esc(q.name))}
      ${row('Email', esc(q.email))}
      ${row('Phone', esc(q.phone))}
      ${q.player_name ? row('Player', `${esc(q.player_name)} (${esc(q.age_group)})`) : ''}
      ${q.message ? row('Message', esc(q.message)) : ''}
    </table>
    <p style="font-family:sans-serif;font-size:13px;color:#666">Reply directly to reach them: ${esc(q.email)}</p>`);
}
