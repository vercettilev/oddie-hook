/**
 * Candle calls: which questions oddie settles itself, which candle it reads,
 * and what the room hears from lock to result. In memory, no network.
 */
import assert from "node:assert/strict";
import { candleWindow, outcomeFor, parsePriceCall, type CandleSource } from "../src/live/priceCall.js";
import { CANDLE_GIVE_UP_MS, handleChat, lockDue, _resetLive, type ChatMessage, type LiveDeps } from "../src/live/calls.js";
import { liveStore, _resetLiveStore } from "../src/store/live.js";

let checks = 0;
const ok = (cond: unknown, what: string) => { assert.ok(cond, what); checks++; };
const eq = <T>(a: T, b: T, what: string) => { assert.deepEqual(a, b, what); checks++; };

/* --------------------------------------------------------------- parse -- */

eq(parsePriceCall("will BTC close current 30min candle above 82k?"),
  { asset: "BTC", size: "30m", which: "current", test: { kind: "above", level: 82000 } }, "the first pilot's question");
eq(parsePriceCall("will btc close the next 5m candle green"),
  { asset: "BTC", size: "5m", which: "next", test: { kind: "green" } }, "next candle, green");
eq(parsePriceCall("$SOL 1h candle closes below 150.5?"),
  { asset: "SOL", size: "1h", which: "current", test: { kind: "below", level: 150.5 } }, "$ticker, decimal level");
eq(parsePriceCall("will ethereum close the daily candle over $4,100")?.test, { kind: "above", level: 4100 }, "comma level, over");
eq(parsePriceCall("will ethereum close the daily candle over $4,100")?.size, "1d", "daily");
eq(parsePriceCall("TON 15 min candle close red?")?.asset, "TON", "a shouted word-ticker");
eq(parsePriceCall("will PEPE 15m candle close above 0.00001")?.test, { kind: "above", level: 0.00001 }, "a tiny level");
eq(parsePriceCall("will bitcoin close this half hour candle above 1.2m")?.size, "30m", "1.2m is a level, not a candle size");

for (const q of [
  "will BTC go above 82k this 30m candle",          // a wick, not a close
  "will BTC not close the 30m candle above 82k",    // turned around
  "BTC won't close the 5m candle green",
  "will BTC close above 82k",                       // no candle
  "will BTC 7m candle close green",                 // no such candle
  "will BTC or ETH close the 5m candle green",      // two coins
  "will BTC close the 5m candle above 82k? red alert", // two tests
  "will the 5m candle close above a ton",           // no coin
  "will I clutch this round",
]) eq(parsePriceCall(q), null, `left to the channel: ${q}`);

/* -------------------------------------------------------------- window -- */

const opened = Date.parse("2026-10-08T13:43:11.830Z");
const bee = parsePriceCall("will BTC close current 30min candle above 82k?")!;
eq(candleWindow(bee, opened), { openAt: Date.parse("2026-10-08T13:30:00Z"), closeAt: Date.parse("2026-10-08T14:00:00Z") }, "current 30m candle");
eq(candleWindow({ ...bee, which: "next" }, opened).openAt, Date.parse("2026-10-08T14:00:00Z"), "next 30m candle");
eq(candleWindow({ ...bee, size: "1d" }, opened).openAt, Date.parse("2026-10-08T00:00:00Z"), "daily starts at UTC midnight");

const real = { open: 82362.01, close: 82182.01 }; // BTCUSDT 13:30 UTC, 8 Oct
eq(outcomeFor({ kind: "above", level: 82000 }, real), "yes", "closed above");
eq(outcomeFor({ kind: "above", level: 82182.01 }, real), "no", "exactly at the level is not above");
eq(outcomeFor({ kind: "below", level: 82000 }, real), "no", "not below");
eq(outcomeFor({ kind: "green" }, real), "no", "red candle is not green");
eq(outcomeFor({ kind: "red" }, real), "yes", "red candle");

/* -------------------------------------------------------------- engine -- */

let now = opened;
const said: string[] = [];
const logged: string[] = [];
let reads = 0;
let candle: { open: number; close: number } | null = real;
const fake: CandleSource = { venue: "Binance", async candle(asset, size, openAt) {
  reads++;
  assert.equal(asset, "BTC"); assert.equal(size, "30m"); assert.equal(openAt, Date.parse("2026-10-08T13:30:00Z"));
  return candle;
} };
const deps: LiveDeps = {
  store: liveStore, now: () => now,
  say: async (_p, _c, text) => { said.push(text); },
  standingsUrl: async () => "https://app.oddie.fun/live/twitch/bee_empire",
  log: (line) => { logged.push(line); },
  candles: fake,
};
const msg = (text: string, senderId: string, canRun = false): ChatMessage => ({
  platform: "twitch", channelId: "1372956063", messageId: `m${Math.random()}`, senderId, senderName: senderId, canRun, text,
});
const last = () => said[said.length - 1];
const reset = () => { _resetLive(); _resetLiveStore(); said.length = 0; logged.length = 0; reads = 0; candle = real; now = opened; };

// The pilot's call, start to finish, with nobody settling it by hand.
reset();
eq(await handleChat(msg("!call will BTC close current 30min candle above 82k?", "bee", true), deps), "opened", "opens");
eq(await handleChat(msg("!yes", "bee", true), deps), "picked", "bee picks");
eq(await handleChat(msg("!no", "viewer"), deps), "picked", "a viewer picks");
now = opened + 3 * 60_000 + 1_000;
eq(await lockDue(deps), 1, "locks at three minutes");
ok(/oddie settles it when the 30m candle closes\.$/.test(last()), `lock line names the candle: ${last()}`);
eq(await handleChat(msg("!call next one", "bee", true), deps), "busy", "one call at a time");
ok(last().includes("settles when the 30m candle closes, then the next one opens"), `busy says the candle settles it: ${last()}`);
now = Date.parse("2026-10-08T13:59:59Z");
await lockDue(deps);
eq(reads, 0, "nothing read before the close");
now = Date.parse("2026-10-08T14:00:04Z");
await lockDue(deps);
eq(reads, 1, "read once after the close");
eq(last(), "BTC 30m candle closed at 82,182.01 on Binance. It's YES. 1 of 2 called it right, +50 each. Standings: https://app.oddie.fun/live/twitch/bee_empire", "the result line");
eq(await liveStore.current("twitch", "1372956063"), null, "settled: the channel is free");
ok(logged.includes("live call settled"), "logged as settled");
await lockDue(deps);
eq(reads, 1, "settled once, never read again");

// The source is down: retries, then hands the call back to the mods.
reset();
candle = null;
await handleChat(msg("!call will BTC close current 30min candle above 82k?", "bee", true), deps);
await handleChat(msg("!yes", "viewer"), deps);
now = opened + 3 * 60_000 + 1_000;
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
now = Date.parse("2026-10-08T14:00:00Z") + CANDLE_GIVE_UP_MS + 1_000;
await lockDue(deps);
eq(last(), `"will BTC close current 30min candle above 82k?" is yours to settle: !call yes or !call no.`, "handed to the mods");
ok((await liveStore.current("twitch", "1372956063")) !== null, "still open for the mods");
eq(await handleChat(msg("!call yes", "bee", true), deps), "settled", "a mod settles it");

// A mod who settles first wins; oddie stays quiet after.
reset();
await handleChat(msg("!call will BTC close current 30min candle above 82k?", "bee", true), deps);
await handleChat(msg("!yes", "viewer"), deps);
now = opened + 3 * 60_000 + 1_000;
await lockDue(deps);
eq(await handleChat(msg("!call no", "bee", true), deps), "settled", "the mod settles before the close");
const lines = said.length;
now = Date.parse("2026-10-08T14:00:04Z");
await lockDue(deps);
eq(reads, 0, "no read for a settled call");
eq(said.length, lines, "and no second result");

// Any other call: the lock line says who settles it.
reset();
await handleChat(msg("!call clutch this round?", "bee", true), deps);
await handleChat(msg("!yes", "viewer"), deps);
now = opened + 3 * 60_000 + 1_000;
await lockDue(deps);
eq(last(), "Calls are locked: 100% YES from 1 call. Mods settle it with !call yes or !call no.", "a mod's call");

// Nobody answered a candle call: oddie still settles it, so the channel is free.
reset();
await handleChat(msg("!call will BTC close current 30min candle above 82k?", "bee", true), deps);
now = opened + 3 * 60_000 + 1_000;
await lockDue(deps);
eq(last(), "Calls are locked for this one. oddie settles it when the 30m candle closes.", "empty candle lock line");
now = Date.parse("2026-10-08T14:00:04Z");
await lockDue(deps);
ok(last().startsWith("BTC 30m candle closed at 82,182.01 on Binance. It's YES. The next one opens with !call."), `empty result line: ${last()}`);
eq(await handleChat(msg("!call next round?", "bee", true), deps), "opened", "the next one opens");

console.log(`test-price-call: ${checks} checks passed`);
