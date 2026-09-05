/*
 * ONE DEVICE IDENTITY ACROSS oddie.fun AND app.oddie.fun.
 *
 * The device id is what an X account, a wallet and a Genesis ticket ledger all
 * hang off. It used to live in localStorage, which is ORIGIN-scoped: the day
 * the app moves to app.oddie.fun, somebody who connected X on oddie.fun/genesis
 * arrives at the app as a stranger, and nobody reads that as a bug -- they just
 * think they never connected.
 *
 * A cookie with domain=.oddie.fun is the only client-side store that crosses
 * that line, so the cookie is authoritative and localStorage is demoted to
 * migration source and fallback. Migration is automatic: the first page on any
 * oddie.fun host that finds an id in localStorage copies it into the cookie,
 * and every later host reads the cookie first. Genesis lives on the apex and
 * everybody who ever connected passes through it, so the copy happens before
 * the split can hurt.
 *
 * Loaded synchronously and before any code that needs the id. No dependencies.
 */
window.OddieId = (function () {
  var KEY = "oddie_did";

  function mint() {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : String(Math.random()).slice(2) + Date.now().toString(36);
  }

  /* Only a registrable-domain cookie crosses subdomains. localhost, IPs and
     any preview host get a host-only cookie, which is the browser's default
     when the attribute is omitted. */
  function domainAttr() {
    return /(^|\.)oddie\.fun$/i.test(location.hostname) ? ";domain=.oddie.fun" : "";
  }

  function readCookie() {
    try {
      var m = document.cookie.match(/(?:^|;\s*)oddie_did=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }
  function writeCookie(id) {
    try {
      document.cookie = KEY + "=" + encodeURIComponent(id)
        + ";path=/;max-age=31536000;samesite=lax"
        + (location.protocol === "https:" ? ";secure" : "")
        + domainAttr();
    } catch (e) {}
  }
  function readLocal() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function writeLocal(id) { try { localStorage.setItem(KEY, id); } catch (e) {} }

  /* Cookie first: it is the one store the other host can see. Then the old
     localStorage value (migration). Then a fresh id. Whatever won is written
     back to BOTH, so the next page on either host agrees. */
  var id = readCookie() || readLocal() || mint();
  writeCookie(id);
  writeLocal(id);

  /* Small remembered preferences, on the same cross-host cookie, so a choice
     made on oddie.fun holds on app.oddie.fun. Used for "I'll do this later" on
     the X gate: skipping is a first-class outcome (the old app's welcome sheet
     said exactly that), and a skip that is forgotten on the next page is a
     nag, not a choice. Days-bounded so it is never forever. */
  function recall(key) {
    try {
      var m = document.cookie.match(new RegExp("(?:^|;\\s*)oddie_" + key + "=([^;]+)"));
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }
  function remember(key, value, days) {
    try {
      document.cookie = "oddie_" + key + "=" + encodeURIComponent(value)
        + ";path=/;max-age=" + Math.round((days || 7) * 86400) + ";samesite=lax"
        + (location.protocol === "https:" ? ";secure" : "")
        + domainAttr();
    } catch (e) {}
  }

  return {
    get: function () { return id; },
    recall: recall,
    remember: remember,
    /* Dev/test seam: says which store the id came from on this load. */
    _source: readCookie() === id ? "cookie" : "fresh",
  };
})();
