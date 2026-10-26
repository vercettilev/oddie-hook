/**
 * The call read off the picture: a fake stream (readings in a queue), a fake
 * category, the memory store, the clock's picture pass. Opens on a match,
 * settles on the end screen, hands a tie or a vanished match to the mods,
 * cancels an overrun one, steps aside for the other readers, and looks only
 * as often as it should. In memory, no network, no ffmpeg, no model.
 */
if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database: unset DATABASE_URL");
  process.exit(1);
}
process.env.LIVE_TOKEN_KEY = "test-key-for-sealing";
import assert from "node:assert/strict";
import { lastSegment, parseReading, pickVariant, type FrameReading, type FrameSource } from "../src/games/frames.js";
import { continues, decidedSide, FRAME_GONE_MS, FRAME_IDLE_MS, FRAME_MATCH_MS, FRAME_OFF_MS, FRAME_OUTAGE_MS, FRAME_POINT_MS, FRAMES_PER_PASS, gameOf, mineOf, watchFrames, _frameMatch, _resetFrames } from "../src/live/frameCalls.js";
import { GAME_COPY, matchQuestion, _resetGames } from "../src/live/gameCalls.js";
import { handleChat, LIVE_COPY, _resetLive, _forgetWaits, type ChatMessage, type LiveDeps } from "../src/live/calls.js";
import type { GameSource } from "../src/games/faceit.js";
import { liveStore, saveChannel, channelStandings, _resetLiveStore } from "../src/store/live.js";
import { _resetGsi } from "../src/live/gsiCalls.js";
import { _setPace } from "../src/live/pace.js";

_setPace({ gapMs: 0, retryMs: [0, 0] });
let checks = 0;
const ok = (cond: unknown, what: string) => { assert.ok(cond, what); checks++; };
const eq = <T>(a: T, b: T, what: string) => { assert.deepEqual(a, b, what); checks++; };

/* ------------------------------------------------------------- the pure -- */
{
  eq(gameOf("Counter-Strike"), "cs2", "Twitch's category");
  eq(gameOf("Counter-Strike 2"), "cs2", "Kick's category");
  eq(gameOf("Dota 2"), "dota2", "Dota");
  eq(gameOf("Just Chatting"), null, "not a game this reads");
  eq(gameOf(null), null, "no category");
  eq(decidedSide("cs2", { left: 13, right: 9 }), "left", "thirteen wins");
  eq(decidedSide("cs2", { left: 9, right: 13 }), "right", "...on either side");
  eq(decidedSide("cs2", { left: 13, right: 12 }), null, "thirteen against twelve may be overtime");
  eq(decidedSide("cs2", { left: 16, right: 14 }), null, "overtime is not called from the score");
  eq(decidedSide("cs2", { left: 7, right: 5 }), null, "a match in play decides nothing");
  eq(decidedSide("dota2", { left: 40, right: 10 }), null, "Dota's numbers are kills, not an end");
  eq(decidedSide("cs2", null), null, "no score, no end");
  ok(continues({ left: 7, right: 5 }, { left: 8, right: 5 }), "a round later is the same match");
  ok(continues({ left: 7, right: 5 }, { left: 5, right: 7 }), "the half swaps the columns");
  ok(continues({ left: 7, right: 5 }, { left: 7, right: 5 }), "the same score is the same match");
  ok(!continues({ left: 7, right: 5 }, { left: 0, right: 0 }), "a smaller score is a new match");
  ok(continues(null, { left: 0, right: 0 }), "nothing before: anything continues");
  eq(mineOf({ left: 13, right: 9 }, "right"), { mine: 9, theirs: 13 }, "the score from the streamer's side");
  eq(mineOf({ left: 1, right: 2 }, null), null, "no side, no score of theirs");

  const r = parseReading('Here you go:\n```json\n{"view":"match","game":"cs2","score":{"left":"7","right":5},"side":"right","result":null,"map":"de_mirage","sure":0.9}\n```')!;
  eq([r.view, r.game, r.score, r.side, r.map, r.sure], ["match", "cs2", { left: 7, right: 5 }, "right", "Mirage", 0.9], "a fenced answer with prose around it is read");
  const e = parseReading('{"view":"end","game":"cs2","score":null,"side":null,"result":"loss","map":null,"sure":1.4}')!;
  eq([e.view, e.result, e.sure], ["end", "loss", 1], "an end screen, with sure clamped");
  eq(parseReading('{"view":"match","game":"cs2","score":{"left":3},"side":null,"result":"win","map":null,"sure":0.5}')!.score, null, "half a score is no score");
  eq(parseReading('{"view":"match","game":"cs2","score":null,"side":null,"result":"win","map":null,"sure":0.5}')!.result, null, "a result is only an end screen's");
  eq(parseReading('{"view":"menu"}'), null, "a view this does not know is no reading");
  eq(parseReading("I cannot tell"), null, "prose is no reading");
  eq(parseReading('{"view":"other","game":null,"score":null,"side":null,"result":null,"map":null,"sure":0.7}')!.view, "other", "other is other");

  const master = ["#EXTM3U", '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1"', "https://cdn/1080.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720', "720.m3u8", '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=852x480', "https://cdn/480.m3u8", ""].join("\n");
  eq(pickVariant(master, "https://usher/chan.m3u8?x=1"), "https://usher/720.m3u8", "the 720 variant, resolved against the master");
  eq(pickVariant(master.replace("1280x720", "2560x1440"), "https://usher/chan.m3u8"), "https://cdn/1080.m3u8", "nearest below 1080 when 720 is not there");
  eq(pickVariant("#EXTM3U\n", "https://usher/chan.m3u8"), null, "no variants, nothing");
  const media = ["#EXTM3U", "#EXT-X-TARGETDURATION:2", "#EXTINF:2.000,live", "https://cdn/s100.ts", "#EXTINF:2.000,live", "s101.ts", "#EXT-X-TWITCH-PREFETCH:https://cdn/s102.ts", ""].join("\n");
  eq(lastSegment(media, "https://cdn/path/720.m3u8"), "https://cdn/path/s101.ts", "the newest segment, not the prefetch line");
  eq(lastSegment("#EXTM3U\n", "https://cdn/x.m3u8"), null, "no segments, nothing");
}

/* ----------------------------------------------------------- the engine -- */
const said: string[] = [];
const logs: string[] = [];
let now = 1_800_000_000_000;
let stream: { live: boolean; game: string | null } | null = { live: true, game: "Counter-Strike" };
const queue: Array<FrameReading | null | Error> = [];
let grabs = 0, reads = 0, playlists = 0;
const frames: FrameSource = {
  playlist: async () => { playlists++; return "https://usher/chan.m3u8"; },
  grab: async () => { grabs++; return Buffer.from("jpeg"); },
  read: async () => { reads++; const r = queue.shift(); if (r instanceof Error) throw r; return r ?? null; },
};
const URL_ = "https://app.oddie.fun/live/twitch/chan";
const deps: LiveDeps = {
  store: liveStore,
  now: () => now,
  say: async (_p, _c, t) => { said.push(t); return `m${said.length}`; },
  standingsUrl: async () => URL_,
  log: (line) => { logs.push(line); },
  streamLive: async () => stream?.live ?? null,
  streamGame: async () => stream,
  frames,
};
const R = (over: Partial<FrameReading>): FrameReading => ({ view: "match", game: "cs2", score: null, side: null, result: null, map: null, sure: 0.9, ...over });
const match = (left: number, right: number, over: Partial<FrameReading> = {}): FrameReading => R({ view: "match", score: { left, right }, map: "Mirage", side: "right", ...over });
const end = (result: "win" | "loss" | "tie", over: Partial<FrameReading> = {}): FrameReading => R({ view: "end", result, ...over });
const other = (): FrameReading => R({ view: "other", game: null });
const msg = (text: string, over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ platform: "twitch", channelId: "c1", messageId: "x", senderId: "mod1", senderName: "mod", canRun: true, text, ...over });
// The last thing said that is not the stream's best callers, which follow a
// result from the stream's second on (src/live/calls.ts sayStreamTop).
const last = () => said.filter((t) => !t.startsWith("top callers this stream")).at(-1) ?? "";
const tick = async (ms = 0) => { now += ms; return watchFrames(deps); };
const reset = async () => {
  _resetLive(); _forgetWaits(); _resetGames(); _resetGsi(); _resetFrames(); _resetLiveStore();
  said.length = 0; logs.length = 0; queue.length = 0; grabs = reads = playlists = 0;
  stream = { live: true, game: "Counter-Strike" };
  await saveChannel({ platform: "twitch", channelId: "c1", slug: "s1mple", name: "S1mple", avatar: null, accessToken: null, refreshToken: null, tokenExpiresAt: null, active: true });
};

/* nothing to read with, nothing read */
{
  await reset();
  eq(await watchFrames({ ...deps, frames: undefined }), 0, "no source, no pass");
  eq(await watchFrames({ ...deps, streamGame: undefined }), 0, "no category reader, no pass");
  eq(reads, 0, "...and nothing was read");
}

/* off, or in another category: not looked at, and asked again later only */
{
  await reset();
  stream = { live: false, game: null };
  await tick();
  eq([reads, grabs], [0, 0], "an offline channel is not read");
  stream = { live: true, game: "Counter-Strike" };
  await tick(FRAME_IDLE_MS);
  eq(reads, 0, "...and not asked about again within five minutes");
  queue.push(other());
  await tick(FRAME_OFF_MS);
  eq(reads, 1, "...then it is");
  stream = { live: true, game: "Just Chatting" };
  queue.push(other());
  await tick(FRAME_OFF_MS);
  eq(reads, 1, "a stream in another category is not read");
}

/* idling in the category: a look a minute, no call */
{
  await reset();
  queue.push(other(), other(), other());
  await tick();
  eq([reads, grabs, playlists], [1, 1, 1], "one picture, one playlist");
  eq(await liveStore.current("twitch", "c1"), null, "a menu opens nothing");
  await tick(10_000);
  eq(reads, 1, "not again ten seconds later");
  await tick(FRAME_IDLE_MS);
  eq([reads, playlists], [2, 1], "a minute later, with the same playlist");
}

/* a match opens the call; the end screen settles it */
{
  await reset();
  queue.push(match(0, 0));
  eq(await tick(), 1, "a match on screen opens the call");
  const open = await liveStore.current("twitch", "c1");
  ok(open && open.matchId?.startsWith("frame:cs2:twitch:c1:") && open.question === matchQuestion("S1mple", "Mirage"), "the call is about this match, under the stream name");
  eq(last(), GAME_COPY.opened("S1mple", "Mirage", URL_), "chat hears the match line");
  queue.push(match(5, 3));
  eq(await tick(FRAME_MATCH_MS), 0, "a round later is the same match");
  queue.push(match(3, 5));
  eq(await tick(FRAME_MATCH_MS), 0, "...and so is the half, with the columns swapped");
  eq((await liveStore.unsettled("twitch", "c1")).length, 1, "one call");
  eq(_frameMatch("twitch", "c1")?.score, { left: 3, right: 5 }, "the score is kept");
  eq(reads, 3, "three looks, a minute apart");
  queue.push(match(9, 12));
  await tick(FRAME_MATCH_MS);
  await tick(10_000);
  eq(reads, 4, "from match point, not ten seconds later...");
  queue.push(match(10, 12));
  await tick(FRAME_POINT_MS - 10_000);
  eq(reads, 5, "...but twenty");
  eq(await handleChat(msg("!yes", { senderId: "u1", senderName: "alice", canRun: false }), deps), "picked", "a viewer answers");
  eq(await handleChat(msg("!no", { senderId: "u2", senderName: "bob", canRun: false }), deps), "picked", "another answers the other way");
  said.length = 0;
  queue.push(end("win"));
  eq(await tick(FRAME_POINT_MS), 1, "the end screen settles");
  ok(last().startsWith(GAME_COPY.result("S1mple", true, null, "Mirage")) && /YES: "/.test(last()), "chat hears the result, no stale score: " + last());
  const rows = await channelStandings("twitch", "c1");
  ok(rows.some((r) => r.username === "alice" && r.points > 0) && !rows.some((r) => r.username === "bob" && r.points > 0), "alice scored, bob did not");
  queue.push(end("win"));
  eq(await tick(FRAME_MATCH_MS), 0, "the end screen seen again does nothing");
  queue.push(match(10, 13));
  eq(await tick(FRAME_MATCH_MS), 0, "the scoreboard lingering after the end is not a new match");
  eq((await liveStore.unsettled("twitch", "c1")).length, 0, "...nothing waits");
  queue.push(match(0, 0, { map: "Inferno" }));
  eq(await tick(FRAME_MATCH_MS), 1, "the next match opens the next call");
  eq((await liveStore.current("twitch", "c1"))?.question, matchQuestion("S1mple", "Inferno"), "...named after its map");
}

/* a loss, said with the final score when the score is final */
{
  await reset();
  queue.push(match(0, 0, { side: "left" }), match(4, 13, { side: "left" }));
  await tick(); await tick(FRAME_MATCH_MS);
  said.length = 0;
  queue.push(end("loss"));
  eq(await tick(FRAME_POINT_MS), 1, "a loss settles");
  ok(last().startsWith(GAME_COPY.result("S1mple", false, "4-13", "Mirage")) && /NO: "/.test(last()), "the final score from the streamer's side: " + last());
}

/* a tie goes to the mods, once */
{
  await reset();
  queue.push(match(0, 0), end("tie"));
  await tick(); said.length = 0;
  eq(await tick(FRAME_MATCH_MS), 1, "a tie is the mods'");
  eq(last(), GAME_COPY.unreadable(matchQuestion("S1mple", "Mirage")), "...said once");
  eq(await handleChat(msg("!call no"), deps), "settled", "a mod settles it by hand");
}

/* overrun: the next match starts while the last one never ended */
{
  await reset();
  queue.push(match(7, 2, { map: "Nuke" }));
  await tick(); said.length = 0;
  queue.push(match(0, 0, { map: "Dust2" }));
  eq(await tick(FRAME_MATCH_MS), 1, "the new one is opened...");
  ok(said.some((s) => s === GAME_COPY.abandoned(matchQuestion("S1mple", "Nuke"))), "...and the nuke call is canceled, said");
  eq((await liveStore.unsettled("twitch", "c1")).map((c) => c.question), [matchQuestion("S1mple", "Dust2")], "only the new one waits");
  queue.push(match(13, 4, { map: "Dust2", side: "left" }));
  await tick(FRAME_MATCH_MS); said.length = 0;
  queue.push(match(0, 0, { map: "Ancient" }));
  eq(await tick(FRAME_POINT_MS), 1, "the next match opens...");
  ok(said.some((s) => s.startsWith(GAME_COPY.result("S1mple", true, "13-4", "Dust2"))), "...and the overrun match with a final score settled by it, a win said with the score");
}

/* gone: a match that leaves the screen without an end screen */
{
  await reset();
  queue.push(match(13, 4, { side: "left" }));
  await tick(); said.length = 0;
  let n = 0;
  for (let i = 0; i < 8 && n === 0; i++) { queue.push(other()); n = await tick(FRAME_IDLE_MS); }
  eq(n, 1, "five minutes unseen with a final score: settled");
  ok(last().startsWith(GAME_COPY.result("S1mple", true, "13-4", "Mirage")), "...by the score: " + last());
  await reset();
  queue.push(match(9, 4, { side: "left" }));
  await tick(); said.length = 0;
  n = 0;
  for (let i = 0; i < 8 && n === 0; i++) { queue.push(other()); n = await tick(FRAME_IDLE_MS); }
  eq(n, 1, "five minutes unseen without a final score: the mods'");
  eq(last(), GAME_COPY.unreadable(matchQuestion("S1mple", "Mirage")), "...said once");
  queue.push(other());
  eq(await tick(FRAME_IDLE_MS), 0, "...and not again");
}

/* the stream drops mid-match */
{
  await reset();
  queue.push(match(9, 4, { side: "left" }));
  await tick(); said.length = 0;
  stream = { live: false, game: null };
  const before = reads;
  let n = 0;
  for (let i = 0; i < 8 && n === 0; i++) n = await tick(FRAME_IDLE_MS);
  eq(n, 1, "a stream that dropped mid-match hands the call to the mods after five minutes");
  eq(reads, before, "...without a single look at a stream that is off");
  eq(last(), GAME_COPY.unreadable(matchQuestion("S1mple", "Mirage")), "...said");
}

/* the room's own call comes first */
{
  await reset();
  eq(await handleChat(msg("!call will I clutch this?"), deps), "opened", "a mod opens a room call");
  queue.push(match(0, 0));
  eq(await tick(), 0, "the match waits while the room's call takes answers");
  eq(await handleChat(msg("!call yes"), deps), "settled", "the mod settles it");
  queue.push(match(1, 0));
  eq(await tick(FRAME_MATCH_MS), 1, "...and the match gets its call on the next look");
}

/* other readers come first: the game talking, a FACEIT account, !matches off */
{
  await reset();
  await liveStore.markGsiSeen("twitch", "c1", now);
  queue.push(other());
  await tick();
  eq(reads, 0, "a channel whose game is talking is not read");
  await tick(FRAME_IDLE_MS);
  eq(reads, 0, "...still, while it talks");
  await liveStore.markGsiSeen("twitch", "c1", now - 3 * 60_000);
  await tick(FRAME_IDLE_MS);
  eq(reads, 1, "...and is, once it has gone quiet");

  await reset();
  await liveStore.setFaceit("twitch", "c1", { id: "p-s1", nick: "s1mple" });
  const games: GameSource = { player: async () => null, ongoing: async () => null, match: async () => null };
  queue.push(other());
  await watchFrames({ ...deps, games });
  eq(reads, 0, "a channel FACEIT reads is not read from the picture");
  _resetFrames();
  await tick();
  eq(reads, 1, "...unless there is no FACEIT to read it");

  await reset();
  eq(await handleChat(msg("!matches"), deps), "matches-how", "bare, it says how");
  eq(last(), LIVE_COPY.matchesHow, "...the how");
  eq(await handleChat(msg("!matches off"), deps), "matches-off", "a runner turns match calls off");
  eq(last(), LIVE_COPY.matchesOff, "...said");
  queue.push(match(0, 0));
  await tick();
  eq([reads, await liveStore.current("twitch", "c1")], [0, null], "...and the channel is not read");
  eq(await handleChat(msg("!matches on", { canRun: false }), deps), "not-allowed", "a viewer cannot turn them on");
  eq(await handleChat(msg("!matches on"), deps), "matches-on", "a runner can");
  eq(last(), LIVE_COPY.matchesOn, "...said");
  _resetFrames();
  eq(await tick(), 1, "...and the match gets its call");
  for (const line of [LIVE_COPY.matchesHow, LIVE_COPY.matchesOff, LIVE_COPY.matchesOn]) ok(!/^!/.test(line) && !/\b(bot|bet|gamble|free)\b/i.test(line), "the copy keeps the product's words: " + line.slice(0, 30));
}

/* the reader out, or not answering */
{
  await reset();
  queue.push(new Error("frames 401 {\"type\":\"authentication_error\"}"));
  await tick();
  eq(reads, 1, "the reader was asked");
  ok(logs.some((l) => l === "frames paused: the reader is out"), "...and is out for a reason only a person can fix");
  queue.push(other());
  await tick(FRAME_IDLE_MS);
  eq(reads, 1, "nothing is read while the reader is out");
  await tick(FRAME_OUTAGE_MS);
  eq(reads, 2, "...until the pause is over");
  queue.push(new Error("frames 529 overloaded"));
  await tick(FRAME_IDLE_MS);
  eq(reads, 3, "an overloaded reader is asked again");
  ok(!logs.slice(-1).some((l) => l === "frames paused: the reader is out"), "...without a pause");
  queue.push(other());
  await tick(FRAME_IDLE_MS);
  eq(reads, 4, "...a minute later");
  queue.push(null);
  await tick(FRAME_IDLE_MS);
  eq(await liveStore.current("twitch", "c1"), null, "an answer that was not a reading opens nothing");
}

/* a reading without a score is a match that is on, no more */
{
  await reset();
  queue.push(R({ view: "match", score: null }));
  eq(await tick(), 0, "a HUD with digits unread opens nothing yet");
  queue.push(match(2, 1));
  eq(await tick(FRAME_MATCH_MS), 1, "...the next readable score does");
}

/* Dota: kills are not an end; the end screen is */
{
  await reset();
  stream = { live: true, game: "Dota 2" };
  queue.push(R({ view: "match", game: "dota2", score: { left: 3, right: 1 }, side: "left" }));
  eq(await tick(), 1, "a Dota match opens the call");
  eq((await liveStore.current("twitch", "c1"))?.question, matchQuestion("S1mple", null), "...without a map");
  queue.push(R({ view: "match", game: "dota2", score: { left: 40, right: 12 }, side: "left" }));
  await tick(FRAME_MATCH_MS);
  await tick(FRAME_POINT_MS);
  eq(reads, 2, "forty kills is not match point");
  queue.push(end("win"));
  said.length = 0;
  eq(await tick(FRAME_MATCH_MS), 1, "the end screen settles Dota too");
  ok(last().startsWith(GAME_COPY.result("S1mple", true, null, null)), "...without a score: " + last());
}

/* the bill: a forty-minute match is some fifty looks */
{
  await reset();
  let l = 0, r = 0;
  queue.push(match(0, 0));
  await tick();
  for (let i = 0; i < 23; i++) { if (i % 2) l++; else r++; queue.push(match(l, r)); await tick(FRAME_MATCH_MS); }
  // 12:11 now: match point, every twenty seconds
  for (let i = 0; i < 6; i++) { queue.push(match(l, r)); await tick(FRAME_POINT_MS); }
  queue.push(end("win"));
  eq(await tick(FRAME_POINT_MS), 1, "...settled");
  ok(reads <= 32, `a whole match in ${reads} looks`);
}

/* a few channels a tick */
{
  await reset();
  for (let i = 2; i <= FRAMES_PER_PASS + 2; i++) {
    await saveChannel({ platform: "twitch", channelId: `c${i}`, slug: `s${i}`, name: null, avatar: null, accessToken: null, refreshToken: null, tokenExpiresAt: null, active: true });
  }
  for (let i = 0; i < FRAMES_PER_PASS + 2; i++) queue.push(other());
  await tick();
  eq(reads, FRAMES_PER_PASS, "one tick reads a few");
  await tick(5_000);
  eq(reads, FRAMES_PER_PASS + 2, "...the next tick the rest");
}

console.log(`test-frame-calls: ${checks} checks passed`);
