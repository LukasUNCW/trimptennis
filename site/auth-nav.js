// site/auth-nav.js
// Renders the utility-bar sign-in state on every page.
//
// The HTML is edge-cached, so this cannot be baked in server-side — the same
// cached page is served to signed-in and signed-out visitors alike. The bar is
// therefore filled in client-side from /api/me, which is marked no-store.
//
// It renders signed-out first and only upgrades on a successful response, so a
// failed or slow request degrades to "Log in" rather than to nothing.

(() => {
  const nav = document.getElementById('authNav');
  if (!nav) return;

  const signedOut = () => {
    nav.innerHTML =
      '<a href="/login">Log in</a>' +
      // data-enroll opens the modal on pages that have it; elsewhere no handler
      // claims the click and the href carries the visitor to the programs.
      '<a href="/#programs" data-enroll=""><b style="color:var(--gold)">Register</b></a>';
  };

  const signedIn = (user) => {
    // Accounts start with only an email; the profile form that collects a name
    // is phase 2, so fall back to the address's local part until then.
    const who = user.first_name || (user.email || '').split('@')[0];
    nav.innerHTML =
      '<span>Hi ' + who.replace(/[<>&"]/g, '') + '</span>' +
      '<a href="/account">My account</a>' +
      '<a href="#" id="authLogout">Log out</a>';

    document.getElementById('authLogout').addEventListener('click', async (e) => {
      e.preventDefault();
      await fetch('/api/auth/logout', { method: 'POST' });
      location.href = '/';
    });
  };

  signedOut();

  fetch('/api/me', { headers: { Accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((user) => { if (user && user.email) signedIn(user); })
    .catch(() => { /* stay signed out */ });
})();
