// A platform that keeps refusing "is this channel live" (src/live/lookups.ts).
// Every asker reads a refusal as "the platform did not answer" and says
// nothing, so a lookup refused for hours went unheard. Here: nothing is told
// before ten minutes of refusals; one mail and one log line at ten; no more
// inside six hours; another after six if it lasts; an answer forgets all of
// it; each platform counts for itself; "not live" and "not set up" are no
// refusals. And what must not change: the asker gets the platform's answer or
// its own throw, and the sweep never reads a refusal as "not live".
//
// The platforms are the documented ones, not stubs: Kick's and Twitch's token
// endpoints and lookups with their status codes, and a token checked on every
// request. The askers are the engine's own (the went-live watcher, the sweep,
// the channel page), run as often as the server runs them. The clock is this
// script's: Date.now moves when it says.
if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database: unset DATABASE_URL");
  process.exit(1);
}
process.env.LIVE_TOKEN_KEY = "test-key-for-sealing";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import {
  handleChat, lockDue, LIVE_COPY, STREAM_POLL_MS, VIEWER_GIVE_UP_MS, VIEWER_POLL_MS, _resetLive, type LiveDeps, type Platform,
} from "../src/live/calls.js";
import { FRAME_OFF_MS } from "../src/live/frameCalls.js";
import { QUIET_AFTER_MS, QUIET_ALERT_GAP_MS, _resetLookups } from "../src/live/lookups.js";
import { alertMail, setOpsSink, wentLiveWatcher, type Alert, type OpsEvent } from "../src/live/openedMail.js";
import { _setPace } from "../src/live/pace.js";
import { kickStreamInfo, kickStreamIsLive } from "../src/kick/client.js";
import { kickEngineDeps, kickRouter } from "../src/kick/routes.js";
import { appToken, streamInfo } from "../src/twitch/client.js";
import { twitchEngineDeps } from "../src/twitch/routes.js";
import { liveStore, saveChannel, _resetLiveStore } from "../src/store/live.js";

// A chat's lines go out a second apart in production; here, at once.
_setPace({ gapMs: 0, retryMs: [0, 0] });

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// A crash prints no cross of its own. Said as one, a broken run never reads as a short clean one.
const crashed = (e: unknown) => { console.log(`  ✗ the script crashed before its end  ${(e as Error)?.stack ?? String(e)}`); process.exit(1); };
process.on("uncaughtException", crashed);
process.on("unhandledRejection", crashed);

/* ------------------------------------------------------------ the clock -- */

const MIN = 60_000, HOUR = 60 * MIN;
let clock = Date.UTC(2026, 10, 24, 12, 0, 0);
Date.now = () => clock;
const tick = (ms: number) => { clock += ms; };
/** A moment as the mail writes it. */
const when = (ms: number) => { const s = new Date(ms).toISOString(); return `${s.slice(0, 10)} ${s.slice(11, 16)} UTC`; };

/* -------------------------------------------------------- the platforms -- */

const KICK_ID = "kick-test-app", KICK_SECRET = "kick-test-secret";
const TWITCH_ID = "twitch-test-app", TWITCH_SECRET = "twitch-test-secret";
const setUp = () => {
  process.env.KICK_CLIENT_ID = KICK_ID; process.env.KICK_CLIENT_SECRET = KICK_SECRET;
  process.env.TWITCH_CLIENT_ID = TWITCH_ID; process.env.TWITCH_CLIENT_SECRET = TWITCH_SECRET;
  process.env.TWITCH_EVENTSUB_SECRET = "an-eventsub-secret-for-this-test";
};

/** up: it answers. down: 503. limited: 429. gone: the operation is switched off.
 *  token-refused: it takes no token, not even its own. key-refused: its sign-in
 *  refuses the app. silent: no connection. slow: nothing in time. */
type Mode = "up" | "down" | "limited" | "gone" | "token-refused" | "key-refused" | "silent" | "slow";
interface FakePlatform {
  mode: Mode;
  /** Who is on air: channel id, with category and viewers. */
  onAir: Map<string, { game: string; viewers: number }>;
  /** Channels whose own lookup it refuses, whoever else it answers for. */
  refuses: Set<string>;
  /** Lookups that reached it, and those that came without a token it gave (ever: never reset). */
  lookups: number; unsigned: number; unsignedEver: number;
  /** The tokens it gave, and when each runs out. */
  tokens: Map<string, number>;
  /** The last error a request died with before any answer. */
  thrown: unknown;
}
const platform = (): FakePlatform => ({ mode: "up", onAir: new Map(), refuses: new Set(), lookups: 0, unsigned: 0, unsignedEver: 0, tokens: new Map(), thrown: null });
const kick = platform(), twitch = platform();

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
/** No answer at all: what fetch itself throws, kept so a check can ask for the very same error.
 *  One that does not come in time costs the asker the client's ten seconds first (TIMEOUT_MS). */
function noAnswer(p: FakePlatform): void {
  if (p.mode === "silent") { p.thrown = new TypeError("fetch failed"); throw p.thrown; }
  if (p.mode === "slow") { tick(10_000); p.thrown = new DOMException("The operation was aborted due to timeout", "TimeoutError"); throw p.thrown; }
}
const formOf = (init?: RequestInit) => new URLSearchParams(String(init?.body ?? ""));
/** A token this platform gave and that has not run out. */
function holdsToken(p: FakePlatform, init?: RequestInit): boolean {
  const bearer = /^Bearer (\S+)$/.exec(new Headers(init?.headers).get("authorization") ?? "")?.[1];
  const until = bearer ? p.tokens.get(bearer) : undefined;
  return until !== undefined && Date.now() < until;
}
const countLookup = (p: FakePlatform, signed: boolean) => { p.lookups++; if (!signed) { p.unsigned++; p.unsignedEver++; } };

/**
 * Kick as its docs have it (docs.kick.com/getting-started/generating-tokens-oauth2-flow
 * and docs.kick.com/apis/livestreams, read 24 and 25 Nov 2026). The app's
 * token: POST id.kick.com/oauth/token, a form with grant_type=client_credentials
 * and the app's id and secret; the one refusal the docs name is a 400
 * "Invalid request". The lookup: GET /public/v1/users/livestreams, user_id
 * required, whole numbers and at most a hundred, a user's or the app's token
 * on every request, and in the answer the active livestreams of the users
 * asked for and of nobody else. Its documented statuses are 200, 400, 401 and
 * 500. /public/v1/livestreams, deprecated, is gone here.
 */
async function kickAnswers(url: URL, init?: RequestInit): Promise<Response> {
  noAnswer(kick);
  if (url.hostname === "id.kick.com") {
    if (url.pathname !== "/oauth/token" || init?.method !== "POST") return json(404, { error: "Not found" });
    const form = formOf(init);
    if (kick.mode === "key-refused" || form.get("grant_type") !== "client_credentials" || form.get("client_id") !== KICK_ID || form.get("client_secret") !== KICK_SECRET) {
      return json(400, { error: "Invalid request" });
    }
    const token = `kick-app-token-${kick.tokens.size + 1}`;
    kick.tokens.set(token, Date.now() + 3_600_000);
    return json(200, { access_token: token, token_type: "Bearer", expires_in: 3600 });
  }
  if (url.pathname !== "/public/v1/users/livestreams") return json(404, { data: {}, message: "Not Found" });
  const signed = holdsToken(kick, init);
  countLookup(kick, signed);
  if (kick.mode === "gone") return json(404, { data: {}, message: "Not Found" });
  if (kick.mode === "down") return json(503, { data: {}, message: "Service Unavailable" });
  if (kick.mode === "limited") return json(429, { data: {}, message: "Too Many Requests" });
  if (!signed || kick.mode === "token-refused") return json(401, { data: {}, message: "Unauthorized" });
  const ids = url.searchParams.getAll("user_id");
  if (!ids.length || ids.length > 100 || !ids.every((i) => /^\d+$/.test(i))) return json(400, { data: {}, message: "Bad Request" });
  if (ids.some((i) => kick.refuses.has(i))) return json(500, { data: {}, message: "Internal Server Error" });
  return json(200, {
    data: ids.filter((i) => kick.onAir.has(i)).map((i) => ({
      id: `5f0c1e2a-9b7d-4c3e-8a61-0000000000${i}`, title: "on air", started_at: "2026-11-24T11:02:11Z", viewer_count: kick.onAir.get(i)!.viewers,
      language_code: "en", tags: [], thumbnail: "https://kick.test/thumb.webp", has_mature_content: false,
      broadcaster_user: { id: Number(i), username: `channel_${i}`, profile_picture: "https://kick.test/p.webp" },
      category: { id: 28, name: kick.onAir.get(i)!.game, thumbnail: "https://kick.test/c.webp" },
      channel: { slug: `channel_${i}` },
    })),
    message: "OK",
  });
}

/**
 * Twitch as its docs have it (dev.twitch.tv/docs/authentication/getting-tokens-oauth,
 * /docs/api/reference/streams and /docs/api/guide, read 25 Nov 2026). The
 * app's token: POST id.twitch.tv/oauth2/token, the client credentials grant as
 * a form, answered with access_token, expires_in and token_type "bearer". The
 * docs name no refusal for it: here an unknown client is a 400 and a wrong
 * secret a 403. The lookup: GET /helix/streams, with a token and the Client-Id
 * it was given to, or 401; at most a hundred user_id, and a `type` that is
 * neither all nor live is a 400; only live streams come back either way. Past
 * its rate limit it answers 429 with the Ratelimit headers.
 */
async function twitchAnswers(url: URL, init?: RequestInit): Promise<Response> {
  noAnswer(twitch);
  if (url.hostname === "id.twitch.tv") {
    if (url.pathname !== "/oauth2/token" || init?.method !== "POST") return json(404, { status: 404, message: "Not Found" });
    const form = formOf(init);
    if (form.get("grant_type") !== "client_credentials") return json(400, { status: 400, message: "invalid grant type" });
    if (twitch.mode === "key-refused" || form.get("client_id") !== TWITCH_ID) return json(400, { status: 400, message: "invalid client" });
    if (form.get("client_secret") !== TWITCH_SECRET) return json(403, { status: 403, message: "invalid client secret" });
    const token = `twitch-app-token-${twitch.tokens.size + 1}`;
    twitch.tokens.set(token, Date.now() + 5_011_271_000);
    return json(200, { access_token: token, expires_in: 5011271, token_type: "bearer" });
  }
  if (url.pathname !== "/helix/streams") return json(404, { error: "Not Found", status: 404, message: "" });
  const signed = holdsToken(twitch, init) && new Headers(init?.headers).get("client-id") === TWITCH_ID;
  countLookup(twitch, signed);
  if (twitch.mode === "gone") return json(410, { error: "Gone", status: 410, message: "This API has been removed." });
  if (twitch.mode === "down") return json(503, { error: "Service Unavailable", status: 503, message: "" });
  if (twitch.mode === "limited") {
    return json(429, { error: "Too Many Requests", status: 429, message: "Your request was rate limited." },
      { "ratelimit-limit": "800", "ratelimit-remaining": "0", "ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 60) });
  }
  if (!signed || twitch.mode === "token-refused") return json(401, { error: "Unauthorized", status: 401, message: "Invalid OAuth token" });
  const type = url.searchParams.get("type");
  const ids = url.searchParams.getAll("user_id");
  if ((type !== null && type !== "all" && type !== "live") || ids.length > 100 || !ids.every((i) => /^\d+$/.test(i))) {
    return json(400, { error: "Bad Request", status: 400, message: "The parameter is not valid." });
  }
  if (ids.some((i) => twitch.refuses.has(i))) return json(500, { error: "Internal Server Error", status: 500, message: "" });
  return json(200, {
    data: ids.filter((i) => twitch.onAir.has(i)).map((i) => ({
      id: `4${i}000000001`, user_id: i, user_login: `channel_${i}`, user_name: `Channel_${i}`, game_id: "509658", game_name: twitch.onAir.get(i)!.game,
      type: "live", title: "on air", viewer_count: twitch.onAir.get(i)!.viewers, started_at: "2026-11-24T11:02:11Z", language: "en",
      thumbnail_url: "https://twitch.test/thumb-{width}x{height}.jpg", tag_ids: [], tags: [], is_mature: false,
    })),
    pagination: {},
  });
}

/** Nothing in this script reaches the network: whatever is not one of the two platforms is a stray. */
const strays: string[] = [];
globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(u));
  if (url.hostname === "id.kick.com" || url.hostname === "api.kick.com") return kickAnswers(url, init);
  if (url.hostname === "id.twitch.tv" || url.hostname === "api.twitch.tv") return twitchAnswers(url, init);
  strays.push(url.origin);
  throw new Error(`a request left the test: ${url.origin}`);
}) as typeof fetch;

/* ---------------------------------------- what is told, and the askers -- */

const logs: Array<{ line: string; extra?: Record<string, unknown> }> = [];
const log = (line: string, extra?: Record<string, unknown>) => { logs.push({ line, extra }); };
/** The log's lines that tell a silence, and those that end one. */
const told = () => logs.filter((l) => l.line.includes("is not answering whether a channel is live"));
const again = () => logs.filter((l) => l.line.includes("answers whether a channel is live again"));
const alerts: Alert[] = [];
const everyMail: Alert[] = [];
setOpsSink((e: OpsEvent) => { if (e.kind === "alert") { alerts.push(e); everyMail.push(e); } });
const nothingTold = () => alerts.length === 0 && told().length === 0;
const heard = () => `${alerts.length} mail(s), ${told().length} log line(s): ${alerts.map((a) => a.text).join(" || ")}`;

const BASE = "https://app.oddie.fun";
const kickEng = kickEngineDeps({ appBaseUrl: BASE, log, voice: "" });
const twitchEng = twitchEngineDeps({ appBaseUrl: BASE, log, voice: "" });
const engOf = (p: Platform): LiveDeps => (p === "twitch" ? twitchEng : kickEng);

type Chan = { platform: Platform; channelId: string };
const everyone: Chan[] = [
  { platform: "kick", channelId: "88" }, { platform: "kick", channelId: "89" },
  { platform: "twitch", channelId: "77" }, { platform: "twitch", channelId: "78" },
];
let asking = everyone;
/** The went-live watcher itself (src/live/openedMail.ts), wired as the server wires it: every
 *  active channel through its own platform's lookup, two minutes between passes. */
const watcher = wentLiveWatcher({
  channels: async () => asking,
  streamLive: (p, c) => engOf(p).streamLive!(p, c),
  now: () => Date.now(),
  report: () => {},
});
const passes = async (n: number) => { for (let i = 0; i < n; i++) { await watcher(); tick(2 * MIN); } };
/** What an asker's own catch would get. */
const outcome = <T>(p: Promise<T>): Promise<string> => p.then((v) => `answered ${JSON.stringify(v)}`, (e) => `threw ${(e as Error).message}`);

/** Both platforms up and set up, one channel on air on each, nothing told yet. */
function fresh(): void {
  setUp();
  _resetLookups();
  logs.length = 0; alerts.length = 0;
  for (const p of [kick, twitch]) { p.mode = "up"; p.refuses.clear(); p.onAir.clear(); p.lookups = 0; p.unsigned = 0; p.thrown = null; }
  kick.onAir.set("88", { game: "Slots & Casino", viewers: 1204 });
  twitch.onAir.set("77", { game: "Just Chatting", viewers: 431 });
  asking = everyone;
}

/* ----------------------------------------------------------------------- */

console.log("the platforms answer");
{
  fresh();
  // What each lookup came to, read the way an asker's catch would: a refusal here is a named failure, not a crash.
  const onKick = [await outcome(kickEng.streamLive!("kick", "88")), await outcome(kickEng.streamLive!("kick", "89"))];
  const onTwitch = [await outcome(twitchEng.streamLive!("twitch", "77")), await outcome(twitchEng.streamLive!("twitch", "78"))];
  check("the engine's lookup says who is on air and who is not, on Kick and on Twitch",
    same(onKick, ["answered true", "answered false"]) && same(onTwitch, ["answered true", "answered false"]), [...onKick, ...onTwitch].join(" | "));
  const kg = await outcome(kickEng.streamGame!("kick", "88")), tg = await outcome(twitchEng.streamGame!("twitch", "77"));
  const kickRead = await outcome(kickStreamInfo("88")), twitchRead = await outcome((async () => streamInfo(await appToken(), "77"))());
  check("...and the stream's category and count, exactly as the client read them",
    kg === 'answered {"live":true,"game":"Slots & Casino","viewers":1204}' && kg === kickRead
    && tg === 'answered {"live":true,"game":"Just Chatting","viewers":431}' && tg === twitchRead, [kg, kickRead, tg, twitchRead].join(" | "));
  check("...every request with a token its platform gave", kick.lookups === 4 && kick.unsigned === 0 && twitch.lookups === 4 && twitch.unsigned === 0,
    `kick ${kick.lookups}/${kick.unsigned} unsigned, twitch ${twitch.lookups}/${twitch.unsigned} unsigned`);
  check("answers tell nobody anything", nothingTold() && logs.length === 0, heard());
}

console.log("\nKick stops answering, Twitch does not");
{
  fresh();
  const t0 = Date.now();
  kick.mode = "down";
  await passes(5);
  check("nothing is told before ten minutes of refusals", nothingTold() && kick.lookups === 10, heard());
  await passes(1);
  const first = alerts[0];
  check("at ten minutes the operator gets one mail, in the platform's name", alerts.length === 1 && first?.title === "Kick has stopped answering whether a channel is live", heard());
  check("...it says since when, how many lookups for how many channels, and the last error",
    Boolean(first?.text.includes("has not answered one live lookup since 2026-11-24 12:00 UTC: 11 asked, for 2 channels, and the last came back \"kick users/livestreams 503\"")), first?.text);
  check("...what that means while it lasts, and which errors are ours to mend",
    /calls in Kick chats do not end with their stream and the screen settles none of them/.test(first?.text ?? "")
    && /!call yes or !call no/.test(first?.text ?? "") && /A 400, 401, 403 or 404 in that error points at our side/.test(first?.text ?? ""), first?.text);
  const mail = first ? alertMail(first) : null;
  check("...and it renders as a mail whose subject is the trouble, with no link to chase",
    mail?.subject === first?.title && first?.link === undefined && Boolean(mail?.html.includes("&quot;kick users/livestreams 503&quot;")), mail?.html);
  const line = told()[0];
  check("the log gets one line, with the last error", told().length === 1 && Boolean(line?.line.startsWith("kick is not answering whether a channel is live"))
    && same(line?.extra, { since: new Date(t0).toISOString(), lookups: 11, channels: 2, err: "kick users/livestreams 503" }), JSON.stringify(told()));
  await passes(179);
  check("not again inside six hours, however many lookups are refused", alerts.length === 1 && told().length === 1 && kick.lookups === 370,
    `${heard()}, ${kick.lookups} lookups`);
  await passes(1);
  check("again once six hours have gone by and it is still quiet", alerts.length === 2 && told().length === 2
    && Boolean(alerts[1]?.text.includes("since 2026-11-24 12:00 UTC: 371 asked, for 2 channels")), alerts[1]?.text ?? heard());
  check("Twitch answered at every pass: that never ended Kick's silence, and nothing was told about Twitch",
    twitch.lookups === 2 * 186 && twitch.unsigned === 0 && alerts.length === 2 && alerts.every((a) => a.title.startsWith("Kick "))
    && ![...alerts.map((a) => a.title + a.text), ...logs.map((l) => l.line)].some((s) => /twitch/i.test(s)),
    `${twitch.lookups} lookups on twitch, ${heard()}`);
  kick.mode = "up";
  await passes(1);
  const back = again();
  check("the first answer ends it: one line in the log, and no mail for that", back.length === 1 && back[0]?.line === "kick answers whether a channel is live again"
    && same(back[0]?.extra, { quietMin: 372 }) && alerts.length === 2, JSON.stringify(back));
  kick.mode = "down";
  const t1 = Date.now();
  await passes(5);
  check("an answer resets it: the next silence is not told before its own ten minutes", alerts.length === 2 && told().length === 2, heard());
  await passes(1);
  check("...and is told at them, however lately the last one was", alerts.length === 3 && told().length === 3
    && Boolean(alerts[2]?.text.includes(`since ${when(t1)}: 11 asked, for 2 channels`)) && when(t1) === "2026-11-24 18:14 UTC", alerts[2]?.text ?? heard());
}

console.log("\na slow moment is not a silence");
{
  fresh();
  kick.mode = "down"; await passes(4);
  kick.mode = "up"; await passes(1);
  kick.mode = "down"; await passes(5);
  check("eight minutes of refusals, one answer, eight more: never ten in a row, so nothing is told", nothingTold() && again().length === 0 && kick.lookups === 20, heard());
}

console.log("\none channel refused while the others answer");
{
  fresh();
  kick.refuses.add("89");
  await passes(30);
  const refused = await outcome(kickEng.streamLive!("kick", "89"));
  check("an hour of one channel's refusals, with another answering on the same platform, is not the platform gone quiet",
    nothingTold() && refused === "threw kick users/livestreams 500", `${heard()} / ${refused}`);
  fresh();
  kick.refuses.add("89");
  asking = everyone.filter((c) => !(c.platform === "kick" && c.channelId === "88"));
  await passes(5);
  const early = alerts.length;
  await passes(1);
  check("with nobody else asking on Kick, its refusals are all Kick has said: told at ten minutes, and the mail says it was one channel",
    early === 0 && alerts.length === 1 && Boolean(alerts[0]?.text.includes("6 asked, for 1 channel, and the last came back \"kick users/livestreams 500\"")), heard());
}

console.log("\n\"not live\" is an answer");
{
  fresh();
  kick.onAir.clear(); twitch.onAir.clear();
  await passes(15);
  const off = [await outcome(kickEng.streamLive!("kick", "88")), await outcome(twitchEng.streamLive!("twitch", "77")), await outcome(kickEng.streamGame!("kick", "88"))];
  check("half an hour of every channel off air is half an hour of answers: nothing is told",
    nothingTold() && same(off, ["answered false", "answered false", 'answered {"live":false,"game":null,"viewers":null}']), `${heard()} / ${off.join(" | ")}`);
  kick.mode = "down"; await passes(4);
  kick.mode = "up"; await passes(1);
  kick.mode = "down"; await passes(5);
  check("...and a \"not live\" between two runs of refusals ends the stretch like any answer", nothingTold(), heard());
}

console.log("\na platform that is not set up");
{
  fresh();
  delete process.env.KICK_CLIENT_SECRET;
  kick.mode = "down";   // what it would say, were it asked
  await passes(15);
  const unset = [await outcome(kickEng.streamLive!("kick", "88")), await outcome(kickEng.streamGame!("kick", "88"))];
  check("a Kick that is not set up is not asked, and its lookups say null as before", kick.lookups === 0 && same(unset, ["answered null", "answered null"]),
    `${kick.lookups} lookups, ${unset.join(" | ")}`);
  check("...so half an hour of that is no silence: nothing is told", nothingTold(), heard());
  fresh();
  delete process.env.TWITCH_EVENTSUB_SECRET;
  twitch.mode = "down";
  await passes(15);
  const asked = twitch.lookups;
  const refusal = await outcome(twitchEng.streamLive!("twitch", "77"));
  check("a Twitch that is not set up is still asked by the engine, as it always was, and the asker gets Twitch's own refusal",
    asked === 30 && refusal.startsWith("threw twitch GET /streams?user_id=77&type=live 503"), `${asked} lookups, ${refusal}`);
  check("...and half an hour of those is ours, not Twitch gone quiet: nothing is told", nothingTold(), heard());
  setUp();
}

console.log("\nevery way a platform stops answering");
{
  const ways: Array<[Mode, string, RegExp]> = [
    ["gone", "an operation switched off (404)", /"kick users\/livestreams 404"/],
    ["limited", "a rate limit (429)", /"kick users\/livestreams 429"/],
    ["token-refused", "a token Kick will not take (401)", /"kick users\/livestreams 401"/],
    ["key-refused", "an app key Kick's sign-in refuses (400 where the token is given)", /"kick token 400 \{"error":"Invalid request"\}"/],
    ["silent", "no connection at all", /"fetch failed"/],
    ["slow", "an answer that does not come in time", /"The operation was aborted due to timeout"/],
  ];
  for (const [mode, name, err] of ways) {
    fresh();
    // Past the life of the token the client holds: it has to ask Kick's sign-in for the next one.
    tick(2 * HOUR);
    kick.mode = mode;
    await passes(5);
    const early = alerts.length;
    await passes(1);
    check(`${name}: told at ten minutes, with that error`, early === 0 && alerts.length === 1 && told().length === 1 && err.test(alerts[0]?.text ?? ""), heard());
  }
}

console.log("\nTwitch stops answering, Kick does not");
{
  fresh();
  twitch.mode = "token-refused";
  await passes(5);
  const early = alerts.length;
  await passes(1);
  const a = alerts[0];
  check("Twitch is told the same way, at ten minutes, under its own name",
    early === 0 && alerts.length === 1 && a?.title === "Twitch has stopped answering whether a channel is live"
    && /11 asked, for 2 channels, and the last came back "twitch GET \/streams\?user_id=77&type=live 401 /.test(a?.text ?? "")
    && told().length === 1 && Boolean(told()[0]?.line.startsWith("twitch is not answering whether a channel is live")), heard());
  check("...and Twitch's silence tells nothing about Kick", !/kick/i.test(`${a?.title} ${a?.text} ${told().map((l) => l.line).join(" ")}`) && kick.lookups === 12 && kick.unsigned === 0, heard());
}

console.log("\nthe other lookup: the stream's category and count");
{
  fresh();
  // A viewer-count call reads the count on the clock's tick, every half minute (VIEWER_POLL_MS),
  // and gives it up to the mods at the look ten minutes after the first it could not read
  // (VIEWER_GIVE_UP_MS). Here the first look times out, ten seconds after it was asked, and
  // the ones after it are refused at once.
  const t0 = Date.now();
  let quiet = true, last = "";
  for (let i = 0; i <= 20; i++) {
    clock = t0 + i * VIEWER_POLL_MS;
    kick.mode = i === 0 ? "slow" : "down";
    last = await outcome(kickEng.streamGame!("kick", "88"));
    if (i < 20) quiet &&= nothingTold();
  }
  check("refused for ten minutes, it is told like the other, and the asker still gets the refusal",
    quiet && alerts.length === 1 && Boolean(alerts[0]?.text.includes("21 asked, for 1 channel,")) && last === "threw kick users/livestreams 503", `${heard()} / ${last}`);
  check("...counted from when the first unanswered look was asked, so it is told at the very look where the engine gives the count up",
    Date.now() - t0 === VIEWER_GIVE_UP_MS && same(told()[0]?.extra?.since, new Date(t0).toISOString()), JSON.stringify(told()[0]?.extra));
}

console.log("\ntwo refusals with nobody asking between them");
{
  fresh();
  kick.mode = "down";
  await passes(1);
  tick(3 * HOUR);
  const later = Date.now();
  await passes(1);
  check("three hours apart with nobody asking in between is not three hours of refusals: nothing is told", nothingTold(), heard());
  await passes(4);
  const early = alerts.length;
  await passes(1);
  check("...the stretch starts at the later one, and ten minutes of asking from there is told",
    early === 0 && alerts.length === 1 && Boolean(alerts[0]?.text.includes(`since ${when(later)}: 11 asked, for 2 channels`)), heard());
  tick(HOUR);
  await passes(10);
  check("...and a silence the operator was told of is not told again because the asking paused: one mail inside the six hours", alerts.length === 1 && told().length === 1, heard());
}

console.log("\nwhat the asker gets is what it got before");
{
  fresh();
  kick.mode = "down"; twitch.mode = "down";
  const viaKick = await outcome(kickEng.streamGame!("kick", "88")), rawKick = await outcome(kickStreamInfo("88"));
  const viaTwitch = await outcome(twitchEng.streamGame!("twitch", "77")), rawTwitch = await outcome((async () => streamInfo(await appToken(), "77"))());
  check("a refusal reaches the asker's own catch as the client's own error, word for word",
    viaKick === rawKick && viaKick === "threw kick users/livestreams 503" && viaTwitch === rawTwitch && viaTwitch.startsWith("threw twitch GET /streams?user_id=77&type=live 503"),
    `${viaKick} | ${rawKick} | ${viaTwitch} | ${rawTwitch}`);
  kick.mode = "silent";
  const caught = await kickEng.streamLive!("kick", "88").then(() => null, (e: unknown) => e);
  check("...the very error the platform call threw, not a copy of it", caught !== null && caught === kick.thrown && caught instanceof TypeError, String(caught));
  fresh();
  const loud = kickEngineDeps({ appBaseUrl: BASE, log: () => { throw new Error("the log is down"); }, voice: "" });
  kick.mode = "down";
  const direct = await outcome(kickStreamIsLive("88"));
  const got: string[] = [];
  for (let i = 0; i < 6; i++) { got.push(await outcome(loud.streamLive!("kick", "88"))); tick(2 * MIN); }
  check("a log that throws changes nothing the asker gets: Kick's own refusal, every time",
    direct === "threw kick users/livestreams 503" && got.length === 6 && got.every((g) => g === direct), got.join(" | "));
  check("...and does not cost the operator the mail", alerts.length === 1, heard());
  kick.mode = "up";
  const answer = await outcome(loud.streamLive!("kick", "88"));
  check("...nor the answer, when Kick answers again", answer === "answered true", answer);
}

console.log("\nthe sweep, through a silence (a refusal is never \"not live\")");
{
  fresh(); _resetLiveStore(); _resetLive();
  await saveChannel({ platform: "kick", channelId: "88", slug: "channel_88", name: "Channel 88", avatar: null,
    accessToken: "streamer-token", refreshToken: null, tokenExpiresAt: null, active: true });
  const said: string[] = [];
  const engine = kickEngineDeps({ appBaseUrl: BASE, log, voice: "" }, { bot: async (_t, text) => { said.push(text); }, user: async (_t, _c, text) => { said.push(text); } });
  const Q = "will I win this game?";
  const opened = await handleChat({ platform: "kick", channelId: "88", messageId: "m1", senderId: "88", senderName: "channel_88", canRun: true, text: `!call ${Q}` }, engine);
  // The clock's own pass (lockDue), which looks at each channel with a call waiting once a minute.
  const sweeps = async (n: number) => { for (let i = 0; i < n; i++) { tick(STREAM_POLL_MS); await lockDue(engine); } };
  await sweeps(2);
  kick.mode = "down";
  await sweeps(10);
  const early = alerts.length;
  await sweeps(110);
  const open = await liveStore.unsettled("kick", "88");
  check("two hours of refusals cancel nothing: the call is still open, and the room heard no result",
    opened === "opened" && open.length === 1 && open[0]?.question === Q && !said.includes(LIVE_COPY.noResult(Q)), `${opened}, ${open.length} open, said: ${said.join(" | ")}`);
  check("...and the operator was told once, at the sweep's eleventh look with no answer",
    early === 0 && alerts.length === 1 && Boolean(alerts[0]?.text.includes("11 asked, for 1 channel,")) && kick.lookups === 2 + 120, `${heard()}, ${kick.lookups} lookups`);
  kick.mode = "up"; kick.onAir.delete("88");
  await sweeps(1);
  check("when Kick answers \"not live\", the call ends with the stream, as it always did",
    (await liveStore.unsettled("kick", "88")).length === 0 && said.includes(LIVE_COPY.noResult(Q)) && again().length === 1, said.join(" | "));
}

console.log("\nthe channel page's lookups count too");
{
  fresh(); _resetLiveStore(); _resetLive();
  await saveChannel({ platform: "kick", channelId: "88", slug: "channel_88", name: "Channel 88", avatar: null,
    accessToken: "streamer-token", refreshToken: null, tokenExpiresAt: null, active: true });
  const app = express();
  app.use(kickRouter({ appBaseUrl: BASE, pageHtml: () => "<p>page</p>", pageOpen: () => true, pageClosed: (res) => { res.status(404).end(); }, log }));
  const server = app.listen(0);
  const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/live/kick/channel_88`;
  // Straight over a socket of its own: this script's fetch answers only as Kick and Twitch.
  // A page that does not come back reads as status 0, a named failure below.
  const page = () => new Promise<{ status: number; live: boolean | null }>((resolve) => {
    http.get(at, { agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => { body += d; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, live: (JSON.parse(body) as { stream: { live: boolean } | null }).stream?.live ?? null }); }
        catch { resolve({ status: 0, live: null }); }
      });
    }).on("error", () => resolve({ status: 0, live: null }));
  });
  try {
    const before = await page();
    check("the page shows the player while Kick says the channel is on air", before.status === 200 && before.live === true && kick.lookups === 1, JSON.stringify(before));
    kick.mode = "down";
    // Somebody keeps the page open: it asks Kick again once its half minute is up.
    let served = true;
    for (let i = 0; i < 20; i++) { tick(31_000); const p = await page(); served &&= p.status === 200 && p.live === true; }
    const early = alerts.length;
    tick(31_000);
    const p = await page();
    check("through the silence the page still answers, with what it last knew", served && p.status === 200 && p.live === true && kick.lookups === 22, `${kick.lookups} lookups`);
    check("...and ten minutes of the page asking alone are told", early === 0 && alerts.length === 1 && Boolean(alerts[0]?.text.includes("21 asked, for 1 channel,")), heard());
  } finally {
    server.close();
  }
}

console.log("\nwired where the adapters hand the lookup over");
{
  const kickSrc = readFileSync("src/kick/routes.ts", "utf8"), twitchSrc = readFileSync("src/twitch/routes.ts", "utf8");
  const n = (s: string, re: RegExp) => (s.match(re) ?? []).length;
  check("Kick: all three lookups (the engine's two, the page's one) go through the count, and only where Kick is set up",
    n(kickSrc, /kickStream(?:IsLive|Info)\(/g) === 3
    && n(kickSrc, /kickConfigured\(\) \? counted\("kick", \w+, d\.log, \(\) => kickStream(?:IsLive|Info)\(\w+\)\) : null/g) === 3,
    `${n(kickSrc, /kickStream(?:IsLive|Info)\(/g)} lookups in src/kick/routes.ts`);
  check("Twitch: the same three, counted only where Twitch is set up",
    n(twitchSrc, /stream(?:IsLive|Info)\(await appToken\(\), \w+\)/g) === 3
    && n(twitchSrc, /lookup\(channelId, async \(\) => stream(?:IsLive|Info)\(await appToken\(\), channelId\)\)/g) === 2
    && /\(twitchConfigured\(\) \? counted\("twitch", channelId, d\.log, ask\) : ask\(\)\)/.test(twitchSrc)
    && /twitchConfigured\(\) \? counted\("twitch", c, d\.log, async \(\) => streamIsLive\(await appToken\(\), c\)\) : null/.test(twitchSrc),
    `${n(twitchSrc, /stream(?:IsLive|Info)\(await appToken\(\), \w+\)/g)} lookups in src/twitch/routes.ts`);
}

console.log("\nthe ten minutes, against how often the engine asks");
{
  const server = readFileSync("src/server.ts", "utf8"), pageSrc = readFileSync("src/live/channelRoutes.ts", "utf8");
  check("ten minutes of refusals before it is told, six hours between mails", QUIET_AFTER_MS === 10 * MIN && QUIET_ALERT_GAP_MS === 6 * HOUR);
  check("in ten minutes the went-live watcher still comes round five more times and the sweep ten, and it is when the engine gives a count up",
    /setInterval\(look, 120_000\)/.test(server) && QUIET_AFTER_MS / 120_000 === 5 && QUIET_AFTER_MS / STREAM_POLL_MS === 10 && VIEWER_GIVE_UP_MS === QUIET_AFTER_MS,
    `sweep ${STREAM_POLL_MS}, give-up ${VIEWER_GIVE_UP_MS}`);
  check("...and no asker waits longer between two looks at a channel than a stretch allows",
    FRAME_OFF_MS < QUIET_AFTER_MS && VIEWER_POLL_MS < QUIET_AFTER_MS && /const LIVE_TTL_MS = 30_000;/.test(pageSrc), `picture pass ${FRAME_OFF_MS}`);
}

console.log("\nall through");
{
  check("every lookup carried a token its platform gave, the refused ones too", kick.unsignedEver === 0 && twitch.unsignedEver === 0,
    `kick ${kick.unsignedEver}, twitch ${twitch.unsignedEver}`);
  check("no request left for anywhere but the two platforms", strays.length === 0, strays.join(" "));
  check("no em dash in any mail or log line", ![...everyMail.map((a) => a.title + a.text), ...logs.map((l) => l.line)].join("").includes(String.fromCharCode(0x2014)));
}

setOpsSink(null);
console.log(failures === 0 ? "\nall quiet-platform checks passed.\n" : `\n${failures} quiet-platform check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
