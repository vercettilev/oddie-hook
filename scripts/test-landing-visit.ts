// Where a visit to the landing came from (src/net/landingVisit.ts): the one
// line "/" writes per visit. What it keeps (our own tag, the sending host, the
// browser's account of the navigation), what it never keeps (the Referer's
// path and query, the user agent, the address), who gets no line (everything
// that does not call itself a browser), and that the root route really writes
// it, on the landing only. Real HTTP against a local Express app with the same
// handler shape, so the headers are the ones Express hands over.
//
// Run with: npm run test-landing-visit
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { callsItselfABrowser, landingVisit, type LandingVisit } from "../src/net/landingVisit.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const visit = (
  headers: Record<string, string | string[] | undefined>,
  query: Record<string, unknown> = {},
  method = "GET",
): LandingVisit | null => landingVisit({ method, headers: { "user-agent": SAFARI, ...headers }, query });

console.log("\nwhat a visit says about where it came from");
{
  check("a typed address: no tag, no referrer, and the browser says \"none\"",
    same(visit({ "sec-fetch-site": "none" }), { src: null, ref: null, fetchSite: "none" }));
  check("a link on X: t.co sent it, and the browser says cross-site",
    same(visit({ referer: "https://t.co/rXAe63r2Yr", "sec-fetch-site": "cross-site" }),
      { src: null, ref: "t.co", fetchSite: "cross-site" }));
  check("a tagged link of ours: ?s=yt",
    same(visit({ "sec-fetch-site": "none" }, { s: "yt" }), { src: "yt", ref: null, fetchSite: "none" }));
  check("utm_source is read when there is no ?s=",
    visit({}, { utm_source: "Instagram" })?.src === "instagram");
  check("?s= wins over utm_source", visit({}, { s: "tt", utm_source: "other" })?.src === "tt");
  check("a tag that is not one of ours falls through to utm_source",
    visit({}, { s: "not a tag!", utm_source: "x" })?.src === "x");
  check("www. is dropped from the host", visit({ referer: "https://www.youtube.com/redirect?q=x" })?.ref === "youtube.com");
  check("the host is lower-cased", visit({ referer: "https://L.Instagram.com/?u=x" })?.ref === "l.instagram.com");
  check("an Android app names itself, and that is kept",
    visit({ referer: "android-app://com.google.android.youtube/" })?.ref === "android-app://com.google.android.youtube");
  check("a move inside the site is said as it is",
    same(visit({ referer: "https://app.oddie.fun/markets", "sec-fetch-site": "same-site" }),
      { src: null, ref: "app.oddie.fun", fetchSite: "same-site" }));
  check("a browser too old to say how it navigated: null, not a guess",
    same(visit({}), { src: null, ref: null, fetchSite: null }));
  check("a header sent twice is read once", visit({ "sec-fetch-site": ["cross-site", "none"] })?.fetchSite === "cross-site");
}

console.log("\nwhat is never written");
{
  const v = visit({
    referer: "https://www.youtube.com/watch?v=lOu6GKF6Mxw&lc=UgxSomeCommentId#frag",
    "sec-fetch-site": "cross-site",
    cookie: "session=abc",
    "cf-connecting-ip": "203.0.113.7",
    "x-forwarded-for": "203.0.113.7",
  }, { s: "yt", deviceId: "d-123", email: "someone@example.com" });
  const line = JSON.stringify({ evt: "landing_visit", ...v });
  check("the line has the three fields and no others",
    same(Object.keys(v ?? {}).sort(), ["fetchSite", "ref", "src"]), line);
  check("the referrer's path and query are not in it", !/watch|lOu6GKF6Mxw|UgxSome|frag/.test(line), line);
  check("no address, cookie, user agent or other query value is in it",
    !/203\.0\.113\.7|session=|Mozilla|iPhone|d-123|example\.com/.test(line), line);
  check("a referrer that is no web address is dropped",
    visit({ referer: "javascript:alert(1)" })?.ref === null && visit({ referer: "not a url" })?.ref === null
    && visit({ referer: "file:///Users/someone/page.html" })?.ref === null);
  check("a tag longer than 24 characters is not copied", visit({}, { s: "a".repeat(25) })?.src === null);
  check("a tag is letters, digits, - and _ only",
    visit({}, { s: "<script>" })?.src === null && visit({}, { s: "a b" })?.src === null && visit({}, { s: "yt_shorts-1" })?.src === "yt_shorts-1");
  check("a tag sent twice (an array) is not copied", visit({}, { s: ["yt", "x"] })?.src === null);
  check("a made-up Sec-Fetch-Site value is not copied", visit({ "sec-fetch-site": "anything" })?.fetchSite === null);
  check("a host longer than 80 characters is dropped",
    visit({ referer: `https://${"a".repeat(60)}.${"b".repeat(30)}.com/` })?.ref === null);
}

console.log("\nwho gets no line");
{
  // Every user agent that asked for "/" between 27 Nov 20:26 and 28 Nov 09:34
  // TR, as Railway logged it, and what the count was read as that morning:
  // 7 browser-looking requests of 717.
  const seen: Array<[string, boolean]> = [
    ["site-watch/1.0", false],
    ["Mozilla/5.0 (compatible; sitewatch/1.0; contract-address monitor)", false],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.8078.4 Safari/537.36", false],
    ["Twitterbot/1.0", false],
    ["NoMoreVibe/1.0 (+https://nomorevibe.app)", false],
    ["Mozilla/5.0 (compatible; goscan-mini/0.1)", false],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; KeenableBot/1.0; +https://keenable.ai/bot)", false],
    ["BigCrawl/0.1 (public website catalog)", false],
    ["Hello from Palo Alto Networks, find out more about our scans in https://docs-cortex.paloaltonetworks.com/", false],
    ["Mozilla/5.0 (compatible; stratagy-scanner/1.0; +research)", false],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1", true],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", true],
    [SAFARI, true],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36", true],
  ];
  for (const [ua, browser] of seen) {
    check(`${browser ? "a line" : "no line"}: ${ua.slice(0, 64)}`, callsItselfABrowser(ua) === browser);
  }
  check("...and landingVisit agrees with it",
    seen.every(([ua, browser]) => (landingVisit({ method: "GET", headers: { "user-agent": ua }, query: {} }) !== null) === browser));
  // The apps the clips are watched in open links in their own browser.
  for (const ua of [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0 (iPhone14,5; iOS 17_5; en_US; en; scale=3.00; 1170x2532; 123456789)",
    "Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.135 Mobile Safari/537.36 musical_ly_2023405030 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/musical_ly app_version/34.5.3 ByteLocale/en Region/US BytedanceWebview/d8a21c6",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.50",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    CHROME,
  ]) check(`a line: ${ua.slice(-44)}`, callsItselfABrowser(ua));
  check("a phone named CUBOT is a phone",
    callsItselfABrowser("Mozilla/5.0 (Linux; Android 11; CUBOT NOTE 20 PRO) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"));
  check("Googlebot wearing a phone's user agent gets no line",
    !callsItselfABrowser("Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"));
  check("no user agent at all gets no line", landingVisit({ method: "GET", headers: {}, query: {} }) === null);
  check("a HEAD gets no line (somebody checking the page is there)", visit({ "sec-fetch-site": "none" }, {}, "HEAD") === null);
}

console.log("\nover real HTTP, through Express");
{
  // The same two statements the root route runs, with the line caught instead
  // of printed.
  const lines: string[] = [];
  const app = express();
  app.get("/", (req, res) => {
    const v = landingVisit(req);
    if (v) lines.push(JSON.stringify({ evt: "landing_visit", ...v }));
    res.type("html").send("<!doctype html>");
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as AddressInfo).port;
  const hit = (path: string, method: string, headers: Record<string, string>): Promise<number> =>
    new Promise((resolve, reject) => {
      const rq = http.request({ host: "127.0.0.1", port, path, method, headers }, (rs) => {
        rs.resume();
        rs.on("end", () => resolve(rs.statusCode ?? 0));
      });
      rq.on("error", reject);
      rq.end();
    });

  const a = await hit("/?s=yt", "GET", { "User-Agent": CHROME, "Sec-Fetch-Site": "none" });
  check("a tagged, typed visit is served and written", a === 200
    && lines.length === 1 && lines[0] === '{"evt":"landing_visit","src":"yt","ref":null,"fetchSite":"none"}', lines.join(" | "));
  await hit("/", "GET", { "User-Agent": CHROME, Referer: "https://t.co/abc?x=1", "Sec-Fetch-Site": "cross-site" });
  check("a click from X is written with t.co and nothing after it",
    lines[1] === '{"evt":"landing_visit","src":null,"ref":"t.co","fetchSite":"cross-site"}', lines[1]);
  await hit("/", "GET", { "User-Agent": "site-watch/1.0" });
  await hit("/", "HEAD", { "User-Agent": CHROME });
  check("the monitor and a HEAD are served and write nothing", lines.length === 2, `${lines.length} lines`);
  await hit("/?s=yt&s=x&utm_source=ig", "GET", { "User-Agent": CHROME });
  check("?s= given twice is no tag of ours; utm_source is read",
    lines[2] === '{"evt":"landing_visit","src":"ig","ref":null,"fetchSite":null}', lines[2]);
  await new Promise<void>((r) => server.close(() => r()));
}

console.log("\nthe root route writes it, on the landing only");
{
  const server = readFileSync("src/server.ts", "utf8");
  const start = server.indexOf('app.get("/", async (req, res) => {');
  const end = server.indexOf("\n});", start);
  const route = start >= 0 && end > start ? server.slice(start, end) : "";
  check("the root route is where it was looked for", route.length > 0);
  check("it writes one landing_visit line from landingVisit(req)",
    route.split("landingVisit(req)").length === 2
    && /const visit = landingVisit\(req\);\n\s*if \(visit\) console\.log\(JSON\.stringify\(\{ evt: "landing_visit", \.\.\.visit \}\)\);/.test(route));
  const appHost = route.indexOf("if (isAppHost(req)) {");
  const appHostEnd = route.indexOf("\n  }", appHost);
  const written = route.indexOf("landingVisit(req)");
  check("after the app host has taken its own root (the app's list is no landing visit)",
    appHost >= 0 && appHostEnd > appHost && written > appHostEnd
    && /return res\.set\("Cache-Control", "no-cache"\)\.type\("html"\)\.send\(stampApp\(MARKETS_HTML\)\);/.test(route.slice(appHost, appHostEnd)));
  check("and before the render, so a page that fails to render still counts",
    written < route.indexOf("renderLanding()"));
  check("nothing else in the server writes that event",
    server.split('evt: "landing_visit"').length === 2);
}

console.log(failures === 0 ? "\nall landing visit checks passed.\n" : `\n${failures} landing visit check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
