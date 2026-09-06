/*
 * WHO YOU ARE, IN THE MASTHEAD, ON EVERY APP PAGE.
 *
 * The X gate only ever shows to a device with no X account, which is correct
 * -- but it meant the social premise was invisible to exactly the people who
 * had already connected. A connected user saw no name anywhere, and a market's
 * opener was four grey characters. This chip is the persistent signal: your
 * handle when we know it, a one-tap "Connect X" when we do not.
 *
 * Two words, never a banner: the app is hypercasual and the masthead is not a
 * place for a sentence.
 */
(function () {
  // Mounted beside the nav, not inside it: on a phone it shares the logo's row
  // rather than pushing the links onto a third one, and it inherits none of
  // `.top nav a` (which is what painted it ink on ink the first time).
  var bar = document.querySelector(".top .wrap") || document.querySelector(".top nav");
  if (!bar) return;
  var did = (window.OddieId && window.OddieId.get && window.OddieId.get()) || "";
  var a = document.createElement("a");
  bar.appendChild(a);

  // Default to the ask. If the fetch never answers, an invitation is a better
  // wrong answer than a blank space or a name we cannot prove.
  a.className = "mechip mechip--go";
  a.textContent = "Connect X";
  a.href = "/api/auth/twitter/start?deviceId=" + encodeURIComponent(did)
         + "&return=" + encodeURIComponent(location.pathname);

  // One request, published for whoever else needs it. window.OddieMe always
  // settles: pages await it rather than opening a second identical call, and a
  // failure resolves to an empty identity instead of hanging their render.
  window.OddieMe = did
    ? fetch("/api/auth/me?deviceId=" + encodeURIComponent(did))
        .then(function (r) { return r.json(); })
        .catch(function () { return { accounts: [] }; })
    : Promise.resolve({ accounts: [] });

  window.OddieMe
    .then(function (j) {
      var tw = (j.accounts || []).filter(function (x) { return x.provider === "twitter"; })[0];
      if (!tw || !tw.handle) return;
      a.className = "mechip";
      a.textContent = "@" + String(tw.handle).replace(/^@+/, "");
      a.href = "/you";
    });
})();
