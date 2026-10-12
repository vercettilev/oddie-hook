// oddie on YouTube: the chat stream's framing, a chat item as the engine reads
// it, lines cut to 200 characters, the sign-in (a streamer's and oddie's own),
// and the watcher reading a live chat end to end, with Google faked at its
// edges. YouTube runs votes only: no line may name a market or carry a link.
//
// Run with: npm run test-youtube

import type { AddressInfo } from "node:net";
import express from "express";
import { _resetLive, LIVE_COPY } from "../src/live/calls.js";
import { liveStore, saveChannel, channelById, _resetLiveStore } from "../src/store/live.js";
import { chatFromYouTube, jsonSplitter, splitForChat, CHAT_MAX, YouTubeError, type ChatPage, type LiveVideo } from "../src/youtube/client.js";
import { youtubeRouter, youtubeEngineDeps, watchYouTube, _resetYouTube, _readers, type YouTubeApi } from "../src/youtube/routes.js";
import { ownerCookieName } from "../src/live/owner.js";
import { _setPace } from "../src/live/pace.js";

_setPace({ gapMs: 0, retryMs: [0, 0] });
process.env.YOUTUBE_CLIENT_ID = "test-client";
process.env.YOUTUBE_CLIENT_SECRET = "test-secret-0123456789";
process.env.YOUTUBE_VOICE_CHANNEL = "oddiefun";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const noLink = (t: string) => !/https?:\/\/|oddie\.fun|\bwww\./i.test(t);
const noMarket = (t: string) => !/\bmarkets?\b|!oddie|2%/i.test(t);

console.log("the chat stream's framing");
{
  const one = jsonSplitter();
  const a = one.push('{"items":[{"id":"a"}],"nextPageToken":"p1"}\n{"items":[],"nextP');
  const b = one.push('ageToken":"p2"}\n');
  check("one object per line, a line cut anywhere", a.length === 1 && b.length === 1 && (b[0] as ChatPage).nextPageToken === "p2");
  const arr = jsonSplitter();
  const objs = [...arr.push('[{"items":[{"id":"x","snippet":{"displayMessage":"a } inside { a string \\" quote"}}]}\n,'), ...arr.push('{"offlineAt":"2026-10-12T20:00:00Z"}]')];
  check("an array streaming in, braces and quotes inside strings left alone", objs.length === 2 && (objs[1] as ChatPage).offlineAt === "2026-10-12T20:00:00Z"
    && ((objs[0] as ChatPage).items?.[0]?.snippet?.displayMessage ?? "") === 'a } inside { a string " quote');
  const pretty = jsonSplitter();
  const p1 = pretty.push('{\n  "items": [\n    {\n      "id": "m1"');
  const p2 = pretty.push('\n    }\n  ]\n}\n');
  check("an object pretty-printed over many lines", p1.length === 0 && p2.length === 1 && (p2[0] as ChatPage).items?.[0]?.id === "m1");
}

console.log("\nlines YouTube takes");
{
  check("a short line is one line", splitForChat("oddie is here.").length === 1);
  const parts = splitForChat(LIVE_COPY.help);
  check("a long one is cut, every part at most 200 characters", LIVE_COPY.help.length > CHAT_MAX && parts.length >= 2 && parts.every((p) => p.length <= CHAT_MAX),
    parts.map((p) => p.length).join(","));
  check("...and nothing is lost in the cut", parts.join(" ").replace(/\s+/g, " ") === LIVE_COPY.help.replace(/\s+/g, " "));
  const word = splitForChat("x".repeat(450));
  check("a word longer than a line is cut where it must be", word.length === 3 && word.every((p) => p.length <= CHAT_MAX));
}

console.log("\nwhat a chat item becomes");
const ch = { channelId: "UCstreamer000000000000001", slug: "streamer" };
const item = (over: Record<string, unknown> = {}, author: Record<string, unknown> = {}) => ({
  id: "msg-1",
  snippet: { type: "textMessageEvent", publishedAt: new Date().toISOString(), displayMessage: "!call will I win?", textMessageDetails: { messageText: "!call will I win?" } },
  authorDetails: { channelId: "UCviewer0000000000000001", displayName: "@viewer", isChatOwner: false, isChatModerator: false, ...author },
  ...over,
});
{
  const m = chatFromYouTube(item(), ch, "UCoddie00000000000000001");
  check("a viewer's line is read as the engine reads every chat", m?.platform === "youtube" && m.channelId === ch.channelId && m.senderId === "UCviewer0000000000000001"
    && m.text === "!call will I win?" && m.canRun === false && m.channelSlug === "streamer");
  check("the handle's @ is dropped for the standings", m?.senderName === "viewer");
  check("the owner can run calls", chatFromYouTube(item({}, { isChatOwner: true }), ch, null)?.canRun === true);
  check("...and so can a moderator", chatFromYouTube(item({}, { isChatModerator: true }), ch, null)?.canRun === true);
  check("a line from oddie's own channel is oddie's", chatFromYouTube(item({}, { channelId: "UCoddie00000000000000001" }), ch, "UCoddie00000000000000001")?.fromOddie === true);
  check("a Super Chat or anything not text is not a command",
    chatFromYouTube(item({ snippet: { type: "superChatEvent", displayMessage: "!call x" } }), ch, null) === null && chatFromYouTube(null, ch, null) === null);
}

/* --------------------------------------------- Google, faked at its edges -- */

interface Sent { chat: string; text: string }
const sent: Sent[] = [];
const pages: ChatPage[] = [];
let liveState: LiveVideo["state"] = "live";
let streamEnd: "open" | "offline" = "open";
let streams = 0;
let me = { channelId: ch.channelId, handle: "streamer", name: "Streamer", avatar: null as string | null };
const api: YouTubeApi = {
  exchangeCode: async (code) => ({ accessToken: `at-${code}`, refreshToken: `rt-${code}`, expiresAt: Date.now() + 3_600_000 }),
  me: async () => me,
  refreshTokens: async () => ({ accessToken: "at-fresh", refreshToken: null, expiresAt: Date.now() + 3_600_000 }),
  recentVideoIds: async (channelId) => (channelId === ch.channelId ? ["vid00000001"] : []),
  videosLive: async (_t, ids) => ids.map((id) => ({ videoId: id, channelId: ch.channelId, state: liveState, liveChatId: liveState === "live" ? "chat-1" : null })),
  streamChat: async (_t, _chat, pageToken, onPage, signal) => {
    streams++;
    for (;;) {
      while (pages.length) await onPage(pages.shift()!);
      if (streamEnd === "offline") return { pageToken: pageToken ?? "pt-1", offline: true };
      if (signal.aborted) return { pageToken: pageToken ?? "pt-1", offline: false };
      await wait(3);
    }
  },
  sendChat: async (_t, chat, text) => { sent.push({ chat, text }); return `sent-${sent.length}`; },
};
const logs: string[] = [];
const log = (line: string) => { logs.push(line); };

_resetLiveStore(); _resetLive(); _resetYouTube();
const app = express();
app.use(youtubeRouter({ appBaseUrl: "http://localhost:0", pageHtml: () => "<html>live</html>", pageOpen: () => true, pageClosed: (res) => { res.status(403).end(); }, log, api }));
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://localhost:${port}`;
const get = (path: string) => fetch(`${base}${path}`, { redirect: "manual" });
const stateOf = (loc: string) => new URL(loc).searchParams.get("state") ?? "";

console.log("\nthe sign-in, through the real router");
{
  const r = await get("/live/youtube/connect");
  const loc = r.headers.get("location") ?? "";
  const u = new URL(loc);
  check("a streamer is sent to Google for their channel's name only", r.status === 302 && u.host === "accounts.google.com"
    && u.searchParams.get("scope") === "https://www.googleapis.com/auth/youtube.readonly" && u.searchParams.get("access_type") === "online", loc.slice(0, 120));
  const cb = await get(`/live/youtube/callback?state=${stateOf(loc)}&code=s1`);
  check("back from Google: the channel's page, with the steps", cb.status === 302 && (cb.headers.get("location") ?? "").endsWith("/live/youtube/streamer?connected=1"), cb.headers.get("location") ?? "");
  check("...the owner cookie is set for YouTube", (cb.headers.get("set-cookie") ?? "").startsWith(`${ownerCookieName("youtube")}=`));
  const saved = await channelById("youtube", ch.channelId);
  check("...and the streamer's token is not kept", !!saved?.active && saved.accessToken === null && saved.refreshToken === null && saved.slug === "streamer");
  const again = await get("/live/youtube/callback?state=nope&code=s2");
  check("a state nobody asked for is an expired link", (again.headers.get("location") ?? "").endsWith("/live?youtube=expired"));

  const v = await get("/live/youtube/voice");
  const vu = new URL(v.headers.get("location") ?? "");
  check("oddie's own channel asks to write, and to keep its token", vu.searchParams.get("scope") === "https://www.googleapis.com/auth/youtube.force-ssl"
    && vu.searchParams.get("access_type") === "offline" && (vu.searchParams.get("prompt") ?? "").includes("consent"));
  me = { channelId: "UCoddie00000000000000001", handle: "oddiefun", name: "oddie", avatar: null };
  const vcb = await get(`/live/youtube/callback?state=${stateOf(v.headers.get("location") ?? "")}&code=v1`);
  const voice = await channelById("youtube", "UCoddie00000000000000001");
  check("...signed in, it keeps the token every line goes out with", (vcb.headers.get("location") ?? "").endsWith("/live/youtube/oddiefun?voice=1")
    && voice?.accessToken === "at-v1" && voice.refreshToken === "rt-v1");
  const c2 = await get("/live/youtube/connect");
  await get(`/live/youtube/callback?state=${stateOf(c2.headers.get("location") ?? "")}&code=v2`);
  check("...and through the streamer door again, it keeps the token it had", (await channelById("youtube", "UCoddie00000000000000001"))?.refreshToken === "rt-v1");
  me = { channelId: "UCsomeone000000000000001", handle: "someone", name: "Someone", avatar: null };
  const v3 = await get("/live/youtube/voice");
  await get(`/live/youtube/callback?state=${stateOf(v3.headers.get("location") ?? "")}&code=x1`);
  check("another channel through oddie's door keeps no token", (await channelById("youtube", "UCsomeone000000000000001"))?.refreshToken === null);
  // That channel is not part of what follows.
  const someone = await channelById("youtube", "UCsomeone000000000000001");
  if (someone) await saveChannel({ ...someone, active: false });
}

console.log("\nthe watcher, a live chat end to end");
const engine = youtubeEngineDeps({ log }, api);
const settle = () => wait(40);
const now = () => Date.now();
{
  const out = await watchYouTube({ engine, log, api });
  check("a connected channel on air is found, and its chat is read", out.live === 1 && _readers().some((r) => r.liveChatId === "chat-1" && !r.done), JSON.stringify(out));
  check("...its first stream since signing in opens with hello", sent.length === 1 && sent[0].text === LIVE_COPY.helloVotes && sent[0].chat === "chat-1");
  const again = await watchYouTube({ engine, log, api });
  check("the next pass keeps the same reader, and hello is said once", again.reading === 1 && streams === 1 && sent.length === 1);

  pages.push({ items: [item({ id: "old-1", snippet: { type: "textMessageEvent", publishedAt: new Date(now() - 3_600_000).toISOString(), displayMessage: "!call from before oddie arrived" } }, { isChatOwner: true })] });
  await settle();
  check("the chat's history is not taken for commands", sent.length === 1 && !(await liveStore.current("youtube", ch.channelId)));

  pages.push({ items: [item({ id: "open-1", snippet: { type: "textMessageEvent", publishedAt: new Date().toISOString(), displayMessage: "!call will I win this round?" } }, { isChatOwner: true })] });
  await settle();
  const call = await liveStore.current("youtube", ch.channelId);
  const opened = sent.slice(1);
  check("the owner's !call opens a vote", call?.question === "will I win this round?", JSON.stringify(call));
  check("...said without a link, every line within 200 characters", opened.length >= 1 && opened.every((s) => noLink(s.text) && s.text.length <= CHAT_MAX), JSON.stringify(opened));

  pages.push({ items: [item({ id: "yes-1", snippet: { type: "textMessageEvent", publishedAt: new Date().toISOString(), displayMessage: "!yes" } })] });
  await settle();
  check("a viewer's !yes counts", call ? (await liveStore.tally(call.id)).yes === 1 : false);

  const before = sent.length;
  pages.push({ items: [item({ id: "mk-1", snippet: { type: "textMessageEvent", publishedAt: new Date().toISOString(), displayMessage: "!oddie BTC above 150k by Friday?" } })] });
  await settle();
  const mk = sent.slice(before).map((s) => s.text);
  check("!oddie opens no market here: the room hears how votes work", mk.length === 1 && mk[0] === LIVE_COPY.votesHere && noMarket(mk[0]), JSON.stringify(mk));

  const own = sent.length;
  pages.push({ items: [item({ id: "own-1", snippet: { type: "textMessageEvent", publishedAt: new Date().toISOString(), displayMessage: "!call oddie's own line" } }, { channelId: "UCoddie00000000000000001", isChatModerator: true })] });
  await settle();
  check("oddie's own line coming back is never a command", sent.length === own && (await liveStore.current("youtube", ch.channelId))?.question === "will I win this round?");

  pages.push({ items: [item({ id: "set-1", snippet: { type: "textMessageEvent", publishedAt: new Date().toISOString(), displayMessage: "!call yes" } }, { isChatModerator: true })] });
  await settle();
  const res = sent[sent.length - 1]?.text ?? "";
  check("a moderator settles it, and the result carries no link", res.startsWith("It's YES") && noLink(res), res);

  const help = sent.length;
  pages.push({ items: [item({ id: "help-1", snippet: { type: "textMessageEvent", publishedAt: new Date().toISOString(), displayMessage: "!call" } }, { isChatOwner: true })] });
  await settle();
  const helpLines = sent.slice(help).map((s) => s.text);
  check("the help, longer than a line, goes out in parts of at most 200", helpLines.length >= 2 && helpLines.every((t) => t.length <= CHAT_MAX), helpLines.map((t) => t.length).join(","));

  check("nothing oddie said on YouTube named a market or carried a link",
    sent.every((s) => noLink(s.text) && !/\bmarkets?\b|!oddie/i.test(s.text)), JSON.stringify(sent.filter((s) => !noLink(s.text) || /\bmarkets?\b|!oddie/i.test(s.text))));

  liveState = "none";
  await watchYouTube({ engine, log, api });
  check("off air: the reader stops, and the stream counts as ended", _readers().length === 0 && (await engine.streamLive!("youtube", ch.channelId)) === false);
  const quiet = sent.length;
  await engine.say("youtube", ch.channelId, "anybody there?");
  check("...and nothing is said into a chat that is gone", sent.length === quiet);

  liveState = "live"; streamEnd = "offline";
  await watchYouTube({ engine, log, api });
  await settle();
  check("a chat that ends with its stream closes its reader", _readers().every((r) => r.done));
}

console.log("\nwhen YouTube says no");
{
  _resetYouTube(); liveState = "live"; streamEnd = "open";
  const tired: YouTubeApi = { ...api, videosLive: async () => { throw new YouTubeError("youtube GET /videos 403 quotaExceeded", 403, "quotaExceeded"); } };
  const out = await watchYouTube({ engine, log, api: tired });
  const next = await watchYouTube({ engine, log, api });
  check("the day's quota spent: the watcher rests instead of asking again", out.live === 0 && next.live === 0 && _readers().length === 0
    && logs.some((l) => l.includes("quota spent")));
}

_resetYouTube();
server.close();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
