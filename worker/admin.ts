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
  @media (max-width:900px) { table { font-size:.85rem; } td,th { padding:7px; } }
</style></head>
<body>
<header>
  <h1>Roster</h1>
  <p>${rows.length} enrolment${rows.length === 1 ? '' : 's'} · read-only · this page lists children and contact details, so treat the link as private</p>
</header>
<main>
  <div>${totals}</div>

  ${registers ? `<h2 style="font-size:1rem;margin:18px 0 10px">Grom's registers</h2><div class="regs">${registers}</div>` : ''}

  <div class="bar">
    <input type="search" id="q" placeholder="Search name, parent, email, phone…" autocomplete="off">
    <a class="btn" href="/admin/roster.csv?key=${encodeURIComponent(key)}">Download CSV</a>
  </div>

  <table>
    <thead><tr>
      <th>Enrolled</th><th>Player</th><th>Days</th><th>Program</th><th>Price</th>
      <th>Parent</th><th>Phone</th><th>Invoice</th><th>Notes</th>
    </tr></thead>
    <tbody id="rows">${body || '<tr><td colspan="9" class="muted">No enrolments yet.</td></tr>'}</tbody>
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
