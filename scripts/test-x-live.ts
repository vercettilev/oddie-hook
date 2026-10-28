// oddie in X live chat (src/x/live.ts): oddie's own sign-in, a streamer's,
// the activity stream's framing, a broadcast.chat event as the engine reads
// it, and a live chat end to end, with X faked at its edges. X live runs
// votes only, like YouTube: no line may name a market or carry a link, and
// every line fits X's 140 characters.
//
// Run with: npm run test-x-live

import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import express from "express";
import { _resetLive, settleOnScreen } from "../src/live/calls.js";
import { liveStore, channelById, saveChannel, _resetLiveStore } from "../src/store/live.js";
import {
  chatFromX, onXEvent, xEngineDeps, xLiveApi, xLiveRouter, _liveIn, _resetXLive, X_CHAT_MAX,
  type XActivityEvent, type XLiveApi, type XVoice,
} from "../src/x/live.js";
import { accessToken, adoptTokens, BOT_SCOPES, _resetTokenCache } from "../src/x/client.js";
import { botStateGet, xLiveChatSource, sourceUrlKind, sourcePostKey, isWebSourceUrl } from "../src/store/markets.js";
import { ownerCookieName } from "../src/live/owner.js";
import { _setPace } from "../src/live/pace.js";

_setPace({ gapMs: 0, retryMs: [0, 0] });
process.env.TWITTER_CLIENT_ID = "test-client";
process.env.TWITTER_CLIENT_SECRET = "test-secret-0123456789";
process.env.X_APP_BEARER_TOKEN = "test-bearer";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};
const noLink = (t: string) => !/https?:\/\/|oddie\.fun|\bwww\./i.test(t);
const noMarket = (t: string) => !/\bmarkets?\b|!oddie|2%/i.test(t);

const ODDIE = "1000000000000000001", STREAMER = "2000000000000000002", VIEWER = "3000000000000000003", MOD = "4000000000000000004";
const users: Record<string, { id: string; username: string }> = {
  "at-voice": { id: ODDIE, username: "Oddiefun" },
  "at-streamer": { id: STREAMER, username: "AleksaFlamingo" },
  "at-other": { id: "5000000000000000005", username: "someone" },
};

const sent: Array<{ token: string; broadcast: string; text: string; replyTo?: string }> = [];
const subs: Array<{ token: string; user: string; ev: string }> = [];
let failChatSub = false, refreshes = 0, rejectNext401 = false;
/* @oddiefun as the reply bot holds it (src/x/client.ts): one token chain. */
const adopted: Array<{ accessToken: string; refreshToken: string }> = [];
const voice: XVoice = {
  ready: () => true,
  token: async (force) => { if (force) refreshes++; return "at-voice"; },
  userId: () => ODDIE,
  adopt: async (t) => { adopted.push(t); },
};
const api: XLiveApi = {
  exchangeCode: async (code) => ({ accessToken: `at-${code}`, refreshToken: `rt-${code}`, expiresAt: Date.now() + 7_200_000 }),
  me: async (token) => {
    const u = users[token];
    if (!u) throw Object.assign(new Error("unknown token"), { status: 401 });
    return { ...u, name: u.username, avatar: null };
  },
  subscribe: async (token, user, ev) => {
    if (failChatSub && ev === "broadcast.chat") throw Object.assign(new Error("x subscribe 403"), { status: 403 });
    subs.push({ token, user, ev });
    return `sub-${subs.length}`;
  },
  sendChat: async (token, broadcast, text, replyTo) => {
    if (rejectNext401) { rejectNext401 = false; throw Object.assign(new Error("x broadcast chat 401"), { status: 401 }); }
    if (token !== "at-voice") throw Object.assign(new Error("wrong token"), { status: 403 });
    sent.push({ token, broadcast, text, replyTo });
    return `ts-${sent.length}`;
  },
  stream: async () => {},
};

_resetLiveStore(); _resetLive(); _resetXLive();
const log = () => {};
const app = express();
const xl = xLiveRouter({ appBaseUrl: "https://app.test", redirectUri: "https://oddie.test/api/auth/twitter/callback", pageHtml: () => "<html></html>", pageOpen: () => true, pageClosed: (res) => res.status(404).end(), log, api, voice });
app.use(xl.router);
// What server.ts does: X's one registered callback hands this file its own states.
app.get("/api/auth/twitter/callback", async (req, res) => {
  const state = String(req.query.state ?? "");
  if (state.startsWith("xl_") && await xl.callback(state, req.query, res)) return;
  res.status(418).send("site sign-in");
});
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const get = (p: string) => fetch(base + p, { redirect: "manual" });
const stateOf = (loc: string) => new URL(loc).searchParams.get("state") ?? "";
const signIn = async (door: string, code: string) => {
  const a = await get(door);
  const loc = a.headers.get("location") ?? "";
  const cb = await get(`/api/auth/twitter/callback?state=${stateOf(loc)}&code=${code}`);
  return { authorize: new URL(loc), back: cb.headers.get("location") ?? "", status: cb.status };
};

console.log("oddie's own account");
{
  const v = await signIn("/live/x/voice", "voice");
  check("the voice door asks for everything the reply bot needs, and chat writing", v.authorize.origin === "https://x.com"
    && v.authorize.searchParams.get("scope") === BOT_SCOPES && /broadcast\.write/.test(BOT_SCOPES) && /tweet\.write/.test(BOT_SCOPES) && /media\.write/.test(BOT_SCOPES)
    && v.authorize.searchParams.get("redirect_uri") === "https://oddie.test/api/auth/twitter/callback" && v.authorize.searchParams.get("code_challenge_method") === "S256");
  check("signed in, the token becomes the bot's own, the one chain replies and chat share",
    v.back.endsWith("/live/x/Oddiefun?voice=1") && adopted.length === 1 && adopted[0].accessToken === "at-voice" && adopted[0].refreshToken === "rt-voice");
  check("...and no second copy of it is kept as a channel", !(await channelById("x", ODDIE)));
  check("nobody subscribes oddie to its own chat", subs.length === 0);
  const other = await signIn("/live/x/voice", "other");
  check("another account at oddie's door is turned away, the bot's token untouched",
    other.back.endsWith("/live?x=voice") && adopted.length === 1 && !(await channelById("x", "5000000000000000005")));
  const stray = await get("/api/auth/twitter/callback?state=xl_nope&code=1");
  check("one of ours this process never saw goes back to /live to try again, not to the site's sign-in",
    (stray.headers.get("location") ?? "").endsWith("/live?x=expired"));
  const again = await get(`/api/auth/twitter/callback?state=${stateOf(v.authorize.toString())}&code=voice`);
  check("X's return loaded a second time lands where the first did", (again.headers.get("location") ?? "").endsWith("/live/x/Oddiefun?voice=1"), again.headers.get("location") ?? "");
  const site = await get("/api/auth/twitter/callback?state=abc&code=1");
  check("an ordinary sign-in goes on to the site's own", site.status === 418);
}

console.log("\na streamer connects");
{
  const first = await get("/live/x/connect");
  const firstLoc = first.headers.get("location") ?? "";
  const cb = await get(`/api/auth/twitter/callback?state=${stateOf(firstLoc)}&code=streamer`);
  const s = { authorize: new URL(firstLoc), back: cb.headers.get("location") ?? "" };
  const scope = s.authorize.searchParams.get("scope") ?? "";
  check("the streamer is asked to let oddie read chat, not to write", /broadcast\.read/.test(scope) && !/broadcast\.write/.test(scope));
  check("they land on their page, which says how to open a vote", s.back.endsWith("/live/x/AleksaFlamingo?added=1"), s.back);
  const cookie = cb.headers.get("set-cookie") ?? "";
  check("...and no owner cookie: X Live runs votes, there is no 2% wallet to offer", !cookie.includes(`${ownerCookieName("x")}=`), cookie);
  check("their chat, and when they go live and stop, with their own token",
    subs.length === 3 && subs.every((x) => x.token === "at-streamer" && x.user === STREAMER)
    && ["broadcast.chat", "broadcast.start", "broadcast.end"].every((e) => subs.some((x) => x.ev === e)));
  const ch = await channelById("x", STREAMER);
  check("the channel is kept", ch?.slug === "AleksaFlamingo" && ch.active === true);
  failChatSub = true;
  const bad = await signIn("/live/x/connect", "streamer");
  check("when X refuses the chat subscription, the streamer is told to go again", bad.back.endsWith("/live?x=subscribe"), bad.back);
  failChatSub = false;
  const subsBefore = subs.length;
  const self = await signIn("/live/x/connect", "voice");
  check("oddie's own account at the streamers' door is turned away, nothing saved or adopted",
    self.back.endsWith("/live?x=is-voice") && subs.length === subsBefore && adopted.length === 1 && !(await channelById("x", ODDIE)), self.back);
  const page = await get("/live/x/AleksaFlamingo");
  check("the channel's page is served", page.status === 200);
}

console.log("\nwhat a chat event becomes");
let n = 0;
const chat = (text: string, from: { id: string; username: string } = { id: VIEWER, username: "viewer" }, over: Record<string, unknown> = {}): XActivityEvent => ({
  event_uuid: `ev-${++n}`, created_at: new Date().toISOString(), event_type: "broadcast.chat",
  filter: { user_id: STREAMER },
  payload: { broadcast_id: "1mGPaZaAdNqJN", message_id: `m-${n}`, message: text, is_subscriber: false, is_moderator: false, author: { data: from }, ...over },
});
{
  const m = chatFromX(chat("!call will I win?"), { slug: "AleksaFlamingo" }, ODDIE);
  check("a viewer's line reads as every chat line does", m?.platform === "x" && m.channelId === STREAMER && m.senderId === VIEWER && m.senderName === "viewer"
    && m.text === "!call will I win?" && m.canRun === false && m.fromOddie === false && m.channelSlug === "AleksaFlamingo");
  check("the host runs calls (X calls the host no moderator)", chatFromX(chat("!x", { id: STREAMER, username: "AleksaFlamingo" }), null, ODDIE)?.canRun === true);
  check("...and so does a moderator", chatFromX(chat("!x", { id: MOD, username: "mod" }, { is_moderator: true }), null, ODDIE)?.canRun === true);
  const LEV = "1218142562483085313";
  check("...and so does Lev's own account, on anyone's stream", chatFromX(chat("!call Can mika beat Stan?", { id: LEV, username: "levvercetti" }), null, ODDIE)?.canRun === true);
  check("...by id, not by name: someone else called levvercetti does not",
    chatFromX(chat("!call x", { id: "6000000000000000006", username: "levvercetti" }), null, ODDIE)?.canRun === false);
  process.env.X_LIVE_OPERATORS = `${VIEWER}, `;
  check("X_LIVE_OPERATORS names the accounts instead",
    chatFromX(chat("!x"), null, ODDIE)?.canRun === true && chatFromX(chat("!x", { id: LEV, username: "levvercetti" }), null, ODDIE)?.canRun === false);
  delete process.env.X_LIVE_OPERATORS;
  check("a line from @oddiefun is oddie's own", chatFromX(chat("noted.", { id: ODDIE, username: "Oddiefun" }), null, ODDIE)?.fromOddie === true);
  check("an event with no text is nothing", chatFromX({ ...chat(""), payload: { broadcast_id: "b" } }, null, null) === null);
}

console.log("\na live chat, end to end");
{
  const engine = xEngineDeps({ log }, api, voice);
  const w = { engine, log, voice };
  check("before the stream, oddie does not know it is on air", (await engine.streamLive!("x", STREAMER)) === null);
  await onXEvent({ event_uuid: "start-1", event_type: "broadcast.start", filter: { user_id: STREAMER }, payload: { broadcast_id: "1mGPaZaAdNqJN" } }, w);
  check("broadcast.start puts it on air", _liveIn(STREAMER) === "1mGPaZaAdNqJN" && (await engine.streamLive!("x", STREAMER)) === true);

  const before = sent.length;
  const open = chat("!call will I win this round?", { id: STREAMER, username: "AleksaFlamingo" });
  await onXEvent(open, w);
  const call = await liveStore.current("x", STREAMER);
  check("the host's !call opens a vote", call?.question.toLowerCase().includes("will i win this round") === true, JSON.stringify(call));
  const said = sent.slice(before);
  check("oddie says so in that broadcast's chat, as @oddiefun", said.length >= 1 && said.every((s) => s.broadcast === "1mGPaZaAdNqJN" && s.token === "at-voice"));
  check("every line fits X's 140 characters", said.every((s) => s.text.length <= X_CHAT_MAX), said.map((s) => s.text.length).join(","));
  check("no line names a market or carries a link", said.every((s) => noLink(s.text) && noMarket(s.text)), said.map((s) => s.text).join(" | "));

  const yes = chat("!yes");
  await onXEvent(yes, w);
  await onXEvent(yes, w);   // the stream handing the same event over twice
  await onXEvent(chat("!no", { id: MOD, username: "mod" }), w);
  const t = await liveStore.tally(call!.id);
  check("viewers answer, once each, even when an event comes twice", t.yes === 1 && t.no === 1, JSON.stringify(t));

  const old = chat("!no", { id: "6000000000000000006", username: "late" }, {});
  old.created_at = new Date(Date.now() - 10 * 60_000).toISOString();
  await onXEvent(old, w);
  check("a line from minutes ago is history, not an answer", (await liveStore.tally(call!.id)).no === 1);

  const ownBefore = sent.length;
  await onXEvent(chat("!call oddie's own line", { id: ODDIE, username: "Oddiefun" }, { is_moderator: true }), w);
  check("oddie's own line is never a command", sent.length === ownBefore && (await liveStore.current("x", STREAMER))?.id === call!.id);

  await onXEvent(chat("!call yes", { id: MOD, username: "mod" }, { is_moderator: true }), w);
  check("a moderator settles it", (await liveStore.current("x", STREAMER)) === null);

  const unknown: XActivityEvent = { ...chat("!call hi"), filter: { user_id: "9999999999999999999" } };
  check("chat from a streamer oddie does not know is left alone", (await onXEvent(unknown, w)) === "unknown-channel");

  rejectNext401 = true;
  const r1 = refreshes;
  await engine.say("x", STREAMER, "noted again.");
  check("a 401 refreshes and tries once more", refreshes === r1 + 1 && sent.at(-1)?.text === "noted again.");

  const long = "word ".repeat(70).trim();
  const s1 = sent.length;
  await engine.say("x", STREAMER, long);
  check("a long line is cut into lines X takes", sent.length - s1 >= 3 && sent.slice(s1).every((s) => s.text.length <= X_CHAT_MAX));

  await onXEvent({ event_uuid: "end-1", event_type: "broadcast.end", filter: { user_id: STREAMER }, payload: { broadcast_id: "1mGPaZaAdNqJN" } }, w);
  const s2 = sent.length;
  await engine.say("x", STREAMER, "anyone there?");
  check("broadcast.end takes it off air: nothing is said, and the engine knows", sent.length === s2 && (await engine.streamLive!("x", STREAMER)) === false);

  await onXEvent(chat("!call back again?", { id: STREAMER, username: "AleksaFlamingo" }, { broadcast_id: "2nNewBroadcast" }), w);
  check("a chat line from a new broadcast puts it back on air, even with its start missed", _liveIn(STREAMER) === "2nNewBroadcast" && sent.at(-1)?.broadcast === "2nNewBroadcast");
}

console.log("\nthe activity stream's framing");
{
  const realFetch = globalThis.fetch;
  const chunks = ['{"data":{"event_uuid":"s1","event_type":"broadcast.chat"}}\r\n\r\n{"data":{"event_', 'uuid":"s2","event_type":"broadcast.end"}}\n', "\n", 'not json\n{"data":{"event_uuid":"s3"}}\n'];
  let asked = "", auth = "";
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    asked = String(url); auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
    const enc = new TextEncoder();
    return new Response(new ReadableStream({ start(c) { for (const k of chunks) c.enqueue(enc.encode(k)); c.close(); } }), { status: 200 });
  }) as typeof fetch;
  const got: string[] = [];
  await xLiveApi.stream((e) => { got.push(String(e.event_uuid)); }, new AbortController().signal);
  globalThis.fetch = realFetch;
  check("the app's stream is read with the app's bearer", asked === "https://api.x.com/2/activity/stream" && auth === "Bearer test-bearer");
  check("one event per line, a line cut anywhere, keep-alives and junk skipped", got.join(",") === "s1,s2,s3", got.join(","));
}

console.log("\nX live: votes, no market, no link (its chat refuses links, Lev's live on 16 Oct)");
{
  const src = xLiveChatSource("AleksaFlamingo", "2090000000000000004");
  check("an X live source keeps its own kind, never a link, never an x: key", src === "xlive-chat:aleksaflamingo/2090000000000000004"
    && sourceUrlKind(src) === "xlive" && !isWebSourceUrl(src) && sourcePostKey(src) === "xlive:2090000000000000004", src);
  const eng = xEngineDeps({ log }, api, voice);
  const w = { engine: eng, log, voice };
  check("X live runs votes: no market door, no standings link", eng.votesOnly === true && !eng.market && (await eng.standingsUrl("x", STREAMER)) === "");
  const host = { id: STREAMER, username: "AleksaFlamingo" };
  const on = { broadcast_id: "2nNewBroadcast" };
  const s0 = sent.length;
  check("!oddie says how votes run here", (await onXEvent(chat("!oddie BTC closes above 120k on Friday", undefined, on), w)) === "votes-only");
  check("!matches off turns the screen reading off on X",
    (await onXEvent(chat("!matches off", host, on), w)) === "matches-off" && (await channelById("x", STREAMER))?.matchCalls === false);
  check("...and !matches on brings it back",
    (await onXEvent(chat("!matches on", host, on), w)) === "matches-on" && (await channelById("x", STREAMER))?.matchCalls === true);
  const call = await liveStore.current("x", STREAMER);
  const FRAME = Buffer.from("\xff\xd8 the frame oddie read \xff\xd9", "latin1");
  check("a call the screen settles is said in the live chat as one short line, the screen's own words left out (Mozaiiic, 28 Oct)",
    Boolean(call) && await settleOnScreen(call!, "yes", "VICTORY 13-11", eng, FRAME)
    && sent.slice(s0).filter((x) => x.text.startsWith('Result: YES on "')).length === 1
    && sent.slice(s0).every((x) => !x.text.includes("VICTORY 13-11") && x.text.length <= X_CHAT_MAX), JSON.stringify(sent.slice(s0).map((x) => x.text)));
  const pageData = await (await get("/api/live/x/AleksaFlamingo")).json() as { recent?: Array<{ frame: string | null }> };
  const framePath = pageData.recent?.[0]?.frame ?? "";
  check("the channel's page data names the picture it was settled on", framePath === `/api/live/x/AleksaFlamingo/frame/${call?.id}`, framePath);
  const img = framePath ? await get(framePath) : null;
  const body = img ? Buffer.from(await img.arrayBuffer()) : Buffer.alloc(0);
  check("...served as it was read, a picture kept for good",
    img?.status === 200 && /image\/jpeg/.test(img.headers.get("content-type") ?? "") && body.equals(FRAME) && /immutable/.test(img.headers.get("cache-control") ?? ""),
    `${img?.status} ${img?.headers.get("content-type")}`);
  check("...and not through another channel's address", (await get(`/api/live/x/someone/frame/${call?.id}`)).status === 404);
  const page = readFileSync("public/app/live.html", "utf8");
  check("the channel page shows it under the settled call", /r\.frame \? '<figure class="res__f">/.test(page) && page.includes("What Oddie saw when it settled this"));
  const said = sent.slice(s0).map((x) => x.text);
  check("not one of those lines carries a link, and each fits X's 140", said.length >= 3 && said.every((t) => noLink(t) && t.length <= X_CHAT_MAX), said.join(" | "));
}

console.log("\n@oddiefun's one token chain (src/x/client.ts)");
{
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/2/oauth2/token")) {
      asked.push(new URLSearchParams(String(init?.body ?? "")).get("refresh_token") ?? "");
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ access_token: `fresh-${asked.length}`, refresh_token: `r${asked.length + 1}`, expires_in: 7200 }), { status: 200 });
    }
    return realFetch(url, init);
  }) as typeof fetch;
  _resetTokenCache();
  await adoptTokens({ accessToken: "a1", refreshToken: "r1", expiresAt: Date.now() + 7_200_000 });
  check("an adopted consent is the token the bot speaks with, no refresh needed", (await accessToken()) === "a1" && asked.length === 0);
  check("...and its refresh token is the one stored for the next restart", (await botStateGet("x_refresh_token")) === "r1");
  await adoptTokens({ accessToken: "a1", refreshToken: "r1", expiresAt: Date.now() - 1 });
  const [a, b] = await Promise.all([accessToken(), accessToken()]);
  check("two callers at once share ONE refresh: a second would spend a dead token and end the chain",
    asked.length === 1 && asked[0] === "r1" && a === "fresh-1" && b === "fresh-1", JSON.stringify(asked));
  check("...and the rotated token is stored", (await botStateGet("x_refresh_token")) === "r2");
  globalThis.fetch = realFetch;
  _resetTokenCache();
}

console.log("\nan X stream's picture, from Twitch when X never said where it is");
{
  const { xPicture, xTwitchTwin } = await import("../src/x/live.js");
  check("Aleksa's X account is paired with the same stream on Twitch by default", xTwitchTwin("1084242319") === "aleksaflamingo" && xTwitchTwin(STREAMER) === null);
  process.env.X_TWITCH_TWINS = "123:SomeOne, 456:x, 789:ok_name:extra, abc:name";
  check("X_TWITCH_TWINS pairs ids with logins and skips what is not id:login",
    xTwitchTwin("123") === "someone" && xTwitchTwin("456") === null && xTwitchTwin("789") === null && xTwitchTwin("1084242319") === null);
  process.env.X_TWITCH_TWINS = `${STREAMER}:aleksaflamingo`;

  _resetXLive();
  const engine = xEngineDeps({ log }, api, voice);
  const lines: string[] = [];
  const w = { engine, log, voice };
  const fetched: string[] = [], asked: string[] = [];
  let ownWorks = true;
  const d = {
    fetchPicture: async (url: string) => { fetched.push(url); return ownWorks ? Buffer.from("x-thumbnail") : null; },
    twitchFrame: async (login: string) => { asked.push(login); return Buffer.from("twitch-frame"); },
    log: (l: string) => { lines.push(l); },
  };
  await onXEvent(chat("hello from Restream", undefined, { broadcast_id: "3rdBroadcast" }), w);
  const a = await xPicture(STREAMER, d);
  await xPicture(STREAMER, d);
  check("no broadcast.start, chat coming in: the picture is the stream's Twitch frame",
    a?.toString() === "twitch-frame" && fetched.length === 0 && asked.join() === "aleksaflamingo,aleksaflamingo", JSON.stringify({ fetched, asked }));
  check("...and the log says so once", lines.filter((l) => l === "x picture from twitch").length === 1, JSON.stringify(lines));

  fetched.length = 0; asked.length = 0;
  await onXEvent({ event_uuid: "start-twin", event_type: "broadcast.start", filter: { user_id: STREAMER }, payload: { broadcast_id: "4thBroadcast", thumbnail_url: "https://x.test/live.jpg" } }, w);
  const b = await xPicture(STREAMER, d);
  check("with a thumbnail from broadcast.start, X's own picture is read and Twitch is not asked", b?.toString() === "x-thumbnail" && fetched.join() === "https://x.test/live.jpg" && asked.length === 0);
  ownWorks = false;
  const c = await xPicture(STREAMER, d);
  check("a thumbnail that no longer loads falls back to Twitch", c?.toString() === "twitch-frame" && asked.length === 1);

  fetched.length = 0; asked.length = 0;
  await onXEvent({ event_uuid: "end-twin", event_type: "broadcast.end", filter: { user_id: STREAMER }, payload: { broadcast_id: "4thBroadcast" } }, w);
  check("after broadcast.end nothing is read, on X or Twitch", (await xPicture(STREAMER, d)) === null && fetched.length === 0 && asked.length === 0);
  check("a streamer with no Twitch pair and no thumbnail has no picture", (await xPicture("7000000000000000007", d)) === null && asked.length === 0);
  delete process.env.X_TWITCH_TWINS;
}

console.log("\nhow often an X stream's picture changes");
{
  const { probeThumbnail } = await import("../src/x/live.js");
  const bodies = ["a", "a", "b", "b", "b", "c"];
  let i = 0;
  const lines: Array<[string, Record<string, unknown> | undefined]> = [];
  const fetcher = (async () => new Response(bodies[Math.min(i++, bodies.length - 1)], { headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
  const out = await probeThumbnail("https://x.test/thumb.jpg", "b1", (l, e) => lines.push([l, e]), { everyMs: 15_000, forMs: 75_000, fetcher, sleep: async () => {} });
  const done = lines.find(([l]) => l === "x thumbnail probe done")?.[1];
  check("the picture is fetched on a beat and each change is counted", out.fetches === 6 && out.changes === 2, JSON.stringify(out));
  check("...and the log says when it changed", done?.gapsSeconds === "30,45" && lines.filter(([l]) => l === "x thumbnail changed").length === 2, JSON.stringify(done));
}

server.close();
console.log(failures ? `\n${failures} FAILED` : "\nall x live checks passed.");
process.exit(failures ? 1 : 0);
