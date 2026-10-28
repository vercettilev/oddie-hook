// oddie on YouTube: the chat stream's framing, a chat item as the engine reads
// it, lines cut to 200 characters, a channel added by its pasted link, oddie's
// own sign-in, the watcher reading a live chat end to end, and the check a
// streamer's link can be given, with Google faked at its edges. YouTube runs
// votes only: no line may name a market or carry a link.
//
// Run with: npm run test-youtube

import type { AddressInfo } from "node:net";
import express from "express";
import { _resetLive, LIVE_COPY } from "../src/live/calls.js";
import { liveStore, saveChannel, channelById, _resetLiveStore } from "../src/store/live.js";
import { chatFromYouTube, jsonSplitter, parseChannelRef, splitForChat, CHAT_MAX, YouTubeError, type ChannelRef, type ChatPage, type LiveVideo, type YouTubeChannel } from "../src/youtube/client.js";
import { youtubeRouter, youtubeEngineDeps, watchYouTube, _resetYouTube, _readers, type YouTubeApi } from "../src/youtube/routes.js";
import { _setPace } from "../src/live/pace.js";

_setPace({ gapMs: 0, retryMs: [0, 0] });
process.env.YOUTUBE_CLIENT_ID = "test-client";
process.env.YOUTUBE_CLIENT_SECRET = "test-secret-0123456789";
process.env.YOUTUBE_VOICE_CHANNEL = "oddiefun";
// Every pass looks a channel up, unless a test says otherwise.
process.env.YOUTUBE_LOOK_MS = "0";

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
const ch = { channelId: "UCstreamer00000000000001", slug: "streamer" };
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

console.log("\nwhat a streamer pastes");
{
  const same = (a: ChannelRef | null, b: ChannelRef) => JSON.stringify(a) === JSON.stringify(b);
  const handle = (h: string): ChannelRef => ({ by: "handle", handle: h });
  check("the address from the browser", same(parseChannelRef("https://www.youtube.com/@Streamer"), handle("streamer")));
  check("...with a tab after it, and without https or www", same(parseChannelRef("youtube.com/@Streamer/streams"), handle("streamer"))
    && same(parseChannelRef("m.youtube.com/@streamer?si=abc"), handle("streamer")));
  check("the handle alone, with or without its @", same(parseChannelRef("@streamer"), handle("streamer")) && same(parseChannelRef("  streamer "), handle("streamer")));
  check("a handle in any script", same(parseChannelRef("youtube.com/@%C3%A7a%C4%9Fla.tv"), handle("çağla.tv")));
  check("a channel's UC… id, bare or in its address",
    same(parseChannelRef("UCstreamer00000000000001"), { by: "id", id: "UCstreamer00000000000001" })
    && same(parseChannelRef("https://youtube.com/channel/UCstreamer00000000000001/live"), { by: "id", id: "UCstreamer00000000000001" }));
  check("a link to the stream itself", same(parseChannelRef("https://www.youtube.com/watch?v=vid00000001&t=3"), { by: "video", id: "vid00000001" })
    && same(parseChannelRef("youtu.be/vid00000001"), { by: "video", id: "vid00000001" })
    && same(parseChannelRef("youtube.com/live/vid00000001?feature=share"), { by: "video", id: "vid00000001" }));
  check("an old /user/ or /c/ address", same(parseChannelRef("youtube.com/user/OldName"), { by: "user", name: "OldName" })
    && same(parseChannelRef("youtube.com/c/Streamer"), handle("streamer")));
  check("anything that is not a YouTube channel is not one", ["", "twitch.tv/streamer", "https://kick.com/streamer", "youtube.com", "youtube.com/feed/subscriptions", "my channel", "ab", "x".repeat(400)]
    .every((s) => parseChannelRef(s) === null));
}

/* --------------------------------------------- Google, faked at its edges -- */

interface Sent { chat: string; text: string }
const sent: Sent[] = [];
const pages: ChatPage[] = [];
let liveState: LiveVideo["state"] = "live";
let streamEnd: "open" | "offline" = "open";
let currentVideo = "vid00000001";
let streams = 0, videoCalls = 0, feedCalls = 0, uploadsCalls = 0;
let feedDown = false;
const known: Record<string, YouTubeChannel> = {
  streamer: { channelId: ch.channelId, handle: "streamer", name: "Streamer", avatar: null },
  oddiefun: { channelId: "UCoddie00000000000000001", handle: "oddiefun", name: "oddie", avatar: null },
  someone: { channelId: "UCsomeone000000000000001", handle: "someone", name: "Someone", avatar: null },
};
// chan01, chan02…: channels that exist, made up on demand.
const lookup = (ref: ChannelRef): YouTubeChannel | null => {
  if (ref.by === "handle") {
    const n = /^chan(\d{2})$/.exec(ref.handle);
    return known[ref.handle] ?? (n ? { channelId: `UCchan${n[1]}${"0".repeat(16)}`, handle: ref.handle, name: `Chan ${n[1]}`, avatar: null } : null);
  }
  if (ref.by === "id") return Object.values(known).find((c) => c.channelId === ref.id) ?? null;
  if (ref.by === "video") return ref.id.startsWith("vid") ? known.streamer : null;
  return null;
};
let me = known.streamer;
const api: YouTubeApi = {
  exchangeCode: async (code) => ({ accessToken: `at-${code}`, refreshToken: `rt-${code}`, expiresAt: Date.now() + 3_600_000 }),
  me: async () => me,
  channelLookup: async (_t, ref) => lookup(ref),
  refreshTokens: async () => ({ accessToken: "at-fresh", refreshToken: null, expiresAt: Date.now() + 3_600_000 }),
  recentVideoIds: async (channelId) => {
    feedCalls++;
    if (feedDown) throw new YouTubeError("youtube feed 404 <!DOCTYPE html>", 404, "<!DOCTYPE html>");
    return channelId === ch.channelId ? [currentVideo] : [];
  },
  uploadsVideoIds: async (_t, channelId) => { uploadsCalls++; return channelId === ch.channelId ? [currentVideo] : []; },
  videosLive: async (_t, ids) => {
    videoCalls++;
    return ids.map((id) => ({ videoId: id, channelId: ch.channelId, state: liveState, liveChatId: liveState === "live" ? "chat-1" : null }));
  },
  streamChat: async (_t, _chat, pageToken, onPage, signal) => {
    streams++;
    for (;;) {
      // A stopped reader takes nothing more: what is queued is for whoever reads next.
      if (signal.aborted) return { pageToken: pageToken ?? "pt-1", offline: false };
      while (pages.length) await onPage(pages.shift()!);
      if (streamEnd === "offline") return { pageToken: pageToken ?? "pt-1", offline: true };
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
const add = async (channel: unknown) => {
  const r = await fetch(`${base}/live/youtube/add`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel }) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; url?: string; slug?: string } };
};
const stateOf = (loc: string) => new URL(loc).searchParams.get("state") ?? "";

console.log("\nadding a channel, through the real router");
{
  const c = await get("/live/youtube/connect");
  check("the old sign-in address leads to the paste box on /live", c.status === 302 && (c.headers.get("location") ?? "").endsWith("/live#youtube"), c.headers.get("location") ?? "");
  const early = await add("youtube.com/@streamer");
  check("before oddie's own channel is in, a link waits (\"almost here\")", early.status === 503 && early.body.error === "soon", JSON.stringify(early));

  const v = await get("/live/youtube/voice");
  const vu = new URL(v.headers.get("location") ?? "");
  check("oddie's own channel asks to write, and to keep its token", vu.searchParams.get("scope") === "https://www.googleapis.com/auth/youtube.force-ssl"
    && vu.searchParams.get("access_type") === "offline" && (vu.searchParams.get("prompt") ?? "").includes("consent"));
  me = known.oddiefun;
  const vcb = await get(`/live/youtube/callback?state=${stateOf(v.headers.get("location") ?? "")}&code=v1`);
  const voice = await channelById("youtube", "UCoddie00000000000000001");
  check("...signed in, it keeps the token every line goes out with", (vcb.headers.get("location") ?? "").endsWith("/live/youtube/oddiefun?voice=1")
    && voice?.accessToken === "at-v1" && voice.refreshToken === "rt-v1");
  const again = await get("/live/youtube/callback?state=nope&code=s2");
  check("a state nobody asked for is an expired link", (again.headers.get("location") ?? "").endsWith("/live?youtube=expired"));
  me = known.someone;
  const v3 = await get("/live/youtube/voice");
  const v3cb = await get(`/live/youtube/callback?state=${stateOf(v3.headers.get("location") ?? "")}&code=x1`);
  check("another channel at oddie's door is added like a pasted link, and keeps no token",
    (v3cb.headers.get("location") ?? "").endsWith("/live/youtube/someone?added=1") && (await channelById("youtube", "UCsomeone000000000000001"))?.refreshToken === null);

  const bad = await add("twitch.tv/streamer");
  check("a link that is not a YouTube channel is asked for again", bad.status === 400 && bad.body.error === "link");
  const ok = await add("https://www.youtube.com/@Streamer/streams");
  const saved = await channelById("youtube", ch.channelId);
  check("a pasted link adds the channel and leads to its page", ok.status === 200 && ok.body.url === "/live/youtube/streamer?added=1", JSON.stringify(ok));
  check("...watched from now on, with no token of theirs", !!saved?.active && saved.slug === "streamer" && saved.accessToken === null && saved.refreshToken === null);
  const none = await add("@nobody");
  check("a channel YouTube does not know is asked for again", none.status === 404 && none.body.error === "link");
  const self = await add("@oddiefun");
  check("oddie's own channel is not a streamer's", self.status === 400 && self.body.error === "voice");
  const stream = await add("youtu.be/vid00000001");
  check("a link to the stream finds its channel", stream.status === 200 && stream.body.slug === "streamer");
  // "someone" (added at oddie's door) is not part of what follows.
  const someone = await channelById("youtube", "UCsomeone000000000000001");
  if (someone) await saveChannel({ ...someone, active: false });

  process.env.YOUTUBE_MAX_CHANNELS = "2";
  const first = await add("@chan01");
  const full = await add("@chan02");
  check("channels fill up to the limit, oddie's own not counted", first.status === 200 && full.status === 429 && full.body.error === "full", `${first.status} ${full.status}`);
  delete process.env.YOUTUBE_MAX_CHANNELS;
  const paced = await add("@chan01");
  check("seven links in ten minutes from one caller: the seventh waits", paced.status === 429 && paced.body.error === "busy", JSON.stringify(paced));
  const chan01 = await channelById("youtube", `UCchan01${"0".repeat(16)}`);
  if (chan01) await saveChannel({ ...chan01, active: false });
}

console.log("\nthe watcher, a live chat end to end");
_resetYouTube();
const engine = youtubeEngineDeps({ log }, api);
const settle = () => wait(40);
const now = () => Date.now();
const say = (id: string, text: string, author: Record<string, unknown> = {}) =>
  pages.push({ items: [item({ id, snippet: { type: "textMessageEvent", publishedAt: new Date().toISOString(), displayMessage: text } }, author)] });
{
  const out = await watchYouTube({ engine, log, api });
  check("a channel on air is found, and its chat is read", out.live === 1 && _readers().some((r) => r.liveChatId === "chat-1" && !r.done), JSON.stringify(out));
  check("...and nobody is greeted: oddie arrives quietly", sent.length === 0, JSON.stringify(sent));
  const again = await watchYouTube({ engine, log, api });
  check("the next pass keeps the same reader", again.reading === 1 && streams === 1 && sent.length === 0);

  pages.push({ items: [item({ id: "old-1", snippet: { type: "textMessageEvent", publishedAt: new Date(now() - 3_600_000).toISOString(), displayMessage: "!call from before oddie arrived" } }, { isChatOwner: true })] });
  await settle();
  check("the chat's history is not taken for commands", sent.length === 0 && !(await liveStore.current("youtube", ch.channelId)));

  say("early-1", "!oddie BTC above 150k by Friday?");
  say("early-2", "!call will I win?");
  await settle();
  check("before the owner or a mod has used a command, a viewer cannot make oddie talk", sent.length === 0 && !(await liveStore.current("youtube", ch.channelId)), JSON.stringify(sent));

  say("open-1", "!call will I win this round?", { isChatOwner: true });
  await settle();
  const call = await liveStore.current("youtube", ch.channelId);
  const opened = sent.slice();
  check("the owner's !call opens a vote", call?.question === "will I win this round?", JSON.stringify(call));
  check("...said without a link, every line within 200 characters", opened.length >= 1 && opened.every((s) => noLink(s.text) && s.text.length <= CHAT_MAX), JSON.stringify(opened));

  say("yes-1", "!yes");
  await settle();
  check("from then on, a viewer's !yes counts", call ? (await liveStore.tally(call.id)).yes === 1 : false);

  const before = sent.length;
  say("mk-1", "!oddie BTC above 150k by Friday?");
  await settle();
  const mk = sent.slice(before).map((s) => s.text);
  check("!oddie opens no market here: the room hears how votes work", mk.length === 1 && mk[0] === LIVE_COPY.votesHere && noMarket(mk[0]), JSON.stringify(mk));

  const own = sent.length;
  say("own-1", "!call oddie's own line", { channelId: "UCoddie00000000000000001", isChatModerator: true });
  await settle();
  check("oddie's own line coming back is never a command", sent.length === own && (await liveStore.current("youtube", ch.channelId))?.question === "will I win this round?");

  say("set-1", "!call yes", { isChatModerator: true });
  await settle();
  const res = sent[sent.length - 1]?.text ?? "";
  check("a moderator settles it, and the result carries no link", res.startsWith("Result: YES on") && noLink(res), res);

  const help = sent.length;
  say("help-1", "!call", { isChatOwner: true });
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
  const asked = videoCalls;
  await watchYouTube({ engine, log, api });
  check("a stream that ended is a recording, never asked about again", videoCalls === asked, `${asked} -> ${videoCalls}`);

  currentVideo = "vid00000002"; liveState = "live";
  await watchYouTube({ engine, log, api });
  check("the next stream is a new video, found on the next pass", _readers().some((r) => !r.done) && videoCalls === asked + 1);
  say("open-2", "!call will the next one hit?", { isChatModerator: true });
  await settle();
  const next = await liveStore.current("youtube", ch.channelId);

  // A restart: oddie forgets who woke it, the vote stays open.
  _resetYouTube();
  await watchYouTube({ engine, log, api });
  say("yes-2", "!yes");
  await settle();
  check("after a restart, viewers can answer a vote that is still open", next ? (await liveStore.tally(next.id)).yes === 1 : false, JSON.stringify(next));

  streamEnd = "offline";
  await settle();
  check("a chat that ends with its stream closes its reader", _readers().every((r) => r.done));
  check("...and what reading it cost is in the log", logs.some((l) => l === "youtube chat reading"));
}

console.log("\nfinding streams while the public feed is down");
{
  _resetYouTube(); liveState = "live"; streamEnd = "open"; currentVideo = "vid00000003"; feedDown = true;
  const before = uploadsCalls;
  const out = await watchYouTube({ engine, log, api });
  check("the feed answers 404: the uploads playlist finds the stream instead", out.live === 1 && uploadsCalls === before + 1
    && _readers().some((r) => !r.done), JSON.stringify(out));
  check("...and the log says so once, not every pass", logs.filter((l) => l.startsWith("youtube feed down")).length === 1);
  await watchYouTube({ engine, log, api });
  check("...said once an hour at most", logs.filter((l) => l.startsWith("youtube feed down")).length === 1);

  _resetYouTube(); feedDown = false;
  process.env.YOUTUBE_LOOK_MS = String(5 * 60_000);
  const f0 = feedCalls, v0 = videoCalls;
  await watchYouTube({ engine, log, api });
  await watchYouTube({ engine, log, api });
  check("a channel is looked up once every few minutes, while its live video is asked about every pass",
    feedCalls === f0 + 1 && videoCalls === v0 + 2, `feed ${feedCalls - f0}, videos ${videoCalls - v0}`);
  process.env.YOUTUBE_LOOK_MS = "0";
}

console.log("\nchecking a channel");
{
  _resetYouTube(); liveState = "live"; streamEnd = "open"; currentVideo = "vid00000004";
  await settle();   // the readers just stopped are gone before anything is queued
  process.env.YOUTUBE_CHECK_MS = "60";
  pages.push({ items: [item({ id: "c-1" }), item({ id: "c-2", snippet: { type: "superChatEvent", displayMessage: "hi" } })] });
  const r = await get("/live/youtube/check?channel=youtube.com/@streamer");
  const j = (await r.json()) as { ok?: boolean; source?: string; live?: { videoId?: string } | null; chat?: { pages: number; items: number; readable: number } | null };
  check("a channel on air: its stream is found and its chat read, in counts only", r.status === 200 && j.live?.videoId === "vid00000004" && j.source === "feed"
    && (j.chat?.pages ?? 0) >= 1 && j.chat?.items === 2 && j.chat?.readable === 1 && !JSON.stringify(j).includes("will I win"), JSON.stringify(j));
  const soon = await get("/live/youtube/check?channel=@streamer");
  check("one check at a time: the next one right after waits", soon.status === 429);
  const wrong = await get("/live/youtube/check?channel=twitch.tv/streamer");
  check("a link that is not YouTube is asked for again", wrong.status === 400);
  delete process.env.YOUTUBE_CHECK_MS;
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
