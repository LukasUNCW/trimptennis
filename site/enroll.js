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

      <!-- Grom's runs Monday to Thursday and the parent chooses which days. Each
           weekday is its own class of 18, so a full Monday says nothing about
           Wednesday. Counts are read when the dialog opens, not when the page
           loaded, because a tab left open overnight would otherwise offer a day
           that filled hours ago. -->
      <div class="field" id="ef-days-wrap" hidden>
        <span class="field-label">Which days? <span class="req">*</span></span>
        <div class="day-picker" id="ef-days"></div>
        <p class="field-note" id="ef-days-note"></p>
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
      <p class="enroll-note">Payment is handled by QuickBooks Payments, provided by Intuit Payments Inc. — card details never touch this site. You'll get a confirmation by email.</p>
    </div>
  </form>

  <!-- Shown once the enrolment is saved and BEFORE the parent reaches the card
       page, so nobody arrives at QuickBooks unsure what they are paying for. The
       handoff is a click rather than an automatic redirect: it is the last chance
       to notice a wrong package, and the amount is the thing worth reading twice. -->
  <div class="enroll-done" id="enrollReview" hidden>
    <div class="tick" aria-hidden="true">&check;</div>
    <h3>Saved — ready to pay</h3>
    <dl class="review-list" id="ef-reviewList"></dl>
    <a class="btn btn-teal" id="ef-pay" href="#">Continue to payment →</a>
    <p class="enroll-note">Payment is handled by QuickBooks Payments, provided by
      Intuit Payments Inc. — card details never touch this site. The enrolment is
      already saved, so if you don't finish now the office will follow up.</p>
  </div>

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
  const daysWrap    = document.getElementById('ef-days-wrap');
  const daysBox     = document.getElementById('ef-days');
  const daysNote    = document.getElementById('ef-days-note');
  const optionSel   = document.getElementById('ef-option');
  const optionNote  = document.getElementById('ef-option-note');
  const review      = document.getElementById('enrollReview');
  const reviewList  = document.getElementById('ef-reviewList');
  const payBtn      = document.getElementById('ef-pay');

  let programs = null;   // catalog from /api/programs, fetched once
  let widgetId = null;   // Turnstile widget handle, so we can reset it
  let me = null;         // signed-in account + children, or null for a guest
  let mePromise = null;  // in-flight /api/me, so a quick second open does not refetch

  const showErr = (msg) => { errBox.textContent = msg; errBox.hidden = false; };
  const clearErr = () => { errBox.hidden = true; };

  // Saved players' names and the review summary both go into innerHTML, and both
  // come from data a person typed. The saved-player menu was interpolating a
  // child's name straight into an <option>.
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function loadPrograms() {
    if (programs) return programs;
    const res = await fetch('/api/programs');
    if (!res.ok) throw new Error('Could not load programs');
    programs = await res.json();
    // The menu offers only what is currently taking signups. The full list is
    // kept in `programs` because a cancelled season still needs its option
    // labels resolvable elsewhere.
    progSel.innerHTML = '<option value="">Choose a program…</option>' +
      programs.filter((p) => p.enrollable !== false)
        .map((p) => `<option value="${esc(p.slug)}">${esc(p.name)}</option>`).join('');
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
      options.map((o) => `<option value="${esc(o.id)}">${esc(o.label)} — ${money(o.price)}</option>`).join('');
    optionNote.textContent = options.every((o) => !o.payable)
      ? 'The office will confirm the price and take payment by phone.'
      : '';

    // Monthly memberships continue by auto draft, which needs the card saved at
    // checkout. Saving it is the parent's choice and has to be — nobody can be
    // opted into a stored card. So the job here is to make sure the prompt is
    // expected rather than sprung, because a parent who declines it is one the
    // office chases by phone every month.
    optionSel.onchange = () => {
      const chosen = options.find((o) => o.id === optionSel.value);
      optionNote.textContent = chosen?.autoDraft
        ? 'This covers your first month. At checkout, choose to save your card so '
          + 'the monthly payment can continue automatically.'
        : '';
    };
  }

  /**
   * Loads the weekdays for a program and draws them as checkboxes.
   *
   * Places remaining rather than places taken: "3 left" is a decision, "15 of
   * 18" is arithmetic. A full day stays visible but disabled, because a parent
   * who came for Wednesdays should learn that Wednesday is full rather than
   * wonder why it is missing.
   *
   * A failure here does not hide the picker or block the form. The days are
   * required, so the honest outcome is to say the list could not be loaded and
   * let the parent retry, rather than silently let them enrol into no class.
   */
  async function loadDays(p) {
    const picks = p?.picksDays === true;
    daysWrap.hidden = !picks;
    if (!picks) { daysBox.innerHTML = ''; daysNote.textContent = ''; return; }

    daysBox.innerHTML = '<p class="field-note">Loading days…</p>';
    daysNote.textContent = '';

    let sessions;
    try {
      const res = await fetch(`/api/sessions?program=${encodeURIComponent(p.slug)}`);
      if (!res.ok) throw new Error();
      sessions = await res.json();
    } catch {
      daysBox.innerHTML = '';
      daysNote.textContent = 'Could not load the days just now — please refresh and try again.';
      return;
    }

    if (!sessions.length) {
      daysBox.innerHTML = '';
      daysNote.textContent = 'No days are open for booking yet — please contact the office.';
      return;
    }

    daysBox.innerHTML = sessions.map((s) => `
      <label class="day-opt${s.full ? ' is-full' : ''}">
        <input type="checkbox" value="${esc(s.id)}"${s.full ? ' disabled' : ''}>
        <span class="day-name">${esc(s.weekday)}</span>
        ${s.timeLabel ? `<span class="day-time">${esc(s.timeLabel)}</span>` : ''}
        <span class="day-left">${s.full
          ? 'Full'
          : `${s.remaining} place${s.remaining === 1 ? '' : 's'} left`}</span>
      </label>`).join('');

    if (sessions.every((s) => s.full)) {
      daysNote.textContent =
        'Every day is full at the moment. Please contact the office about the waiting list.';
      return;
    }

    // Each weekday is a separate session at its own price, so the total moves as
    // boxes are ticked. Shown live rather than only on the review panel: finding
    // out that two days is $400 after committing is how a signup gets abandoned
    // at the last step.
    const unit = p.options?.[0]?.price;
    const perDay = p.priceIsPerDay === true && typeof unit === 'number';
    const tally = () => {
      const n = chosenDays().length;
      daysNote.textContent = !perDay
        ? 'Same price whichever days you choose.'
        : n === 0
          ? `$${unit} per day. Pick the days you want.`
          : `${n} day${n === 1 ? '' : 's'} at $${unit} = ` +
            `$${unit * n} for the session.`;
    };
    daysBox.addEventListener('change', tally);
    tally();
  }

  const chosenDays = () =>
    [...daysBox.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value);

  // Age groups are per-program, so they refill whenever the program changes.
  // Adult programs also drop the guardian field entirely — the person signing
  // up is the player, so asking for a parent makes no sense there.
  function syncAgeGroups() {
    const p = programs?.find((x) => x.slug === progSel.value);
    const groups = p?.ageGroups ?? [];
    syncOptions(p);
    loadDays(p);
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
      kids.map((c) => `<option value="${esc(c.id)}">${esc(c.first_name)}${c.last_name ? ' ' + esc(c.last_name) : ''}</option>`).join('') +
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

  /**
   * The last screen before the card page. Every value comes from the POST
   * response rather than the form, so it shows what was actually recorded — which
   * differs for a saved player, whose name the Worker takes from the stored child
   * record, and for a single-option program, whose option the Worker resolved.
   */
  function showReview(data) {
    const price = typeof data.option?.price === 'number'
      ? `$${data.option.price}`
      : 'the office will confirm';
    const rows = [
      ['Program', esc(data.program)],
      ['Option', esc(data.option?.label)],
      // Echoed back from what was actually claimed, not from the checkboxes, so
      // the last thing a parent reads before paying is the places they really
      // hold.
      ...(data.days?.length ? [['Days', esc(data.days.join(', '))]] : []),
      ['Player', esc(data.playerName)],
      ['Amount', `<span class="review-price">${price}</span>`]
    ];
    reviewList.innerHTML = rows
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
      .join('');
    payBtn.href = data.payUrl;
    form.hidden = true;
    review.hidden = false;
    payBtn.focus();
  }

  async function open(slug, childId) {
    clearErr();
    form.hidden = false;
    done.hidden = true;
    // Reopening after an abandoned payment must not show the previous summary.
    review.hidden = true;
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
      notes:        document.getElementById('ef-notes').value,
      days:         daysWrap.hidden ? undefined : chosenDays()
    };

    const selfEnroll = programs?.find((p) => p.slug === body.program)?.selfEnroll === true;

    if (!body.program)                    return showErr('Please choose a program.');
    if (!optionWrap.hidden && !optionSel.value)
                                          return showErr('Please choose which option you want.');
    if (!body.player_name.trim())         return showErr(selfEnroll ? 'Please enter your name.' : "Please enter the player's name.");
    if (!body.age_group)                  return showErr('Please choose an age group.');
    if (!daysWrap.hidden && body.days.length === 0)
                                          return showErr('Please choose at least one day.');
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
      // A day that filled while this form was open is the one error where the
      // numbers on screen are now wrong, so redraw them. Telling somebody
      // "Monday just filled up" above a checkbox still offering Monday reads as
      // a broken site rather than a busy class.
      if (data?.full?.length) {
        const p = programs?.find((x) => x.slug === progSel.value);
        loadDays(p);
      }
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
    // created that option's QuickBooks payment link.
    if (data.payUrl) {
      showReview(data);
      return;
    }
    form.hidden = true;
    done.hidden = false;
    document.getElementById('ef-doneTitle').textContent = 'Got it — you’re on the list';
    document.getElementById('ef-doneMsg').textContent =
      "We've saved the enrollment and emailed the academy. Someone will call you to take payment and confirm the schedule.";
  });
})();
