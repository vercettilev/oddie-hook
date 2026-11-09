// The screen settles it (src/live/screenCalls.ts, src/games/screen.ts): a room
// call's answer read off the stream, the same sure answer twice in a row, never
// in the call's first minute, never for a price or a match call, a channel
// that said !matches off, or a stream that is not live; and a call over many
// games never on one game's result.
//
// Run with: npm run test-screen-calls

import { handleChat, parseCommand, LIVE_COPY, _resetLive, type ChatMessage, type LiveDeps } from "../src/live/calls.js";
import { callFrame, liveStore, recentCalls, saveChannel, _resetLiveStore } from "../src/store/live.js";
import { SCREEN_AFTER_RESULT_MS, watchScreens, _resetScreens, SCREEN_AGREE_MS, SCREEN_GRACE_MS, SCREEN_EVERY_MS, SCREEN_CONFIRM_MS, SCREEN_MAX_AGE_MS, SCREEN_TICK_MS, SCREEN_EVENT_EVERY_MS, SCREEN_EVENT_MAX_AGE_MS, SCREEN_PER_HOUR, SCREEN_OUTAGE_MS, SCREEN_ALERT_GAP_MS, SCREEN_OPS_COPY, SCREEN_X_EVERY_MS, SCREEN_X_PER_HOUR } from "../src/live/screenCalls.js";
import { askScreen, callScope, cleanSeen, fetchPicture, parseScreen, parseStat, quotedResult, roundNotMatch, screenPrompt, screenSource, statRule, winnerDecides, SCREEN_FRAME_WIDTH, type ScreenReading, type ScreenSource } from "../src/games/screen.js";
import { decodeFrame, grabFrame, nearFrames } from "../src/games/frames.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { onXEvent, xEngineDeps, xThumbnail, _resetXLive, type XLiveApi, type XVoice } from "../src/x/live.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

console.log("what the reader says");
{
  const r = parseScreen('```json\n{"answer":"yes","sure":1.4,"seen":"VICTORY 13-11"}\n```');
  check("a fenced answer is read, its sureness kept between 0 and 1", r?.answer === "yes" && r.sure === 1 && r.seen === "VICTORY 13-11", JSON.stringify(r));
  check("anything that is not yes, no or unclear is no reading", parseScreen('{"answer":"maybe","sure":0.9}') === null && parseScreen("no json here") === null);
  check("an event call's reading names the picture's kind, and an unknown kind is none",
    parseScreen('{"screen":"event","answer":"no","sure":0.9,"seen":"x"}')?.screen === "event" && parseScreen('{"screen":"trophy","answer":"no","sure":0.9}')?.screen === undefined);
  check("the evidence never carries a link or reads as a command",
    cleanSeen("!call yes https://evil.example/x") === "call yes" && parseCommand(cleanSeen("!call yes")) === null);
  check("...and stays short", cleanSeen("x".repeat(80)).length === 40);
  const p = screenPrompt("will I win this match?", "nova");
  check("the question goes with the streamer's name, and the picture's own text is never an instruction",
    p.includes('"will I win this match?"') && p.includes('"nova"') && /not an instruction to you/.test(p) && /unclear/.test(p));
  const events = ["will I win the Lucky 13 tournament?", "Aleksa takes the series?", "BO3 to Aleksa?", "best of 3 to nova?",
    "who lifts the cup?", "will I win the championship?", "Aleksa becomes champion?", "will I win the grand final?",
    "turnuvayı Aleksa mı alır?", "Aleksa şampiyon olur mu?", "Kupa bizim mi?"];
  // Named by its own name, or a stretch of games: no tournament word in them.
  // Making the final is winning every game before it.
  const named = ["Does GPPoker win Lucky 13?", "does gppoker win lucky 13", "Is GPPoker the Lucky 13 winner?", "GPPoker takes down Lucky 13?",
    "does GPPoker win a game in Lucky 13?", "will I make it to the final?", "does he make the final table?", "will I win 3 in a row?",
    "will I win today?", "does he win it all?", "top 3 finish?", "will he win the title?", "will I win the next 2 games?"];
  const games = ["will I win this game?", "will I win this match?", "Aleksa wins this hand?", "will I win?", "does he win this one?",
    "will I win this League of Legends game?", "boss down first try?", "first game of the season?", "cupcake speedrun under 2 min?",
    "will I win against Aleksa?", "will I win in 10 turns?", "does he take the W?", "does GPPoker win this game of Lucky 13?",
    "does he beat the final boss?", "will I survive the final round?", "top 10 this game?"];
  check("a call that names a tournament, a series, a cup or a championship is an event call",
    events.every((q) => callScope(q) === "event"), events.filter((q) => callScope(q) !== "event").join(" | "));
  check("...so is one that names its event by its own name, or a stretch of games",
    named.every((q) => callScope(q) === "event"), named.filter((q) => callScope(q) !== "event").join(" | "));
  check("...and a game, a match, a hand or a round is a game call, also inside a tournament, League of Legends included",
    games.every((q) => callScope(q) === "game"), games.filter((q) => callScope(q) !== "game").join(" | "));
  const ev = screenPrompt("will I win the Lucky 13 tournament?", "nova");
  check("an event call is told that no game's result answers it, only the whole event decided",
    /not one game/.test(ev) && /WINNER: <name>/.test(ev) && /champion or trophy screen/.test(ev) && /knocked out/.test(ev), ev.slice(-400));
  check("...while a game call is asked as before", !/not one game/.test(p));
  check("a game call is told a notice naming who was defeated is not the streamer's defeat",
    /\("<name> DEFEATED"\) is not a defeat screen and does not say the streamer lost/.test(p));
  process.env.SCREEN_SETTLE = "off";
  check("SCREEN_SETTLE=off turns it off", screenSource({}).source === null);
  delete process.env.SCREEN_SETTLE;
}

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);
async function room(over: { live?: boolean; matchCalls?: boolean; strong?: boolean; near?: boolean; x?: boolean } = {}) {
  _resetLiveStore(); _resetLive(); _resetScreens();
  // On X every picture differs unless a test hands out the same one twice.
  const platform = over.x ? "x" : "kick", channelId = over.x ? "200" : "100";
  await saveChannel({ platform, channelId, slug: "nova", name: "nova", avatar: null,
    accessToken: null, refreshToken: null, tokenExpiresAt: null, active: true });
  if (over.matchCalls === false) await liveStore.setMatchCalls(platform, channelId, false);
  let clock = T0;
  const said: string[] = [];
  const readings: Array<ScreenReading | Error> = [];
  const strong: Array<ScreenReading | Error> = [];
  const pics: Buffer[] = [];
  let grabs = 0, asks = 0, confirms = 0;
  const asked: string[] = [];
  const screen: ScreenSource = {
    grab: async () => { grabs++; return pics.shift() ?? Buffer.from(over.x ? `jpeg ${grabs}` : "jpeg"); },
    ask: async (_j, q) => { asks++; asked.push(q); const r = readings.shift(); if (r instanceof Error) throw r; return r ?? { answer: "unclear", sure: 0, seen: "" }; },
    ...(over.strong === false ? {} : {
      confirm: async () => { confirms++; const r = strong.shift(); if (r instanceof Error) throw r; return r ?? { answer: "unclear", sure: 0, seen: "" }; },
    }),
    ...(over.near ? { near: async () => [Buffer.from("a second on"), Buffer.from("a second before")] } : {}),
  };
  const deps: LiveDeps = {
    store: liveStore, now: () => clock,
    say: async (_p, _c, text) => { said.push(text); return `s${said.length}`; },
    standingsUrl: async () => "",
    streamLive: async () => over.live !== false,
    log: () => {},
    screen,
  };
  let n = 0;
  const line = (who: string, text: string, canRun = false): ChatMessage => ({
    platform, channelId, messageId: `m${++n}`, senderId: who, senderName: who, canRun, text,
  });
  const at = async (ms: number) => { clock = T0 + ms; return watchScreens(deps); };
  return { deps, said, readings, strong, pics, line, at, counts: () => ({ grabs, asks, confirms }), asked: (q: string) => asked.filter((x) => x === q).length,
    last: () => said[said.length - 1] ?? "", unsettled: () => liveStore.unsettled(platform, channelId) };
}
const yes = (sure = 0.92, seen = "VICTORY 13-11"): ScreenReading => ({ answer: "yes", sure, seen });
const no = (sure = 0.92, seen = "DEFEAT 9-13"): ScreenReading => ({ answer: "no", sure, seen });
const unclear: ScreenReading = { answer: "unclear", sure: 0.3, seen: "round 7" };

console.log("\nthe streamer opens it, the screen settles it");
{
  const r = await room();
  await handleChat(r.line("nova", "!call will I win this match?", true), r.deps);
  await handleChat(r.line("mika", "!yes"), r.deps);
  await handleChat(r.line("bags", "!no"), r.deps);
  await r.at(SCREEN_GRACE_MS - 1_000);
  check("nothing is looked at in the call's first minute: the last result may still be up", r.counts().grabs === 0);
  r.readings.push(unclear, yes(), yes(0.95, "VICTORY"));
  await r.at(SCREEN_GRACE_MS);
  check("a match still going is unclear, and nothing happens", r.counts().asks === 1 && (await liveStore.unsettled("kick", "100")).length === 1);
  await r.at(SCREEN_GRACE_MS + SCREEN_EVERY_MS);
  check("one sure YES is not enough", r.counts().asks === 2 && (await liveStore.unsettled("kick", "100")).length === 1);
  const before = r.said.length;
  const n = await r.at(SCREEN_GRACE_MS + SCREEN_EVERY_MS + SCREEN_CONFIRM_MS);
  check("the same sure YES at the next look settles it", n === 1 && (await liveStore.unsettled("kick", "100")).length === 0);
  check("...said in one line: the result on its question, then who called it",
    r.said.length === before + 1 && r.last() === 'Result: YES on "will I win this match?" Called it: @mika.', r.last());
  check("...a line that never reads as a command", parseCommand(r.last()) === null);
  const [done] = await recentCalls("kick", "100", 1);
  const kept = done ? await callFrame("kick", "100", done.id) : null;
  check("...and the picture it was settled on is kept for the channel page, with what was read off it",
    done?.frame === true && kept?.jpeg.toString() === "jpeg" && kept?.seen === "VICTORY", JSON.stringify({ frame: done?.frame, seen: kept?.seen }));
  check("...for that channel's own calls only", (await callFrame("kick", "999", done?.id ?? "1")) === null && (await callFrame("kick", "100", "x1")) === null);
  await r.at(SCREEN_GRACE_MS + 10 * SCREEN_EVERY_MS);
  check("a settled call is not looked at again", r.counts().asks === 3);
}

console.log("\nTwitch and Kick: the frames beside a sure answer");
{
  const r = await room({ near: true });
  await handleChat(r.line("nova", "!call will I win this match?", true), r.deps);
  r.readings.push(yes(0.95, "VICTORY 13-7"), yes(0.95, "VICTORY 13-7"));
  await r.at(SCREEN_GRACE_MS);
  check("a sure answer the frame a second on agrees with settles at once", (await liveStore.unsettled("kick", "100")).length === 0 && r.counts().asks === 2 && r.counts().grabs === 1);

  const s = await room({ near: true });
  await handleChat(s.line("nova", "!call will I win this match?", true), s.deps);
  s.readings.push(yes(0.95, "VICTORY 13-7"), unclear, yes(0.95, "VICTORY 13-7"));
  await s.at(SCREEN_GRACE_MS);
  check("...or the frame a second before it", (await liveStore.unsettled("kick", "100")).length === 0 && s.counts().asks === 3);

  const t = await room({ near: true });
  await handleChat(t.line("nova", "!call will I win this match?", true), t.deps);
  t.readings.push(yes(0.95, "VICTORY 13-7"), unclear, no(0.95, "DEFEAT 7-13"), yes(0.95, "VICTORY 13-7"));
  await t.at(SCREEN_GRACE_MS);
  check("neither agreeing: nothing settles yet", (await liveStore.unsettled("kick", "100")).length === 1 && t.counts().asks === 3);
  await t.at(SCREEN_GRACE_MS + SCREEN_CONFIRM_MS);
  check("...and the next sure look that agrees settles it", (await liveStore.unsettled("kick", "100")).length === 0 && t.counts().asks === 4);

  const u = await room({ near: true });
  await handleChat(u.line("nova", "!call will I win this match?", true), u.deps);
  u.readings.push(yes(0.95, "VICTORY 13-7"), yes(0.95, "WON ENEMY TEAM ELIMINATED"), yes(0.6, "VICTORY"));
  await u.at(SCREEN_GRACE_MS);
  check("a round's banner or an unsure read beside it agrees with nothing", (await liveStore.unsettled("kick", "100")).length === 1 && u.counts().asks === 3);
}

console.log("\na round is not the match");
{
  const r = await room({ near: true });
  await handleChat(r.line("nova", "!call will I win this match?", true), r.deps);
  r.readings.push(yes(0.95, "WON ENEMY TEAM ELIMINATED"), no(0.95, "ROUND LOST"), yes(0.95, "WON - ENEMY TEAM ELIMINATED"));
  await r.at(SCREEN_GRACE_MS); await r.at(SCREEN_GRACE_MS + SCREEN_EVERY_MS); await r.at(SCREEN_GRACE_MS + 2 * SCREEN_EVERY_MS);
  check("a round's banner never settles a call on the match", (await liveStore.unsettled("kick", "100")).length === 1 && r.counts().asks === 3);
  check("...nor asks the mods anything", !r.said.includes(LIVE_COPY.screenUnsure("will I win this match?")));
  r.readings.push(yes(0.95, "13 VICTORY 7"), yes(0.95, "VICTORY 13-7"));
  await r.at(SCREEN_GRACE_MS + 3 * SCREEN_EVERY_MS);
  check("...the match's own VICTORY does", (await liveStore.unsettled("kick", "100")).length === 0);

  const s = await room({ near: true });
  await handleChat(s.line("nova", "!call will we win this round?", true), s.deps);
  s.readings.push(yes(0.95, "ROUND WON"), yes(0.95, "ROUND WON"));
  await s.at(SCREEN_GRACE_MS);
  check("a call on one round still settles on its banner", (await liveStore.unsettled("kick", "100")).length === 0);
  // As the reader quoted them on the 5 Nov VODs, and the earlier tests' result screens.
  const banners = ["WON ENEMY TEAM ELIMINATED", "LOST - TEAM ELIMINATED", "WON banner displayed on screen", "WON screen displayed, match completed",
    "ROUND LOST banner displayed on screen", "ROUND WON - defended the planted bomb", "LOST SPIKE DETONATED"];
  const results = ["13 VICTORY 7", "DEFEAT 6 13 score display", "2-13 DEFEAT banner displayed", "Rounds Played: 19 Rounds Won: 13",
    "VICTORY WINNER: ALEKSAFLAMINGO", "ENEMY TIMEOUT WINNER: ALEKSAFLAMINGO", "EXTRACTION SUCCESSFUL", "SQUAD ELIMINATED PLACED #6", "SHIBARK DEFEATED", "#1 VICTORY ROYALE"];
  check("Valorant's and CS2's round banners are rounds", banners.every((x) => roundNotMatch("will I win this match?", x)), banners.filter((x) => !roundNotMatch("will I win this match?", x)).join(" | "));
  check("...and no game's end screen is", !results.some((x) => roundNotMatch("will I win this match?", x)), results.filter((x) => roundNotMatch("will I win this match?", x)).join(" | "));
  check("...while on a call about one round they answer it", !roundNotMatch("will we win this round?", "ROUND WON") && !roundNotMatch("next point to me?", "WON"));

  // As the reader quoted them on the 6 Nov MW4 Search and Destroy VODs.
  const replays = ["FINAL KILL, KILLED BY [KIRA]TheLastManga", "FINAL KILL displayed at top of screen", "FINAL KILLCAM"];
  check("MW4's replay after a round is no result on the match", replays.every((x) => roundNotMatch("will I win this match?", x)), replays.filter((x) => !roundNotMatch("will I win this match?", x)).join(" | "));
  check("...and its own result screens still are", !["VICTORY 6 2", "DEFEAT score 4-6", "AFTER ACTION REPORT VICTORY"].some((x) => roundNotMatch("will I win this match?", x)));
  const m = await room({ near: true });
  await handleChat(m.line("nova", "!call will I win this match?", true), m.deps);
  m.readings.push(no(0.95, "FINAL KILL, KILLED BY KillerDeathGOD"));
  await m.at(SCREEN_GRACE_MS);
  check("...so the replay of round one leaves the call open", (await liveStore.unsettled("kick", "100")).length === 1 && m.counts().asks === 1);
}

console.log("\nthe name on the banner decides");
{
  const said = (q: string, answer: ScreenReading["answer"], seen: string, streamer = "Showdown") =>
    winnerDecides(q, streamer, { answer, sure: 0.95, seen }).answer;
  // As the reader quoted them on the Beat Stan replays and Aleksa's 16 Oct stream.
  check("the guest lost: VICTORY on Stan's own view is no win for the guest",
    said("Can Roothlus beat StanCifka?", "yes", "VICTORY WINNER: STANCIFKA AMOUNT WON: +…") === "no"
    && said("Can Roothlus beat StanCifka?", "yes", "VICTORY screen shows WINNER: STANCIFKA,…") === "no"
    && said("Can Vibhu beat StanCifka this game?", "yes", "VICTORY WINNER: StanCifka") === "no");
  check("the guest won: DEFEAT on Stan's own view is the guest's win", said("Can Vibhu beat StanCifka?", "no", "DEFEAT WINNER: VIBHU") === "yes");
  // As the reader put it in its own words on the 9 Nov replay, and the same the other way.
  check("...also in the reader's own words",
    said("Can Vib beat StanCifka?", "no", "DEFEAT screen showing VIB as WINNER") === "yes"
    && said("Can Vib beat StanCifka?", "yes", "VICTORY, StanCifka is the winner") === "no");
  check("...while nobody named as the winner changes nothing",
    said("Can Vib beat StanCifka?", "no", "DEFEAT, no one as winner yet") === "no" && said("Can Vib beat StanCifka?", "yes", "who is the winner?") === "yes");
  check("...and an in-game name holding the call's name counts", said("Can Ondrej beat StanCifka?", "no", "DEFEAT WINNER: ONDREJSHOWDOWN") === "yes");
  check("a name the evidence cut short still counts", said("Can AleksaFlamingo win this game?", "no", "VICTORY screen with WINNER: ALEKSAFLAMI…") === "yes");
  check("a win by timeout is a win, whatever the word above it", said("Can AleksaFlamingo win this game?", "no", "ENEMY TIMEOUT WINNER: ALEKSAFLAMINGO") === "yes");
  check("I means the streamer",
    said("will I win this game?", "no", "ENEMY TIMEOUT WINNER: ALEKSAFLAMINGO", "Aleksa Flamingo 🦩") === "yes"
    && said("can I beat StanCifka?", "yes", "VICTORY WINNER: STANCIFKA", "Aleksa Flamingo 🦩") === "no");
  check("a winner the call does not name changes nothing",
    said("Can Vibhu beat StanCifka?", "no", "DEFEAT WINNER: SOMEONE") === "no"
    && said("Can AleksaFlamingo win this game?", "no", "DEFEAT WINNER: PEACCC") === "no"
    && said("will I win this game?", "yes", "VICTORY WINNER: NOVA99") === "yes"
    && said("Will the streamer win this game?", "no", "DEFEAT WINNER: THEBEST") === "no");
  check("an unclear reading stays unclear", said("Can Roothlus beat StanCifka?", "unclear", "WINNER: STANCIFKA") === "unclear");
  check("a reading that names no winner keeps its answer",
    said("Can Roothlus beat StanCifka?", "yes", "VICTORY screen displayed") === "yes"
    && said("will I win this game?", "yes", "WINNER WINNER CHICKEN DINNER", "WINNER") === "yes");
  const reader = ["Can Vibhu beat StanCifka in under 10 minutes?", "Will Vibhu not win this game?", "Can't Vibhu win this game?", "Will Vibhu lose this game?", "Will Vibhu win by 50 chips?"];
  check("a call with a condition or a negation stays the reader's", reader.every((q) => said(q, "no", "DEFEAT WINNER: VIBHU") === "no"), reader.filter((q) => said(q, "no", "DEFEAT WINNER: VIBHU") !== "no").join(" | "));
  const realFetch = globalThis.fetch, realKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = (async () => new Response(JSON.stringify({ content: [{ type: "text", text: '{"answer":"yes","sure":0.95,"seen":"VICTORY WINNER: STANCIFKA"}' }] }))) as typeof fetch;
  const asked = await askScreen(Buffer.from("x"), "Can Roothlus beat StanCifka?", "Showdown").finally(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = realKey;
  });
  check("...and the server gets the name's answer from the reader", asked?.answer === "no" && asked.sure === 0.95, JSON.stringify(asked));
}

console.log("\nthe words the reader quotes answer a plain win call");
{
  const Q = "will I win this game?";
  const read = (seen: string, q = Q, streamer = "MATTLAFFF") => quotedResult(q, streamer, { answer: "unclear", sure: 0.15, seen });
  // As the reader quoted them on the 6 Nov Warzone VODs.
  const places = ["28TH PLA map screen, game in progress", "3RD PLACE shown on screen, game in prog…", "33rd place, 5 kills, 2 deaths, match in…", "5th Place, 3 Contracts, 11 Kills, 2 Dea…"];
  check("a finishing place answers NO, as sure as a look needs", places.every((x) => read(x).answer === "no" && read(x).sure === 0.95), places.filter((x) => read(x).answer !== "no").join(" | "));
  check("...but first place does not", read("1ST PLACE, 8 KILLS").answer === "unclear");
  const reports = ["After Action Report showing 7th place,…", "After Action Report, 4th place, match i…", "After Action Report, placed 13th, match…", "PLACED 7TH"];
  check("a report opened later answers nothing", reports.every((x) => read(x).answer === "unclear"), reports.filter((x) => read(x).answer !== "unclear").join(" | "));
  check("another team's title answers NO", read("ENEMY VICTORY screen displayed, game in").answer === "no");
  const cut = ["VICTOR text displayed, game appears in…", "VICTOF text visible, game stats shown,…"];
  check("the streamer's own title, cut by the camera, answers YES", cut.every((x) => read(x).answer === "yes" && read(x).sure === 0.95));
  const notCut = ["VICTORY ROAD, gym 3", "VICTORIA eliminated", "Victor text displayed", "Game in progress, no victory or defeat", "VICTOR WINNER: NOVA"];
  check("...but nothing else starting that way does", notCut.every((x) => read(x).answer === "unclear"), notCut.filter((x) => read(x).answer !== "unclear").join(" | "));
  check("the streamer's name is the streamer", read("13TH PLA, game in progress", "Will MATTLAFFF win this game?").answer === "no" && read("VICTOR displayed", "Will Aleksa win the next battle?", "Aleksa Flamingo 🦩").answer === "yes");
  check("a call about anyone else stays the reader's", read("13TH PLA, game in progress", "Will Bob win this game?").answer === "unclear" && read("ENEMY VICTORY", "Can Roothlus beat StanCifka?", "Showdown").answer === "unclear");
  const others = ["will I not win this game?", "will I finish top 5 this game?", "will I get 10 kills this game?", "Will Loochy extract with the loot?", "will I win this game by 10 kills?"];
  check("a call with a condition, a negation or another goal stays the reader's", others.every((q) => read("3RD PLACE", q).answer === "unclear"), others.filter((q) => read("3RD PLACE", q).answer !== "unclear").join(" | "));
  const realFetch = globalThis.fetch, realKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = (async () => new Response(JSON.stringify({ content: [{ type: "text", text: '{"answer":"unclear","sure":0.15,"seen":"28TH PLA, game in progress"}' }] }))) as typeof fetch;
  const asked = await askScreen(Buffer.from("x"), Q, "nova").finally(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = realKey;
  });
  check("...and the server gets the quote's answer from the reader", asked?.answer === "no" && asked.sure === 0.95, JSON.stringify(asked));

  check("a Gulag loss is no result on the game", roundNotMatch(Q, "GULAG DEFEAT KILLED IN ACTION") && roundNotMatch("will I win this match?", "GULAG DEFEAT"));
  check("...while a call on the Gulag itself takes it", !roundNotMatch("will I survive this gulag?", "GULAG DEFEAT") && !roundNotMatch("Do I make it out of the Gulag?", "GULAG DEFEAT"));
  const m = await room({ near: true });
  await handleChat(m.line("nova", `!call ${Q}`, true), m.deps);
  m.readings.push(no(0.95, "GULAG DEFEAT KILLED IN ACTION"));
  await m.at(SCREEN_GRACE_MS);
  check("...so a lost Gulag leaves the call open", (await liveStore.unsettled("kick", "100")).length === 1 && m.counts().asks === 1);
}

console.log("\nthe server's beat: every second, a look only when one falls due");
{
  const r = await room();
  let lists = 0;
  const store = r.deps.store;
  r.deps.store = new Proxy(store, {
    get: (t, k) => (k === "everyUnsettled" ? async () => { lists++; return t.everyUnsettled(); } : Reflect.get(t, k)),
  });
  await handleChat(r.line("nova", "!call will I win this match?", true), r.deps);
  r.readings.push(unclear, yes(0.95, "VICTORY"), yes(0.95, "VICTORY"));
  await r.at(SCREEN_GRACE_MS);
  const listed = lists;
  for (let t = SCREEN_TICK_MS; t < SCREEN_EVERY_MS; t += SCREEN_TICK_MS) await r.at(SCREEN_GRACE_MS + t);
  check("a pass between two looks asks the reader nothing", r.counts().asks === 1, `asks ${r.counts().asks}`);
  check("...and does not ask the store either", lists === listed, `lists ${lists - listed}`);
  await r.at(SCREEN_GRACE_MS + SCREEN_EVERY_MS);
  check("the next look comes when it falls due", r.counts().asks === 2);
  check("the result screen, up a few seconds, is looked at again within them",
    SCREEN_CONFIRM_MS <= 2_000 && SCREEN_EVERY_MS <= 4_000 && SCREEN_TICK_MS <= SCREEN_CONFIRM_MS);
  await r.at(SCREEN_GRACE_MS + SCREEN_EVERY_MS + SCREEN_CONFIRM_MS);
  check("...and settles there", (await liveStore.unsettled("kick", "100")).length === 0 && r.counts().asks === 3);
}

console.log("\nwhat does not settle");
{
  const r = await room();
  await handleChat(r.line("nova", "!call will I win this match?", true), r.deps);
  r.readings.push(yes(), no(), no(), no());
  await r.at(SCREEN_GRACE_MS);
  await r.at(SCREEN_GRACE_MS + SCREEN_CONFIRM_MS);
  check("YES then NO is two different answers: nothing settles", (await liveStore.unsettled("kick", "100")).length === 1);
  check("...the mods are asked instead", r.last() === LIVE_COPY.screenUnsure("will I win this match?"), r.last());
  check("...in a line that never reads as a command", parseCommand(r.last()) === null);
  check("...and its voting closes", (await liveStore.unsettled("kick", "100"))[0]?.lockedAt != null);
  await r.at(SCREEN_GRACE_MS + 2 * SCREEN_CONFIRM_MS);
  await r.at(SCREEN_GRACE_MS + 2 * SCREEN_CONFIRM_MS + SCREEN_EVERY_MS);
  check("...the screen never looks at it again: NO twice after it settles nothing", (await liveStore.unsettled("kick", "100")).length === 1 && r.counts().asks === 2);
  await handleChat(r.line("nova", "!call no", true), r.deps);
  check("...the streamer's !call no settles it", (await liveStore.unsettled("kick", "100")).length === 0 && r.last().startsWith('Result: NO on "'), r.last());

  const s = await room();
  await handleChat(s.line("nova", "!call boss down first try?", true), s.deps);
  s.readings.push(yes(), unclear, yes());
  await s.at(SCREEN_GRACE_MS);
  await s.at(SCREEN_GRACE_MS + SCREEN_CONFIRM_MS);
  check("an unclear look after a sure one does not start over", (await liveStore.unsettled("kick", "100")).length === 1 && s.counts().asks === 2);
  await s.at(SCREEN_GRACE_MS + SCREEN_CONFIRM_MS + SCREEN_EVERY_MS);
  check("...the next sure look that agrees, within the minute, settles it", (await liveStore.unsettled("kick", "100")).length === 0 && s.counts().asks === 3);

  const g = await room();
  await handleChat(g.line("nova", "!call boss down first try?", true), g.deps);
  g.readings.push(yes());
  await g.at(SCREEN_GRACE_MS);
  for (let at = SCREEN_GRACE_MS + SCREEN_CONFIRM_MS; at <= SCREEN_GRACE_MS + SCREEN_AGREE_MS; at += SCREEN_EVERY_MS) await g.at(at);
  check("a sure answer nothing agrees with waits its minute", (await liveStore.unsettled("kick", "100")).length === 1 && !g.said.includes(LIVE_COPY.screenUnsure("boss down first try?")));
  g.readings.push(yes());
  const asks = g.counts().asks;
  await g.at(SCREEN_GRACE_MS + SCREEN_AGREE_MS + SCREEN_EVERY_MS);
  check("...then the mods are asked, with no picture read for it", g.last() === LIVE_COPY.screenUnsure("boss down first try?") && g.counts().asks === asks, g.last());
  await g.at(SCREEN_GRACE_MS + SCREEN_AGREE_MS + 3 * SCREEN_EVERY_MS);
  check("...and the result that went by never settles it a game late", (await liveStore.unsettled("kick", "100")).length === 1 && g.counts().asks === asks);

  const t = await room();
  await handleChat(t.line("nova", "!call will I win this match?", true), t.deps);
  t.readings.push(yes(0.6), yes(0.6), yes(0.6));
  await t.at(SCREEN_GRACE_MS);
  await t.at(SCREEN_GRACE_MS + SCREEN_EVERY_MS);
  await t.at(SCREEN_GRACE_MS + 2 * SCREEN_EVERY_MS);
  check("a reader that is not sure never settles anything", (await liveStore.unsettled("kick", "100")).length === 1 && t.counts().asks === 3);

  const u = await room();
  await handleChat(u.line("nova", "!call will BTC close the hour green?", true), u.deps);
  await u.at(SCREEN_GRACE_MS + SCREEN_EVERY_MS);
  check("a price call is the chart's, never the screen's", u.counts().grabs === 0);

  const v = await room({ matchCalls: false });
  await handleChat(v.line("nova", "!call will I win this match?", true), v.deps);
  await v.at(SCREEN_GRACE_MS);
  check("a channel that said !matches off is never looked at", v.counts().grabs === 0);

  const w = await room({ live: false });
  await handleChat(w.line("nova", "!call will I win this match?", true), w.deps);
  await w.at(SCREEN_GRACE_MS);
  check("a stream that is not live is never looked at", w.counts().grabs === 0);

  const x = await room();
  await handleChat(x.line("nova", "!call will I win this match?", true), x.deps);
  x.readings.push(yes());
  await x.at(SCREEN_GRACE_MS);
  await handleChat(x.line("nova", "!call no", true), x.deps);
  const settled = x.said.length;
  x.readings.push(yes());
  await x.at(SCREEN_GRACE_MS + SCREEN_CONFIRM_MS);
  check("the streamer's own !call settles first, and the screen says nothing after", x.said.length === settled && x.counts().asks === 1);

  const z = await room();
  await handleChat(z.line("nova", "!call will I win this match?", true), z.deps);
  await z.at(SCREEN_MAX_AGE_MS + 1_000);
  check("a call open past its third hour is not looked at any more: !call yes still settles it", z.counts().grabs === 0);

  const y = await room();
  await handleChat(y.line("nova", "!call will I win this match?", true), y.deps);
  y.readings.push(new Error("screen 401 invalid x-api-key"));
  await y.at(SCREEN_GRACE_MS);
  y.readings.push(yes(), yes());
  await y.at(SCREEN_GRACE_MS + SCREEN_EVERY_MS);
  check("a reader out of order pauses the looking rather than asking again and again", y.counts().asks === 1);

  // 2 Nov, Showdown ep 2: the balance ran out mid-show and only a log line knew.
  const out = await room();
  const heard: string[] = [];
  out.deps.alertOps = async (text) => { heard.push(text); };
  const empty = () => new Error("screen 400 Your credit balance is too low to access the Anthropic API.");
  await handleChat(out.line("nova", "!call will I win this match?", true), out.deps);
  out.readings.push(empty());
  await out.at(SCREEN_GRACE_MS);
  check("an empty balance tells the operator, with what chat can do meanwhile",
    heard.length === 1 && heard[0] === SCREEN_OPS_COPY.billing && /!call yes or !call no/.test(heard[0]), JSON.stringify(heard));
  out.readings.push(empty());
  await out.at(SCREEN_GRACE_MS + SCREEN_OUTAGE_MS + 1_000);
  check("...the same outage ten minutes on is not told again", out.counts().asks === 2 && heard.length === 1,
    JSON.stringify({ asks: out.counts().asks, heard: heard.length }));
  await handleChat(out.line("nova", "!call cancel", true), out.deps);
  await out.at(SCREEN_GRACE_MS + SCREEN_ALERT_GAP_MS);
  await handleChat(out.line("nova", "!call will I win the next one?", true), out.deps);
  out.readings.push(empty());
  await out.at(2 * SCREEN_GRACE_MS + SCREEN_ALERT_GAP_MS);
  check("...but is told again three hours on", heard.length === 2, String(heard.length));
  check("...and chat never hears about the balance", out.said.every((s) => !/balance|anthropic/i.test(s)));
}

console.log("\nthe last result may still be up (4 Nov, MW4 DMZ: a summary stayed 66 s, past the first minute)");
{
  const r = await room();
  const Q = "will I extract with the loot?";
  await handleChat(r.line("nova", `!call repeat ${Q}`, true), r.deps);
  r.readings.push(unclear, yes(), yes());
  const t1 = SCREEN_GRACE_MS + SCREEN_EVERY_MS + SCREEN_CONFIRM_MS;
  await r.at(SCREEN_GRACE_MS); await r.at(SCREEN_GRACE_MS + SCREEN_EVERY_MS); await r.at(t1);
  const round2 = await liveStore.current("kick", "100");
  check("round 1 settles off the screen and round 2 opens", round2?.question === Q && r.said.some((s) => s.startsWith("round 2:")));
  r.readings.push(yes(0.95, "EXTRACTION SUMMARY"), yes(0.95, "EXTRACTION SUMMARY"));
  await r.at(t1 + SCREEN_GRACE_MS); await r.at(t1 + SCREEN_GRACE_MS + SCREEN_CONFIRM_MS + SCREEN_EVERY_MS);
  check("round 2 does not settle on round 1's summary, however sure", (await liveStore.current("kick", "100"))?.id === round2?.id && r.counts().asks === 5,
    JSON.stringify({ asks: r.counts().asks }));
  r.readings.push(unclear, yes(0.95, "EXTRACTION SUCCESSFUL"), yes(0.95, "EXTRACTION SUCCESSFUL"));
  const t2 = t1 + SCREEN_GRACE_MS + 2 * SCREEN_EVERY_MS + SCREEN_CONFIRM_MS;
  await r.at(t2); await r.at(t2 + SCREEN_EVERY_MS); await r.at(t2 + SCREEN_EVERY_MS + SCREEN_CONFIRM_MS);
  check("...once it has seen the game, its own result settles it", r.said.some((s) => s.startsWith("round 3:")), JSON.stringify(r.said.slice(-2)));
}
{
  // 6 Nov, Warzone: with the result read off the title, the next round opens before the summary shows.
  const r = await room();
  await handleChat(r.line("nova", "!call repeat will I win this game?", true), r.deps);
  r.readings.push(yes(), yes());
  const t1 = SCREEN_GRACE_MS + SCREEN_CONFIRM_MS;
  await r.at(SCREEN_GRACE_MS); await r.at(t1);
  check("a round on a whole game opens after the result", r.said.some((s) => s.startsWith("round 2:")), JSON.stringify(r.said.slice(-2)));
  const asks = r.counts().asks;
  await r.at(t1 + SCREEN_GRACE_MS); await r.at(t1 + SCREEN_AFTER_RESULT_MS - 1_000);
  check("...and does not look while the summary and the report still come and go", r.counts().asks === asks, JSON.stringify(r.counts()));
  r.readings.push(unclear);
  await r.at(t1 + SCREEN_AFTER_RESULT_MS);
  check("...then looks as usual", r.counts().asks === asks + 1, JSON.stringify(r.counts()));
}
{
  const r = await room();
  await handleChat(r.line("nova", "!call repeat will I win this round?", true), r.deps);
  r.readings.push(yes(), yes());
  const t1 = SCREEN_GRACE_MS + SCREEN_CONFIRM_MS;
  await r.at(SCREEN_GRACE_MS); await r.at(t1);
  const asks = r.counts().asks;
  r.readings.push(unclear);
  await r.at(t1 + SCREEN_GRACE_MS);
  check("a round on one part of a game keeps the first minute: the next one is close", r.counts().asks === asks + 1, JSON.stringify(r.counts()));
}
{
  const r = await room();
  await handleChat(r.line("nova", "!call will I win this match?", true), r.deps);
  await handleChat(r.line("nova", "!call yes", true), r.deps);
  const later = 5 * 60_000 + 1_000;
  await r.at(later);
  await handleChat(r.line("nova", "!call will I win the next one?", true), r.deps);
  r.readings.push(yes(), yes());
  await r.at(later + SCREEN_GRACE_MS); await r.at(later + SCREEN_GRACE_MS + SCREEN_CONFIRM_MS);
  check("a call opened well after the last result settles on its first sure reads, as before",
    (await liveStore.unsettled("kick", "100")).length === 0, String(r.counts().asks));
}

console.log("\na tournament call and a game's call are read apart");
{
  /* 22 Oct, Lev: "turnuvanın call'ı ile bir oyunun call'ı farklı işler".
     Showdown ends every game with the same VICTORY banner, so the tournament
     call is read with its own rule (src/games/screen.ts), less often, for
     longer, and on its own count of looks. */
  const TOUR = "will I win the Lucky 13 tournament?";
  const GAME = "will I win this game?";
  const r = await room();
  await handleChat(r.line("nova", `!call ${TOUR}`, true), r.deps);
  await handleChat(r.line("mika", "!yes"), r.deps);
  await handleChat(r.line("nova", `!call ${GAME}`, true), r.deps);
  check("the game's call locks the tournament call, which keeps its answer and waits for its own result",
    (await liveStore.unsettled("kick", "100")).length === 2 && r.said.some((l) => l.startsWith(`Locked "${TOUR}"`) && l.includes("waits for its result")), r.said.join(" / "));
  for (let t = SCREEN_GRACE_MS; t <= SCREEN_GRACE_MS + 50 * 60_000; t += 2_000) await r.at(t);
  const game = r.asked(GAME), tour = r.asked(TOUR);
  check("the game is looked at every four seconds, the tournament every eight",
    SCREEN_EVENT_EVERY_MS === 2 * SCREEN_EVERY_MS && game === 751 && tour === 376, `game ${game}, tournament ${tour}`);
  check("...each on its own count of looks: together past what one channel used to get, and the game still read",
    game + tour > SCREEN_PER_HOUR && game < SCREEN_PER_HOUR, `${game} + ${tour}`);

  const s = await room();
  await handleChat(s.line("nova", `!call ${TOUR}`, true), s.deps);
  await s.at(SCREEN_MAX_AGE_MS + 60_000);
  check("a tournament call is still looked at past a game call's third hour", s.counts().asks === 1);
  await s.at(SCREEN_EVENT_MAX_AGE_MS + 60_000);
  check("...and not past its eighth: !call yes still settles it", s.counts().asks === 1);
}

console.log("\nDoes GPPoker win Lucky 13: a game's banner settles nothing, the event's own page does");
{
  /* The call Showdown was offered (22 Oct). Its words name no tournament, and
     every game of it ends on a WINNER banner. Measured that day on Aleksa's
     16 Oct frames (src/games/screen.ts): the reader names the picture's kind
     right, a game's banner never settles an event call, and an event page
     settles one only where the strong model reads it the same way. */
  const Q = "Does GPPoker win Lucky 13?";
  const ev = screenPrompt(Q, "Showdown");
  check("its reader says what the picture is, is told one game never answers it, nor another event's page",
    callScope(Q) === "event" && /"screen":"game"\|"event"\|"other"/.test(ev) && /not one game/.test(ev) && /not the one the question names/.test(ev), ev.slice(-400));
  const game = (answer: "yes" | "no", seen: string): ScreenReading => ({ answer, sure: 0.95, seen, screen: "game" });
  const page = (answer: "yes" | "no" | "unclear", seen: string): ScreenReading => ({ answer, sure: 0.95, seen, screen: "event" });

  const r = await room();
  await handleChat(r.line("nova", `!call ${Q}`, true), r.deps);
  await handleChat(r.line("mika", "!yes"), r.deps);
  await handleChat(r.line("bags", "!no"), r.deps);
  r.readings.push(game("yes", "VICTORY WINNER: GPPOKER"), game("yes", "VICTORY WINNER: GPPOKER"), game("no", "DEFEAT WINNER: STAN"));
  for (let t = SCREEN_GRACE_MS; t < SCREEN_GRACE_MS + 3 * SCREEN_EVENT_EVERY_MS; t += SCREEN_TICK_MS) await r.at(t);
  check("a sure answer beside one game's result settles nothing, looked at every eight seconds",
    r.asked(Q) === 3 && (await liveStore.unsettled("kick", "100")).length === 1, `asked ${r.asked(Q)}`);
  check("...and the strong model is not even asked", r.counts().confirms === 0, JSON.stringify(r.counts()));

  // The fast model's misread on 22 Oct: a NO for a player still in.
  let t = SCREEN_GRACE_MS + 3 * SCREEN_EVENT_EVERY_MS;
  r.readings.push(page("no", "GPPoker Eliminated"), page("no", "GPPoker Eliminated"));
  r.strong.push(page("unclear", "GPPoker still in"), page("unclear", "GPPoker still in"));
  await r.at(t); await r.at(t + SCREEN_CONFIRM_MS); await r.at(t + SCREEN_CONFIRM_MS + SCREEN_EVENT_EVERY_MS);
  check("an event page the strong model does not read the same way settles nothing",
    (await liveStore.unsettled("kick", "100")).length === 1 && r.counts().confirms === 2, JSON.stringify(r.counts()));

  t += SCREEN_CONFIRM_MS + 2 * SCREEN_EVENT_EVERY_MS;
  r.readings.push(page("no", "GPPoker Eliminated"), page("no", "GPPoker Eliminated"));
  r.strong.push(page("no", "GPPoker Eliminated (Lucky 13)"), page("no", "GPPoker Eliminated (Lucky 13)"));
  await r.at(t);
  check("...one agreeing look is not enough", (await liveStore.unsettled("kick", "100")).length === 1);
  await r.at(t + SCREEN_CONFIRM_MS);
  check("the two agreeing twice in a row settle it",
    (await liveStore.unsettled("kick", "100")).length === 0 && r.last().startsWith('Result: NO on "Does GPPoker win Lucky 13?"'), r.last());

  const w = await room({ strong: false });
  await handleChat(w.line("nova", `!call ${Q}`, true), w.deps);
  w.readings.push(page("no", "GPPoker Eliminated"), page("no", "GPPoker Eliminated"));
  await w.at(SCREEN_GRACE_MS); await w.at(SCREEN_GRACE_MS + SCREEN_CONFIRM_MS);
  check("with no strong model to ask, an event call is the mods' alone", (await liveStore.unsettled("kick", "100")).length === 1);

  const g = await room();
  await handleChat(g.line("nova", "!call does GPPoker win this game of Lucky 13?", true), g.deps);
  g.readings.push(yes(0.95, "VICTORY WINNER: GPPOKER"), yes(0.95, "VICTORY WINNER: GPPOKER"));
  await g.at(SCREEN_GRACE_MS); await g.at(SCREEN_GRACE_MS + SCREEN_CONFIRM_MS);
  check("a game inside the tournament still settles on its own banner, without the strong model",
    (await liveStore.unsettled("kick", "100")).length === 0 && g.counts().confirms === 0, g.last());

  const m = await room();
  await handleChat(m.line("nova", `!call ${Q}`, true), m.deps);
  await handleChat(m.line("mika", "!yes"), m.deps);
  await handleChat(m.line("nova", "!call yes", true), m.deps);
  check("...and a mod's !call yes settles the tournament whenever they like",
    (await liveStore.unsettled("kick", "100")).length === 0 && /^Result: YES on "Does GPPoker win Lucky 13\?"/.test(m.last()), m.last());
}

console.log("\nA BR1 round's kills or time alive: the panel's number decides, not the reader's yes or no");
{
  /* Aleksa's 23 Oct BR1 stream, read 28 Oct: every round ends on "YOU'VE BEEN
     ELIMINATED" over KILLS and SURVIVAL TIME, and the reader answered "Will
     Aleksa get a kill this round?" a sure NO on nearly every one, KILLS 1
     included (src/games/screen.ts). */
  const rules: Array<[string, string]> = [
    ["Will Aleksa get a kill this round?", "kills>=1"], ["Will Aleksa get 2 kills this round?", "kills>=2"],
    ["will I get 2+ kills this round?", "kills>=2"], ["Aleksa gets at least 3 kills this round?", "kills>=3"],
    ["more than 1 kill this round?", "kills>=2"], ["any kills this round?", "kills>=1"],
    ["Will Aleksa survive 40 seconds this round?", "time>=40"], ["will I survive 2 minutes this round?", "time>=120"],
    ["survive a minute this round?", "time>=60"], ["survive over a minute?", "time>=61"], ["will I last 1:30 this round?", "time>=90"],
    ["stay alive 45s?", "time>=45"], ["survive half a minute?", "time>=30"],
  ];
  const show = (q: string) => { const r = statRule(q); return !r ? "none" : r.stat === "runtime" ? `runtime<${r.under}` : `${r.stat}>=${r.atLeast}`; };
  check("a call on kills or time alive names its number and threshold",
    rules.every(([q, want]) => show(q) === want), rules.filter(([q, want]) => show(q) !== want).map(([q]) => `${q} -> ${show(q)}`).join(" | "));
  /* VS Protocol (28 Oct): a run that reaches the ship ends on MISSION COMPLETE
     with its SCORE; a death shows no panel, so the call waits for the next. */
  const scores: Array<[string, string]> = [
    ["Will Aleksa score 200+ on the next extraction?", "score>=200"], ["Will Aleksa score over 235 on the next extraction?", "score>=236"],
    ["at least 150 points this run?", "score>=150"], ["Will Aleksa score 200 or more points on the next extraction?", "score>=200"],
  ];
  check("a call on a round's score names its threshold",
    scores.every(([q, want]) => show(q) === want), scores.filter(([q, want]) => show(q) !== want).map(([q]) => `${q} -> ${show(q)}`).join(" | "));
  const notScores = ["score 13-11 this map?", "final score 13:11?", "will I score 2 goals?", "will I score 3+ headshots?", "will I beat my best score?"];
  check("...but a match's score, a count of goals or a best score is no score threshold",
    notScores.every((q) => statRule(q) === null), notScores.filter((q) => statRule(q) !== null).join(" | "));
  const sp = screenPrompt("Will Aleksa score 200+ on the next extraction?", "Aleksa Flamingo");
  check("a score call's reader is asked for the round's own SCORE off its result panel, never the score counting up during play",
    /"score":<a number, or null>/.test(sp) && /not a best, a record or a rank/.test(sp) && /The score counting up during play/.test(sp) && !/"kills"/.test(sp), sp.slice(-300));
  const s200 = statRule("Will Aleksa score 200+ on the next extraction?")!;
  check("SCORE 224 on the panel is a YES, 189 a NO, play or a death no answer",
    parseStat(JSON.stringify({ screen: "panel", score: 224, sure: 0.95, seen: "MISSION COMPLETE SCORE 224" }), s200)?.answer === "yes"
    && parseStat(JSON.stringify({ screen: "panel", score: "189", sure: 0.95 }), s200)?.answer === "no"
    && parseStat(JSON.stringify({ screen: "panel", score: "1,240", sure: 0.95 }), s200)?.answer === "yes"
    && parseStat(JSON.stringify({ screen: "other", score: 240, sure: 0.95 }), s200)?.answer === "unclear"
    && parseStat(JSON.stringify({ screen: "panel", score: 224, sure: 0.95, seen: "" }), s200)?.seen === "SCORE 224");
  /* A run's own time (28 Oct, Aleksa: "Will aleksa defeat his 2:05 min high
     score"): VS Protocol's panel shows TIME 3:53.3 beside the score; faster wins. */
  const runs: Array<[string, string]> = [
    ["Will aleksa defeat his 2:05 min high score", "runtime<125"], ["Will Aleksa extract in under 4:00?", "runtime<240"],
    ["Will Aleksa get to the ship in under 2:05?", "runtime<125"], ["Will Aleksa beat 2:05?", "runtime<125"],
    ["Will Aleksa beat his 235 high score?", "score>=236"], ["Will Aleksa survive 2:05 this round?", "time>=125"],
  ];
  check("a call on how fast a run ends is under its time, a high score to beat is above it, surviving stays time alive",
    runs.every(([q, want]) => show(q) === want), runs.filter(([q, want]) => show(q) !== want).map(([q]) => `${q} -> ${show(q)}`).join(" | "));
  const rp = screenPrompt("Will Aleksa extract in under 4:00?", "Aleksa Flamingo");
  check("its reader is asked for the round's own TIME, never the clock or a leaderboard's",
    /The number asked about is the round's own TIME/.test(rp) && /not the time left on the clock, not a time on a leaderboard/.test(rp) && /like 3:53.3/.test(rp), rp.slice(-300));
  const u240 = statRule("Will Aleksa extract in under 4:00?")!;
  const at = (time: string) => parseStat(JSON.stringify({ screen: "panel", time, sure: 0.9 }), u240)?.answer;
  check("3:53.3 is under 4:00, 4:04.2 and 5:08.9 are not, and a reader's dropped colon or quote mark still reads",
    at("3:53.3") === "yes" && at("4:04.2") === "no" && at("5:08.9") === "no" && at("353.3") === "yes" && at("4'04.2") === "no" && at("363.9") === "unclear" && at("4:00") === "no");
  const judged = ["will I win this match?", "Will Aleksa win the next battle?", "Can Ondrej beat StanCifka?", "Will Aleksa win the Kill Race?",
    "will I get the first kill?", "will I kill the boss?", "will I survive this round?", "will I win in 10 minutes?", "will I get 10 kills tonight?",
    "Aleksa wins this hand?", "will I survive 3 rounds?"];
  check("...and every other call is judged as before, a whole night's kills included",
    judged.every((q) => statRule(q) === null), judged.filter((q) => statRule(q) !== null).join(" | "));

  const Q = "Will Aleksa get a kill this round?";
  const p = screenPrompt(Q, "Aleksa Flamingo");
  check("its reader is asked for the panel's numbers, not for an answer",
    /"screen":"panel"\|"other"/.test(p) && /The number asked about is KILLS/.test(p) && /Do not answer the question/.test(p) && !/"answer":"yes"\|"no"\|"unclear"/.test(p), p.slice(-300));
  check("...and a death card or a kill feed is no panel", /A death message, an elimination card, a kill feed/.test(p));
  const kill1 = statRule(Q)!, alive40 = statRule("Will Aleksa survive 40 seconds this round?")!;
  const read = (j: object, rule = kill1) => parseStat(JSON.stringify(j), rule);
  check("KILLS 1 on the panel is a YES, said with what was read",
    read({ screen: "panel", kills: 1, time: "00:41", sure: 0.95, seen: "YOU'VE BEEN ELIMINATED, KILLS 1" })?.answer === "yes"
    && read({ screen: "panel", kills: 1, sure: 0.95, seen: "" })?.seen === "KILLS 1");
  check("KILLS 0 is a NO, eliminated or not", read({ screen: "panel", kills: 0, sure: 0.95, seen: "KILLS 0" })?.answer === "no");
  check("a death card, a missing number or no JSON is no answer",
    read({ screen: "other", kills: 0, sure: 0.95, seen: "ELIMINATED BETTER LUCK NEXT TIME" })?.answer === "unclear"
    && read({ screen: "panel", kills: null, sure: 0.95 })?.answer === "unclear" && parseStat("no json", kill1) === null);
  check("SURVIVAL TIME is compared in seconds: 00:41 lives 40, 00:21 does not, 1:16 is 76",
    read({ screen: "panel", time: "00:41", sure: 0.9 }, alive40)?.answer === "yes" && read({ screen: "panel", time: "00:21", sure: 0.9 }, alive40)?.answer === "no"
    && read({ screen: "panel", time: "1:16", sure: 0.9 }, statRule("survive 76 seconds?")!)?.answer === "yes"
    && read({ screen: "panel", time: "1:16", sure: 0.9 }, statRule("survive 77 seconds?")!)?.answer === "no");

  const panel = (answer: "yes" | "no", seen: string): ScreenReading => ({ answer, sure: 0.95, seen });
  const r = await room();
  await handleChat(r.line("nova", `!call ${Q}`, true), r.deps);
  await handleChat(r.line("mika", "!yes"), r.deps);
  r.readings.push(panel("yes", "KILLS 1"));
  r.strong.push(panel("no", "KILLS 0"));
  await r.at(SCREEN_GRACE_MS); await r.at(SCREEN_GRACE_MS + SCREEN_CONFIRM_MS);
  check("a number the strong model reads differently settles nothing, and the next look waits its turn",
    (await liveStore.unsettled("kick", "100")).length === 1 && r.counts().asks === 1 && r.counts().confirms === 1, JSON.stringify(r.counts()));
  const t = SCREEN_GRACE_MS + SCREEN_EVERY_MS;
  r.readings.push(panel("yes", "KILLS 1"), panel("yes", "KILLS 1"));
  r.strong.push(panel("yes", "KILLS 1, SURVIVAL TIME 00:41"), panel("yes", "KILLS 1, SURVIVAL TIME 00:41"));
  await r.at(t);
  check("...one agreeing look is not enough", (await liveStore.unsettled("kick", "100")).length === 1);
  await r.at(t + SCREEN_CONFIRM_MS);
  check("the two agreeing twice in a row settle it",
    (await liveStore.unsettled("kick", "100")).length === 0 && r.last().startsWith(`Result: YES on "${Q}"`), r.last());

  const w = await room({ strong: false });
  await handleChat(w.line("nova", `!call ${Q}`, true), w.deps);
  w.readings.push(panel("yes", "KILLS 1"), panel("yes", "KILLS 1"));
  await w.at(SCREEN_GRACE_MS); await w.at(SCREEN_GRACE_MS + SCREEN_CONFIRM_MS);
  check("with no strong model to ask, a number call waits for the streamer", (await liveStore.unsettled("kick", "100")).length === 1);
}

console.log("\nX's picture is its live thumbnail");
{
  _resetXLive();
  const api = { sendChat: async () => null } as unknown as XLiveApi;
  const voice: XVoice = { ready: () => true, token: async () => "t", userId: () => "1", adopt: async () => {} };
  const w = { engine: xEngineDeps({ log: () => {} }, api, voice), log: () => {}, voice };
  await onXEvent({ event_uuid: "s1", event_type: "broadcast.start", filter: { user_id: "200" },
    payload: { broadcast_id: "b1", thumbnail_url: "https://prod-fastly.example/latest.jpg?token=t" } }, w);
  check("broadcast.start's live thumbnail is the stream's picture", (await xThumbnail("200")) === "https://prod-fastly.example/latest.jpg?token=t");
  await onXEvent({ event_uuid: "e1", event_type: "broadcast.end", filter: { user_id: "200" }, payload: { broadcast_id: "b1" } }, w);
  check("...and the stream's end takes it away", (await xThumbnail("200")) === null);
}

console.log("\nX's picture, asked past the CDN's copy");
{
  /* 9 Nov, Showdown's Beat Stan #3: the CDN in front of X's live thumbnail
     keeps a copy up to five seconds, and DEFEAT / WINNER: VIB went by unread. */
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const asked: string[] = [];
  const serve = (mode: { refuse?: boolean; gone?: boolean }) => createServer((req, res) => {
    asked.push(req.url ?? "");
    if (mode.gone || (mode.refuse && /oddie_at=/.test(req.url ?? ""))) { res.statusCode = mode.gone ? 404 : 403; res.end(); return; }
    res.setHeader("content-type", "image/jpeg"); res.end(jpeg);
  });
  const up = async (mode: { refuse?: boolean; gone?: boolean }) => {
    const s = serve(mode);
    await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
    return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/latest.jpg?token=t` };
  };
  const a = await up({});
  const pic = await fetchPicture(a.url, 1234);
  check("each fetch asks with a query of its own, which no CDN can have kept",
    pic?.equals(jpeg) === true && asked.join(" ") === "/latest.jpg?token=t&oddie_at=1234", asked.join(" "));
  a.s.close();

  const b = await up({ refuse: true });
  asked.length = 0;
  const plain = await fetchPicture(b.url, 1);
  check("a host that refuses the query is asked the plain address",
    plain?.equals(jpeg) === true && asked.join(" ") === "/latest.jpg?token=t&oddie_at=1 /latest.jpg?token=t", asked.join(" "));
  asked.length = 0;
  await fetchPicture(b.url, 2);
  check("...and only the plain one from then on", asked.join(" ") === "/latest.jpg?token=t", asked.join(" "));
  b.s.close();

  const c = await up({ gone: true });
  asked.length = 0;
  check("a stream that has ended gives no picture either way", (await fetchPicture(c.url, 1)) === null && asked.length === 2);
  c.s.close();
}

console.log("\nX is looked at every two seconds, and one picture read by both models settles it");
{
  check("every two seconds on X, four on Twitch and Kick, and the hour's looks to match",
    SCREEN_X_EVERY_MS === 2_000 && SCREEN_EVERY_MS === 4_000 && SCREEN_X_PER_HOUR * SCREEN_X_EVERY_MS === 3_600_000);
  const Q = "Can Vib beat StanCifka?";
  const r = await room({ x: true });
  await handleChat(r.line("nova", `!call ${Q}`, true), r.deps);
  await handleChat(r.line("mika", "!yes"), r.deps);
  r.readings.push(unclear, unclear, unclear);
  await r.at(SCREEN_GRACE_MS);
  await r.at(SCREEN_GRACE_MS + SCREEN_X_EVERY_MS);
  check("a call on X is looked at two seconds after the last look", r.counts().asks === 2, JSON.stringify(r.counts()));
  const same = Buffer.from("a picture X has not renewed");
  r.pics.push(same, same);
  await r.at(SCREEN_GRACE_MS + 2 * SCREEN_X_EVERY_MS);
  await r.at(SCREEN_GRACE_MS + 3 * SCREEN_X_EVERY_MS);
  check("...and the same picture twice is read once", r.counts().grabs === 4 && r.counts().asks === 3, JSON.stringify(r.counts()));
  r.readings.push(yes(0.95, "DEFEAT WINNER: VIB"));
  r.strong.push(yes(0.95, "DEFEAT, WINNER: VIB"));
  const n = await r.at(SCREEN_GRACE_MS + 4 * SCREEN_X_EVERY_MS);
  check("one sure answer the strong model reads the same way on the same picture settles it at once",
    n === 1 && (await r.unsettled()).length === 0 && r.counts().confirms === 1 && r.last() === `Result: YES on "${Q}" Called it: @mika.`, r.last());

  const s = await room({ x: true });
  await handleChat(s.line("nova", "!call will I win this game?", true), s.deps);
  s.readings.push(yes(0.95, "VICTORY"));
  s.strong.push(unclear);
  await s.at(SCREEN_GRACE_MS);
  check("one the strong model does not read the same way settles nothing", (await s.unsettled()).length === 1 && s.counts().confirms === 1);
  s.readings.push(yes(0.95, "VICTORY"));
  await s.at(SCREEN_GRACE_MS + SCREEN_CONFIRM_MS);
  check("...and the next sure look agreeing settles it, as before, without asking the strong model again",
    (await s.unsettled()).length === 0 && s.counts().confirms === 1, JSON.stringify(s.counts()));

  const k = await room();
  await handleChat(k.line("nova", "!call will I win this game?", true), k.deps);
  k.readings.push(yes(0.95, "VICTORY"));
  await k.at(SCREEN_GRACE_MS);
  check("on Twitch and Kick the strong model is never asked for a game", k.counts().confirms === 0 && (await k.unsettled()).length === 1);
}

console.log("\nTwitch and Kick pictures are read full size");
{
  const ff = process.env.FFMPEG_PATH ?? "ffmpeg";
  const made = spawnSync(ff, ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30", "-frames:v", "2", "-f", "mpegts", "pipe:1"]);
  const seg = made.status === 0 ? made.stdout : null;
  // A JPEG's width sits in its frame header (SOF0..SOF2), two bytes after the height.
  const width = (j: Buffer | null) => {
    if (!j) return 0;
    for (let i = 2; i + 9 < j.length; i++) if (j[i] === 0xff && j[i + 1] >= 0xc0 && j[i + 1] <= 0xc2) return j.readUInt16BE(i + 7);
    return 0;
  };
  if (!seg?.length) console.log("  (no ffmpeg here: skipped)");
  else {
    check("a stream frame for the screen is decoded at full size", width(await decodeFrame(seg, ff, SCREEN_FRAME_WIDTH)) === 1280);
    check("...while the match reader keeps its small one", width(await decodeFrame(seg, ff)) === 640);
  }

  // An fMP4 stream, the way renyan's Twitch VODs came (5 Nov): served here
  // over HTTP, master, playlist, init and segments, and grabbed as the server does.
  const dir = mkdtempSync(join(tmpdir(), "oddie-fmp4-"));
  const hls = seg?.length ? spawnSync(ff, ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30", "-t", "4", "-c:v", "libx264", "-g", "30",
    "-f", "hls", "-hls_time", "2", "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4", join(dir, "720.m3u8")]) : null;
  if (hls?.status !== 0) console.log("  (no ffmpeg with fMP4 here: skipped)");
  else {
    writeFileSync(join(dir, "master.m3u8"), "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720\n720.m3u8\n");
    const server = createServer((req, res) => {
      try { res.end(readFileSync(join(dir, basename(req.url ?? "")))); } catch { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const last = readFileSync(join(dir, "720.m3u8"), "utf8").trim().split("\n").filter((l) => !l.startsWith("#")).pop()!;
    check("an fMP4 segment on its own gives no picture", (await decodeFrame(readFileSync(join(dir, last)), ff, SCREEN_FRAME_WIDTH)) === null);
    const pic = await grabFrame(`${base}/master.m3u8`, ff, SCREEN_FRAME_WIDTH);
    check("...so its init goes in front of it, and the stream gives one full size", width(pic) === 1280);
    const near = pic ? await nearFrames(pic, ff) : [];
    check("the frames a second on and a second before it come from the same stream, full size",
      near.length === 2 && near.every((j) => width(j) === 1280) && near.every((j) => !j.equals(pic!)) && !near[0].equals(near[1]));
    check("...and a picture it did not take has none", (await nearFrames(Buffer.from("x"), ff)).length === 0);
    server.close();
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nall screen checks passed.");
process.exit(failures ? 1 : 0);
