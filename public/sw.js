/*
 * THE ONLY REASON THIS FILE EXISTS IS TO BE AWAKE WHEN NOBODY IS LOOKING.
 *
 * A page can only tell somebody something while that page is open. A market
 * settles weeks after the bet, so by then there is no page: the money sits in
 * the vault and the person who won it has no way to find out except by
 * wandering back on their own. A service worker is the one piece of a website
 * the browser will start up on its own, and that is the whole of what it is for
 * here.
 *
 * DELIBERATELY NOT A CACHE. Every instinct says to make a service worker do
 * offline too, and this one must not: the pages it would cache are the ones
 * quoting live pools and live odds, and an offline copy of a market page is a
 * price that was true once, shown as though it were true now, on a screen where
 * somebody is deciding to spend money. Nothing here touches fetch.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  // A push with no payload, or a payload we cannot read, is still a push: the
  // server sent it because something happened, so it is better to say the dull
  // true thing than to swallow it.
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }
  const title = d.title || "oddie";
  const body = d.body || "Something of yours moved.";
  e.waitUntil(self.registration.showNotification(title, {
    body: body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // Tagged per market, so a resolve that fires twice replaces its own
    // notification instead of stacking two identical ones on a lock screen.
    tag: d.tag || "oddie",
    data: { url: d.url || "/profile" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/profile";
  /* FOCUS A TAB WE ALREADY HAVE, rather than opening a third copy of the app.
     Somebody who taps a payout notice with oddie already open in the background
     should land in the tab they left, on the page the notice is about. */
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (new URL(c.url).origin !== self.location.origin) continue;
      if ("focus" in c) return ("navigate" in c ? c.navigate(url).catch(() => c) : Promise.resolve(c)).then((w) => (w || c).focus());
    }
    return self.clients.openWindow(url);
  }));
});
