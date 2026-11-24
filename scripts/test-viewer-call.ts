/**
 * A VIEWER-COUNT CALL (Lev, 24 Nov): "will we hit 500 viewers today?", settled
 * from the platform's own count on Twitch and Kick.
 *
 * Which questions oddie reads and which it leaves to the channel; what the
 * room hears from the open to the result; that a count is read from the open
 * on, never twice in half a minute and never after a result; that a stream
 * has to be dark for two minutes to have ended; that a restart loses the
 * readings and says so by saying less; and that a viewer count is a vote,
 * never a market. In memory, no network.
 */
if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database: unset DATABASE_URL");
  process.exit(1);
}
import { readFileSync } from "node:fs";
import { parseViewerCall, viewerDeadline, viewerMet, viewerWhenText, viewersShort, viewersText, type ViewerCall } from "../src/live/viewerCall.js";
import {
  PRICE_CALL_LOCK_MS, STREAM_POLL_MS, VIEWER_DARK_MS, VIEWER_GIVE_UP_MS, VIEWER_POLL_MS,
  handleChat, isRoomCall, lockDue, viewerCallOf, _forgetWaits, _resetLive, type ChatMessage, type LiveCall, type LiveDeps, type Platform,
} from "../src/live/calls.js";
import { settledMail } from "../src/live/openedMail.js";
import { liveStore, _resetLiveStore } from "../src/store/live.js";
import { streamInfo } from "../src/twitch/client.js";
import { kickStreamInfo } from "../src/kick/client.js";

let failures = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (ok) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/* ---------------------------------------------------------------- read -- */

console.log("\nthe questions oddie reads\n");
const vc = (target: number, above = false, minutes: number | null = null): ViewerCall => ({ target, above, minutes });
const reads: Array<[string, ViewerCall]> = [
  ["will we hit 500 viewers today?", vc(500)],
  ["500 viewers today?", vc(500)],
  ["500 viewers?", vc(500)],
  ["can we hit 1k viewers tonight", vc(1000)],
  ["1.5k viewers this stream?", vc(1500)],
  ["1.1k viewers today?", vc(1100)],
  ["will we hit 2.25k viewers", vc(2250)],
  ["will we hit 10,500 viewers tonight", vc(10500)],
  ["do we reach 2,000 concurrent viewers this stream", vc(2000)],
  ["will we get to 300 viewers before the stream ends?", vc(300)],
  ["Will This Stream Hit 250 Viewers?", vc(250)],
  ["will the stream reach 400 viewers by the end of the stream", vc(400)],
  ["is chat going to hit 100 viewers", vc(100)],
  ["will we see 2k ccv tonight", vc(2000)],
  ["will the viewer count hit 500", vc(500)],
  ["will we hit the 500 viewer mark today", vc(500)],
  ["let's hit 150 viewers", vc(150)],
  ["500+ viewers today?", vc(500)],
  ["at least 500 viewers tonight?", vc(500)],
  ["will we hit 500 viewers at any point today", vc(500)],
  ["can we get 750 viewers before we end the stream", vc(750)],
  ["will there be 600 viewers today", vc(600)],
  // above the number, not at it
  ["will we get more than 500 viewers today?", vc(500, true)],
  ["over 500 viewers tonight?", vc(500, true)],
  ["will the viewer count go above 1k this stream", vc(1000, true)],
  ["can we pass 300 viewers", vc(300, true)],
  // within a length it states
  ["will we hit 500 viewers in the next 30 minutes?", vc(500, false, 30)],
  ["500 viewers in 10 min?", vc(500, false, 10)],
  ["can we hit 1k viewers within 2 hours", vc(1000, false, 120)],
  ["will we reach 200 viewers in half an hour", vc(200, false, 30)],
  ["will we hit 300 viewers in the next hour", vc(300, false, 60)],
  ["over 400 viewers within the hour?", vc(400, true, 60)],
];
for (const [q, want] of reads) check(`reads: ${q}`, same(parseViewerCall(q), want), JSON.stringify(parseViewerCall(q)));

console.log("\n...and the ones it leaves to the channel\n");
for (const [q, why] of [
  ["will I win this game", "no count"],
  ["will we hit 500 followers today", "not viewers"],
  ["will viewers like this game", "no number"],
  ["will xqc hit 100k viewers today", "a name: not this channel's count"],
  ["will bee hit 500 viewers today", "a name, even the streamer's own"],
  ["will we hit 500 viewers on youtube", "another platform's count"],
  ["will we hit 500 or 600 viewers today", "two numbers"],
  ["will we hit 500 viewers before round 3", "another condition"],
  ["will we hit 500 viewers before the game ends", "another end than the stream's"],
  ["will we hit 500 viewers by 9pm", "a clock time"],
  ["500 viewers by 21:00 UTC?", "a clock time"],
  ["will we hit 500 viewers this week", "longer than a stream"],
  ["will we hit 500 viewers tomorrow", "another stream"],
  ["will we ever hit 1k viewers", "no end at all"],
  ["will we drop below 100 viewers", "a count going down"],
  ["will we stay above 300 viewers today", "a count held"],
  ["will we keep 300 viewers this stream", "a count held"],
  ["will we average 500 viewers today", "an average"],
  ["will we end on 500 viewers", "the count at the end"],
  ["will we be at 500 viewers at the end of the stream", "the count at the end"],
  ["will we peak at 500 viewers", "exactly, or at least?"],
  ["is 500 viewers the peak today", "the most, not a count to reach"],
  ["won't hit 500 viewers today", "turned around"],
  ["will we not hit 500 viewers", "turned around"],
  ["do we have 500 viewers", "about now, not the rest of the stream"],
  ["have we hit 500 viewers", "about before now"],
  ["will we get 50% more viewers today", "a move, not a count"],
  ["will we double our viewers", "no number"],
  ["will we hit 5m viewers", "5m is a length to a chat, not five million"],
  ["will 500 viewers type yes", "something else about them"],
  ["will we hit 500 unique viewers", "not the count under the player"],
  ["will we hit 500 total viewers today", "not the count under the player"],
  ["will we hit 1.5 viewers", "not a count"],
  ["will we hit 1.2345k viewers", "not a whole count"],
  ["will we hit 1 viewers", "one is the streamer"],
  ["will we hit 500 viewers in the next 30", "a length with no unit"],
  ["will we hit 500 viewers in 3 days", "not a length in a stream"],
  ["will we hit 500 viewers in the next 900 minutes", "longer than a call runs"],
  ["will we go over the top with 500 viewers", "\"over\" not in front of the number"],
] as Array<[string, string]>) check(`left to the channel (${why}): ${q}`, parseViewerCall(q) === null, JSON.stringify(parseViewerCall(q)));

console.log("\nwhat a count means\n");
check("reaching the number is enough", viewerMet(vc(500), 500) && !viewerMet(vc(500), 499));
check("\"more than 500\" needs 501", !viewerMet(vc(500, true), 500) && viewerMet(vc(500, true), 501));
check("how many more it takes", viewersShort(vc(500), 460) === 40 && viewersShort(vc(500, true), 500) === 1 && viewersShort(vc(500), 520) === 0);
check("a count reads the way chat writes it", viewersText(1500) === "1,500" && viewersText(431) === "431");
const t0 = Date.parse("2026-11-24T18:00:00.000Z");
check("a call with no length runs until the stream ends", viewerDeadline(vc(500), t0) === null && viewerDeadline(vc(500, false, 30), t0) === t0 + 30 * 60_000);
check("the room hears when it settles", viewerWhenText(vc(500), null) === "the moment the stream has 500 viewers, or when it ends", viewerWhenText(vc(500), null));
check("...a length by its moment, and \"more than\" as it was asked",
  viewerWhenText(vc(1500, true, 30), t0 + 30 * 60_000) === "the moment the stream has more than 1,500 viewers, or at 18:30 UTC", viewerWhenText(vc(1500, true, 30), t0 + 30 * 60_000));
check("the count is read on Twitch and Kick, and nowhere else",
  viewerCallOf({ platform: "twitch", question: "500 viewers today?" })?.target === 500 && viewerCallOf({ platform: "kick", question: "500 viewers today?" })?.target === 500
  && viewerCallOf({ platform: "x", question: "500 viewers today?" }) === null && viewerCallOf({ platform: "youtube", question: "500 viewers today?" }) === null);

/* -------------------------------------------------------------- engine -- */

type Stream = { live: boolean; game: string | null; viewers?: number | null };
let now = t0;
let stream: Stream | null | "down" = { live: true, game: "Just Chatting", viewers: 312 };
let looks = 0;
let markets = 0;
let onAir: boolean | null = true;
const said: string[] = [];
const logged: Array<{ line: string; extra?: Record<string, unknown> }> = [];
const CH = "1372956063";
const PAGE = "https://app.oddie.fun/live/twitch/bee_empire";
const deps: LiveDeps = {
  store: liveStore, now: () => now,
  say: async (_p, _c, text) => { said.push(text); },
  standingsUrl: async (p) => (p === "x" ? "" : PAGE),
  log: (line, extra) => { logged.push({ line, extra }); },
  streamGame: async () => { looks++; if (stream === "down") throw new Error("twitch 503"); return stream; },
  streamLive: async () => onAir,
  market: async () => { markets++; return "market-opened"; },
};
let seq = 0;
const msg = (text: string, senderId: string, canRun = false, platform: Platform = "twitch"): ChatMessage => ({
  platform, channelId: CH, messageId: `m${++seq}`, senderId, senderName: senderId, canRun, text,
});
const watching = (n: number): Stream => ({ live: true, game: "Just Chatting", viewers: n });
const DARK: Stream = { live: false, game: null, viewers: null };
const last = () => said[said.length - 1] ?? "";
// A result line ends on the call's own page, whose number is the store's: read here as N.
const N = (line: string) => line.replace(/\/call\/\d+$/, "/call/N");
const reset = () => {
  _resetLive(); _resetLiveStore(); said.length = 0; logged.length = 0; looks = 0; markets = 0; onAir = true;
  now = t0; stream = watching(312);
};
const tick = async (ms: number) => { now += ms; await lockDue(deps); };
const unsettled = (platform: Platform = "twitch"): Promise<LiveCall[]> => liveStore.unsettled(platform, CH);
const Q = "will we hit 500 viewers today?";
const LOCK = PRICE_CALL_LOCK_MS + 1_000;

console.log("\nfrom the open to a YES, with nobody settling it\n");
reset();
check("it opens", (await handleChat(msg(`!call ${Q}`, "bee", true), deps)) === "opened");
check("the opening line says how many are watching, and that it locks in three minutes",
  said[0] === `call: "${Q}" 312 watching now. Type !yes or !no, locks in 3 min. Standings: ${PAGE}`, said[0]);
check("the count was read once, at the open", looks === 1, String(looks));
await handleChat(msg("!yes", "a"), deps);
await handleChat(msg("!no", "b"), deps);
await handleChat(msg("!no", "c"), deps);
await handleChat(msg("!no", "d"), deps);
check("it is not a moment for the screen to read", (await unsettled()).every((c) => !isRoomCall(c)));
await tick(LOCK);
check("at three minutes it locks, and the room hears what settles it",
  said.includes("Calls are locked: 25% YES from 4 calls. oddie settles it the moment the stream has 500 viewers, or when it ends."), said.join(" | "));
check("a late answer is not taken", (await handleChat(msg("!yes", "late"), deps)) === "no-open-call");
const afterLock = looks;
stream = watching(431);
await tick(5_000);
check("the count is not asked for twice inside half a minute", looks === afterLock, `${looks} vs ${afterLock}`);
await tick(VIEWER_POLL_MS);
check("...and is once the half minute is up", looks === afterLock + 1, `${looks} vs ${afterLock}`);
const quiet = said.length;
stream = watching(460);
await tick(VIEWER_POLL_MS);
check("nine tenths of the way, the room hears how close it is", said.length === quiet + 1 && last() === "460 watching, 40 to go.", last());
stream = watching(470);
await tick(VIEWER_POLL_MS);
check("...once", said.length === quiet + 1, said.slice(quiet).join(" | "));
stream = watching(512);
await tick(VIEWER_POLL_MS);
check("the first reading at the number settles it, with the reading in front and how chat voted",
  N(last()) === `512 watching. Result: YES on "${Q}" Chat voted no. Called it: @a. Card: ${PAGE}/call/N`, last());
check("nothing is left waiting", (await unsettled()).length === 0);
const done = logged.find((l) => l.line === "live call settled");
check("the log names what settled it", done?.extra?.by === "viewers" && done?.extra?.outcome === "yes" && done?.extra?.target === 500 && done?.extra?.peak === 512, JSON.stringify(done?.extra));
const afterResult = looks;
await tick(VIEWER_POLL_MS); await tick(VIEWER_POLL_MS);
check("a settled call's stream is not asked again", looks === afterResult, `${looks} vs ${afterResult}`);

console.log("\nthe stream ends first: a NO\n");
reset();
await handleChat(msg(`!call ${Q}`, "bee", true), deps);
await handleChat(msg("!yes", "a"), deps);
await handleChat(msg("!no", "b"), deps);
await tick(LOCK);
stream = watching(431);
await tick(VIEWER_POLL_MS);
stream = DARK;
await tick(VIEWER_POLL_MS);
check("one dark reading is not the end: a connection can drop", (await unsettled()).length === 1);
stream = watching(420);
await tick(VIEWER_POLL_MS);
stream = DARK;
await tick(VIEWER_POLL_MS);
await tick(VIEWER_DARK_MS - VIEWER_POLL_MS);
check("...and the two minutes start again after it came back", (await unsettled()).length === 1, last());
await tick(VIEWER_POLL_MS);
check("dark for two minutes, the stream has ended: NO, with the highest count read",
  N(last()) === `The stream ended. Highest count read: 431. Result: NO on "${Q}" Called it: @b. Card: ${PAGE}/call/N`, last());
check("...two answers are not a vote, so nothing is said about chat", !last().includes("Chat voted"));

console.log("\nthe count gets there while the room is still answering\n");
reset();
stream = watching(470);
await handleChat(msg(`!call ${Q}`, "bee", true), deps);
check("an open already nine tenths of the way says so in its own line", said[0].includes("470 watching now."), said[0]);
await handleChat(msg("!yes", "a"), deps);
stream = watching(505);
await tick(VIEWER_POLL_MS);
check("it settles at once, inside its three minutes", N(last()) === `505 watching. Result: YES on "${Q}" Called it: @a. Card: ${PAGE}/call/N`, last());
check("...with no \"to go\" line on the way", !said.some((l) => l.includes("to go")));
check("...and takes no answer after", (await handleChat(msg("!no", "late"), deps)) === "no-open-call" && (await unsettled()).length === 0);

console.log("\na number the stream already has is no call\n");
reset();
await handleChat(msg("!call will I win this game?", "bee", true), deps);
stream = watching(520);
const before = said.length;
check("it is not opened", (await handleChat(msg(`!call ${Q}`, "bee", true), deps)) === "viewers-already");
check("...the room hears why", said.length === before + 1 && last() === "Already at 520 viewers. Ask for a number above that.", last());
const still = await unsettled();
check("...and the call that was running still takes answers", still.length === 1 && still[0].question === "will I win this game?" && still[0].lockedAt === null);
check("a higher number opens", (await handleChat(msg("!call will we hit 600 viewers today?", "bee", true), deps)) === "opened" && last().includes("520 watching now."), last());

console.log("\n\"more than 500\" is above it\n");
reset();
stream = watching(400);
await handleChat(msg("!call will we get more than 500 viewers today?", "bee", true), deps);
await tick(LOCK);
check("the lock line says more than", last() === "Calls are locked for this one. oddie settles it the moment the stream has more than 500 viewers, or when it ends.", last());
stream = watching(500);
await tick(VIEWER_POLL_MS);
check("500 is not more than 500", (await unsettled()).length === 1 && last() === "500 watching, 1 to go.", last());
stream = watching(501);
await tick(VIEWER_POLL_MS);
check("501 is", N(last()).startsWith(`501 watching. Result: YES on "will we get more than 500 viewers today?"`), last());

console.log("\na length the question states\n");
reset();
stream = watching(300);
const QW = "will we hit 500 viewers in the next 10 minutes?";
await handleChat(msg(`!call ${QW}`, "bee", true), deps);
check("it still locks in three minutes", said[0] === `call: "${QW}" 300 watching now. Type !yes or !no, locks in 3 min. Standings: ${PAGE}`, said[0]);
await handleChat(msg("!no", "a"), deps);
await tick(45_000);
stream = watching(480);
while (now < t0 + LOCK) await tick(VIEWER_POLL_MS);
check("the lock line names its moment", said.some((l) => l === "Calls are locked: 0% YES from 1 call. oddie settles it the moment the stream has 500 viewers, or at 18:10 UTC."), said.join(" | "));
while (now + VIEWER_POLL_MS < t0 + 10 * 60_000) await tick(VIEWER_POLL_MS);
check("short of its moment it waits", (await unsettled()).length === 1 && now < t0 + 10 * 60_000);
const beforeEnd = looks;
await tick(t0 + 10 * 60_000 - now);
check("it is read at its moment, not half a minute after", looks === beforeEnd + 1 && now === t0 + 10 * 60_000, `${looks - beforeEnd} looks`);
check("...and short of the number is a NO", N(last()) === `Time is up. Highest count read: 480. Result: NO on "${QW}" Called it: @a. Card: ${PAGE}/call/N`, last());

reset();
await handleChat(msg("!call 10m will we hit 500 viewers today?", "bee", true), deps);
check("a length in front is how long it takes answers", said[0].includes("locks in 10 min"), said[0]);
reset();
await handleChat(msg("!call 10m will we hit 500 viewers in the next 5 minutes?", "bee", true), deps);
check("...never past the question's own end", said[0].includes("locks in 5 min"), said[0]);

console.log("\nthe platform does not answer\n");
reset();
await handleChat(msg(`!call ${Q}`, "bee", true), deps);
await handleChat(msg("!yes", "a"), deps);
stream = "down";
await tick(LOCK);
const firstMiss = now;
while (now + VIEWER_POLL_MS < firstMiss + VIEWER_GIVE_UP_MS) await tick(VIEWER_POLL_MS);
check("under ten minutes it keeps asking, and says nothing", (await unsettled()).length === 1 && !said.some((l) => l.includes("yours to settle")), last());
await tick(VIEWER_POLL_MS); await tick(VIEWER_POLL_MS);
check("after ten, the call is the mods', in one line", last() === `"${Q}" is yours to settle: !call yes or !call no.`, last());
const handed = looks;
const lines = said.length;
await tick(STREAM_POLL_MS); await tick(STREAM_POLL_MS);
check("...said once, and the stream is not asked again", looks === handed && said.length === lines, `${looks - handed} looks, ${said.length - lines} lines`);
check("...and a mod settles it", (await handleChat(msg("!call no", "bee", true), deps)) === "settled" && N(last()) === `Result: NO on "${Q}" Nobody called it. Card: ${PAGE}/call/N`, last());

console.log("\na restart in the middle\n");
reset();
await handleChat(msg(`!call ${Q}`, "bee", true), deps);
await handleChat(msg("!no", "a"), deps);
await tick(LOCK);
stream = watching(431);
await tick(VIEWER_POLL_MS);
_forgetWaits();
const atRestart = looks;
stream = watching(470);
await tick(STREAM_POLL_MS);
await tick(5_000);
check("the clock gives the call its wait back", looks > atRestart, `${looks - atRestart} looks`);
check("...and does not say \"to go\" a second time, in case it already had", !said.some((l) => l.includes("to go")), said.join(" | "));
stream = DARK;
await tick(VIEWER_POLL_MS);
await tick(VIEWER_DARK_MS);
check("the stream ending is still a NO, without a highest count it can no longer vouch for",
  N(last()) === `The stream ended. Result: NO on "${Q}" Called it: @a. Card: ${PAGE}/call/N`, last());

reset();
await handleChat(msg(`!call ${Q}`, "bee", true), deps);
await tick(LOCK);
_forgetWaits();
stream = DARK;
await tick(STREAM_POLL_MS);
const sinceRestart = looks;
await tick(5_000);
await tick(VIEWER_DARK_MS + VIEWER_POLL_MS);
check("dark since the restart, with the stream never seen on air again: not called a NO",
  looks === sinceRestart + 2 && (await unsettled()).length === 1, `${looks - sinceRestart} looks, ${last()}`);
while (!said.some((l) => l.includes("yours to settle")) && now < t0 + 30 * 60_000) await tick(VIEWER_POLL_MS);
check("...it goes to the mods after ten minutes", last() === `"${Q}" is yours to settle: !call yes or !call no.`, last());

console.log("\nasked before the stream is on air\n");
reset();
stream = DARK;
check("it opens all the same", (await handleChat(msg(`!call ${Q}`, "bee", true), deps)) === "opened");
check("...with no count to say yet", said[0] === `call: "${Q}" Type !yes or !no, locks in 3 min. Standings: ${PAGE}`, said[0]);
await handleChat(msg("!yes", "a"), deps);
await tick(LOCK);
await tick(VIEWER_DARK_MS);
check("dark before it was ever on air is not the stream ending", (await unsettled()).length === 1, last());
stream = watching(120);
await tick(VIEWER_POLL_MS);
stream = DARK;
await tick(VIEWER_POLL_MS);
await tick(VIEWER_DARK_MS);
check("once it was on air, going dark ends it", N(last()) === `The stream ended. Highest count read: 120. Result: NO on "${Q}" Nobody called it. Card: ${PAGE}/call/N`, last());

console.log("\na mod gets there first\n");
reset();
await handleChat(msg(`!call ${Q}`, "bee", true), deps);
await handleChat(msg("!yes", "a"), deps);
check("!call yes settles it as any call", (await handleChat(msg("!call yes", "bee", true), deps)) === "settled" && N(last()) === `Result: YES on "${Q}" Called it: @a. Card: ${PAGE}/call/N`, last());
const bySettle = looks;
stream = watching(900);
await tick(LOCK); await tick(VIEWER_POLL_MS);
check("...and the count is not read after", looks === bySettle && N(last()).startsWith("Result: YES"), `${looks - bySettle} looks`);
reset();
await handleChat(msg(`!call ${Q}`, "bee", true), deps);
check("!call cancel cancels it", (await handleChat(msg("!call cancel", "bee", true), deps)) === "canceled");
const byCancel = looks;
stream = watching(900);
await tick(LOCK); await tick(VIEWER_POLL_MS);
check("...and nothing settles it later", looks === byCancel && last() === "Call canceled. The next one opens with !call.", last());

console.log("\nthe same number, asked again\n");
reset();
await handleChat(msg(`!call ${Q}`, "bee", true), deps);
await handleChat(msg("!yes", "a"), deps);
check("in other words while it still takes answers: said again, not opened twice",
  (await handleChat(msg("!call 500 viewers this stream?", "mod", true), deps)) === "again" && last().startsWith(`still open: "${Q}" 100% yes`), last());
await tick(LOCK);
check("after its lock: the room hears it is waiting, and for what",
  (await handleChat(msg(`!call ${Q}`, "mod", true), deps)) === "again"
  && last() === `Locked "${Q}" at 100% YES from 1 call. oddie settles it the moment the stream has 500 viewers, or when it ends.`, last());
check("...one call, not two", (await unsettled()).length === 1);
check("another number is another call", (await handleChat(msg("!call will we hit 800 viewers today?", "mod", true), deps)) === "opened" && (await unsettled()).length === 2);
check("...and so is the same number inside a length", (await handleChat(msg("!call will we hit 500 viewers in the next 30 minutes?", "mod", true), deps)) === "opened");

console.log("\nwhile it waits for the count\n");
reset();
await handleChat(msg(`!call ${Q}`, "bee", true), deps);
await handleChat(msg("!yes", "a"), deps);
check("another call takes the room", (await handleChat(msg("!call will I win this game?", "bee", true), deps)) === "opened");
check("...and the room hears the count call is locked, and what settles it",
  said.includes(`Locked "${Q}" at 100% YES from 1 call. oddie settles it the moment the stream has 500 viewers, or when it ends.`), said.join(" | "));
stream = watching(500);
await tick(VIEWER_POLL_MS);
check("it settles behind the call that took the room", N(last()) === `500 watching. Result: YES on "${Q}" Called it: @a. Card: ${PAGE}/call/N`, last());
check("...which goes on taking answers", (await unsettled()).length === 1 && (await unsettled())[0].lockedAt === null);
reset();
await handleChat(msg(`!call ${Q}`, "bee", true), deps);
await tick(LOCK);
check("a runner's stray !yes while it waits is told what it waits for, not how to settle it",
  (await handleChat(msg("!yes", "bee", true), deps)) === "pick-help"
  && last() === `Locked "${Q}". oddie settles it the moment the stream has 500 viewers, or when it ends.`, last());

console.log("\non X the same words are an ordinary call\n");
reset();
check("it opens", (await handleChat(msg(`!call ${Q}`, "showdown", true, "x"), deps)) === "opened");
check("...with no count and no lock: the channel settles it", said[0] === `call: "${Q}" Type !yes or !no, earlier calls score more`, said[0]);
check("...the stream's count is never asked for", looks === 0, String(looks));
check("...and it stays a moment the screen or a mod settles", (await unsettled("x")).every((c) => isRoomCall(c)));

console.log("\na viewer count is never a market\n");
reset();
check("!oddie on a viewer count opens nothing", (await handleChat(msg(`!oddie ${Q}`, "viewer"), deps)) === "viewers-no-market" && markets === 0);
check("...and says where it runs", last() === "A viewer count is a call, never a market. Mods open it with !call and the same question.", last());
check("any other claim goes through the door as before", (await handleChat(msg("!oddie BTC above 100k by Friday", "viewer"), deps)) === "market-opened" && markets === 1);

console.log("\nbeside a repeating call\n");
reset();
check("!call repeat on a viewer count opens it once", (await handleChat(msg(`!call repeat ${Q}`, "bee", true), deps)) === "opened");
check("...with no repeat kept and no word about one", (await liveStore.repeat!("twitch", CH)) === null && !said.some((l) => l.includes("opens again")), said.join(" | "));
reset();
const GAME = "will I win this game?";
await handleChat(msg(`!call repeat ${GAME}`, "bee", true), deps);
await handleChat(msg(`!call ${Q}`, "bee", true), deps);
check("a viewer-count call leaves the channel's repeat alone", (await liveStore.repeat!("twitch", CH))?.question === GAME);
check("the game's result comes in while the count call holds the room", (await handleChat(msg("!call yes 1", "bee", true), deps)) === "settled");
check("...so no round can open yet", (await unsettled()).length === 1 && (await unsettled())[0].question === Q);
await tick(LOCK);
check("the count call locks, and the next round opens behind it", last() === `round 2: "${GAME}" Type !yes or !no`, last());
check("...one round, taking answers", (await unsettled()).filter((c) => c.question === GAME && c.lockedAt === null).length === 1);
reset();
await handleChat(msg(`!call repeat ${GAME}`, "bee", true), deps);
await handleChat(msg(`!call ${Q}`, "bee", true), deps);
await tick(LOCK);
check("a round still waiting for its result is not opened a second time", (await unsettled()).filter((c) => c.question === GAME).length === 1, last());

/* ------------------------------------------------------- the platforms -- */

console.log("\nthe count the platforms hand over\n");
{
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  let twitch: unknown = { data: [{ game_name: "Just Chatting", viewer_count: 431 }] };
  let kick: unknown = { data: [{ category: { name: "Slots & Casino" }, viewer_count: 1204 }] };
  process.env.KICK_CLIENT_ID ??= "test-id";
  process.env.KICK_CLIENT_SECRET ??= "test-secret";
  globalThis.fetch = (async (u: string | URL | Request) => {
    const url = String(u);
    asked.push(url);
    if (url.startsWith("https://api.twitch.tv/helix/streams")) return new Response(JSON.stringify(twitch), { status: 200 });
    if (url.startsWith("https://id.kick.com/oauth/token")) return new Response(JSON.stringify({ access_token: "app", expires_in: 3600 }), { status: 200 });
    if (url.startsWith("https://api.kick.com/public/v1/livestreams")) return new Response(JSON.stringify(kick), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  try {
    check("Twitch: the stream's row carries its viewer_count", same(await streamInfo("app", "77"), { live: true, game: "Just Chatting", viewers: 431 }), JSON.stringify(await streamInfo("app", "77")));
    check("...asked for with the channel's id, live streams only", asked.some((a) => a === "https://api.twitch.tv/helix/streams?user_id=77&type=live"), asked.join(" "));
    twitch = { data: [] };
    check("...no row is a stream that is not on air", same(await streamInfo("app", "77"), { live: false, game: null, viewers: null }));
    twitch = { data: [{ game_name: "Just Chatting" }] };
    check("...and a row with no count is on air with nothing to read", same(await streamInfo("app", "77"), { live: true, game: "Just Chatting", viewers: null }));
    check("Kick: the livestream's row carries its viewer_count", same(await kickStreamInfo("88"), { live: true, game: "Slots & Casino", viewers: 1204 }), JSON.stringify(await kickStreamInfo("88")));
    kick = { data: [] };
    check("...no row is a stream that is not on air", same(await kickStreamInfo("88"), { live: false, game: null, viewers: null }));
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ------------------------------------------------------ what is written -- */

console.log("\nthe operator's mail, and the public page\n");
const mail = settledMail({ kind: "settled", platform: "twitch", channelId: CH, callId: "7", question: Q, outcome: "yes", source: "viewers", right: 1, total: 4, winners: ["a"], frame: false },
  { slug: "bee_empire", name: "Bee Empire" }, "https://app.oddie.fun");
check("the mail says the viewer count settled it", mail.html.includes("The viewer count settled it <b>YES</b>"), mail.html.slice(0, 400));
const page = readFileSync("public/settles.html", "utf8");
check("the page that says how calls settle says this one too", page.includes("A viewer-count call settles off the count") && page.includes("It runs as a call, never as a market."));

console.log(failures === 0 ? "\nall viewer call checks passed.\n" : `\n${failures} viewer call check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
