/**
 * Price calls: which questions oddie settles itself, which number it reads,
 * and what the room hears from lock to result. In memory, no network.
 */
import assert from "node:assert/strict";
import { nextClock, outcomeFor, parsePriceCall, planFor, readPriceCall, timeLabel, type PriceCall, type PriceSource } from "../src/live/priceCall.js";
import { PRICE_GIVE_UP_MS, handleChat, lockDue, _resetLive, type ChatMessage, type LiveDeps } from "../src/live/calls.js";
import { liveStore, _resetLiveStore } from "../src/store/live.js";

let checks = 0;
const ok = (cond: unknown, what: string) => { assert.ok(cond, what); checks++; };
const eq = <T>(a: T, b: T, what: string) => { assert.deepEqual(a, b, what); checks++; };

/* --------------------------------------------------------------- parse -- */

const read: Array<[string, PriceCall]> = [
  // candle
  ["will BTC close current 30min candle above 82k?", { kind: "candle", asset: "BTC", size: "30m", which: "current", test: { kind: "above", level: 82000 } }],
  ["will btc close the next 5m candle green", { kind: "candle", asset: "BTC", size: "5m", which: "next", test: { kind: "green" } }],
  ["$SOL 1h candle closes below 150.5?", { kind: "candle", asset: "SOL", size: "1h", which: "current", test: { kind: "below", level: 150.5 } }],
  ["will ethereum close the daily candle over $4,100", { kind: "candle", asset: "ETH", size: "1d", which: "current", test: { kind: "above", level: 4100 } }],
  ["TON 15 min candle close red?", { kind: "candle", asset: "TON", size: "15m", which: "current", test: { kind: "red" } }],
  ["will PEPE 15m candle close above 0.00001", { kind: "candle", asset: "PEPE", size: "15m", which: "current", test: { kind: "above", level: 0.00001 } }],
  ["will bitcoin close this half hour candle above 1.2m", { kind: "candle", asset: "BTC", size: "30m", which: "current", test: { kind: "above", level: 1200000 } }],
  // at a moment
  ["will BTC be above 82k in 10 minutes?", { kind: "at", asset: "BTC", when: { kind: "in", minutes: 10 }, test: { kind: "above", level: 82000 } }],
  ["SOL under 150 in 30 min?", { kind: "at", asset: "SOL", when: { kind: "in", minutes: 30 }, test: { kind: "below", level: 150 } }],
  ["BTC above 83k in half an hour?", { kind: "at", asset: "BTC", when: { kind: "in", minutes: 30 }, test: { kind: "above", level: 83000 } }],
  ["will doge be below 0.2 an hour from now", { kind: "at", asset: "DOGE", when: { kind: "in", minutes: 60 }, test: { kind: "below", level: 0.2 } }],
  ["will ETH be over 4k at 18:00 UTC", { kind: "at", asset: "ETH", when: { kind: "clock", hour: 18, minute: 0, tz: "UTC", label: "UTC" }, test: { kind: "above", level: 4000 } }],
  ["will BTC be above 82,500 at 6pm ET?", { kind: "at", asset: "BTC", when: { kind: "clock", hour: 18, minute: 0, tz: "America/New_York", label: "ET" }, test: { kind: "above", level: 82500 } }],
  // a touch on the way
  ["will BTC hit 83k in the next 15 min?", { kind: "touch", asset: "BTC", level: 83000, dir: "either", until: { kind: "in", minutes: 15 } }],
  ["will BTC dip to 81k this hour", { kind: "touch", asset: "BTC", level: 81000, dir: "down", until: { kind: "candle", size: "1h", which: "current" } }],
  ["will BTC go above 82k this 30m candle", { kind: "touch", asset: "BTC", level: 82000, dir: "up", until: { kind: "candle", size: "30m", which: "current" } }],
  ["will SOL break 200 by 18:00 UTC", { kind: "touch", asset: "SOL", level: 200, dir: "either", until: { kind: "clock", hour: 18, minute: 0, tz: "UTC", label: "UTC" } }],
  ["will ETH drop below 4k within the next hour", { kind: "touch", asset: "ETH", level: 4000, dir: "down", until: { kind: "in", minutes: 60 } }],
  ["will BTC see 85k within the hour", { kind: "touch", asset: "BTC", level: 85000, dir: "either", until: { kind: "in", minutes: 60 } }],
  ["will btc pump to 90k in 2 hours", { kind: "touch", asset: "BTC", level: 90000, dir: "up", until: { kind: "in", minutes: 120 } }],
];
for (const [q, want] of read) eq(parsePriceCall(q), want, `reads: ${q}`);

for (const q of [
  "will BTC not close the 30m candle above 82k",       // turned around
  "BTC won't close the 5m candle green",
  "will BTC close above 82k",                          // no time
  "will BTC 7m candle close green",                    // no such candle
  "will BTC or ETH close the 5m candle green",         // two coins
  "will BTC close the 5m candle above 82k? red alert", // two tests
  "will the 5m candle close above a ton",              // no coin
  "will the chart go above 82k in 10 minutes",         // no coin
  "will I clutch this round",
  "will BTC be above 82k at 18:00",                    // whose 18:00?
  "will BTC be above 82k at 6 ET",                     // six in the morning or at night?
  "will BTC hit 83k",                                  // no time
  "will BTC hit 83k today",                            // whose today?
  "will BTC stay above 82k for 10 minutes",            // every second of a window
  "will BTC pump 5% in 10 minutes",                    // a percentage is not a level
  "will BTC hit 83k or 80k in 10 min",                 // two levels
  "will BTC hit 83k in the next 4h candle",            // a window that has not started
  "will BTC be above 82k in 10 minutes or at 18:00 UTC", // two times
  "will btc go up in 10 minutes",                      // no level
]) eq(parsePriceCall(q), null, `left to the channel: ${q}`);

/* ---------------------------------------------------------------- time -- */

const opened = Date.parse("2026-10-08T13:43:11.830Z");
const bee = parsePriceCall("will BTC close current 30min candle above 82k?")!;
eq(planFor(bee, opened), { from: Date.parse("2026-10-08T13:30:00Z"), to: Date.parse("2026-10-08T14:00:00Z") }, "current 30m candle");
eq(planFor(parsePriceCall("will btc close the next 30m candle green")!, opened).from, Date.parse("2026-10-08T14:00:00Z"), "next 30m candle");
eq(planFor(parsePriceCall("will btc close the daily candle green")!, opened).from, Date.parse("2026-10-08T00:00:00Z"), "daily starts at UTC midnight");
eq(planFor(parsePriceCall("will BTC be above 82k in 10 minutes?")!, opened), { from: opened + 600_000, to: opened + 600_000 }, "a moment ten minutes on");
eq(planFor(parsePriceCall("will BTC hit 83k in the next 15 min?")!, opened), { from: opened, to: opened + 900_000 }, "a touch window from the open");
eq(planFor(parsePriceCall("will BTC dip to 81k this hour")!, opened).to, Date.parse("2026-10-08T14:00:00Z"), "this hour ends on the hour");
eq(nextClock({ hour: 18, minute: 0, tz: "UTC" }, opened), Date.parse("2026-10-08T18:00:00Z"), "18:00 UTC later today");
eq(nextClock({ hour: 9, minute: 0, tz: "UTC" }, opened), Date.parse("2026-10-09T09:00:00Z"), "09:00 UTC tomorrow");
eq(nextClock({ hour: 18, minute: 0, tz: "America/New_York" }, opened), Date.parse("2026-10-08T22:00:00Z"), "6pm ET in October is 22:00 UTC");
eq(nextClock({ hour: 18, minute: 0, tz: "America/New_York" }, Date.parse("2026-11-01T12:00:00Z")), Date.parse("2026-11-01T23:00:00Z"), "6pm ET after the clocks go back");
eq(timeLabel(Date.parse("2026-10-08T22:00:00Z"), { tz: "America/New_York", label: "ET" }), "18:00 ET", "a moment in the question's zone");
eq(timeLabel(opened + 600_000), "13:53 UTC", "a moment in UTC");

const real = { open: 82362.01, close: 82182.01 }; // BTCUSDT 13:30 UTC, 8 Oct
eq(outcomeFor({ kind: "above", level: 82000 }, real), "yes", "closed above");
eq(outcomeFor({ kind: "above", level: 82182.01 }, real), "no", "exactly at the level is not above");
eq(outcomeFor({ kind: "below", level: 82000 }, real), "no", "not below");
eq(outcomeFor({ kind: "green" }, real), "no", "red candle is not green");
eq(outcomeFor({ kind: "red" }, real), "yes", "red candle");

/* -------------------------------------------------------------- source -- */

let reads = 0;
let candle: { open: number; close: number } | null = real;
let prices: Record<number, number> = {};
let ex: { high: number; low: number } | null = null;
const fake: PriceSource = {
  venue: "Binance",
  async candle(asset, size, openAt) {
    reads++;
    assert.equal(asset, "BTC"); assert.equal(size, "30m"); assert.equal(openAt, Date.parse("2026-10-08T13:30:00Z"));
    return candle;
  },
  async priceAt(_asset, t) { reads++; return prices[t] ?? null; },
  async extremes() { reads++; return ex; },
};

{
  const at = parsePriceCall("will BTC be above 82k in 10 minutes?")!;
  const plan = planFor(at, opened);
  prices = { [plan.to]: 82100 };
  eq(await readPriceCall(at, plan, opened, fake, plan.to - 1_000), "wait", "not before its moment");
  eq(await readPriceCall(at, plan, opened, fake, plan.to + 5_000), { outcome: "yes", said: "BTC was 82,100 at 13:53 UTC on Binance." }, "the price at its moment");
  prices = {};
  eq(await readPriceCall(at, plan, opened, fake, plan.to + 5_000), null, "no number, no result");

  const hit = parsePriceCall("will BTC hit 83k in the next 15 min?")!;
  const hp = planFor(hit, opened);
  prices = { [opened]: 82500 };
  ex = { high: 83010, low: 82400 };
  eq(await readPriceCall(hit, hp, opened, fake, opened + 120_000), { outcome: "yes", said: "BTC high was 83,010 on Binance." }, "a touch settles the moment it happens");
  ex = { high: 82900, low: 82400 };
  eq(await readPriceCall(hit, hp, opened, fake, opened + 120_000), "wait", "no touch yet, time left");
  eq(await readPriceCall(hit, hp, opened, fake, hp.to + 5_000), { outcome: "no", said: "BTC high was 82,900 on Binance." }, "no touch by the end");
  prices = { [opened]: 83500 };
  ex = { high: 83600, low: 82990 };
  eq(await readPriceCall(hit, hp, opened, fake, opened + 120_000), { outcome: "yes", said: "BTC low was 82,990 on Binance." }, "from above, hitting 83k is a move down");
}

/* -------------------------------------------------------------- engine -- */

let now = opened;
const said: string[] = [];
const logged: string[] = [];
const deps: LiveDeps = {
  store: liveStore, now: () => now,
  say: async (_p, _c, text) => { said.push(text); },
  standingsUrl: async () => "https://app.oddie.fun/live/twitch/bee_empire",
  log: (line) => { logged.push(line); },
  prices: fake,
};
const msg = (text: string, senderId: string, canRun = false): ChatMessage => ({
  platform: "twitch", channelId: "1372956063", messageId: `m${Math.random()}`, senderId, senderName: senderId, canRun, text,
});
const last = () => said[said.length - 1];
const reset = () => { _resetLive(); _resetLiveStore(); said.length = 0; logged.length = 0; reads = 0; candle = real; prices = {}; ex = null; now = opened; };
const lockAt = opened + 3 * 60_000 + 1_000;

// The pilot's call, start to finish, with nobody settling it by hand.
reset();
eq(await handleChat(msg("!call will BTC close current 30min candle above 82k?", "bee", true), deps), "opened", "opens");
ok(/calls lock in 3 min, earlier calls score more/.test(said[0] ?? ""), `a candle call takes answers for three minutes: ${said[0]}`);
eq(await handleChat(msg("!yes", "bee", true), deps), "picked", "bee picks");
eq(await handleChat(msg("!no", "viewer"), deps), "picked", "a viewer picks");
now = lockAt;
eq(await lockDue(deps), 1, "locks at three minutes");
ok(/oddie settles it when the 30m candle closes\.$/.test(last()), `lock line names the candle: ${last()}`);
eq(await handleChat(msg("!call next one", "bee", true), deps), "opened", "a new call opens while the candle call waits for its candle");
now = Date.parse("2026-10-08T13:59:59Z");
await lockDue(deps);
eq(reads, 0, "nothing read before the close");
now = Date.parse("2026-10-08T14:00:04Z");
await lockDue(deps);
eq(reads, 1, "read once after the close");
eq(last(), `BTC 30m candle closed at 82,182.01 on Binance. It's YES: "will BTC close current 30min candle above 82k?". 1 of 2 called it right, up to +50, earlier calls scored more. Standings: https://app.oddie.fun/live/twitch/bee_empire`, "the result line");
ok((await liveStore.unsettled("twitch", "1372956063")).every((c) => !c.question.includes("30min candle")), "settled: only the new call is left");
ok(logged.includes("live call settled"), "logged as settled");
await lockDue(deps);
eq(reads, 1, "settled once, never read again");

// A touch: looked for from the lock, settled the moment it happens.
reset();
await handleChat(msg("!call will BTC hit 83k in the next 15 min?", "bee", true), deps);
await handleChat(msg("!yes", "viewer"), deps);
prices = { [Date.parse("2026-10-08T13:43:11.830Z")]: 82500 };
ex = { high: 82900, low: 82400 };
now = lockAt;
await lockDue(deps);
ok(last().endsWith("oddie settles it the moment BTC touches 83,000, or at 13:58 UTC."), `touch lock line: ${last()}`);
const before = reads;
ok(before > 0, "looked at the lock");
now += 5_000;
await lockDue(deps);
eq(reads, before, "waits between looks");
ex = { high: 83010, low: 82400 };
now += 15_000;
await lockDue(deps);
eq(last(), `BTC high was 83,010 on Binance. It's YES: "will BTC hit 83k in the next 15 min?". 1 of 1 called it right, up to +1, earlier calls scored more. Standings: https://app.oddie.fun/live/twitch/bee_empire`, "touched: settled at once");

// The source is down: retries, then hands the call back to the mods.
reset();
candle = null;
await handleChat(msg("!call will BTC close current 30min candle above 82k?", "bee", true), deps);
await handleChat(msg("!yes", "viewer"), deps);
now = lockAt;
await lockDue(deps);
now = Date.parse("2026-10-08T14:00:04Z");
await lockDue(deps);
eq(reads, 1, "first try");
now += 5_000;
await lockDue(deps);
eq(reads, 1, "waits before trying again");
now += 15_000;
await lockDue(deps);
eq(reads, 2, "tries again");
now = Date.parse("2026-10-08T14:00:00Z") + PRICE_GIVE_UP_MS + 1_000;
await lockDue(deps);
eq(last(), `"will BTC close current 30min candle above 82k?" is yours to settle: !call yes or !call no.`, "handed to the mods");
ok((await liveStore.unsettled("twitch", "1372956063")).length === 1, "still waiting, for the mods");
eq(await handleChat(msg("!call yes", "bee", true), deps), "settled", "a mod settles it");

// A mod who settles first wins; oddie stays quiet after.
reset();
await handleChat(msg("!call will BTC close current 30min candle above 82k?", "bee", true), deps);
await handleChat(msg("!yes", "viewer"), deps);
now = lockAt;
await lockDue(deps);
eq(await handleChat(msg("!call no", "bee", true), deps), "settled", "the mod settles before the close");
const lines = said.length;
now = Date.parse("2026-10-08T14:00:04Z");
await lockDue(deps);
eq(reads, 0, "no read for a settled call");
eq(said.length, lines, "and no second result");

// Any other call: the lock line says who settles it.
reset();
await handleChat(msg("!call 3m clutch this round?", "bee", true), deps);
await handleChat(msg("!yes", "viewer"), deps);
now = lockAt;
await lockDue(deps);
eq(last(), "Calls are locked: 100% YES from 1 call. Mods settle it with !call yes or !call no.", "a mod's call");

// Nobody answered a candle call: oddie still settles it, so the channel is free.
reset();
await handleChat(msg("!call will BTC close current 30min candle above 82k?", "bee", true), deps);
now = lockAt;
await lockDue(deps);
eq(last(), "Calls are locked for this one. oddie settles it when the 30m candle closes.", "empty candle lock line");
now = Date.parse("2026-10-08T14:00:04Z");
await lockDue(deps);
ok(last().startsWith(`BTC 30m candle closed at 82,182.01 on Binance. It's YES: "will BTC close current 30min candle above 82k?". The next one opens with !call.`), `empty result line: ${last()}`);
eq(await handleChat(msg("!call next round?", "bee", true), deps), "opened", "the next one opens");

// Live on 8 Oct: the same candle question twice in ninety seconds opened its
// twin, and one candle would have been settled twice.
reset();
eq(await handleChat(msg("!call will BTC close the next 30m candle green?", "bee", true), deps), "opened", "a candle call opens");
now = opened + 90_000;
eq(await handleChat(msg("!call will BTC close the next 30m candle green?", "bee", true), deps), "again", "the same question again is said again");
ok(last().startsWith('Still open: "will BTC close the next 30m candle green?"'), `...as the reminder line: ${last()}`);
eq((await liveStore.unsettled("twitch", "1372956063")).length, 1, "...one call, still taking answers");
// The same words once the candle has turned are the next round.
reset();
now = Date.parse("2026-10-08T13:59:00Z");
await handleChat(msg("!call will BTC close the next 30m candle green?", "bee", true), deps);
now = Date.parse("2026-10-08T14:00:30Z");
eq(await handleChat(msg("!call will BTC close the next 30m candle green?", "bee", true), deps), "opened", "after the candle turned, the same words open the next round");
eq((await liveStore.unsettled("twitch", "1372956063")).length, 2, "...and each round waits for its own candle");

console.log(`test-price-call: ${checks} checks passed`);
