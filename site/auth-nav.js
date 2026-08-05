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
      // Staff only. Read off the account, which is what signedIn() is handed —
      // the sibling isAdmin on the /api/me envelope is not in scope here, and
      // reading it would silently never show the tab.
      //
      // The link appearing is a convenience, not the control: the Worker checks
      // is_admin on the request itself, so pasting /admin without the flag gets
      // a 401 whether or not a tab was ever drawn.
      (user.is_admin === 1 ? '<a href="/admin"><b>Admin</b></a>' : '') +
      '<a href="/account">My account</a>' +
      '<a href="#" id="authLogout">Log out</a>';

    document.getElementById('authLogout').addEventListener('click', async (e) => {
      e.preventDefault();
      await fetch('/api/auth/logout', { method: 'POST' });
      location.href = '/';
    });
  };

  signedOut();

  // cache:'no-store' as well as the server's header — this response flips the
  // moment someone signs in or out, so a stale copy shows the wrong bar.
  fetch('/api/me', { cache: 'no-store', headers: { Accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      // /api/me returns { account, children }. It used to return the account
      // flat, and this line kept reading the old shape after that changed —
      // which left the bar showing "Log in" to people who were signed in. The
      // fallback tolerates either shape so it cannot break that way again.
      const account = data?.account ?? data;
      if (account?.email) signedIn(account);
    })
    .catch(() => { /* stay signed out */ });
})();
