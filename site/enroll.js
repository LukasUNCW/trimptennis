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

  let programs = null;   // catalog from /api/programs, fetched once
  let widgetId = null;   // Turnstile widget handle, so we can reset it

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

  // Age groups are per-program, so they refill whenever the program changes.
  // Adult programs also drop the guardian field entirely — the person signing
  // up is the player, so asking for a parent makes no sense there.
  function syncAgeGroups() {
    const p = programs?.find((x) => x.slug === progSel.value);
    const groups = p?.ageGroups ?? [];
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

  async function open(slug) {
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
    await mountTurnstile();
  }

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
      player_name:  document.getElementById('ef-player').value,
      age_group:    ageSel.value,
      parent_name:  document.getElementById('ef-parent').value,
      parent_email: document.getElementById('ef-email').value,
      phone:        document.getElementById('ef-phone').value,
      notes:        document.getElementById('ef-notes').value
    };

    const selfEnroll = programs?.find((p) => p.slug === body.program)?.selfEnroll === true;

    if (!body.program)                    return showErr('Please choose a program.');
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
