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
      a.href = "/profile";
    });

  /*
   * MONEY WAITING, ON EVERY PAGE.
   *
   * Winning on chain used to tell the winner nothing, anywhere. The profile
   * has always listed what is collectable, but you had to already be on the
   * profile to see it, and nobody goes to a profile to find out whether they
   * got richer. This is the only surface that is on every page of the app.
   *
   * KEYED ON THE DEVICE, NOT ON A HANDLE. A bettor is guaranteed to have a
   * wallet and is not guaranteed to have connected X, so anything routed
   * through an @handle would skip exactly the people who came from a tweet,
   * bet, and left. The server answers from the wallets linked to this browser.
   *
   * A database read, not a chain read: it is asked on every navigation, and a
   * getMultipleAccounts per page view per visitor is not a thing to build.
   *
   * Silent on every failure. A masthead is not the place to report that a
   * request blinked, and a badge that cannot be trusted is worse than none.
   */
  if (did) {
    var css = document.createElement("style");
    // Defined here rather than in five page stylesheets: this element is
    // created by this file, so its look lives with it and cannot drift.
    css.textContent = ".mechip--cash{background:#FF2D78;color:#FBFCF4;"
      + "box-shadow:3px 3px 0 #A3053F}.mechip--cash:hover{background:#FF2D78;color:#fff}"
      // Under the phone breakpoint every page gives .mechip `margin-left:auto`
      // to push it to the end of the masthead row. With TWO of them both did
      // it, each claimed the whole remaining width. Only the first one pushes.
      + ".mechip--cash + .mechip{margin-left:0}"
      /* AND ON A PHONE THE NAME GIVES WAY TO THE MONEY. Even sharing one
         margin, the wordmark plus two chips is about 418px of a 375px row, so
         the masthead wrapped to three lines: 134px of a 667px screen spent on
         chrome, on the page where the money is. One of them has to go, and it
         is not the one with SOL behind it. The handle is one tap away on the
         page this chip links to. */
      + "@media (max-width:560px){.mechip--cash ~ .mechip{display:none}}";
    document.head.appendChild(css);

    fetch("/api/chain/payouts?deviceId=" + encodeURIComponent(did))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var n = j && j.count;
        if (!n) return;
        var cash = document.createElement("a");
        cash.className = "mechip mechip--cash";
        // The COUNT and the verb, never an amount: the payout depends on the
        // pool's totals and this route never reads the chain, so any figure
        // here would be one we made up.
        cash.textContent = n === 1 ? "1 to collect" : n + " to collect";
        cash.href = "/profile";
        // Before the identity chip: on a phone the masthead wraps, and the one
        // thing that must survive the wrap is the money.
        bar.insertBefore(cash, a);
      })
      .catch(function () {});
  }
})();
