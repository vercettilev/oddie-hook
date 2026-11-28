/**
 * WHERE A VISIT TO THE LANDING CAME FROM.
 *
 * Lev asked on 27 Nov 2026, the evening the first clip went out on four
 * platforms: "peki websiteye girme, veya profile girme falan yok mu?" (did
 * anybody come to the site?). Nobody could say. The page carries no analytics,
 * and Railway's request log keeps a request's host, path and user agent but
 * not the page it came from. Its path has no query string either (measured
 * 28 Nov: a request for /?s=probe is logged with path "/"), so a link we
 * tagged could not be told from a bare one.
 *
 * So the landing writes one line per visit, with the three things a request
 * says about where it came from:
 *
 *   src        the tag a link of ours carried: oddie.fun/?s=yt
 *   ref        the host of the page that sent the visitor, or the Android app
 *              that did (the Referer's host, never its path or its query)
 *   fetchSite  the browser's own account of the navigation (Sec-Fetch-Site):
 *              "none" is an address typed, pasted or handed over by an app,
 *              "cross-site" is a link on somebody else's page, and
 *              "same-origin" or "same-site" is a move inside oddie.fun
 *
 * fetchSite earns its place because of how that first clip went out. The
 * comment under it said "oddie.fun" in plain text on three platforms, so the
 * only way in was to type it, and a typed visit has no Referer and no tag:
 * "none" is the one mark it leaves. Whether the header also separates people
 * from scanners wearing a browser's user agent (5 of that night's 7
 * browser-looking requests carried user agents years out of date) is not
 * measured yet; the first lines will say.
 *
 * Nothing about the person is written: no address, no user agent, no cookie.
 *
 * Clients that do not call themselves a browser get no line. That night they
 * were 710 of the 717 requests to "/", 689 of them a monitor asking once a
 * minute, which is the noise this line exists to get out from under.
 *
 * Read it with:
 *   railway logs -s oddie-hook --since 24h --lines 5000 --json --filter '@evt:landing_visit'
 */

export type FetchSite = "none" | "cross-site" | "same-origin" | "same-site";

export interface LandingVisit {
  /** The tag one of our own links carried (?s=yt), or null. */
  src: string | null;
  /** The host of the page, or the Android app, that sent the visitor, or null. */
  ref: string | null;
  /** The browser's own account of the navigation, or null when it gave none. */
  fetchSite: FetchSite | null;
}

/** The least of a request this reads. Express's Request fits it. */
export interface VisitRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
}

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? "" : v ?? "");

/* What a client that is not a browser says about itself, read off the user
   agents that asked for "/" on 27-28 Nov: a name with no "Mozilla/5.0 (" in
   front of it (site-watch/1.0, Twitterbot/1.0), "compatible;" (the crawlers
   that borrow the prefix), an address to write to (+https://...), or
   HeadlessChrome. "bot/" and not "bot": CUBOT is a phone. */
const NOT_A_BROWSER = /compatible;|\+https?:|headless|bot\/|crawl|spider/i;
export const callsItselfABrowser = (userAgent: string): boolean =>
  userAgent.startsWith("Mozilla/5.0 (") && !NOT_A_BROWSER.test(userAgent);

/* A tag is ours to choose, so it is held to what we would write: short, lower
   case, letters, digits, "-" and "_". Anything else is somebody else's query
   string and is not copied into the log. */
const TAG = /^[a-z0-9][a-z0-9_-]{0,23}$/;
function tag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return TAG.test(v) ? v : null;
}

/* The host and nothing after it. A Referer's path and query can name a page,
   a search or a person, and none of that is needed to say "from YouTube".
   An Android app that opens a link names itself the same way
   (android-app://com.google.android.youtube/), and that is kept as it is:
   it is the only trace an app leaves. */
function refHost(value: string): string | null {
  if (!value) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!host || host.length > 80) return null;
  if (u.protocol === "android-app:") return `android-app://${host}`;
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return host.replace(/^www\./, "");
}

const FETCH_SITES: ReadonlySet<string> = new Set(["none", "cross-site", "same-origin", "same-site"]);

/** What to write about this request for "/", or null when it gets no line. */
export function landingVisit(req: VisitRequest): LandingVisit | null {
  // A HEAD is somebody checking that the page is there, not reading it.
  if (req.method !== "GET") return null;
  if (!callsItselfABrowser(one(req.headers["user-agent"]))) return null;
  const site = one(req.headers["sec-fetch-site"]).trim().toLowerCase();
  return {
    src: tag(req.query.s) ?? tag(req.query.utm_source),
    ref: refHost(one(req.headers.referer).trim()),
    fetchSite: FETCH_SITES.has(site) ? (site as FetchSite) : null,
  };
}
