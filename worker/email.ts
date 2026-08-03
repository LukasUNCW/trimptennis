// worker/email.ts
// Notification emails via Resend (free tier: 100/day).
// Until the academy's domain is verified in Resend, FROM_EMAIL stays
// onboarding@resend.dev (Resend's shared sender for development).

import type { Env } from './types';

async function sendTo(env: Env, to: string, subject: string, html: string): Promise<boolean> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: `${env.SITE_NAME} <${env.FROM_EMAIL}>`,
      to: [to],
      subject,
      html
    })
  });
  if (!res.ok) {
    console.error('Resend failed:', res.status, await res.text());
    return false;
  }
  return true;
}

/** Notifications to the academy office. */
const send = (env: Env, subject: string, html: string): Promise<boolean> =>
  sendTo(env, env.NOTIFY_EMAIL, subject, html);

/**
 * Sign-in link — the only mail we send to a visitor rather than to the office.
 * Returns false when delivery failed, which the caller must NOT surface: whether
 * an address exists or accepted mail is not something an anonymous visitor
 * should be able to probe.
 *
 * Until the academy's domain is verified in Resend, the shared dev sender can
 * only deliver to the Resend account owner, so links to anyone else silently
 * fail. See docs/ACCOUNTS.md.
 */
export function sendMagicLink(env: Env, to: string, url: string): Promise<boolean> {
  return sendTo(env, to, `Sign in to ${env.SITE_NAME}`, `
    <h2 style="margin:0 0 14px;font-family:sans-serif;color:#0A2240">Sign in 🎾</h2>
    <p style="font-family:sans-serif;font-size:15px;color:#15263D;margin:0 0 22px">
      Click the button below to sign in to your ${esc(env.SITE_NAME)} account.
      The link works once and expires in 15 minutes.</p>
    <p style="margin:0 0 24px">
      <a href="${esc(url)}" style="display:inline-block;background:#077A78;color:#fff;
         font-family:sans-serif;font-weight:700;font-size:15px;text-decoration:none;
         padding:13px 26px;border-radius:999px">Sign in</a></p>
    <p style="font-family:sans-serif;font-size:13px;color:#666;margin:0 0 6px">
      If the button does not work, paste this into your browser:</p>
    <p style="font-family:monospace;font-size:12px;color:#666;word-break:break-all;margin:0 0 22px">
      ${esc(url)}</p>
    <p style="font-family:sans-serif;font-size:13px;color:#666;margin:0">
      Didn't ask to sign in? You can ignore this email — nobody can get into your
      account without this link.</p>`);
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
  /** Which price option was bought, e.g. "8 classes / month". */
  optionLabel?: string | null;
  /** Whole dollars as shown to the parent, or null when the option is unpriced. */
  price_quoted?: number | null;
  /** A first month of membership — auto draft has to be set up afterwards. */
  autoDraftFollowUp?: boolean;
  /**
   * How this parent was sent to pay. Drives the Payment line, which is the only
   * thing telling the office whether anything is waiting on them:
   *
   * - `invoice`        — invoice raised, parent sent to its pay page. Nothing to do.
   * - `invoice-unsent` — invoice raised but QuickBooks issued no pay link, so
   *                      somebody has to send it from QuickBooks.
   * - `static-link`    — QuickBooks was unreachable; the old shared link was used
   *                      and the payment will arrive with no customer on it.
   * - `timeout`        — QuickBooks did not answer in time and may or may not
   *                      have raised an invoice. Somebody has to look before
   *                      taking payment another way.
   * - `none`           — no way to pay yet; the office calls them.
   */
  paymentRoute?: 'invoice' | 'invoice-unsent' | 'static-link' | 'sandbox' | 'timeout' | 'none';
  /** QuickBooks invoice number, when one was raised. */
  invoiceId?: string | null;
}): Promise<void> {
  // Says plainly whether anything is waiting on the office. The two lines that
  // ask for action are worded as instructions, because the failure mode here is
  // an email that reads like a receipt and gets filed.
  const paymentLine = (route: string | undefined, invoiceId: string | null | undefined) => {
    const inv = invoiceId ? ` (invoice ${esc(invoiceId)})` : '';
    switch (route) {
      case 'invoice':
        return `Invoice raised in QuickBooks${inv} and the parent was sent to pay it. Nothing to do.`;
      case 'invoice-unsent':
        return `<b>Action:</b> invoice raised in QuickBooks${inv}, but no payment link came back — send it from QuickBooks.`;
      case 'static-link':
        return '<b>Action:</b> QuickBooks could not be reached, so the old shared payment link was used. This payment will arrive with no customer on it and will need attributing by hand.';
      case 'sandbox':
        return `TEST MODE — an invoice${inv} was raised in the QuickBooks <b>sandbox</b>, not the academy's books. The parent was sent to the usual payment link, so a real payment will arrive as normal and still needs attributing by hand.`;
      case 'timeout':
        return '<b>Action:</b> QuickBooks did not respond in time. An invoice may or may not have been raised — check QuickBooks for this parent BEFORE taking payment another way, or they could be charged twice.';
      case 'none':
        return '<b>Action:</b> no payment link for this option — call them to take payment.';
      default:
        return 'Sent to the QuickBooks payment link — confirm in QuickBooks that it arrived.';
    }
  };

  // The amount goes in the subject line because a multi-use QuickBooks payment
  // link records no customer name: when the office reconciles, the amount is
  // what ties a payment back to a person, so it needs to be findable by search.
  const money = typeof e.price_quoted === 'number' ? ` · $${e.price_quoted}` : '';
  await send(env, `New enrollment: ${e.player_name ?? e.parent_name ?? 'Unknown'} — ${e.program}${money}`, `
    <h2 style="margin:0 0 12px">New enrollment 🎾</h2>
    <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
      ${row('Program', esc(e.program))}
      ${e.optionLabel ? row('Option', `${esc(e.optionLabel)}${
        typeof e.price_quoted === 'number' ? ` — <b>$${e.price_quoted}</b>` : ' — <i>price to be confirmed</i>'
      }`) : ''}
      ${row('Player', `${esc(e.player_name)} (${esc(e.age_group)})`)}
      ${e.parent_name
        ? row('Parent', `${esc(e.parent_name)} — ${esc(e.parent_email)}`)
        : row('Contact', esc(e.parent_email))}
      ${row('Phone', esc(e.phone))}
      ${e.notes ? row('Notes', esc(e.notes)) : ''}
      ${row('Payment', paymentLine(e.paymentRoute, e.invoiceId))}
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
  email_to?: string | null; zip?: string | null; contact_preference?: string | null;
}): Promise<void> {
  const label = q.kind === 'free_trial' ? 'Free trial request' : 'Website contact';
  // The topic belongs in the subject line — it is how the office decides who
  // picks the message up.
  const subject = q.email_to ? `${label} — ${q.email_to}: ${q.name}` : `${label}: ${q.name}`;
  const wantsPhone = q.contact_preference === 'phone';

  await send(env, subject, `
    <h2 style="margin:0 0 12px">${esc(label)}</h2>
    <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
      ${q.email_to ? row('Regarding', esc(q.email_to)) : ''}
      ${row('Name', esc(q.name))}
      ${row('Email', esc(q.email))}
      ${row('Phone', esc(q.phone))}
      ${q.zip ? row('Zip', esc(q.zip)) : ''}
      ${q.player_name ? row('Player', `${esc(q.player_name)} (${esc(q.age_group)})`) : ''}
      ${q.message ? row('Message', esc(q.message)) : ''}
    </table>
    ${q.contact_preference ? `
    <p style="font-family:sans-serif;font-size:14px;padding:11px 14px;margin:16px 0 0;
       background:${wantsPhone ? '#FFF4D6' : '#EDF6F6'};border-left:4px solid ${wantsPhone ? '#F5B72E' : '#077A78'}">
      <b>Prefers ${wantsPhone ? 'a phone call' : 'email'}:</b>
      ${wantsPhone ? esc(q.phone) : esc(q.email)}</p>` : `
    <p style="font-family:sans-serif;font-size:13px;color:#666">Reply directly to reach them: ${esc(q.email)}</p>`}`);
}
