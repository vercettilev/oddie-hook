// The screen settles it (src/live/screenCalls.ts, src/games/screen.ts): a room
// call's answer read off the stream, the same sure answer twice in a row, never
// in the call's first minute, never for a price or a match call, a channel
// that said !matches off, or a stream that is not live; and a call over many
// games never on one game's result.
//
// Run with: npm run test-screen-calls

import { handleChat, parseCommand, LIVE_COPY, _resetLive, type ChatMessage, type LiveDeps } from "../src/live/calls.js";
import { callFrame, liveStore, recentCalls, saveChannel, _resetLiveStore } from "../src/store/live.js";
import { watchScreens, _resetScreens, SCREEN_GRACE_MS, SCREEN_EVERY_MS, SCREEN_CONFIRM_MS, SCREEN_MAX_AGE_MS, SCREEN_TICK_MS, SCREEN_EVENT_EVERY_MS, SCREEN_EVENT_MAX_AGE_MS, SCREEN_PER_HOUR } from "../src/live/screenCalls.js";
import { callScope, cleanSeen, parseScreen, screenPrompt, screenSource, SCREEN_FRAME_WIDTH, type ScreenReading, type ScreenSource } from "../src/games/screen.js";
import { decodeFrame } from "../src/games/frames.js";
import { spawnSync } from "node:child_process";
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
    cleanSeen("!call yes https://evil.example/x") === "call yes" && parseCommand(LIVE_COPY.onScreen(cleanSeen("!call yes"))) === null);
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
async function room(over: { live?: boolean; matchCalls?: boolean; strong?: boolean } = {}) {
  _resetLiveStore(); _resetLive(); _resetScreens();
  await saveChannel({ platform: "kick", channelId: "100", slug: "nova", name: "nova", avatar: null,
    accessToken: null, refreshToken: null, tokenExpiresAt: null, active: true });
  if (over.matchCalls === false) await liveStore.setMatchCalls("kick", "100", false);
  let clock = T0;
  const said: string[] = [];
  const readings: Array<ScreenReading | Error> = [];
  const strong: Array<ScreenReading | Error> = [];
  let grabs = 0, asks = 0, confirms = 0;
  const asked: string[] = [];
  const screen: ScreenSource = {
    grab: async () => { grabs++; return Buffer.from("jpeg"); },
    ask: async (_j, q) => { asks++; asked.push(q); const r = readings.shift(); if (r instanceof Error) throw r; return r ?? { answer: "unclear", sure: 0, seen: "" }; },
    ...(over.strong === false ? {} : {
      confirm: async () => { confirms++; const r = strong.shift(); if (r instanceof Error) throw r; return r ?? { answer: "unclear", sure: 0, seen: "" }; },
    }),
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
    platform: "kick", channelId: "100", messageId: `m${++n}`, senderId: who, senderName: who, canRun, text,
  });
  const at = async (ms: number) => { clock = T0 + ms; return watchScreens(deps); };
  return { deps, said, readings, strong, line, at, counts: () => ({ grabs, asks, confirms }), asked: (q: string) => asked.filter((x) => x === q).length, last: () => said[said.length - 1] ?? "" };
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
  check("...said with what was on screen, then the result and who called it",
    r.said.length === before + 1 && r.last() === 'On stream: VICTORY. YES: "will I win this match?". @mika called it.', r.last());
  check("...a line that never reads as a command", parseCommand(r.last()) === null);
  const [done] = await recentCalls("kick", "100", 1);
  const kept = done ? await callFrame("kick", "100", done.id) : null;
  check("...and the picture it was settled on is kept for the channel page, with what was read off it",
    done?.frame === true && kept?.jpeg.toString() === "jpeg" && kept?.seen === "VICTORY", JSON.stringify({ frame: done?.frame, seen: kept?.seen }));
  check("...for that channel's own calls only", (await callFrame("kick", "999", done?.id ?? "1")) === null && (await callFrame("kick", "100", "x1")) === null);
  await r.at(SCREEN_GRACE_MS + 10 * SCREEN_EVERY_MS);
  check("a settled call is not looked at again", r.counts().asks === 3);
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
  r.readings.push(yes(), no(), no());
  await r.at(SCREEN_GRACE_MS);
  await r.at(SCREEN_GRACE_MS + SCREEN_CONFIRM_MS);
  check("YES then NO is two different answers: nothing settles", (await liveStore.unsettled("kick", "100")).length === 1);
  await r.at(SCREEN_GRACE_MS + 2 * SCREEN_CONFIRM_MS);
  check("...NO twice in a row then does", (await liveStore.unsettled("kick", "100")).length === 0 && r.last().startsWith("On stream: DEFEAT 9-13. NO:"), r.last());

  const s = await room();
  await handleChat(s.line("nova", "!call boss down first try?", true), s.deps);
  s.readings.push(yes(), unclear, yes(), yes());
  await s.at(SCREEN_GRACE_MS);
  await s.at(SCREEN_GRACE_MS + SCREEN_CONFIRM_MS);
  await s.at(SCREEN_GRACE_MS + SCREEN_CONFIRM_MS + SCREEN_EVERY_MS);
  check("an unclear look in between starts over", (await liveStore.unsettled("kick", "100")).length === 1 && s.counts().asks === 3);
  await s.at(SCREEN_GRACE_MS + 2 * SCREEN_CONFIRM_MS + SCREEN_EVERY_MS);
  check("...and two sure looks in a row after it settle", (await liveStore.unsettled("kick", "100")).length === 0);

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
  check("the two agreeing twice in a row settle it, in the strong model's words",
    (await liveStore.unsettled("kick", "100")).length === 0 && r.last().startsWith('On stream: GPPoker Eliminated (Lucky 13). NO: "Does GPPoker win Lucky 13?"'), r.last());

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
    (await liveStore.unsettled("kick", "100")).length === 0 && /^YES: "Does GPPoker win Lucky 13\?"/.test(m.last()), m.last());
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
}

console.log(failures ? `\n${failures} FAILED` : "\nall screen checks passed.");
process.exit(failures ? 1 : 0);
