// worker/admin.ts
// The office roster: everyone who has registered, and who is in which class.
//
// Read-only, deliberately. Viewing is a page; marking paid, cancelling, moving a
// child between days and adding someone who phoned in are four write paths with
// their own edge cases. Better to learn what the office actually reaches for
// than to guess at buttons.
//
// ACCESS. This is gated by ADMIN_KEY, the same shared secret as /qbo/*, which is
// adequate for one person checking a roster and NOT adequate for what this page
// holds: children's names and ages next to their parents' phone numbers and
// email addresses, all on one screen. It is the most sensitive thing in the
// project.
//
// Before this reaches routine office use it belongs behind Cloudflare Access —
// free to 50 users, an allow-list of email addresses, and a one-time code or
// Google sign-in before the Worker runs at all. That is also the position
// SCOPE.md section 4 already took, and the reason there is no staff login here:
// this system stores no passwords anywhere, and the page with the children on it
// is the last place to start.

import type { Env } from './types';
import { PROGRAMS } from './programs';
import { qboConfigured, getInvoice } from './qbo';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

interface Row {
  id: string;
  created_at: string;
  player_name: string | null;
  age_group: string | null;
  parent_name: string | null;
  parent_email: string | null;
  phone: string | null;
  program: string;
  price_option: string | null;
  price_quoted: number | null;
  payment_status: string;
  qbo_invoice_id: string | null;
  notes: string | null;
}

interface DayRow {
  enrollment_id: string;
  session_id: string;
  weekday: string;
  sort: number;
  program: string;
  capacity: number;
}

async function load(env: Env) {
  const [enrolments, days] = await Promise.all([
    env.DB
      .prepare(
        `SELECT id, created_at, player_name, age_group, parent_name, parent_email,
                phone, program, price_option, price_quoted, payment_status,
                qbo_invoice_id, notes
           FROM enrollments ORDER BY created_at DESC`
      )
      .all<Row>(),
    env.DB
      .prepare(
        `SELECT es.enrollment_id, es.session_id, s.weekday, s.sort, s.program, s.capacity
           FROM enrollment_sessions es
           JOIN program_sessions s ON s.id = es.session_id
          ORDER BY s.sort, s.weekday`
      )
      .all<DayRow>()
  ]);

  // Grouped in JS rather than with GROUP_CONCAT, because SQLite gives no
  // guarantee about the order inside a group and "Thursday, Monday" on a
  // register is the kind of small wrongness that makes people stop trusting a
  // page.
  const byEnrolment = new Map<string, DayRow[]>();
  for (const d of days.results ?? []) {
    const list = byEnrolment.get(d.enrollment_id) ?? [];
    list.push(d);
    byEnrolment.set(d.enrollment_id, list);
  }
  return { rows: enrolments.results ?? [], byEnrolment };
}

/**
 * D1's payment_status is written once at enrolment time and never updated —
 * there is no webhook telling this Worker when QuickBooks later collects the
 * money, so the column is useless for "has this actually been paid?" (see
 * Stephanie Golshani, 2026-08-12: enrolled and invoiced, but never reached the
 * QuickBooks pay screen, and nothing here would have caught that on its own).
 * This asks QuickBooks directly, per invoice, so the roster can flag it.
 *
 * Best-effort: a lookup that throws (rate limit, expired token) is reported as
 * 'unknown' rather than failing the whole page — the office losing the roster
 * because one invoice lookup hiccupped would be worse than one blank badge.
 */
async function paymentStates(
  env: Env,
  invoiceIds: string[]
): Promise<Map<string, { paid: boolean; payLink: string | null }>> {
  const out = new Map<string, { paid: boolean; payLink: string | null }>();
  if (!qboConfigured(env) || invoiceIds.length === 0) return out;

  // Firing every lookup at once used to be fine when the roster was small, but
  // at today's scale (dozens of invoices) a burst that size occasionally trips
  // QuickBooks' rate/concurrency limit — enough failures come back as
  // 'unknown' that the "unpaid" count visibly changed on every reload
  // (Wylie Beam appearing and disappearing, 2026-08-27). A small batch size
  // keeps peak concurrency low without making the page noticeably slower.
  const BATCH_SIZE = 6;
  const attempt = async (ids: string[]) => {
    await Promise.all(
      ids.map(async (id) => {
        try {
          const inv = await getInvoice(env, id);
          out.set(id, { paid: inv.paid, payLink: inv.payLink });
        } catch {
          // Left out of the map for this pass; retried once more below.
        }
      })
    );
  };
  for (let i = 0; i < invoiceIds.length; i += BATCH_SIZE) {
    await attempt(invoiceIds.slice(i, i + BATCH_SIZE));
  }

  // One more pass, batched the same way, for whatever still failed — a
  // transient rate-limit is exactly the kind of failure a second try clears.
  const stillMissing = invoiceIds.filter((id) => !out.has(id));
  for (let i = 0; i < stillMissing.length; i += BATCH_SIZE) {
    await attempt(stillMissing.slice(i, i + BATCH_SIZE));
  }

  return out;
}

/** Label for a stored price_option id, resolved through the catalog. */
function optionLabel(program: string, optionId: string | null): string {
  if (!optionId) return '';
  for (const p of Object.values(PROGRAMS)) {
    if (p.name !== program) continue;
    const o = p.options.find((x) => x.id === optionId);
    if (o) return o.label;
  }
  return optionId;
}

const money = (n: number | null) => (typeof n === 'number' ? `$${n}` : '');

/** Just the date. Times are noise on a register. */
const day = (iso: string) => esc(String(iso).slice(0, 10));

export async function adminCsv(env: Env): Promise<Response> {
  const { rows, byEnrolment } = await load(env);
  const cell = (v: unknown) => {
    const s = String(v ?? '');
    // Quote everything rather than deciding per value. A parent's note with a
    // comma in it silently shifting every later column is the classic way a CSV
    // export becomes worse than no export.
    return `"${s.replace(/"/g, '""')}"`;
  };
  const header = [
    'Enrolled', 'Player', 'Age group', 'Days', 'Program', 'Option', 'Price',
    'Parent', 'Email', 'Phone', 'Invoice', 'Status', 'Notes'
  ];
  const lines = [header.map(cell).join(',')];
  for (const r of rows) {
    lines.push([
      String(r.created_at).slice(0, 10),
      r.player_name, r.age_group,
      (byEnrolment.get(r.id) ?? []).map((d) => d.weekday).join(' '),
      r.program, optionLabel(r.program, r.price_option),
      typeof r.price_quoted === 'number' ? r.price_quoted : '',
      r.parent_name, r.parent_email, r.phone,
      r.qbo_invoice_id, r.payment_status, r.notes
    ].map(cell).join(','));
  }
  return new Response('﻿' + lines.join('\r\n'), {
    headers: {
      // The BOM is for Excel, which otherwise renders any accented name as
      // mojibake and makes the whole export look broken.
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="seahawks-roster.csv"',
      'Cache-Control': 'no-store'
    }
  });
}

export async function adminPage(env: Env, key: string): Promise<Response> {
  const { rows, byEnrolment } = await load(env);

  // Abandoned rows are excluded from the live lookup entirely: a voided
  // invoice has balance 0, same as a paid one, so re-checking QuickBooks for
  // one would show it as "Paid" — wrong, and the opposite of what abandoned
  // means. Our own terminal status is trusted instead; see the Payment cell.
  const invoiceIds = [...new Set(
    rows.filter((r) => r.payment_status !== 'abandoned')
      .map((r) => r.qbo_invoice_id).filter((id): id is string => !!id)
  )];
  const payments = await paymentStates(env, invoiceIds);
  const unpaid = rows.filter((r) => r.qbo_invoice_id && payments.get(r.qbo_invoice_id)?.paid === false);
  // Timed out (see HOLD_MINUTES in worker/index.ts): never paid, so the seat
  // was released and the invoice voided. The parent's own copy of the "Saved —
  // ready to pay" screen said this could happen, but nothing tells them it
  // actually did — Katie's request, 2026-08-23, after a parent (Megan Bunnell)
  // emailed in thinking her daughter was enrolled.
  const timedOut = rows.filter((r) => r.payment_status === 'abandoned');

  // ── registers, one per weekday that has a session ──
  const sessions = await env.DB
    .prepare(
      `SELECT id, program, weekday, time_label, capacity, sort
         FROM program_sessions WHERE active = 1 ORDER BY program, sort, weekday`
    )
    .all<{ id: string; program: string; weekday: string; time_label: string | null; capacity: number; sort: number }>();

  const playersBySession = new Map<string, string[]>();
  for (const r of rows) {
    for (const d of byEnrolment.get(r.id) ?? []) {
      const list = playersBySession.get(d.session_id) ?? [];
      list.push(r.player_name ?? '(no name)');
      playersBySession.set(d.session_id, list);
    }
  }

  const registers = (sessions.results ?? []).map((s) => {
    const players = (playersBySession.get(s.id) ?? []).sort((a, b) => a.localeCompare(b));
    const left = Math.max(0, s.capacity - players.length);
    return `
      <section class="reg">
        <h3>${esc(s.weekday)}
          <span class="count${left === 0 ? ' full' : ''}">${players.length} / ${s.capacity}</span></h3>
        ${s.time_label ? `<p class="muted">${esc(s.time_label)}</p>` : ''}
        <ol>${players.map((p) => `<li>${esc(p)}</li>`).join('') || '<li class="muted">Nobody yet</li>'}</ol>
      </section>`;
  }).join('');

  const byProgram = new Map<string, number>();
  for (const r of rows) byProgram.set(r.program, (byProgram.get(r.program) ?? 0) + 1);
  const totals = [...byProgram.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `<span class="pill">${esc(p)} <b>${n}</b></span>`)
    .join('');

  const body = rows.map((r) => {
    const days = (byEnrolment.get(r.id) ?? []).map((d) => d.weekday);
    return `
      <tr>
        <td class="nowrap">${day(r.created_at)}</td>
        <td><b>${esc(r.player_name)}</b><span class="sub">${esc(r.age_group)}</span></td>
        <td>${days.length ? days.map((d) => `<span class="day">${esc(d.slice(0, 3))}</span>`).join('') : '<span class="muted">—</span>'}</td>
        <td>${esc(r.program)}<span class="sub">${esc(optionLabel(r.program, r.price_option))}</span></td>
        <td class="nowrap">${money(r.price_quoted)}</td>
        <td>${esc(r.parent_name) || '<span class="muted">self</span>'}
          <span class="sub"><a href="mailto:${esc(r.parent_email)}">${esc(r.parent_email)}</a></span></td>
        <td class="nowrap">${r.phone ? `<a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : '<span class="muted">—</span>'}</td>
        <td class="nowrap">${r.qbo_invoice_id
          ? esc(r.qbo_invoice_id)
          : '<span class="muted">not invoiced</span>'}</td>
        <td class="nowrap">${(() => {
          if (r.payment_status === 'abandoned') return '<span class="badge expired">Expired hold</span>';
          if (!r.qbo_invoice_id) return '<span class="muted">—</span>';
          const p = payments.get(r.qbo_invoice_id);
          if (!p) return '<span class="muted">unknown</span>';
          return p.paid
            ? '<span class="badge paid">Paid</span>'
            : `<span class="badge unpaid">Unpaid</span>${p.payLink ? ` <a href="${esc(p.payLink)}">link</a>` : ''}`;
        })()}</td>
        <td>${r.notes ? esc(r.notes) : ''}</td>
      </tr>`;
  }).join('');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Roster — Seahawks Tennis Academy</title>
<style>
  :root { --navy:#0A2240; --teal:#077A78; --line:#D5DCE5; --mute:#5A6B80; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--navy); background:#F7F9FC; }
  header { background:var(--navy); color:#fff; padding:18px 22px; }
  header h1 { margin:0; font-size:1.15rem; }
  header p { margin:6px 0 0; color:#B9C6D8; font-size:.85rem; }
  .head-row { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; }
  .head-nav { display:flex; gap:14px; font-size:.9rem; white-space:nowrap; }
  .head-nav a { color:#fff; text-decoration:none; border-bottom:1px solid rgba(255,255,255,.35); padding-bottom:1px; }
  .head-nav a:hover { border-bottom-color:#fff; }
  main { padding:22px; max-width:1500px; margin:0 auto; }
  .pill { display:inline-block; background:#fff; border:1px solid var(--line); border-radius:999px; padding:4px 12px; margin:0 8px 8px 0; font-size:.85rem; }
  .pill b { color:var(--teal); }
  .bar { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin:14px 0 18px; }
  input[type=search] { flex:1; min-width:220px; padding:9px 12px; border:1px solid var(--line); border-radius:8px; font-size:15px; }
  .btn { display:inline-block; background:var(--teal); color:#fff; text-decoration:none; padding:9px 16px; border-radius:8px; font-weight:600; font-size:.9rem; }
  .regs { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; margin-bottom:26px; }
  .reg { background:#fff; border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .reg h3 { margin:0 0 4px; font-size:.95rem; display:flex; justify-content:space-between; align-items:center; gap:8px; }
  .count { font-variant-numeric:tabular-nums; color:var(--teal); font-weight:700; }
  .count.full { color:#A8434B; }
  .reg ol { margin:8px 0 0; padding-left:20px; font-size:.9rem; }
  .reg li { margin:2px 0; }
  table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  th { text-align:left; font-size:.75rem; text-transform:uppercase; letter-spacing:.04em; color:var(--mute); padding:10px; border-bottom:1px solid var(--line); background:#FBFCFE; }
  td { padding:10px; border-bottom:1px solid #EEF1F5; vertical-align:top; }
  tr:last-child td { border-bottom:0; }
  .sub { display:block; color:var(--mute); font-size:.82rem; }
  .sub a { color:var(--mute); }
  .muted { color:var(--mute); }
  .nowrap { white-space:nowrap; }
  .day { display:inline-block; background:#E7F3F3; color:var(--teal); border-radius:5px; padding:1px 6px; margin-right:3px; font-size:.78rem; font-weight:600; }
  a { color:var(--teal); }
  .badge { display:inline-block; border-radius:5px; padding:1px 7px; font-size:.78rem; font-weight:600; }
  .badge.paid { background:#E4F3E8; color:#1F7A42; }
  .badge.unpaid { background:#FBE7E9; color:#A8434B; }
  .badge.expired { background:#EEF1F5; color:var(--mute); }
  .unpaid-callout { background:#FFF7ED; border:1px solid #F3C98B; border-radius:10px; padding:14px 18px; margin-bottom:22px; }
  .unpaid-callout h2 { margin:0 0 4px; font-size:1rem; color:#8A5A1E; }
  .unpaid-callout ul { list-style:none; margin:12px 0 0; padding:0; }
  .unpaid-callout li { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:8px 0; border-top:1px solid #F3E3C6; }
  .unpaid-callout li:first-child { border-top:0; }
  .timedout-callout { background:#EEF1F5; border:1px solid var(--line); border-radius:10px; padding:14px 18px; margin-bottom:22px; }
  .timedout-callout h2 { margin:0 0 4px; font-size:1rem; color:var(--mute); }
  .timedout-callout ul { list-style:none; margin:12px 0 0; padding:0; }
  .timedout-callout li { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:8px 0; border-top:1px solid var(--line); }
  .timedout-callout li:first-child { border-top:0; }
  .btn-sm { display:inline-block; background:var(--teal); color:#fff; text-decoration:none; padding:4px 10px; border-radius:6px; font-weight:600; font-size:.8rem; }
  @media (max-width:900px) { table { font-size:.85rem; } td,th { padding:7px; } }
</style></head>
<body>
<header>
  <div class="head-row">
    <div>
      <h1>Roster</h1>
      <p>${rows.length} enrolment${rows.length === 1 ? '' : 's'} · read-only · this page lists children and contact details, so treat the link as private</p>
    </div>
    <!-- A way out. This page is served standalone rather than inside the site
         shell, so without these it is a dead end and the only exit is the back
         button or retyping the address. -->
    <nav class="head-nav">
      <a href="/">Main site</a>
      <a href="/account">My account</a>
    </nav>
  </div>
</header>
<main>
  <div>${totals}</div>

  ${unpaid.length ? `
  <div class="unpaid-callout">
    <h2>⚠ ${unpaid.length} enrolled but not yet paid</h2>
    <p class="muted">Invoiced in QuickBooks, but nothing has been collected — most often a
      parent who saved the enrolment and never clicked through to the card screen.</p>
    <ul>
      ${unpaid.map((r) => {
        const link = r.qbo_invoice_id ? payments.get(r.qbo_invoice_id)?.payLink : null;
        const subject = `Finish your ${r.program} enrolment — payment link`;
        const bodyText =
          `Hi${r.parent_name ? ' ' + r.parent_name : ''},\n\n${r.player_name} is enrolled in ${r.program}, ` +
          `but the payment wasn't completed. Here's the link:\n${link ?? '(no link — check QuickBooks)'}\n\nThanks,\nSeahawks Tennis Academy`;
        // mailto: only fires if the machine has a default desktop mail client
        // configured, which the office does not — Gmail/Workspace is a browser
        // tab, not a registered handler, so mailto: buttons silently did
        // nothing. Gmail's own compose URL opens directly in the browser
        // instead, in the account already signed in.
        const gmailCompose = 'https://mail.google.com/mail/?view=cm&fs=1'
          + `&to=${encodeURIComponent(r.parent_email ?? '')}`
          + `&su=${encodeURIComponent(subject)}`
          + `&body=${encodeURIComponent(bodyText)}`;
        return `<li>
          <b>${esc(r.player_name)}</b> — ${esc(r.program)} ${money(r.price_quoted)}
          <span class="sub">${esc(r.parent_name)} · <a href="mailto:${esc(r.parent_email)}">${esc(r.parent_email)}</a></span>
          ${link
            ? `<a class="btn btn-sm" href="${esc(gmailCompose)}" target="_blank" rel="noopener">Email payment link</a>`
            : '<span class="muted">no payment link on file — check QuickBooks</span>'}
        </li>`;
      }).join('')}
    </ul>
  </div>` : ''}

  ${timedOut.length ? `
  <div class="timedout-callout">
    <h2>⏱ ${timedOut.length} timed out — not enrolled</h2>
    <p class="muted">Saved a spot but never completed payment within the hold window, so the
      seat was released and the invoice voided. They may still think they're signed up.</p>
    <ul>
      ${timedOut.map((r) => {
        const subject = `About your ${r.program} sign-up`;
        const bodyText =
          `Hi${r.parent_name ? ' ' + r.parent_name : ''},\n\n${r.player_name}'s spot in ${r.program} was ` +
          `held but never completed with payment, so it was released and ${r.player_name} is not currently ` +
          `enrolled. If you'd still like to sign up, just fill out the form again on our site — happy to help ` +
          `if you have any trouble.\n\nThanks,\nSeahawks Tennis Academy`;
        const gmailCompose = 'https://mail.google.com/mail/?view=cm&fs=1'
          + `&to=${encodeURIComponent(r.parent_email ?? '')}`
          + `&su=${encodeURIComponent(subject)}`
          + `&body=${encodeURIComponent(bodyText)}`;
        return `<li>
          <b>${esc(r.player_name)}</b> — ${esc(r.program)}
          <span class="sub">${esc(r.parent_name)} · <a href="mailto:${esc(r.parent_email)}">${esc(r.parent_email)}</a> · ${day(r.created_at)}</span>
          ${r.parent_email
            ? `<a class="btn btn-sm" href="${esc(gmailCompose)}" target="_blank" rel="noopener">Tell them</a>`
            : '<span class="muted">no email on file</span>'}
        </li>`;
      }).join('')}
    </ul>
  </div>` : ''}

  ${registers ? `<h2 style="font-size:1rem;margin:18px 0 10px">Grom's registers</h2><div class="regs">${registers}</div>` : ''}

  <div class="bar">
    <input type="search" id="q" placeholder="Search name, parent, email, phone…" autocomplete="off">
    <a class="btn" href="/admin/roster.csv?key=${encodeURIComponent(key)}">Download CSV</a>
  </div>

  <table>
    <thead><tr>
      <th>Enrolled</th><th>Player</th><th>Days</th><th>Program</th><th>Price</th>
      <th>Parent</th><th>Phone</th><th>Invoice</th><th>Payment</th><th>Notes</th>
    </tr></thead>
    <tbody id="rows">${body || '<tr><td colspan="10" class="muted">No enrolments yet.</td></tr>'}</tbody>
  </table>
</main>
<script>
  // Filtering in the page rather than on the server: the whole roster is already
  // here, an academy this size will not outgrow that, and it means typing is
  // instant and works with the connection dropping on a court-side phone.
  const q = document.getElementById('q');
  const rows = [...document.querySelectorAll('#rows tr')];
  q.addEventListener('input', () => {
    const needle = q.value.trim().toLowerCase();
    for (const tr of rows) {
      tr.hidden = needle !== '' && !tr.textContent.toLowerCase().includes(needle);
    }
  });
</script>
</body></html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
