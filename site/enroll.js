// site/enroll.js
// The enrollment dialog, available to any page that loads this script.
//
// It lived inline in index.html until the programme pages needed it too. Rather
// than copy sixty lines of markup into every page, the dialog is injected here
// and every page gets it from one <script> tag — so there is a single copy of
// both the form and its logic to keep correct.
//
// Requires: the Turnstile api.js tag, and styles.css for .enroll rules.

(() => {
  document.body.insertAdjacentHTML('beforeend', `
<dialog class="enroll" id="enrollDialog" aria-labelledby="enrollTitle">
  <form id="enrollForm" novalidate>
    <div class="enroll-head">
      <div>
        <h2 id="enrollTitle">Enroll a player</h2>
        <p id="enrollSub">Tell us who's playing — payment comes next.</p>
      </div>
      <button type="button" class="enroll-x" data-enroll-close aria-label="Close">&times;</button>
    </div>
    <div class="enroll-body">
      <div class="enroll-msg" id="enrollErr" role="alert" hidden></div>

      <div class="field">
        <label for="ef-program">Program <span class="req">*</span></label>
        <select id="ef-program" name="program" required></select>
      </div>

      <!-- Only shown when the program sells more than one price. A program with
           a single option needs no decision, and an unnecessary menu invites a
           wrong answer. -->
      <div class="field" id="ef-option-wrap" hidden>
        <label for="ef-option">Which option? <span class="req">*</span></label>
        <select id="ef-option" name="option" required></select>
        <p class="field-note" id="ef-option-note"></p>
      </div>

      <div class="field" id="ef-saved-wrap" hidden>
        <label for="ef-saved">Who is playing?</label>
        <select id="ef-saved"></select>
      </div>

      <div class="field-row">
        <div class="field">
          <label for="ef-player" id="ef-player-label">Player's full name <span class="req">*</span></label>
          <input id="ef-player" name="player_name" maxlength="100" required>
        </div>
        <div class="field">
          <label for="ef-age">Age group <span class="req">*</span></label>
          <select id="ef-age" name="age_group" required></select>
        </div>
      </div>

      <div class="field-row" id="ef-row-guardian">
        <div class="field" id="ef-field-parent">
          <label for="ef-parent">Parent / guardian <span class="req">*</span></label>
          <input id="ef-parent" name="parent_name" maxlength="100" autocomplete="name" required>
        </div>
        <div class="field">
          <label for="ef-phone">Phone</label>
          <input id="ef-phone" name="phone" type="tel" maxlength="40" autocomplete="tel">
        </div>
      </div>

      <div class="field">
        <label for="ef-email">Email <span class="req">*</span></label>
        <input id="ef-email" name="parent_email" type="email" maxlength="200" autocomplete="email" required>
      </div>

      <div class="field">
        <label for="ef-notes">Anything we should know?</label>
        <textarea id="ef-notes" name="notes" maxlength="2000"></textarea>
      </div>

      <div id="ef-turnstile"></div>

      <button type="submit" class="btn btn-teal" id="ef-submit">Continue to payment</button>
      <p class="enroll-note">Payment is handled by QuickBooks — card details never touch this site. You'll get a confirmation by email.</p>
    </div>
  </form>

  <div class="enroll-done" id="enrollDone" hidden>
    <div class="tick" aria-hidden="true">&check;</div>
    <h3 id="ef-doneTitle">You're enrolled</h3>
    <p id="ef-doneMsg"></p>
    <button type="button" class="btn btn-ghost" data-enroll-close>Close</button>
  </div>
</dialog>
`);
})();
(() => {
  // Live Turnstile widget "Seahawks Tennis Academy". The site key is public;
  // the matching secret is the TURNSTILE_SECRET Worker secret.
  const TURNSTILE_SITE_KEY = '0x4AAAAAAD_U3gZ8R47QurWL';

  const dlg      = document.getElementById('enrollDialog');
  const form     = document.getElementById('enrollForm');
  const done     = document.getElementById('enrollDone');
  const errBox   = document.getElementById('enrollErr');
  const submitBt = document.getElementById('ef-submit');
  const progSel  = document.getElementById('ef-program');
  const ageSel   = document.getElementById('ef-age');
  const subtitle = document.getElementById('enrollSub');
  const parentField = document.getElementById('ef-field-parent');
  const parentInput = document.getElementById('ef-parent');
  const guardianRow = document.getElementById('ef-row-guardian');
  const playerLabel = document.getElementById('ef-player-label');
  const savedWrap   = document.getElementById('ef-saved-wrap');
  const savedSel    = document.getElementById('ef-saved');
  const optionWrap  = document.getElementById('ef-option-wrap');
  const optionSel   = document.getElementById('ef-option');
  const optionNote  = document.getElementById('ef-option-note');

  let programs = null;   // catalog from /api/programs, fetched once
  let widgetId = null;   // Turnstile widget handle, so we can reset it
  let me = null;         // signed-in account + children, or null for a guest
  let mePromise = null;  // in-flight /api/me, so a quick second open does not refetch

  const showErr = (msg) => { errBox.textContent = msg; errBox.hidden = false; };
  const clearErr = () => { errBox.hidden = true; };

  async function loadPrograms() {
    if (programs) return programs;
    const res = await fetch('/api/programs');
    if (!res.ok) throw new Error('Could not load programs');
    programs = await res.json();
    progSel.innerHTML = '<option value="">Choose a program…</option>' +
      programs.map((p) => `<option value="${p.slug}">${p.name}</option>`).join('');
    return programs;
  }

  const money = (price) => (typeof price === 'number' ? `$${price}` : 'price on request');

  /**
   * Price options are per-program, so they refill with the age groups. Hidden
   * entirely for a single-option program: there is nothing to decide, and the
   * price still reaches the parent on the QuickBooks page.
   *
   * The amount shown here is what the catalog says. QuickBooks charges whatever
   * its link says — see the note on PriceOption.price in worker/programs.ts.
   */
  function syncOptions(p) {
    const options = p?.options ?? [];
    const choose = options.length > 1;
    optionWrap.hidden = !choose;
    optionSel.required = choose;

    if (!choose) {
      optionSel.innerHTML = '';
      optionNote.textContent = '';
      return;
    }
    optionSel.innerHTML =
      '<option value="">Choose an option…</option>' +
      options.map((o) => `<option value="${o.id}">${o.label} — ${money(o.price)}</option>`).join('');
    optionNote.textContent = options.every((o) => !o.payable)
      ? 'The office will confirm the price and take payment by phone.'
      : '';
  }

  // Age groups are per-program, so they refill whenever the program changes.
  // Adult programs also drop the guardian field entirely — the person signing
  // up is the player, so asking for a parent makes no sense there.
  function syncAgeGroups() {
    const p = programs?.find((x) => x.slug === progSel.value);
    const groups = p?.ageGroups ?? [];
    syncOptions(p);
    ageSel.innerHTML = groups.length
      ? groups.map((g) => `<option value="${g}">${g}</option>`).join('')
      : '<option value="">Choose a program first</option>';
    ageSel.disabled = groups.length === 0;

    const self = p?.selfEnroll === true;
    parentField.hidden = self;
    guardianRow.classList.toggle('one-col', self);
    parentInput.required = !self;          // else the browser blocks submit on a hidden field
    if (self) parentInput.value = '';
    playerLabel.innerHTML = self
      ? 'Your full name <span class="req">*</span>'
      : "Player's full name <span class=\"req\">*</span>";

    subtitle.textContent = p && !p.payable
      ? "We'll follow up by phone to take payment for this program."
      : self
        ? 'Tell us who you are — payment comes next.'
        : "Tell us who's playing — payment comes next.";
  }

  const turnstileReady = (timeoutMs = 8000) => {
    if (window.turnstile) return Promise.resolve(true);
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (window.turnstile) { clearInterval(timer); resolve(true); }
        else if (Date.now() - started > timeoutMs) { clearInterval(timer); resolve(false); }
      }, 100);
    });
  };

  // The Turnstile script is async, so a quick click can land before it exists.
  // Keep submit disabled until the widget is actually mounted — otherwise the
  // form looks ready but every attempt fails the bot gate with no explanation.
  async function mountTurnstile() {
    submitBt.disabled = true;
    if (!(await turnstileReady())) {
      showErr('The verification check could not load — please refresh and try again.');
      return;
    }
    if (widgetId === null) {
      widgetId = window.turnstile.render('#ef-turnstile', { sitekey: TURNSTILE_SITE_KEY });
    } else {
      window.turnstile.reset(widgetId);
    }
    submitBt.disabled = false;
  }

  /**
   * Loads the signed-in account once, if there is one. A 401 is the normal
   * answer for a guest, not an error — enrolling without an account is
   * supported and must not be blocked by this failing.
   */
  function loadMe() {
    if (me !== null) return Promise.resolve(me);
    if (!mePromise) {
      mePromise = fetch('/api/me', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : false))
        .catch(() => false)
        .then((data) => { me = data; return me; });
    }
    return mePromise;
  }

  /** Fills the parent fields from the account, without clobbering typing. */
  function prefillFromAccount() {
    if (!me || !me.account) return;
    const a = me.account;
    const set = (el, v) => { if (el && !el.value && v) el.value = v; };
    set(document.getElementById('ef-parent'), [a.first_name, a.last_name].filter(Boolean).join(' '));
    set(document.getElementById('ef-email'), a.email);
    set(document.getElementById('ef-phone'), a.phone);
  }

  /**
   * Offers the account's saved players. Choosing one sends its id, and the
   * Worker takes the name from the stored record rather than from this form.
   */
  function buildSavedPlayers() {
    const kids = (me && me.children) || [];
    if (!kids.length) { savedWrap.hidden = true; return; }
    savedWrap.hidden = false;
    savedSel.innerHTML =
      kids.map((c) => `<option value="${c.id}">${c.first_name}${c.last_name ? ' ' + c.last_name : ''}</option>`).join('') +
      '<option value="">Someone else…</option>';
    applySavedPlayer();
  }

  function applySavedPlayer() {
    const kids = (me && me.children) || [];
    const child = kids.find((c) => c.id === savedSel.value);
    const nameField = document.getElementById('ef-player');

    if (!child) {                       // "Someone else…" — type a name
      nameField.readOnly = false;
      nameField.value = '';
      return;
    }
    nameField.value = [child.first_name, child.last_name].filter(Boolean).join(' ');
    nameField.readOnly = true;          // the stored record is the source of truth

    // Preselect the age group this child's birth year falls into, if the
    // chosen programme has one that fits.
    if (child.birth_year) {
      const age = new Date().getUTCFullYear() - Number(child.birth_year);
      const fit = [...ageSel.options].find((o) => {
        const m = /^(\d+)-(\d+)$/.exec(o.value);
        return m && age >= +m[1] && age <= +m[2];
      });
      if (fit) ageSel.value = fit.value;
    }
  }

  async function open(slug, childId) {
    clearErr();
    form.hidden = false;
    done.hidden = true;
    submitBt.textContent = 'Continue to payment';
    if (!dlg.open) dlg.showModal();

    try {
      await loadPrograms();
      if (slug && programs.some((p) => p.slug === slug)) progSel.value = slug;
      syncAgeGroups();
    } catch {
      showErr('Could not load the program list. Please refresh and try again.');
    }

    await loadMe();
    prefillFromAccount();
    buildSavedPlayers();
    if (childId && [...savedSel.options].some((o) => o.value === childId)) {
      savedSel.value = childId;
      applySavedPlayer();
    }
    syncAgeGroups();
    if (childId) applySavedPlayer();   // age group again, now the menu is right

    await mountTurnstile();
  }

  savedSel.addEventListener('change', applySavedPlayer);

  // Lets the account page open the dialog for a specific saved player instead
  // of faking a click and then poking at fields on a timer.
  window.staEnroll = { open };

  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-enroll]');
    if (trigger) { e.preventDefault(); open(trigger.getAttribute('data-enroll') || ''); return; }
    if (e.target.closest('[data-enroll-close]')) dlg.close();
  });

  progSel.addEventListener('change', syncAgeGroups);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErr();

    const body = {
      program:      progSel.value,
      // Omitted for a single-option program; the Worker resolves it to the only
      // option rather than requiring the form to know that.
      option:       optionWrap.hidden ? undefined : optionSel.value,
      // present only for a saved player; the Worker then takes the name from
      // the stored record and ignores player_name below
      child_id:     (savedWrap.hidden || !savedSel.value) ? undefined : savedSel.value,
      player_name:  document.getElementById('ef-player').value,
      age_group:    ageSel.value,
      parent_name:  document.getElementById('ef-parent').value,
      parent_email: document.getElementById('ef-email').value,
      phone:        document.getElementById('ef-phone').value,
      notes:        document.getElementById('ef-notes').value
    };

    const selfEnroll = programs?.find((p) => p.slug === body.program)?.selfEnroll === true;

    if (!body.program)                    return showErr('Please choose a program.');
    if (!optionWrap.hidden && !optionSel.value)
                                          return showErr('Please choose which option you want.');
    if (!body.player_name.trim())         return showErr(selfEnroll ? 'Please enter your name.' : "Please enter the player's name.");
    if (!body.age_group)                  return showErr('Please choose an age group.');
    if (!selfEnroll && !body.parent_name.trim())
                                          return showErr('Please enter a parent or guardian name.');
    if (!body.parent_email.includes('@')) return showErr('Please enter a valid email address.');

    if (!window.turnstile || widgetId === null) {
      return showErr('The verification widget did not load. Please refresh and try again.');
    }
    body.turnstileToken = window.turnstile.getResponse(widgetId);
    if (!body.turnstileToken) return showErr('Please complete the verification check.');

    submitBt.disabled = true;
    submitBt.textContent = 'Submitting…';

    let data;
    try {
      const res = await fetch('/api/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Something went wrong.');
    } catch (err) {
      submitBt.disabled = false;
      submitBt.textContent = 'Continue to payment';
      window.turnstile.reset(widgetId);   // tokens are single-use
      return showErr(err.message === 'Failed to fetch'
        ? 'Network problem — please check your connection and try again.'
        : err.message);
    }

    // The account page shows an enrollment list. Without this it keeps showing
    // the list from page load, so a parent who enrols from /account sees "you're
    // on the list" above a list the new enrollment is missing from. Announced
    // rather than called directly because this dialog is on every page, most of
    // which have nothing listening.
    document.dispatchEvent(new CustomEvent('sta:enrolled'));

    // Enrollment is saved either way. payUrl is null until the office has
    // created that program's QuickBooks payment link.
    if (data.payUrl) {
      submitBt.textContent = 'Redirecting to payment…';
      window.location.href = data.payUrl;
      return;
    }
    form.hidden = true;
    done.hidden = false;
    document.getElementById('ef-doneTitle').textContent = 'Got it — you’re on the list';
    document.getElementById('ef-doneMsg').textContent =
      "We've saved the enrollment and emailed the academy. Someone will call you to take payment and confirm the schedule.";
  });
})();
