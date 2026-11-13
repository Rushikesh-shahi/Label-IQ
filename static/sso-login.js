/* Added by shahi-server (not part of Shahi IT's dashboard).
 *
 * The original dashboard asks for a master token. Here the token is added on the server side and people are
 * signed in by Shahi SSO, so the page starts already signed in with a placeholder and never sees the real token.
 * Loaded before app.js (both are deferred, so they run in order). app.js itself is unchanged.
 */
(function () {
  'use strict';
  var KEY = 'labeliq_master_token';          // same key app.js uses
  try { window.sessionStorage.setItem(KEY, 'shahi-sso'); } catch (e) { /* blocked */ }

  document.addEventListener('DOMContentLoaded', function () {
    // The proxy ignores the placeholder; signing out would only show a form that does nothing.
    var out = document.getElementById('signout');
    if (out) out.style.display = 'none';

    var scope = document.getElementById('token-scope');
    if (scope) {
      var TEXT = 'Signed in through Shahi SSO';
      var fix = function () { if (scope.textContent !== TEXT) scope.textContent = TEXT; };
      new MutationObserver(fix).observe(scope, { childList: true, characterData: true, subtree: true });
      fix();
    }

    // The only way the original login form can appear here is that the Shahi SSO session ended (the API
    // answered 401). Reloading the page sends the person to the Shahi sign-in. Guarded against loops.
    var login = document.getElementById('login');
    if (login) {
      new MutationObserver(function () {
        if (login.hidden) return;
        var last = 0;
        try { last = Number(window.sessionStorage.getItem('lq_reload') || 0); } catch (e) { /* blocked */ }
        if (Date.now() - last < 15000) return;
        try { window.sessionStorage.setItem('lq_reload', String(Date.now())); } catch (e) { /* blocked */ }
        setTimeout(function () { window.location.reload(); }, 400);
      }).observe(login, { attributes: true, attributeFilter: ['hidden'] });
    }
  });
})();
