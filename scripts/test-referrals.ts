// Invites (src/live/referrals.ts): a streamer who brings a streamer earns part
// of Oddie's own fee on the new channel's markets, for a while. The terms, the
// cookie, who is credited and when (through each platform's real connect, its
// own side faked), the ledger's arithmetic read off the fee each resolve
// recorded, the owner's card, and the admin's ledger and recorded payouts.
// Memory stores only; every outside service is a fake, so nothing leaves this
// machine.
//
// Run with: npm run test-referrals
if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database: unset DATABASE_URL");
  process.exit(1);
}
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";
import { _resetLive, type LiveDeps } from "../src/live/calls.js";
import { liveStore, saveChannel, _resetLiveStore } from "../src/store/live.js";
import { kickRouter, type KickSignIn } from "../src/kick/routes.js";
import { twitchRouter, type TwitchSignIn } from "../src/twitch/routes.js";
import { xLiveRouter, _resetXLive, type XLiveApi, type XVoice } from "../src/x/live.js";
import { youtubeRouter, _resetYouTube, type YouTubeApi } from "../src/youtube/routes.js";
import type { YouTubeChannel } from "../src/youtube/client.js";
import { ownerCookieName, ownerKeyFromEnv, ownerToken } from "../src/live/owner.js";
import {
  REFERRAL_SHARE_BPS, REFERRAL_DAYS, REFERRAL_COOKIE, REFERRAL_COOKIE_DAYS, MONEY_PLATFORMS, inviteTerms, invitePath,
  referralCookieValue, parseReferralCookie, referralCookie, sharedCookieDomain, creditInvite,
  shareOf, inWindow, windowEnd, referralEarnings, referralLedger, inviteCard, referralRouter, type LedgerMarket,
} from "../src/live/referrals.js";
import { saveReferral, referralOf, referralsBy, _resetReferralStore, type Referral } from "../src/store/referrals.js";
import { claimMention, settleMention, logRealFee, recordedProtocolFees, streamOpenedMarkets, _resetBotState } from "../src/store/markets.js";
import { PROTOCOL_FEE_BPS_REAL } from "../src/store/economy.js";
import { _setPace } from "../src/live/pace.js";

process.env.LIVE_TOKEN_KEY = "test-key-for-referrals";
process.env.KICK_CLIENT_ID = "test-client";
process.env.KICK_CLIENT_SECRET = "test-secret";
process.env.YOUTUBE_VOICE_CHANNEL = "oddiefun";
_setPace({ gapMs: 0, retryMs: [0, 0] });

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

const DAY = 86_400_000;
const logs: Array<{ line: string; extra?: Record<string, unknown> }> = [];
const log = (line: string, extra?: Record<string, unknown>) => { logs.push({ line, extra }); };
_resetLiveStore(); _resetLive(); _resetReferralStore(); _resetBotState(); _resetXLive(); _resetYouTube();

/** A channel that is already on Oddie. */
const seed = (platform: "kick" | "twitch" | "x" | "youtube", channelId: string, slug: string, extra: Record<string, unknown> = {}) =>
  saveChannel({ platform, channelId, slug, name: slug, avatar: null, accessToken: null, refreshToken: null, tokenExpiresAt: null, active: true, ...extra });
const ownerCookieFor = (platform: "kick" | "twitch" | "x" | "youtube", channelId: string) =>
  `${ownerCookieName(platform)}=${ownerToken(channelId, ownerKeyFromEnv(platform) as Buffer)}`;
const refCookie = (platform: "kick" | "twitch" | "x" | "youtube", channelId: string, at = Date.now()) =>
  `${REFERRAL_COOKIE}=${referralCookieValue(platform, channelId, at)}`;

console.log("the terms, in one place");
{
  check("a quarter of Oddie's fee, for 180 days, remembered for 30", REFERRAL_SHARE_BPS === 2500 && REFERRAL_DAYS === 180 && REFERRAL_COOKIE_DAYS === 30);
  check("Oddie's fee is the 2% the share is taken from", PROTOCOL_FEE_BPS_REAL === 200);
  check("the streamer reads Lev's line, said from those numbers",
    inviteTerms() === "You get 0.5% of every pool in their chat for 6 months.", inviteTerms());
  check("...and it follows them when they change", inviteTerms(5000, 90) === "You get 1% of every pool in their chat for 3 months."
    && inviteTerms(2500, 45) === "You get 0.5% of every pool in their chat for 45 days.", inviteTerms(5000, 90));
  check("only Kick and Twitch chats open markets that pay a fee",
    [...MONEY_PLATFORMS].sort().join() === "kick,twitch" && !MONEY_PLATFORMS.has("x") && !MONEY_PLATFORMS.has("youtube"));
}

console.log("\nthe cookie");
{
  const T = Date.UTC(2026, 10, 3, 12);
  const v = referralCookieValue("kick", "131980691", T);
  const back = parseReferralCookie(v, T + 1_000);
  check("it names the channel that invited, and when", back?.platform === "kick" && back.channelId === "131980691" && back.at === T, v);
  check("a YouTube id keeps its dashes and underscores", parseReferralCookie(referralCookieValue("youtube", "UCa-b_c0000000000000000x", T), T)?.channelId === "UCa-b_c0000000000000000x");
  check("it lasts its 30 days and not a moment more",
    parseReferralCookie(v, T + 30 * DAY - 1) !== null && parseReferralCookie(v, T + 30 * DAY + 1) === null);
  check("one from a few minutes ahead of this clock is taken, one from tomorrow is not",
    parseReferralCookie(referralCookieValue("kick", "1", T + 60_000), T) !== null && parseReferralCookie(referralCookieValue("kick", "1", T + DAY), T) === null);
  const bad = ["", "kick", "kick.123", "kick.123.abc.def", "steam.123.abc", "kick.12 3.abc", "kick..abc", "kick.123.ABC",
    `kick.123.${"z".repeat(12)}`, `kick.${"1".repeat(41)}.abc`, "x.1.-5", `kick.1.${"a".repeat(90)}`];
  check("anything malformed is null, never a throw", bad.every((b) => parseReferralCookie(b, T) === null)
    && parseReferralCookie(null, T) === null && parseReferralCookie(undefined, T) === null,
    bad.filter((b) => parseReferralCookie(b, T) !== null).join(" | "));
  let threw = 0;
  for (const [p, id] of [["kick", "a.b"], ["steam", "1"], ["kick", ""]] as const) {
    try { referralCookieValue(p as "kick", id); } catch { threw++; }
  }
  check("no cookie is made for something that is not a channel", threw === 3);
  const line = referralCookie(v, true, ".oddie.fun");
  check("the cookie is HttpOnly, same-site, on every path a connect ends on, for 30 days",
    line.startsWith(`${REFERRAL_COOKIE}=${v};`) && /; HttpOnly/.test(line) && /; SameSite=Lax/.test(line) && /; Path=\/;/.test(line)
    && /; Max-Age=2592000;/.test(line) && /; Secure/.test(line) && /; Domain=\.oddie\.fun$/.test(line), line);
  check("...Secure only over https, and on its own host unless told otherwise",
    !/Secure|Domain/.test(referralCookie(v, false)), referralCookie(v, false));
  check("the shared domain is Oddie's own, and nobody else's",
    sharedCookieDomain("https://app.oddie.fun") === ".oddie.fun" && sharedCookieDomain("https://oddie.fun") === ".oddie.fun"
    && sharedCookieDomain("http://localhost:3000") === null && sharedCookieDomain("https://evil-oddie.fun") === null
    && sharedCookieDomain("https://oddie.fun.evil.com") === null && sharedCookieDomain("not a url") === null);
  check("the invite link names the channel by its page's name", invitePath("x", "Show Down") === "/live/invite/x/Show%20Down");
}

/* ------------------------------------------------ one app, every platform -- */

const ADMIN = "admin-token-for-tests";
const app = express();
app.use(express.json());
const engine: LiveDeps = { store: liveStore, now: () => Date.now(), say: async () => {}, standingsUrl: async () => "", log: () => {} };
let kickWho = { userId: "2002", name: "NewKick", avatar: null as string | null, slug: "newkick" };
const kickSignIn: KickSignIn = {
  exchangeCode: async () => ({ accessToken: "acc", refreshToken: "ref", expiresAt: Date.now() + 3_600_000 }),
  me: async () => ({ userId: kickWho.userId, name: kickWho.name, avatar: kickWho.avatar }),
  myChannel: async () => ({ slug: kickWho.slug }),
  subscribe: async () => ({ added: [] }),
};
app.use(kickRouter({ appBaseUrl: "https://app.oddie.fun", pageHtml: () => "<p>page</p>", pageOpen: () => true, pageClosed: (res) => { res.status(404).end(); },
  log, signIn: kickSignIn, engine,
  payout: {
    domain: () => "app.oddie.fun", wallet: async () => null, setWallet: async () => {},
    openedSlugs: async () => [], nameMarkets: async () => ({ onRow: 0, onChain: 0, seen: 0 }),
  } }));
let twitchWho = { userId: "5005", login: "newtwitch", name: "NewTwitch", avatar: null as string | null };
const twitchSignIn: TwitchSignIn = {
  exchangeCode: async () => ({ accessToken: "acc", refreshToken: "ref", expiresAt: Date.now() + 3_600_000 }),
  me: async () => twitchWho,
  subscribe: async () => ({ added: true }),
};
app.use(twitchRouter({ appBaseUrl: "https://app.oddie.fun", pageHtml: () => "<p>page</p>", pageOpen: () => true, pageClosed: (res) => { res.status(404).end(); },
  log, signIn: twitchSignIn, secret: () => "s3cret", engine }));
const ODDIE_X = "1000000000000000001";
let xWho = { id: "7000000000000000007", username: "NewOnX" };
const xApi: XLiveApi = {
  exchangeCode: async (code) => ({ accessToken: `at-${code}`, refreshToken: `rt-${code}`, expiresAt: Date.now() + 7_200_000 }),
  me: async () => ({ id: xWho.id, username: xWho.username, name: xWho.username, avatar: null }),
  subscribe: async () => "sub",
  sendChat: async () => null,
  stream: async () => {},
};
const xVoice: XVoice = { ready: () => true, token: async () => "at-voice", userId: () => ODDIE_X, adopt: async () => {} };
// X's one callback is on the landing's host, the page on the app's, as in production.
const xl = xLiveRouter({ appBaseUrl: "https://app.oddie.fun", redirectUri: "https://oddie.fun/api/auth/twitter/callback",
  pageHtml: () => "<p>page</p>", pageOpen: () => true, pageClosed: (res) => { res.status(404).end(); }, log, api: xApi, voice: xVoice });
app.use(xl.router);
app.get("/api/auth/twitter/callback", async (req, res) => {
  const state = String(req.query.state ?? "");
  if (state.startsWith("xl_") && await xl.callback(state, req.query, res, req.headers.cookie)) return;
  res.status(418).send("site sign-in");
});
const ytKnown: Record<string, YouTubeChannel> = {
  pasted: { channelId: "UCpasted0000000000000001", handle: "pasted", name: "Pasted", avatar: null },
  signedin: { channelId: "UCsignedin00000000000001", handle: "signedin", name: "Signed In", avatar: null },
};
let ytMe = ytKnown.signedin;
const ytApi: YouTubeApi = {
  exchangeCode: async (code) => ({ accessToken: `at-${code}`, refreshToken: `rt-${code}`, expiresAt: Date.now() + 3_600_000 }),
  me: async () => ytMe,
  channelLookup: async (_t, ref) => (ref.by === "handle" ? ytKnown[ref.handle] ?? null : null),
  refreshTokens: async () => ({ accessToken: "at-fresh", refreshToken: null, expiresAt: Date.now() + 3_600_000 }),
  recentVideoIds: async () => [], uploadsVideoIds: async () => [], videosLive: async () => [],
  streamChat: async () => ({ pageToken: null, offline: true }), sendChat: async () => null,
};
app.use(youtubeRouter({ appBaseUrl: "https://app.oddie.fun", pageHtml: () => "<p>page</p>", pageOpen: () => true, pageClosed: (res) => { res.status(404).end(); },
  log, api: ytApi }));
app.use(referralRouter({ appBaseUrl: "https://app.oddie.fun", cookieDomain: ".oddie.fun",
  adminOk: (req) => req.get("x-oddie-admin") === ADMIN, adminHtml: () => "<p>ledger</p>", log }));
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const get = (p: string, cookie?: string) => fetch(base + p, { redirect: "manual", headers: cookie ? { cookie } : {} });
const stateOf = (loc: string | null) => new URL(loc ?? "http://x").searchParams.get("state") ?? "";

// Who invites: a Kick streamer, and an X Live streamer (the partners are on X).
await seed("kick", "1001", "kickref");
await seed("x", "9000000000000000009", "ShowdownTV");
await seed("youtube", "UCoddie00000000000000001", "oddiefun", { accessToken: "at-v", refreshToken: "rt-v", tokenExpiresAt: Date.now() + 3_600_000 });

console.log("\nthe invite link");
{
  const r = await get("/live/invite/kick/KICKREF");
  const set = r.headers.get("set-cookie") ?? "";
  const value = set.split(";")[0]?.split("=")[1] ?? "";
  check("it remembers the channel that sent it and leads to the page with every Add button",
    r.status === 302 && r.headers.get("location") === "/live" && parseReferralCookie(value)?.channelId === "1001"
    && /HttpOnly/.test(set) && /Domain=\.oddie\.fun/.test(set) && /Secure/.test(set), `${r.status} ${r.headers.get("location")} ${set}`);
  check("...and is never cached or indexed", /no-store/.test(r.headers.get("cache-control") ?? "") && /noindex/.test(r.headers.get("x-robots-tag") ?? ""));
  const nobody = await get("/live/invite/kick/nobody-here");
  const wrong = await get("/live/invite/steam/kickref");
  check("a channel Oddie does not know, or no platform at all, leads to the page and remembers nothing",
    nobody.status === 302 && nobody.headers.get("location") === "/live" && !nobody.headers.get("set-cookie")
    && wrong.status === 302 && !wrong.headers.get("set-cookie"));
  check("each opening is in the log, without the visitor", logs.some((l) => l.line === "invite opened" && l.extra?.channel === "kickref"));
}

console.log("\na first connect through an invite, on each platform");
const kickConnect = async (cookie?: string) => {
  const go = await get("/live/kick/connect");
  return get(`/live/kick/callback?state=${stateOf(go.headers.get("location"))}&code=abc`, cookie);
};
{
  const r = await kickConnect(refCookie("kick", "1001"));
  const ref = await referralOf("kick", "2002");
  check("Kick: a new channel is the inviting channel's, on today's terms",
    r.headers.get("location") === "https://app.oddie.fun/live/kick/newkick?connected=1" && ref?.referrerPlatform === "kick" && ref.referrerId === "1001"
    && ref.shareBps === REFERRAL_SHARE_BPS && ref.days === REFERRAL_DAYS && Math.abs(ref.at - Date.now()) < 60_000, JSON.stringify(ref));
  check("...and the connect still ends as it did, with the owner cookie", (r.headers.get("set-cookie") ?? "").startsWith(`${ownerCookieName("kick")}=`));
  check("...said in the log", logs.some((l) => l.line === "invite at connect" && l.extra?.outcome === "recorded" && l.extra?.by === "kick:1001"));
  // The same channel again, through somebody else's invite: who brought it never changes.
  await kickConnect(refCookie("x", "9000000000000000009"));
  const again = await referralOf("kick", "2002");
  check("a reconnect is not a new channel: the referral is the first one, unchanged",
    again?.referrerPlatform === "kick" && again.referrerId === "1001" && again.at === ref?.at
    && logs.some((l) => l.line === "invite at connect" && l.extra?.outcome === "not-new"));

  // A channel that was on Oddie before invites existed for it, reconnecting with an invite in the browser.
  await seed("kick", "3003", "oldtimer");
  kickWho = { userId: "3003", name: "OldTimer", avatar: null, slug: "oldtimer" };
  await kickConnect(refCookie("kick", "1001"));
  check("an existing channel that signs in again is nobody's referral", (await referralOf("kick", "3003")) === null);

  // No cookie at all: a plain connect.
  kickWho = { userId: "4004", name: "Plain", avatar: null, slug: "plain" };
  const before = logs.length;
  await kickConnect();
  check("no invite in the browser, no referral and nothing logged about one",
    (await referralOf("kick", "4004")) === null && !logs.slice(before).some((l) => l.line === "invite at connect"));

  twitchWho = { userId: "5005", login: "newtwitch", name: "NewTwitch", avatar: null };
  const tgo = await get("/live/twitch/connect");
  const tr = await get(`/live/twitch/callback?state=${stateOf(tgo.headers.get("location"))}&code=abc`, refCookie("x", "9000000000000000009"));
  const tref = await referralOf("twitch", "5005");
  check("Twitch: the same, through an X streamer's invite",
    tr.headers.get("location") === "https://app.oddie.fun/live/twitch/newtwitch?connected=1" && tref?.referrerPlatform === "x" && tref.referrerId === "9000000000000000009", JSON.stringify(tref));

  const xgo = await get("/live/x/connect");
  const xr = await get(`/api/auth/twitter/callback?state=${stateOf(xgo.headers.get("location"))}&code=streamer`, refCookie("kick", "1001"));
  const xref = await referralOf("x", xWho.id);
  const xset = xr.headers.get("set-cookie") ?? "";
  check("X Live: a new channel is the inviting channel's", xr.headers.get("location") === "https://app.oddie.fun/live/x/NewOnX?added=1"
    && xref?.referrerPlatform === "kick" && xref.referrerId === "1001", `${xr.headers.get("location")} ${JSON.stringify(xref)}`);
  check("...and X's sign-in now leaves the owner cookie, on the shared domain its page on the app's host can see",
    xset.startsWith(`${ownerCookieName("x")}=`) && /Path=\/api\/live\/x;/.test(xset) && /HttpOnly/.test(xset) && /Domain=\.oddie\.fun/.test(xset), xset);

  const pasted = await fetch(`${base}/live/youtube/add`, { method: "POST",
    headers: { "content-type": "application/json", cookie: refCookie("x", "9000000000000000009") }, body: JSON.stringify({ channel: "youtube.com/@pasted" }) });
  const yref = await referralOf("youtube", ytKnown.pasted.channelId);
  check("YouTube: a first paste through an invite counts toward it", pasted.status === 200 && yref?.referrerPlatform === "x", `${pasted.status} ${JSON.stringify(yref)}`);
  await fetch(`${base}/live/youtube/add`, { method: "POST",
    headers: { "content-type": "application/json", cookie: refCookie("kick", "1001") }, body: JSON.stringify({ channel: "youtube.com/@pasted" }) });
  check("...and pasting it again through another changes nothing", (await referralOf("youtube", ytKnown.pasted.channelId))?.referrerPlatform === "x");

  const vgo = await get("/live/youtube/voice");
  ytMe = ytKnown.signedin;
  const yr = await get(`/live/youtube/callback?state=${stateOf(vgo.headers.get("location"))}&code=g1`, refCookie("kick", "1001"));
  const yset = yr.headers.get("set-cookie") ?? "";
  check("YouTube's own sign-in, the door that proves the channel, leaves its owner cookie and counts the invite",
    (yr.headers.get("location") ?? "").endsWith("/live/youtube/signedin?added=1") && yset.startsWith(`${ownerCookieName("youtube")}=`)
    && /Path=\/api\/live\/youtube;/.test(yset) && (await referralOf("youtube", ytKnown.signedin.channelId))?.referrerId === "1001", `${yr.headers.get("location")} ${yset}`);
}

console.log("\nwho is never credited");
{
  await seed("kick", "6006", "selfie");
  const self = await creditInvite(refCookie("kick", "6006"), { platform: "kick", channelId: "6006", slug: "selfie" }, true, log);
  check("a channel cannot invite itself", self === "self" && (await referralOf("kick", "6006")) === null);
  const twin = await creditInvite(refCookie("kick", "1001"), { platform: "twitch", channelId: "6116", slug: "KickRef" }, true, log);
  check("...nor its own name on another platform", twin === "self" && (await referralOf("twitch", "6116")) === null);
  const ghost = await creditInvite(refCookie("kick", "424242"), { platform: "twitch", channelId: "6226", slug: "someone" }, true, log);
  check("an invite naming a channel Oddie never had is refused", ghost === "unknown-referrer" && (await referralOf("twitch", "6226")) === null);
  const forged = await creditInvite(`${REFERRAL_COOKIE}=kick.1001.notbase36!`, { platform: "twitch", channelId: "6336", slug: "x1" }, true, log);
  const stale = await creditInvite(refCookie("kick", "1001", Date.now() - 31 * DAY), { platform: "twitch", channelId: "6446", slug: "x2" }, true, log);
  check("a malformed or expired cookie is refused", forged === "bad-cookie" && stale === "bad-cookie"
    && (await referralOf("twitch", "6336")) === null && (await referralOf("twitch", "6446")) === null);
  const unread = await creditInvite(refCookie("kick", "1001"), { platform: "twitch", channelId: "6556", slug: "x3" }, false, log);
  check("a channel the platform could not show was new is never credited", unread === "not-new" && (await referralOf("twitch", "6556")) === null);
  check("one referral per channel, by the table itself",
    !(await saveReferral({ platform: "kick", channelId: "2002", referrerPlatform: "x", referrerId: "9000000000000000009", at: 1, shareBps: 9999, days: 9 }))
    && (await referralOf("kick", "2002"))?.referrerId === "1001");
  check("no cookie is no-cookie", (await creditInvite("a=1; b=2", { platform: "kick", channelId: "6666", slug: "x4" }, true)) === "no-cookie");
}

console.log("\nthe share, in lamports");
{
  check("a quarter of the recorded fee, rounded down to a whole lamport",
    shareOf(400, 2500) === 100 && shareOf(333, 2500) === 83 && shareOf(3, 2500) === 0 && shareOf(1_000_000_007, 2500) === 250_000_001);
  check("no recorded fee, no share", shareOf(null, 2500) === 0 && shareOf(undefined, 2500) === 0 && shareOf(0, 2500) === 0 && shareOf(-40, 2500) === 0);
  check("...nor from a fee that is not a whole number of lamports", shareOf(400.5, 2500) === 0 && shareOf(Number.NaN, 2500) === 0
    && shareOf(Number.MAX_SAFE_INTEGER + 2, 2500) === 0);
  check("exact past where a double would round: no float on the way", shareOf(9_007_199_254_740_991, 2500) === 2_251_799_813_685_247);
  check("a share is never more than the fee, and none is none", shareOf(400, 20_000) === 400 && shareOf(400, 0) === 0);

  const T = Date.UTC(2026, 10, 3);
  const r = { at: T, days: 180 };
  check("the window opens at the first connect and closes 180 days on",
    inWindow(r, T) && !inWindow(r, T - 1) && inWindow(r, T + 180 * DAY - 1) && !inWindow(r, T + 180 * DAY) && windowEnd(r) === T + 180 * DAY);
  const ref = (platform: Referral["platform"]): Referral => ({ platform, channelId: "c", referrerPlatform: "kick", referrerId: "1001", at: T, shareBps: 2500, days: 180 });
  const markets: LedgerMarket[] = [
    { slug: "inside", openedAt: T + 10 * DAY, protocolFeeLamports: 400 },
    { slug: "unresolved", openedAt: T + 11 * DAY, protocolFeeLamports: null },
    { slug: "before", openedAt: T - DAY, protocolFeeLamports: 4000 },
    { slug: "after", openedAt: T + 181 * DAY, protocolFeeLamports: 4000 },
  ];
  const k = referralEarnings(ref("kick"), markets);
  check("only markets opened inside the window count", k.earnedLamports === 100
    && k.lines.map((l) => `${l.slug}:${l.counted}:${l.shareLamports}`).join() === "inside:true:100,unresolved:true:0,before:false:0,after:false:0",
    JSON.stringify(k.lines));
  const x = referralEarnings(ref("x"), markets), y = referralEarnings(ref("youtube"), markets);
  check("an X or YouTube channel earns its referrer nothing, whatever is in front of it",
    x.earnedLamports === 0 && y.earnedLamports === 0 && [...x.lines, ...y.lines].every((l) => !l.counted && l.shareLamports === 0));
}

console.log("\nthe ledger, read off what each resolve recorded");
const opened = async (key: string, slug: string, reason = "opened") => { await claimMention(key, "viewer"); await settleMention(key, "replied", { slug, reason }); };
{
  // kick:2002 joined through kick:1001's invite above. Its chat opens markets:
  await opened("kick:2002:m-1", "ref-capped");      // resolved: the program fixed a capped fee
  await opened("kick:2002:m-2", "ref-open");        // not settled yet: no fee recorded
  await opened("kick:2002:m-3", "ref-one-sided");   // one-sided: the program took nothing
  await opened("kick:2002:m-4", "ref-elsewhere", "existing"); // a pointer to a market opened in another chat
  await opened("kick:7777:m-5", "ref-elsewhere");
  await logRealFee("ref-capped", 1_001_000_000, 200, { creator: 333, protocol: 333 });
  await logRealFee("ref-one-sided", 2_000_000_000, 200, { creator: 0, protocol: 0 });
  await logRealFee("ref-elsewhere", 10_000_000_000, 200, { creator: 200_000_000, protocol: 200_000_000 });
  const mk = await streamOpenedMarkets("kick", "2002");
  check("the channel's own markets, each with the moment it opened",
    mk.map((m) => m.slug).join() === "ref-capped,ref-open,ref-one-sided" && mk.every((m) => Math.abs(m.openedAt - Date.now()) < 60_000), JSON.stringify(mk));
  const fees = await recordedProtocolFees(["ref-capped", "ref-open", "ref-one-sided", "ref-elsewhere"]);
  check("the fee is the one recorded, never the rate times the pool",
    fees.get("ref-capped") === 333 && !fees.has("ref-open") && !fees.has("ref-one-sided") && fees.get("ref-elsewhere") === 200_000_000, JSON.stringify([...fees]));
  await logRealFee("ref-logged-twice", 1_000_000_000, 200, { creator: 1, protocol: 500 });
  await logRealFee("ref-logged-twice", 1_000_000_000, 200, { creator: 1, protocol: 600 });
  check("...and a market logged twice keeps its latest", (await recordedProtocolFees(["ref-logged-twice"])).get("ref-logged-twice") === 600);

  const [mine] = await referralLedger({ platform: "kick", channelId: "1001" });
  const line = mine?.referrals.find((r) => r.channelId === "2002");
  check("kick:1001 earned a quarter of the one fee its referral's chat produced: 333 lamports make 83",
    line?.earnedLamports === 83 && line.markets.find((m) => m.slug === "ref-open")?.shareLamports === 0
    && line.markets.find((m) => m.slug === "ref-one-sided")?.shareLamports === 0 && !line.markets.some((m) => m.slug === "ref-elsewhere"),
    JSON.stringify(line?.markets));
  check("...across everybody it brought, the votes-only channels at nothing",
    mine?.referrals.map((r) => r.platform).sort().join() === "kick,x,youtube" && mine.earnedLamports === 83 && mine.owedLamports === 83, JSON.stringify(mine?.referrals.map((r) => [r.platform, r.earnedLamports])));

  // An X channel's chat with a market and a fee in front of it (the day X ran
  // markets, 16 Oct) still earns its referrer nothing.
  await opened(`x:${xWho.id}:m-6`, "ref-x-market");
  await logRealFee("ref-x-market", 4_000_000_000, 200, { creator: 80_000_000, protocol: 80_000_000 });
  const [again] = await referralLedger({ platform: "kick", channelId: "1001" });
  check("a referred X channel accrues 0 even with a recorded fee", again?.referrals.find((r) => r.platform === "x")?.earnedLamports === 0 && again.earnedLamports === 83);

  // The window, end to end: three channels referred by kick:1500 at different
  // moments, each opening one market now with a 1000-lamport fee.
  await seed("kick", "1500", "windowref");
  const now = Date.now();
  for (const [id, at] of [["8001", now - 10 * DAY], ["8002", now - 200 * DAY], ["8003", now + DAY]] as const) {
    await saveReferral({ platform: "twitch", channelId: id, referrerPlatform: "kick", referrerId: "1500", at, shareBps: REFERRAL_SHARE_BPS, days: REFERRAL_DAYS });
    await opened(`twitch:${id}:m-w`, `ref-window-${id}`);
    await logRealFee(`ref-window-${id}`, 1_000_000_000, 200, { creator: 1000, protocol: 1000 });
  }
  const [w] = await referralLedger({ platform: "kick", channelId: "1500" });
  const by = (id: string) => w?.referrals.find((r) => r.channelId === id)?.earnedLamports;
  check("a market inside the window counts; one after it closed, or before the referral, does not",
    by("8001") === 250 && by("8002") === 0 && by("8003") === 0 && w?.earnedLamports === 250, JSON.stringify(w?.referrals.map((r) => [r.channelId, r.earnedLamports])));
  check("a referral keeps the terms it was made on", (await referralsBy("kick", "1500")).every((r) => r.shareBps === 2500 && r.days === 180));
  const [lonely] = await referralLedger({ platform: "kick", channelId: "4004" });
  check("a channel that brought nobody has an empty ledger, not none", lonely?.referrals.length === 0 && lonely.earnedLamports === 0);
}

console.log("\nthe owner's card");
{
  type Api = { owner?: { wallet?: string | null; invite?: { path: string; terms: string; brought: number; earnedLamports: number; paidLamports: number; wallet: string | null } } };
  const read = (p: string, cookie?: string) => get(p, cookie).then((r) => r.json() as Promise<Api>);
  const mine = await read("/api/live/kick/kickref", ownerCookieFor("kick", "1001"));
  check("the streamer's own browser sees the link, the one line of terms, who joined and what it earned",
    mine.owner?.invite?.path === "/live/invite/kick/kickref" && mine.owner.invite.terms === inviteTerms()
    && mine.owner.invite.brought === 3 && mine.owner.invite.earnedLamports === 83 && mine.owner.invite.paidLamports === 0
    && mine.owner.invite.wallet === null && "wallet" in (mine.owner ?? {}), JSON.stringify(mine.owner?.invite));
  check("...nobody else does", (await read("/api/live/kick/kickref")).owner === undefined
    && (await read("/api/live/kick/kickref", ownerCookieFor("kick", "2002"))).owner === undefined);
  const x = await read("/api/live/x/ShowdownTV", ownerCookieFor("x", "9000000000000000009"));
  check("an X streamer's card is the invite alone: X pays no 2%, so no wallet card",
    x.owner?.invite?.path === "/live/invite/x/ShowdownTV" && x.owner.invite.brought === 2 && !("wallet" in x.owner), JSON.stringify(x.owner));
  check("...and without the owner cookie, nothing", (await read("/api/live/x/ShowdownTV")).owner === undefined);
  const card = await inviteCard({ platform: "youtube", channelId: "UCnobody", slug: "nobody" });
  check("a card with nothing brought says so in numbers", card.brought === 0 && card.earnedLamports === 0 && card.path === "/live/invite/youtube/nobody");
}

console.log("\nthe admin's ledger and payouts");
{
  const admin = (p: string, init: RequestInit = {}, token: string | null = ADMIN) => fetch(base + p, {
    ...init, headers: { "content-type": "application/json", ...(token ? { "x-oddie-admin": token } : {}), ...(init.headers ?? {}) },
  });
  check("the ledger is the admin's alone", (await admin("/api/admin/referrals", {}, null)).status === 401 && (await admin("/api/admin/referrals", {}, "wrong")).status === 401);
  type Ledger = { totals: { earnedLamports: number; owedLamports: number; paidLamports: number };
    referrers: Array<{ referrer: string; slug: string | null; brought: number; earnedLamports: number; owedLamports: number; paidLamports: number;
      referrals: Array<{ slug: string | null; earns: boolean; markets: Array<{ slug: string; counted: boolean; shareLamports: number }> }> }> };
  const l = await (await admin("/api/admin/referrals")).json() as Ledger;
  const k = l.referrers.find((r) => r.referrer === "kick:1001");
  check("it says who is owed what, most owed first, with every referral and market behind it",
    l.referrers[0]?.referrer === "kick:1500" && k?.slug === "kickref" && k.brought === 3 && k.owedLamports === 83
    && k.referrals.some((r) => r.slug === "newkick" && r.earns && r.markets.some((m) => m.slug === "ref-capped" && m.counted && m.shareLamports === 83))
    && k.referrals.some((r) => r.slug === "NewOnX" && !r.earns)
    && l.totals.earnedLamports === 333 && l.totals.owedLamports === 333, JSON.stringify(l.totals));
  const pay = (body: Record<string, unknown>, token: string | null = ADMIN) => admin("/api/admin/referrals/payout", { method: "POST", body: JSON.stringify(body) }, token);
  const SIG = "5".repeat(88);
  check("recording a payout is the admin's alone", (await pay({ referrer: "kick:1001", lamports: 10 }, null)).status === 401);
  const over = await pay({ referrer: "kick:1001", lamports: 84 });
  check("more than is owed is refused, so an extra zero is caught", over.status === 409 && (await over.json() as { owedLamports: number }).owedLamports === 83);
  const bad = await Promise.all([
    pay({ referrer: "kick:1001", lamports: 1.5 }), pay({ referrer: "kick:1001", lamports: -5 }), pay({ referrer: "kick:1001", lamports: "12abc" }),
    pay({ referrer: "steam:1", lamports: 10 }), pay({ referrer: "kick:1001", lamports: 10, wallet: "not-a-wallet" }), pay({ referrer: "kick:1001", lamports: 10, tx: "short" }),
  ]);
  check("a part lamport, a negative, a stranger, a bad wallet or a bad signature is refused", bad.every((r) => r.status === 400), bad.map((r) => r.status).join());
  const ok = await pay({ referrer: "kick:1001", lamports: 50, tx: SIG, wallet: "4Nd1mYwJ8Ytt8i9cFEPzJEgUyAqRZVDkHmEHUmbFGhLU", note: "first\npayout" });
  const okBody = await ok.json() as { owedLamports: number; payout: { lamports: number; tx: string; wallet: string; note: string } };
  check("a payout already sent is recorded, and what is owed goes down by it",
    ok.status === 200 && okBody.owedLamports === 33 && okBody.payout.lamports === 50 && okBody.payout.tx === SIG && okBody.payout.note === "first payout", JSON.stringify(okBody));
  const twice = await pay({ referrer: "kick:1001", lamports: 20, tx: SIG });
  check("the same transaction cannot be recorded twice", twice.status === 409 && (await twice.json() as { error: string }).error === "tx-recorded");
  const after = await (await admin("/api/admin/referrals")).json() as Ledger;
  const k2 = after.referrers.find((r) => r.referrer === "kick:1001");
  check("the ledger counts it as paid", k2?.paidLamports === 50 && k2.owedLamports === 33 && after.totals.paidLamports === 50 && after.totals.owedLamports === 283);
  const card = await get("/api/live/kick/kickref", ownerCookieFor("kick", "1001")).then((r) => r.json() as Promise<{ owner?: { invite?: { paidLamports: number; earnedLamports: number } } }>);
  check("...and so does the streamer's card", card.owner?.invite?.paidLamports === 50 && card.owner.invite.earnedLamports === 83);
  check("each payout is in the log", logs.some((x) => x.line === "referral payout recorded" && x.extra?.lamports === 50));
  const pageRes = await get("/live/referrals");
  check("the admin's page is served, never cached or indexed", pageRes.status === 200 && (await pageRes.text()) === "<p>ledger</p>"
    && /noindex/.test(pageRes.headers.get("x-robots-tag") ?? ""));
}

console.log("\ntrying it locally, with no platform to sign in with");
{
  check("without LIVE_DEV_SEED there is no way in but a platform's own sign-in",
    (await get("/live/_dev/connect/kick/devguy")).status === 404 && (await get("/live/_dev/market/kick/kickref")).status === 404);
  const devApp = express();
  devApp.use(referralRouter({ appBaseUrl: "http://localhost:3000", adminOk: () => false, adminHtml: () => "", log, dev: true }));
  const devServer = devApp.listen(0);
  const devBase = `http://127.0.0.1:${(devServer.address() as AddressInfo).port}`;
  const dget = (p: string, cookie?: string) => fetch(devBase + p, { redirect: "manual", headers: cookie ? { cookie } : {} });
  const c = await dget("/live/_dev/connect/kick/devfriend", refCookie("x", "9000000000000000009"));
  const set = c.headers.get("set-cookie") ?? "";
  check("a dev connect does what a callback does: the channel, the invite, the owner cookie",
    c.status === 302 && c.headers.get("location") === "/live/kick/devfriend" && set.startsWith(`${ownerCookieName("kick")}=`)
    && (await referralOf("kick", "dev-devfriend"))?.referrerId === "9000000000000000009", `${c.status} ${set}`);
  const m = await dget("/live/_dev/market/kick/devfriend?fee=20000000");
  const [show] = await referralLedger({ platform: "x", channelId: "9000000000000000009" });
  check("...and a dev market's resolve pays the referrer its quarter", m.status === 302 && show?.earnedLamports === 5_000_000, String(show?.earnedLamports));
  check("an unknown platform is refused", (await dget("/live/_dev/connect/steam/x")).status === 404 && (await dget("/live/_dev/market/kick/nobody")).status === 404);
  devServer.close();
  const src = readFileSync("src/live/referrals.ts", "utf8");
  check("...and the dev routes never exist with a database, whatever the flag says", /if \(d\.dev && !STORE_PERSISTENT\) \{/.test(src));
}

console.log("\nwhat the code may and may not do");
{
  const mod = readFileSync("src/live/referrals.ts", "utf8"), store = readFileSync("src/store/referrals.ts", "utf8");
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  check("nothing in it can send SOL or reach the program", [mod, store].every((s) => !/chain\/|@solana|@coral-xyz|SystemProgram|sendTransaction|transfer\(|onchain/i.test(code(s))));
  const mstore = readFileSync("src/store/markets.ts", "utf8");
  const sqlOf = (fn: string) => {
    const i = mstore.indexOf(`export async function ${fn}(`);
    return i < 0 ? "" : mstore.slice(i, mstore.indexOf("\n}\n", i)).split("await ensureSchema();")[1] ?? "";
  };
  check("in the database too, only an opening makes a market a channel's", /outcome = 'replied' AND reason = 'opened'/.test(sqlOf("streamOpenedMarkets")));
  check("...and the fee read is Oddie's own, real and recorded",
    /market_kind = 'real' AND fee_kind = 'protocol' AND enforced = true/.test(sqlOf("recordedProtocolFees")) && /ORDER BY slug, id DESC/.test(sqlOf("recordedProtocolFees")));
  check("one referral per channel is the table's own rule",
    /PRIMARY KEY \(platform, channel_id\)/.test(store) && /ON CONFLICT \(platform, channel_id\) DO NOTHING/.test(store)
    && /CREATE UNIQUE INDEX IF NOT EXISTS live_referral_payout_tx_idx/.test(store));
  const live = readFileSync("public/app/live.html", "utf8");
  const block = live.slice(live.indexOf("function inviteCard()"), live.indexOf("function wireInvite()"));
  const words = (s: string) => /\bbets?\b|\bbetting\b|gambl|free money|real money|guarantee/i.test(s);
  check("the card says it plainly: no dash, no bet, no promise", block.length > 200 && block.includes("Invite a streamer")
    && !/[\u2013\u2014]/.test(block) && !words(block) && !/[\u2013\u2014]/.test(inviteTerms()) && !words(inviteTerms()));
  check("the page shows the card on every platform, under the 2% card or on its own",
    (live.match(/inviteCard\(\)\)?; wireInvite\(\);/g) ?? []).length === 3);
  const page = readFileSync("public/referrals.html", "utf8");
  check("the admin's page sends the admin token and nothing reads it from an address",
    /"x-oddie-admin": token/.test(page) && !/location\.(search|hash)/.test(page) && !/[\u2013\u2014]/.test(page) && !words(page));
  for (const f of ["src/live/referrals.ts", "src/store/referrals.ts", "scripts/test-referrals.ts"]) {
    check(`${f} has no em or en dash`, !/[\u2013\u2014]/.test(readFileSync(f, "utf8")));
  }
}

server.close();
console.log(failures ? `\n${failures} failure(s)\n` : "\nall green\n");
process.exit(failures ? 1 : 0);
