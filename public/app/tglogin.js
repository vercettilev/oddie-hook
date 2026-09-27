/*
 * "CONTINUE WITH TELEGRAM", on any page that offers it.
 *
 * The browser asks the server for a one-time link to the bot, the link opens
 * the bot, the bot asks "sign in on Chrome on macOS? code 4821", and the Yes
 * there signs THIS browser in on the server. The page only notices: it polls,
 * and reloads once the answer is in. If it was closed meanwhile, the sign-in
 * still happened and the next visit simply finds it.
 *
 * THE LINK IS FETCHED BEFORE THE TAP, not in it. A window opened after an
 * await is a popup to Safari and gets blocked, so the button is a real link
 * with its href already set by the time anybody can press it.
 *
 * Usage: OddieTgLogin.prepare(anchor). The anchor stays hidden until its link
 * is ready, and stays hidden if Telegram sign-in is switched off.
 */
(function () {
  var FRESH_MS = 9 * 60000; // the server keeps a link for ten
  function did() { return (window.OddieId && window.OddieId.get && window.OddieId.get()) || ""; }

  function fetchLink() {
    return fetch("/api/auth/telegram/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: did() }),
    }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  function prepare(a, onDone) {
    if (!a || !did()) return;
    a.hidden = true;
    var cur = null, at = 0;
    function load() {
      return fetchLink().then(function (j) {
        if (!j || !j.link) return null;
        cur = j; at = Date.now();
        a.href = j.link;
        a.target = "_blank";
        a.rel = "noopener";
        a.hidden = false;
        return j;
      });
    }
    load();

    var note = null;
    function say(t) {
      if (!note) {
        note = document.createElement("p");
        note.className = "tglogin-note";
        note.setAttribute("role", "status");
        a.insertAdjacentElement("afterend", note);
      }
      note.textContent = t;
    }

    function poll(j, t0) {
      if (Date.now() - t0 > 10 * 60000) { say("That took a while. Press Continue with Telegram again."); load(); return; }
      fetch("/api/auth/telegram/status?nonce=" + j.nonce + "&deviceId=" + encodeURIComponent(did()), { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (s) {
          if (s && s.status === "done") {
            say("Signed in" + (s.handle ? " as @" + s.handle : "") + ".");
            if (onDone) onDone(s); else setTimeout(function () { location.reload(); }, 600);
            return;
          }
          if (s && s.status === "expired") { say("That link expired. Press Continue with Telegram again."); load(); return; }
          setTimeout(function () { poll(j, t0); }, 2000);
        })
        .catch(function () { setTimeout(function () { poll(j, t0); }, 4000); });
    }

    a.addEventListener("click", function (ev) {
      if (!cur) { ev.preventDefault(); return; }
      // An old link would only earn "expired" in the chat: swap it first, in
      // this same tab so no popup rule applies.
      if (Date.now() - at > FRESH_MS) {
        ev.preventDefault();
        load().then(function (j) { if (j) { location.href = j.link; poll(j, Date.now()); } });
        return;
      }
      say("Confirm in Telegram. Code " + cur.code + ".");
      poll(cur, Date.now());
    });
  }

  window.OddieTgLogin = { prepare: prepare };
})();
