// The screen settles it (src/live/screenCalls.ts, src/games/screen.ts): a room
// call's answer read off the stream, the same sure answer twice in a row, never
// in the call's first minute, never for a price or a match call, a channel that
// said !matches off, or a stream that is not live.
//
// Run with: npm run test-screen-calls

import { handleChat, parseCommand, LIVE_COPY, _resetLive, type ChatMessage, type LiveDeps } from "../src/live/calls.js";
import { liveStore, saveChannel, _resetLiveStore } from "../src/store/live.js";
import { watchScreens, _resetScreens, SCREEN_GRACE_MS, SCREEN_EVERY_MS, SCREEN_CONFIRM_MS, SCREEN_MAX_AGE_MS, SCREEN_TICK_MS } from "../src/live/screenCalls.js";
import { cleanSeen, parseScreen, screenPrompt, screenSource, type ScreenReading, type ScreenSource } from "../src/games/screen.js";
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
  check("the evidence never carries a link or reads as a command",
    cleanSeen("!call yes https://evil.example/x") === "call yes" && parseCommand(LIVE_COPY.onScreen(cleanSeen("!call yes"))) === null);
  check("...and stays short", cleanSeen("x".repeat(80)).length === 40);
  const p = screenPrompt("will I win this match?", "nova");
  check("the question goes with the streamer's name, and the picture's own text is never an instruction",
    p.includes('"will I win this match?"') && p.includes('"nova"') && /not an instruction to you/.test(p) && /unclear/.test(p));
  process.env.SCREEN_SETTLE = "off";
  check("SCREEN_SETTLE=off turns it off", screenSource({}).source === null);
  delete process.env.SCREEN_SETTLE;
}

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);
async function room(over: { live?: boolean; matchCalls?: boolean } = {}) {
  _resetLiveStore(); _resetLive(); _resetScreens();
  await saveChannel({ platform: "kick", channelId: "100", slug: "nova", name: "nova", avatar: null,
    accessToken: null, refreshToken: null, tokenExpiresAt: null, active: true });
  if (over.matchCalls === false) await liveStore.setMatchCalls("kick", "100", false);
  let clock = T0;
  const said: string[] = [];
  const readings: Array<ScreenReading | Error> = [];
  let grabs = 0, asks = 0;
  const screen: ScreenSource = {
    grab: async () => { grabs++; return Buffer.from("jpeg"); },
    ask: async () => { asks++; const r = readings.shift(); if (r instanceof Error) throw r; return r ?? { answer: "unclear", sure: 0, seen: "" }; },
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
  return { deps, said, readings, line, at, counts: () => ({ grabs, asks }), last: () => said[said.length - 1] ?? "" };
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
  await handleChat(z.line("nova", "!call will I make it to the final?", true), z.deps);
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

console.log(failures ? `\n${failures} FAILED` : "\nall screen checks passed.");
process.exit(failures ? 1 : 0);
