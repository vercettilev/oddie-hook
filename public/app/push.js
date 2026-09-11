/*
 * PERMISSION TO TELL SOMEBODY THEY WON.
 *
 * Winning on chain reaches the winner through no channel at all today: not X,
 * not mail, and the profile only works if they come back on their own. This is
 * the one way to reach somebody who is not looking.
 *
 * NEVER ASKS COLD, and that is not politeness. A browser permission prompt is
 * answered once and a denial is close to permanent - there is no second ask, on
 * any page, ever. So the real API is only called from a tap on our own line,
 * which somebody who is not interested simply does not tap, leaving the door
 * open for a better moment.
 *
 * AND IT ASKS WHERE THE MONEY IS. The prompt lives on the profile, shown to
 * somebody who has a wallet connected and therefore something to be told about.
 * Nobody is asked on the way in.
 */
(function () {
  var SW = "/sw.js";
  var api = { supported: false, ready: null, key: null };
  window.OddiePush = api;

  api.supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!api.supported) return;

  // Registered on every app page, because the worker has to already exist when
  // somebody finally taps the ask; registering inside the tap costs a round
  // trip at the one moment the answer has to feel instant.
  api.ready = navigator.serviceWorker.register(SW).catch(function () { return null; });

  /** The server's public VAPID key, or null when push is not configured at all
   *  - in which case nothing is ever shown to anybody. */
  function vapidKey() {
    if (api.key !== null) return Promise.resolve(api.key);
    return fetch("/api/push/key").then(function (r) { return r.json(); })
      .then(function (j) { api.key = (j && j.key) || ""; return api.key; })
      .catch(function () { api.key = ""; return ""; });
  }

  /** base64url to the Uint8Array the PushManager wants. */
  function keyBytes(b64) {
    var pad = "=".repeat((4 - (b64.length % 4)) % 4);
    var raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  /** Whether it is worth showing our own line: push is configured, the browser
   *  has not already been answered, and there is a device to key it to. */
  api.askable = function () {
    var did = (window.OddieId && window.OddieId.get && window.OddieId.get()) || "";
    if (!did || Notification.permission !== "default") return Promise.resolve(false);
    return vapidKey().then(function (k) { return Boolean(k); });
  };

  /**
   * The real ask. Called ONLY from a tap.
   *
   * Resolves true when a subscription actually reached the server, which is not
   * the same as permission being granted: a browser can grant and then fail to
   * subscribe, and a caller that treated permission as success would tell
   * somebody they will be notified when nothing is listening.
   */
  api.ask = function () {
    var did = (window.OddieId && window.OddieId.get && window.OddieId.get()) || "";
    if (!did) return Promise.resolve(false);
    return vapidKey().then(function (key) {
      if (!key) return false;
      return Notification.requestPermission().then(function (p) {
        if (p !== "granted") return false;
        return api.ready.then(function (reg) {
          if (!reg) return false;
          return reg.pushManager.subscribe({
            // Required by every browser now: a push we cannot show is not
            // allowed, which suits a product whose only push is about money.
            userVisibleOnly: true,
            applicationServerKey: keyBytes(key),
          });
        }).then(function (sub) {
          if (!sub) return false;
          var j = sub.toJSON();
          return fetch("/api/push/subscribe", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ deviceId: did, subscription: j }),
          }).then(function (r) { return r.ok; });
        });
      });
    }).catch(function () { return false; });
  };

  /** Whether this browser already has a live subscription. Not the same as
   *  permission being granted: a granted browser whose subscription was
   *  dropped (permission reset, profile cleared) shows "on" and hears nothing,
   *  which is the failure worth catching. */
  api.subscribed = function () {
    if (Notification.permission !== "granted") return Promise.resolve(false);
    return api.ready.then(function (reg) {
      return reg ? reg.pushManager.getSubscription() : null;
    }).then(function (s) { return Boolean(s); }).catch(function () { return false; });
  };

  /**
   * ONE REAL NOTIFICATION, ON A REAL DEVICE.
   *
   * Everything else about this path can be proven from a server. Whether a
   * notification actually appears on a phone cannot, and the alternative to a
   * button is finding out the first time somebody wins.
   */
  api.test = function () {
    var did = (window.OddieId && window.OddieId.get && window.OddieId.get()) || "";
    if (!did) return Promise.resolve(false);
    return fetch("/api/push/test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: did }),
    }).then(function (r) { return r.json(); })
      .then(function (j) { return Boolean(j && j.ok); })
      .catch(function () { return false; });
  };

  /* A STAKE IS THE MOMENT SOMEBODY ACQUIRES A REASON TO BE TOLD, and chain.js
     already announces it. Remembered rather than acted on: the receipt sheet is
     open at that instant and stacking a system dialog on top of it is how a
     permission gets denied out of reflex. The profile reads this flag and asks
     when there is room. */
  document.addEventListener("oddie:staked", function () {
    try { localStorage.setItem("oddie.push.owed", "1"); } catch (e) { /* private mode */ }
  });
})();
