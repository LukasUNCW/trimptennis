// site/account.js
// The account page: profile form, children, and enrollment history.
//
// The Worker redirects signed-out visitors before this page is ever served, so
// this script assumes a session. It still handles a 401 — a session can expire
// between the page loading and a save being submitted.

(() => {
  const $ = (id) => document.getElementById(id);

  const profileForm = $('profileForm');
  const childForm   = $('childForm');
  const childList   = $('childList');
  const childAdd    = $('childAdd');
  const enrolList   = $('enrolList');

  const PROFILE_FIELDS = {
    first_name: 'ac-first', last_name: 'ac-last', phone: 'ac-phone',
    address1: 'ac-addr1', address2: 'ac-addr2',
    city: 'ac-city', state: 'ac-state', zip: 'ac-zip'
  };

  let programs = [];   // used to say which programmes a child's age fits
  let editingId = null; // set while the form is editing an existing player
  let lastChildren = []; // last rendered list, so Edit can find the record

  const showErr = (box, msg) => { box.textContent = msg; box.hidden = false; };
  const clearErr = (box) => { box.hidden = true; };

  // A status word next to the heading rather than a toast: it cannot be missed
  // if the save is slow, and it does not move the layout.
  function status(el, text, ms = 2600) {
    el.textContent = text;
    if (ms) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, ms);
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Signed out mid-session: send them back rather than showing broken saves. */
  const bounceIfSignedOut = (res) => {
    if (res.status === 401) { location.href = '/login'; return true; }
    return false;
  };

  async function api(url, options) {
    const res = await fetch(url, options);
    if (bounceIfSignedOut(res)) throw new Error('signed out');
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'Something went wrong.');
    return data;
  }

  // ── rendering ──────────────────────────────────────────────────────────

  function fillProfile(account) {
    $('ac-email').value = account.email ?? '';
    for (const [field, id] of Object.entries(PROFILE_FIELDS)) {
      $(id).value = account[field] ?? '';
    }
    // Greet by first name once we have one, so the page does not just say
    // "My account" to someone who has filled their details in.
    $('acHeading').textContent = account.first_name
      ? `${account.first_name}'s account`
      : 'My account';
  }

  /** Which programmes a child of this birth year could join, from /api/programs. */
  function eligibility(birthYear) {
    if (!birthYear || !programs.length) return '';
    const age = new Date().getUTCFullYear() - Number(birthYear);
    const fits = programs.filter((p) => p.ageGroups.some((g) => {
      const m = /^(\d+)-(\d+)$/.exec(g);
      return m && age >= +m[1] && age <= +m[2];
    }));
    if (!fits.length) return `Age ${age} — ask the office which programme fits`;
    return `Age ${age} — ${fits.map((p) => p.name).join(', ')}`;
  }

  function renderChildren(children) {
    lastChildren = children;
    if (!children.length) {
      childList.innerHTML =
        '<li class="child-empty">No players added yet.</li>';
      return;
    }
    childList.innerHTML = children.map((c) => `
      <li class="child-row" data-id="${esc(c.id)}">
        <div class="child-main">
          <b>${esc(c.first_name)}${c.last_name ? ' ' + esc(c.last_name) : ''}</b>
          ${c.birth_year ? `<span class="child-meta">${esc(eligibility(c.birth_year))}</span>` : ''}
          ${c.notes ? `<span class="child-note">${esc(c.notes)}</span>` : ''}
        </div>
        <div class="child-actions">
          <button type="button" class="child-btn" data-enroll-child="${esc(c.id)}">Enroll</button>
          <button type="button" class="child-btn quiet" data-edit="${esc(c.id)}">Edit</button>
          <button type="button" class="child-btn danger" data-remove="${esc(c.id)}">Remove</button>
        </div>
      </li>`).join('');
  }

  function render(me) {
    fillProfile(me.account);
    renderChildren(me.children ?? []);
  }

  // ── enrollment history ─────────────────────────────────────────────────

  // What a parent is shown for each payment_status. The stored values are the
  // office's vocabulary, not a parent's: "abandoned" is a book-keeping word for
  // an enrollment that was never paid for, and reads as an accusation on
  // someone's own account page.
  const PAY_LABEL = {
    awaiting_payment: ['Awaiting payment', 'pending'],
    paid: ['Paid', 'paid'],
    abandoned: ['Not completed', 'void']
  };

  /** Unknown status: shown as-is rather than hidden, so nothing goes silent. */
  const prettyStatus = (s) => {
    const t = String(s ?? '').replace(/_/g, ' ').trim();
    return t ? t[0].toUpperCase() + t.slice(1) : 'Status unknown';
  };

  /**
   * Which package was bought, e.g. "8 classes / month · $240". Several programs
   * sell more than one, so without this two Shredder's enrolments render as
   * identical rows.
   *
   * The row stores the option *id*; the readable label lives in /api/programs, so
   * it is resolved through the catalog and falls back to the raw id if the option
   * has since been renamed or removed — a historic row must still say something.
   */
  function packageLabel(r) {
    const prog = programs.find((p) => p.name === r.program);
    const opt = (prog?.options ?? []).find((o) => o.id === r.price_option);
    const label = opt?.label ?? r.price_option ?? '';
    const price = typeof r.price_quoted === 'number' ? `$${r.price_quoted}` : '';
    return [label, price].filter(Boolean).join(' · ');
  }

  // D1 writes created_at as datetime('now') — "2026-07-28 13:24:11", UTC with
  // nothing to say so. Browsers read that shape as LOCAL time, which moves the
  // date across midnight for anyone west of UTC, so the zone is made explicit
  // before formatting.
  function fmtDate(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    const iso = raw.replace(' ', 'T');
    const d = new Date(/[Zz]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
    return isNaN(d.getTime())
      ? raw
      : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function renderEnrollments(rows) {
    if (!rows.length) {
      enrolList.innerHTML =
        '<li class="child-empty">Nothing here yet. <a href="/#programs">Browse the programs</a> to sign a player up.</li>';
      return;
    }
    enrolList.innerHTML = rows.map((r) => {
      const [label, mod] = PAY_LABEL[r.payment_status] ?? [prettyStatus(r.payment_status), ''];
      // player_name is only ever missing on a row typed in by hand, but the
      // list should not render a nameless bullet if that happens.
      const who = r.player_name || 'Player not recorded';
      const pkg = packageLabel(r);
      return `
      <li class="enrol-row">
        <div class="enrol-main">
          <b>${esc(r.program)}${pkg ? ` <span class="enrol-pkg">${esc(pkg)}</span>` : ''}</b>
          <span class="enrol-meta">${esc(who)}${r.age_group ? ' · ' + esc(r.age_group) : ''}</span>
        </div>
        <span class="enrol-date">${esc(fmtDate(r.created_at))}</span>
        <span class="enrol-status ${mod}">${esc(label)}</span>
      </li>`;
    }).join('');
  }

  /**
   * Loaded on its own request, not folded into /api/me. It is the least
   * important thing on the page, so a failure here shows one message in this
   * card and leaves the profile and players working.
   */
  async function loadHistory() {
    try {
      clearErr($('histErr'));
      // The catalog is needed to turn a stored option id into a readable label,
      // and both loads start together — so wait for it rather than rendering the
      // raw id on first paint and only looking right after a refresh.
      const [data] = await Promise.all([api('/api/enrollments'), programsReady]);
      renderEnrollments(data.enrollments ?? []);
    } catch (err) {
      if (err.message !== 'signed out') {
        enrolList.innerHTML = '';
        showErr($('histErr'), 'Could not load your enrollments. Please refresh.');
      }
    }
  }

  // Enrolling from this page leaves the list on screen, so it has to be reread.
  // enroll.js announces the save; see the dispatch there.
  document.addEventListener('sta:enrolled', () => {
    status($('histStatus'), 'Updating…', 0);
    loadHistory().then(() => status($('histStatus'), 'Updated'));
  });

  // ── load ───────────────────────────────────────────────────────────────

  // One shared fetch: both the eligibility line and the enrolment history need
  // the catalog, and they load in parallel, so neither should fetch it twice.
  const programsReady = fetch('/api/programs')
    .then((r) => r.json())
    .catch(() => [])
    .then((list) => { programs = list; return list; });

  (async () => {
    // Not awaited: the history is independent of the profile, and waiting for
    // one before starting the other only makes the page slower.
    loadHistory();
    try {
      // Programmes first so the eligibility line is present on first paint.
      await programsReady;
      render(await api('/api/me'));
    } catch (err) {
      if (err.message !== 'signed out') {
        showErr($('profileErr'), 'Could not load your account. Please refresh.');
      }
    }
  })();

  // ── profile ────────────────────────────────────────────────────────────

  profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErr($('profileErr'));

    const body = {};
    for (const [field, id] of Object.entries(PROFILE_FIELDS)) body[field] = $(id).value;

    $('profileSave').disabled = true;
    status($('profileStatus'), 'Saving…', 0);
    try {
      render(await api('/api/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }));
      status($('profileStatus'), 'Saved');
    } catch (err) {
      status($('profileStatus'), '', 0);
      if (err.message !== 'signed out') showErr($('profileErr'), err.message);
    } finally {
      $('profileSave').disabled = false;
    }
  });

  // ── children ───────────────────────────────────────────────────────────

  /** Returns the shared form to "add" mode. */
  function resetChildForm() {
    editingId = null;
    childForm.reset();
    clearErr($('childErr'));
    $('childSave').textContent = 'Add player';
    $('childAddSummary').textContent = '+ Add a player';
    childAdd.open = false;
  }

  /** Loads a player into the same form, which then PATCHes instead of POSTs. */
  function startEdit(child) {
    editingId = child.id;
    $('ch-first').value = child.first_name ?? '';
    $('ch-last').value = child.last_name ?? '';
    $('ch-year').value = child.birth_year ?? '';
    $('ch-notes').value = child.notes ?? '';
    clearErr($('childErr'));
    $('childSave').textContent = 'Save changes';
    $('childAddSummary').textContent = `Editing ${child.first_name}`;
    childAdd.open = true;
    $('ch-year').focus();   // the field most often being filled in
  }

  childForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErr($('childErr'));

    const body = {
      first_name: $('ch-first').value,
      last_name: $('ch-last').value,
      birth_year: $('ch-year').value,
      notes: $('ch-notes').value
    };
    if (!body.first_name.trim()) return showErr($('childErr'), "Please enter the player's first name.");

    const editing = editingId;   // render() clears it, so capture first
    $('childSave').disabled = true;
    try {
      render(await api(editing ? `/api/children/${editing}` : '/api/children', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }));
      resetChildForm();
      status($('childStatus'), editing ? 'Saved' : 'Added');
    } catch (err) {
      if (err.message !== 'signed out') showErr($('childErr'), err.message);
    } finally {
      $('childSave').disabled = false;
    }
  });

  $('childCancel').addEventListener('click', resetChildForm);

  childList.addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const child = (lastChildren || []).find((c) => c.id === edit.getAttribute('data-edit'));
      if (child) startEdit(child);
      return;
    }

    const remove = e.target.closest('[data-remove]');
    if (remove) {
      const row = remove.closest('.child-row');
      const name = row.querySelector('b')?.textContent ?? 'this player';
      // Deleting a child is not recoverable from the UI, so it asks first.
      if (!confirm(`Remove ${name} from your account?`)) return;
      clearErr($('childErr'));
      remove.disabled = true;
      try {
        render(await api(`/api/children/${remove.getAttribute('data-remove')}`, { method: 'DELETE' }));
        status($('childStatus'), 'Removed');
      } catch (err) {
        remove.disabled = false;
        if (err.message !== 'signed out') showErr($('childErr'), err.message);
      }
      return;
    }

    // Enrolling a saved player hands the child's id to the shared dialog, which
    // selects it and submits it — so the Worker links the enrolment to this
    // account and this child rather than matching on a typed name.
    const enrol = e.target.closest('[data-enroll-child]');
    if (enrol) {
      const childId = enrol.getAttribute('data-enroll-child');
      if (window.staEnroll) {
        window.staEnroll.open('', childId);
      } else {
        // enroll.js not loaded for some reason; the programmes page still works
        location.href = '/#programs';
      }
    }
  });
})();
