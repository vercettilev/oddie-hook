/**
 * A live call oddie can settle by itself: a coin's price.
 *
 * WHY. The first outside streamer opened "will BTC close current 30min candle
 * above 82k?", watched the candle close, and asked where oddie's result was.
 * A call is the channel's to settle because most are moments no source can
 * see ("clutch this round?"). A price is not one of those: it is a public
 * number the second it happens, so the room should not wait on a mod.
 *
 * FIVE SHAPES, each read the way a trader means it:
 *   candle  "will BTC close the 30m candle above 82k?"  the candle's close
 *           "will the next 5m BTC candle close green?"  close against open
 *   at      "will SOL be under 150 in 10 minutes?"      the price at that second
 *           "ETH above 4k at 18:00 UTC?"
 *   touch   "will BTC hit 83k in the next 15 min?"      the high or low on the way,
 *           "will BTC dip to 81k this hour?"            settled the moment it touches
 *   hold    "will BTC hold the low of 76270 today?"     NO the moment it trades past,
 *           "will SOL stay above 150 this hour?"        YES when the window ends
 *   ath     "HYPE ath today?"                           a trade above the highest one
 *                                                       before the call opened
 *
 * TODAY IS THE UTC DAY (Lev, 18 Nov). Bee Empire's "hold the low of 76270 by
 * the end of today" and "come back down to 84k at any point end of today UTC"
 * went to the room as moments, and the stream ending canceled them with no
 * result. A trading stream's day is the exchange's daily candle, so "today",
 * "end of day" and "eod" run to 00:00 UTC (or to midnight in a zone the
 * question names), and the line says "at 00:00 UTC" so nobody guesses.
 *
 * NARROW ON PURPOSE. Only a question that names one coin, one level or colour
 * and one time is read. Anything else (two coins, "not", "stay above" with no
 * window, a clock time with no time zone) stays the channel's, exactly as
 * before. A wrong result in a live chat costs more than a mod typing !call yes.
 *
 * ONE SOURCE, NAMED IN THE LINE. Binance's public market data (no key), the
 * venue most chart-watchers have open. The result line says which venue and
 * which number, so a viewer on another chart sees why.
 */

export type CandleSize = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "6h" | "8h" | "12h" | "1d";

export type LevelTest = { kind: "above" | "below"; level: number };
export type CandleTest = LevelTest | { kind: "green" | "red" };

/** When a price is read or a touch stops counting. */
export type When =
  | { kind: "candle"; size: CandleSize; which: "current" | "next" }
  | { kind: "in"; minutes: number }
  | { kind: "clock"; hour: number; minute: number; tz: string; label: string };

export type PriceCall =
  | { kind: "candle"; asset: string; size: CandleSize; which: "current" | "next"; test: CandleTest }
  | { kind: "at"; asset: string; when: Extract<When, { kind: "in" | "clock" }>; test: LevelTest }
  /** "either" is hit/touch/reach: up or down depends on where the price was when the call opened. */
  | { kind: "touch"; asset: string; level: number; dir: "up" | "down" | "either"; until: When }
  /** "above": a trade below the level by `until` is a NO, none is a YES. */
  | { kind: "hold"; asset: string; level: number; dir: "above" | "below"; until: When }
  /** A trade above the highest trade before the call opened. */
  | { kind: "ath"; asset: string; until: When };

const MINUTES: Record<CandleSize, number> = {
  "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30,
  "1h": 60, "2h": 120, "4h": 240, "6h": 360, "8h": 480, "12h": 720, "1d": 1440,
};
const BY_MINUTES = new Map(Object.entries(MINUTES).map(([k, v]) => [v, k as CandleSize]));

/** Names a chat uses for a coin. Lower case keys; all have a USDT pair on Binance. */
const COINS: Record<string, string> = {
  btc: "BTC", bitcoin: "BTC", xbt: "BTC",
  eth: "ETH", ethereum: "ETH", ether: "ETH",
  sol: "SOL", solana: "SOL",
  bnb: "BNB", xrp: "XRP", doge: "DOGE", dogecoin: "DOGE", ada: "ADA", cardano: "ADA",
  avax: "AVAX", sui: "SUI", ltc: "LTC", litecoin: "LTC", trx: "TRX", tron: "TRX",
  pepe: "PEPE", wif: "WIF", bonk: "BONK", shib: "SHIB", chainlink: "LINK", polkadot: "DOT",
  hyperliquid: "HYPE",
};
/** Tickers that are also English words: read only as $LINK or LINK. TON was one
 *  until every TON pair on Binance stopped trading (30 June 2026, all BREAK on
 *  20 Oct): oddie told the room it would settle a TON call, read nothing for ten
 *  minutes past its moment, then handed it to the mods. A TON call is the
 *  channel's from the start now, like any call no price can answer. */
const SHOUTED_ONLY: Record<string, string> = { link: "LINK", dot: "DOT", hype: "HYPE" };

/** Read for a stream vote, not yet for a market (18 Nov): a HYPE market keeps
 *  the rail it opened on, and money markets change rails on their own day. */
const CALLS_ONLY: ReadonlySet<string> = new Set(["HYPE"]);

/** Every ticker above, each with a USDT pair on Binance: the coins whose price a
 *  market can read at its open when no token is pinned on chain (server.ts). */
export const BINANCE_ASSETS: ReadonlySet<string> = new Set([...Object.values(COINS), ...Object.values(SHOUTED_ONLY)].filter((a) => !CALLS_ONLY.has(a)));

/** Time zones a chat writes, to the zone that keeps its daylight saving right. */
const ZONES: Record<string, string> = {
  utc: "UTC", gmt: "UTC",
  et: "America/New_York", est: "America/New_York", edt: "America/New_York",
  ct: "America/Chicago", cst: "America/Chicago", cdt: "America/Chicago",
  pt: "America/Los_Angeles", pst: "America/Los_Angeles", pdt: "America/Los_Angeles",
  cet: "Europe/Paris", cest: "Europe/Paris", bst: "Europe/London", trt: "Europe/Istanbul",
};

export const candleMs = (size: CandleSize): number => MINUTES[size] * 60_000;

/** How a candle size reads in chat: "30m", "1h", "daily". */
export const sizeLabel = (size: CandleSize): string => (size === "1d" ? "daily" : size);

/* --------------------------------------------------------------- parse -- */

// A level: "82k", "$82,500.5", "0.00001". Never a percentage.
const NUM = String.raw`\$?(\d[\d,]*(?:\.\d+)?)\s*(k|m)?\b(?!\s*%)`;

function sizeFrom(text: string): CandleSize | null {
  if (/\b(daily|1d|1 ?day|one day)\b/.test(text)) return "1d";
  if (/\b(hourly|an hour|one hour)\b/.test(text)) return "1h";
  if (/\bhalf[- ]?hour(ly)?\b/.test(text)) return "30m";
  const sizes = new Set<CandleSize>();
  for (const m of text.matchAll(/(?<![\d.,])\b(\d{1,2})\s*-?\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/g)) {
    const minutes = Number(m[1]) * (m[2].startsWith("h") ? 60 : 1);
    const size = BY_MINUTES.get(minutes);
    if (!size) return null;
    sizes.add(size);
  }
  return sizes.size === 1 ? [...sizes][0] : null;
}

function assetFrom(raw: string): string | null {
  const found = new Set<string>();
  for (const m of raw.matchAll(/(\$?)\b([A-Za-z]{2,9})\b/g)) {
    const word = m[2].toLowerCase();
    const shouted = m[1] === "$" || m[2] === m[2].toUpperCase();
    const coin = COINS[word] ?? (shouted ? SHOUTED_ONLY[word] : undefined);
    if (coin) found.add(coin);
  }
  return found.size === 1 ? [...found][0] : null;
}

/** "82k" -> 82000, "$82,500.5" -> 82500.5, "1.2m" -> 1200000. */
function levelFrom(num: string, unit: string | undefined): number | null {
  const n = Number(num.replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const k = unit === "k" ? 1e3 : unit === "m" ? 1e6 : 1;
  return n * k;
}

/** Exactly one "above 82k" / "under 150" in the question. */
function levelTestFrom(text: string): LevelTest | null | "many" {
  const levels = [...text.matchAll(new RegExp(String.raw`\b(above|over|below|under)\s+${NUM}`, "g"))];
  if (levels.length > 1) return "many";
  if (!levels.length) return null;
  const [, word, num, unit] = levels[0];
  const level = levelFrom(num, unit);
  if (level === null) return null;
  return { kind: word === "above" || word === "over" ? "above" : "below", level };
}

const UP_VERBS = String.raw`(?:go|goes|get|gets|rise|rises|pump|pumps|run|runs|move|moves|break|breaks|push|pushes)\s+(?:above|over|past|to)`;
const DOWN_VERBS = String.raw`lose|loses|(?:dip|dips|drop|drops|fall|falls|dump|dumps|go|goes|get|gets|sink|sinks|slip|slips|break|breaks)\s+(?:below|under|to)|(?:come|comes)\s+(?:back\s+)?down\s+(?:to|below|under)`;
// "Break 80k" is down from 81k and up from 79k: these take their way from the price at the open.
const EITHER_VERBS = String.raw`hit|hits|touch|touches|tag|tags|reach|reaches|see|sees|retest|retests|break|breaks|cross|crosses`;

/** A move to a level on the way, as opposed to where the price ends up. */
function touchFrom(text: string): { level: number; dir: "up" | "down" | "either" } | null | "many" {
  const found: Array<{ level: number; dir: "up" | "down" | "either" }> = [];
  for (const [verbs, dir] of [[UP_VERBS, "up"], [DOWN_VERBS, "down"], [EITHER_VERBS, "either"]] as const) {
    for (const m of text.matchAll(new RegExp(String.raw`\b(?:${verbs})\s+${NUM}`, "g"))) {
      const level = levelFrom(m[1], m[2]);
      if (level !== null) found.push({ level, dir });
    }
  }
  if (found.length > 1) return "many";
  return found[0] ?? null;
}

/** "in 10 minutes", "within the next hour", "half an hour from now". */
function minutesFrom(text: string): number | null | "many" {
  const out: number[] = [];
  const amount = String.raw`(\d{1,4}|an?|one|half an?|half)`;
  const unit = String.raw`(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)`;
  const re = new RegExp(String.raw`\b(?:in|within|over)\s+(?:the\s+)?(?:next\s+)?${amount}\s*-?\s*${unit}\b|\b${amount}\s*-?\s*${unit}\s+from now\b|\b(?:in|within|over)\s+the\s+next\s+${unit}\b`, "g");
  for (const m of text.matchAll(re)) {
    const amt = m[1] ?? m[3] ?? "1";
    const u = m[2] ?? m[4] ?? m[5];
    const hours = u.startsWith("h");
    const n = /^half/.test(amt) ? 0.5 : /^(an?|one)$/.test(amt) ? 1 : Number(amt);
    const minutes = Math.round(n * (hours ? 60 : 1));
    if (!(minutes >= 1 && minutes <= 1440)) return null;
    out.push(minutes);
  }
  if (/\bwithin the hour\b/.test(text)) out.push(60);
  if (out.length > 1) return "many";
  return out[0] ?? null;
}

/** "18:00 UTC", "6pm ET", "6:30 pm est". A time with no zone is anybody's time: none. */
function clockFrom(text: string, after: "at" | "by"): Extract<When, { kind: "clock" }> | null | "many" {
  const lead = after === "at" ? "at" : "(?:by|before)";
  const re = new RegExp(String.raw`\b${lead}\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(${Object.keys(ZONES).join("|")})\b`, "g");
  const found = [...text.matchAll(re)];
  if (found.length > 1) return "many";
  if (!found.length) return null;
  const [, h, mm, ampm, zone] = found[0];
  let hour = Number(h);
  const minute = mm === undefined ? 0 : Number(mm);
  // "at 6 ET" is six in the morning to a clock and six at night to a person.
  if (!ampm && mm === undefined) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (ampm === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  return { kind: "clock", hour, minute, tz: ZONES[zone], label: zone.toUpperCase() };
}

/** "this hour", "this 30m candle", "in the next 15 min", "by 18:00 UTC". */
function untilFrom(text: string): When | null {
  const ways: When[] = [];
  if (/\b(this|the current) hour\b|\b(by the end of|before the end of) the hour\b|\bbefore the hour (ends|is up|closes)\b|\bby the top of the hour\b/.test(text)) {
    ways.push({ kind: "candle", size: "1h", which: "current" });
  }
  if (/\bcandles?\b/.test(text)) {
    if (/\bnext\b/.test(text)) return null;
    const size = sizeFrom(text);
    if (!size) return null;
    ways.push({ kind: "candle", size, which: "current" });
  }
  const minutes = minutesFrom(text);
  if (minutes === "many") return null;
  if (minutes !== null) ways.push({ kind: "in", minutes });
  const clock = clockFrom(text, "by");
  if (clock === "many") return null;
  if (clock) ways.push(clock);
  const day = todayFrom(text);
  if (day) ways.push(day);
  return ways.length === 1 ? ways[0] : null;
}

/** "today", "by the end of today", "end of day", "eod": to the next midnight,
 *  UTC unless the question names a zone right after it ("today ET"). */
function todayFrom(text: string): Extract<When, { kind: "clock" }> | null {
  if (!/\btoday\b|\bend of (?:the )?day\b|\beod\b/.test(text)) return null;
  const named = new RegExp(String.raw`\b(?:today|day|eod)\s+(${Object.keys(ZONES).join("|")})\b`).exec(text);
  const zone = named?.[1] ?? "utc";
  return { kind: "clock", hour: 0, minute: 0, tz: ZONES[zone], label: zone.toUpperCase() };
}

const HOLD_WORDS = /\b(stay|stays|hold|holds|remain|remains|keep|keeps)\b/;
// After the level: "hold 5 minutes" is a length, "hold 82k" a level.
const NOT_A_LENGTH = String.raw`(?!\s*(?:s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|candles?)\b)`;

/** "hold the low of 76270", "hold 80k", "stay above 150", "hold below the high of 2k". */
function holdFrom(text: string): { level: number; dir: "above" | "below" } | null | "many" {
  const re = new RegExp(String.raw`\b(?:(hold|holds)|stay|stays|remain|remains|keep|keeps)\s+(?:the\s+)?(?:(low|lows|support|floor|bottom)\s+(?:of|at)\s+|(above|over)\s+|(below|under)\s+(?:the\s+(?:high|top)\s+of\s+)?|(high|highs|top|resistance)\s+(?:of|at)\s+)?${NUM}${NOT_A_LENGTH}`, "g");
  const found: Array<{ level: number; dir: "above" | "below" }> = [];
  for (const m of text.matchAll(re)) {
    const [, hold, low, above, below, high, num, unit] = m;
    // A bare level only after "hold": "keep 5" is not a price.
    if (!hold && !low && !above && !below && !high) continue;
    const level = levelFrom(num, unit);
    if (level !== null) found.push({ level, dir: below || high ? "below" : "above" });
  }
  if (found.length > 1) return "many";
  return found[0] ?? null;
}

const ATH = /\b(?:aths?|all[- ]time highs?|new highs?)\b/;

/* "Close the hour green" is a candle without the word. The pitch to the first
   YouTube host used exactly that, and it went to the room as a moment's call
   (15 Oct, live test). Only the hour: everyone's hour turns at the same moment,
   while "the day" has the same whose-today problem as a touch "today". */
function hourFrom(text: string): "current" | "next" | null {
  if (/\bnext hour\b/.test(text)) return "next";
  if (/\b(the|this|current|the current) hour\b/.test(text)) return "current";
  return null;
}

function candleCall(text: string, asset: string): PriceCall | null {
  const hour = /\bcandles?\b/.test(text) ? null : hourFrom(text);
  if (!hour && !/\bcandles?\b/.test(text)) return null;
  const size = hour ? "1h" : sizeFrom(text);
  if (!size) return null;
  const colors = [...new Set([...text.matchAll(/\b(green|red)\b/g)].map((m) => m[1]))];
  const level = levelTestFrom(text);
  if (level === "many" || colors.length + (level ? 1 : 0) !== 1) return null;
  const which = hour ?? (/\bnext\b/.test(text) ? "next" : "current");
  if (colors.length) return { kind: "candle", asset, size, which, test: { kind: colors[0] as "green" | "red" } };
  // A level is about where the candle CLOSES. "Go above 82k this candle" is a
  // move on the way, which is a touch, below.
  if (!/\bclos(e|es|ed|ing)\b/.test(text)) return null;
  return { kind: "candle", asset, size, which, test: level! };
}

function atCall(text: string, asset: string): PriceCall | null {
  if (/\bcandles?\b|\b(green|red)\b/.test(text)) return null;
  const test = levelTestFrom(text);
  if (!test || test === "many") return null;
  const minutes = minutesFrom(text);
  const clock = clockFrom(text, "at");
  if (minutes === "many" || clock === "many" || (minutes !== null) === (clock !== null)) return null;
  return { kind: "at", asset, when: clock ?? { kind: "in", minutes: minutes as number }, test };
}

function touchCall(text: string, asset: string): PriceCall | null {
  if (/\b(green|red)\b/.test(text)) return null;
  const touch = touchFrom(text);
  if (!touch || touch === "many") return null;
  const until = untilFrom(text);
  if (!until) return null;
  return { kind: "touch", asset, level: touch.level, dir: touch.dir, until };
}

/** A hold asks about every trade in a window, so it needs one, and nothing else
 *  to answer: no colour, no move, no close ("hold 80k at the close" is a candle). */
function holdCall(text: string, asset: string, hold: { level: number; dir: "above" | "below" }): PriceCall | null {
  if (/\b(green|red)\b|\bclos(e|es|ed|ing)\b/.test(text) || ATH.test(text) || touchFrom(text)) return null;
  const until = untilFrom(text);
  if (!until) return null;
  return { kind: "hold", asset, level: hold.level, dir: hold.dir, until };
}

/** "ATH today", "new high this hour": a touch whose level is the highest trade
 *  before the open. At the close ("ATH this 4h candle close?") is left alone. */
function athCall(text: string, asset: string): PriceCall | null {
  if (/\b(green|red)\b|\bclos(e|es|ed|ing)\b/.test(text) || touchFrom(text) || levelTestFrom(text)) return null;
  const until = untilFrom(text);
  if (!until) return null;
  return { kind: "ath", asset, until };
}

/** The price call in a question, or null when oddie should leave it to the channel. */
export function parsePriceCall(question: string): PriceCall | null {
  const raw = String(question ?? "");
  const text = raw.toLowerCase().replace(/\s+/g, " ");
  // "won't close above" turns the answer around: not worth guessing at.
  if (/\bnot\b|n't\b|\bnever\b/.test(text)) return null;
  // "83k or 80k", "10 or 15 minutes": two answers to one question.
  if (/\b(or|and)\s+\$?\d/.test(text)) return null;
  const asset = assetFrom(raw);
  if (!asset) return null;
  const hold = holdFrom(text);
  if (hold === "many") return null;
  if (hold) return holdCall(text, asset, hold);
  // "Stay above" with no level it can read is still every second of something.
  if (HOLD_WORDS.test(text)) return null;
  if (ATH.test(text)) return athCall(text, asset);
  if (touchFrom(text)) return touchCall(text, asset);
  return candleCall(text, asset) ?? atCall(text, asset);
}

/* ---------------------------------------------------------------- time -- */

/** Wall-clock parts of `t` in `tz`. */
function partsIn(tz: string, t: number): { y: number; mo: number; d: number; h: number; mi: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute) };
}

/** The first moment after `from` when the clock in `tz` reads hour:minute. */
export function nextClock(c: { hour: number; minute: number; tz: string }, from: number): number {
  const offset = (t: number) => {
    const p = partsIn(c.tz, t);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(t / 60_000) * 60_000;
  };
  for (let day = 0; day <= 2; day++) {
    const p = partsIn(c.tz, from + day * 86_400_000);
    const wall = Date.UTC(p.y, p.mo - 1, p.d, c.hour, c.minute);
    let t = wall - offset(wall);
    t = wall - offset(t); // once more, for the day the clocks change
    if (t > from) return t;
  }
  return from + 86_400_000;
}

/** The stretch of time a call is about: a candle, a moment (from = to), or a window. */
export interface PricePlan { from: number; to: number }

function untilMs(u: When, openedAt: number): number {
  if (u.kind === "candle") {
    const ms = candleMs(u.size);
    return Math.floor(openedAt / ms) * ms + (u.which === "next" ? 2 : 1) * ms;
  }
  if (u.kind === "in") return openedAt + u.minutes * 60_000;
  return nextClock(u, openedAt);
}

export function planFor(pc: PriceCall, openedAt: number): PricePlan {
  if (pc.kind === "candle") {
    const ms = candleMs(pc.size);
    const from = Math.floor(openedAt / ms) * ms + (pc.which === "next" ? ms : 0);
    return { from, to: from + ms };
  }
  if (pc.kind === "at") {
    const t = untilMs(pc.when, openedAt);
    return { from: t, to: t };
  }
  return { from: openedAt, to: untilMs(pc.until, openedAt) };
}

/** A moment as chat reads it: "14:13 UTC", or "18:00 ET" when the question named its zone. */
export function timeLabel(t: number, zone?: { tz: string; label: string }): string {
  const p = partsIn(zone?.tz ?? "UTC", t);
  return `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")} ${zone?.label ?? "UTC"}`;
}

/* --------------------------------------------------------------- read -- */

export interface Candle { open: number; close: number }

export function outcomeFor(test: CandleTest, c: Candle): "yes" | "no" {
  switch (test.kind) {
    case "above": return c.close > test.level ? "yes" : "no";
    case "below": return c.close < test.level ? "yes" : "no";
    case "green": return c.close > c.open ? "yes" : "no";
    case "red": return c.close < c.open ? "yes" : "no";
  }
}

export interface PriceSource {
  /** Where the number comes from, as the result line names it. */
  venue: string;
  /** The finished candle that opened at `openAt`, or null when it is not
   *  finished or not there. Every method throws when the source did not answer. */
  candle(asset: string, size: CandleSize, openAt: number): Promise<Candle | null>;
  /** The price at that second. */
  priceAt(asset: string, t: number): Promise<number | null>;
  /** The highest and lowest trade in [from, to). */
  extremes(asset: string, from: number, to: number): Promise<{ high: number; low: number } | null>;
  /** The highest trade before `t`, over the pair's whole history: an ATH call's
   *  level. A source without it hands ATH calls to the mods. */
  highBefore?(asset: string, t: number): Promise<number | null>;
}

/** A price as chat reads it: 82,182.01 or 0.00001234. */
export function priceText(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 2 : 8 });
}

/** How long after a moment its second is on the source for good. */
export const PRICE_SETTLE_LAG_MS = 3_000;

/**
 * Which way a touch looks from the price at the open, and whether the level is
 * already behind it. "Will SOL go above 100 this hour" asked with SOL at 108
 * was a YES at the first read, so whoever answered !yes scored for a result
 * everybody could already see. A touch already met at the open asks where the
 * price ends up, the reading Lev chose for markets on 12 Oct, and is read like
 * an "at" call at the end of its window.
 */
export function touchAtOpen(pc: Extract<PriceCall, { kind: "touch" }>, ref: number): { dir: "up" | "down"; met: boolean } {
  const dir = pc.dir === "either" ? (pc.level >= ref ? "up" : "down") : pc.dir;
  return { dir, met: dir === "up" ? ref >= pc.level : ref <= pc.level };
}

/** A hold whose level the price was already past at the open: read, like a met
 *  touch, where the price is when its window ends. */
export function holdAtOpen(pc: Extract<PriceCall, { kind: "hold" }>, ref: number): { broken: boolean } {
  return { broken: pc.dir === "above" ? ref < pc.level : ref > pc.level };
}

/** Read through the window, not once at its end: touch, hold and ATH. */
export const readsOnTheWay = (pc: PriceCall): boolean => pc.kind === "touch" || pc.kind === "hold" || pc.kind === "ath";

/** The highest trade before `t`, once per call: the ATH a call is measured
 *  against does not move while it runs, and a minute's poll should not page
 *  the whole history again. */
const athMemo = new Map<string, Promise<number | null>>();
function athBefore(source: PriceSource, asset: string, t: number): Promise<number | null> {
  if (!source.highBefore) return Promise.resolve(null);
  const key = `${source.venue}:${asset}:${t}`;
  let p = athMemo.get(key);
  if (!p) {
    p = source.highBefore(asset, t);
    p.catch(() => athMemo.delete(key));
    if (athMemo.size > 200) athMemo.clear();
    athMemo.set(key, p);
  }
  return p;
}

export type PriceRead = { outcome: "yes" | "no"; said: string };

/**
 * The result of a price call at `now`: an outcome with the line that shows it,
 * "wait" when the answer is not in yet, or null when the source has no number.
 * A touch is answered the moment it happens; everything else when its time is up.
 */
export async function readPriceCall(pc: PriceCall, plan: PricePlan, openedAt: number, source: PriceSource, now: number): Promise<PriceRead | "wait" | null> {
  const ready = now >= plan.to + PRICE_SETTLE_LAG_MS;
  if (pc.kind === "candle") {
    if (!ready) return "wait";
    const c = await source.candle(pc.asset, pc.size, plan.from);
    if (!c) return null;
    const label = sizeLabel(pc.size);
    const said = pc.test.kind === "green" || pc.test.kind === "red"
      ? `${pc.asset} ${label} candle opened ${priceText(c.open)}, closed ${priceText(c.close)} on ${source.venue}.`
      : `${pc.asset} ${label} candle closed at ${priceText(c.close)} on ${source.venue}.`;
    return { outcome: outcomeFor(pc.test, c), said };
  }
  if (pc.kind === "at") {
    if (!ready) return "wait";
    const p = await source.priceAt(pc.asset, plan.to);
    if (p === null) return null;
    const zone = pc.when.kind === "clock" ? pc.when : undefined;
    return { outcome: outcomeFor(pc.test, { open: p, close: p }), said: `${pc.asset} was ${priceText(p)} at ${timeLabel(plan.to, zone)} on ${source.venue}.` };
  }
  const end = Math.min(plan.to, now - PRICE_SETTLE_LAG_MS);
  if (end <= plan.from) return "wait";
  if (pc.kind === "hold") {
    const ref = await source.priceAt(pc.asset, openedAt);
    if (ref !== null && holdAtOpen(pc, ref).broken) {
      if (!ready) return "wait";
      const p = await source.priceAt(pc.asset, plan.to);
      if (p === null) return null;
      const zone = pc.until.kind === "clock" ? pc.until : undefined;
      const yes = pc.dir === "above" ? p >= pc.level : p <= pc.level;
      return { outcome: yes ? "yes" : "no", said: `${pc.asset} was ${priceText(p)} at ${timeLabel(plan.to, zone)} on ${source.venue}.` };
    }
    const ex = await source.extremes(pc.asset, plan.from, end);
    if (!ex) return null;
    const broke = pc.dir === "above" ? ex.low < pc.level : ex.high > pc.level;
    const mark = pc.dir === "above" ? `${pc.asset} low was ${priceText(ex.low)}` : `${pc.asset} high was ${priceText(ex.high)}`;
    if (broke) return { outcome: "no", said: `${mark} on ${source.venue}.` };
    if (!ready) return "wait";
    return { outcome: "yes", said: `${mark} on ${source.venue}.` };
  }
  if (pc.kind === "ath") {
    const ath = await athBefore(source, pc.asset, openedAt);
    if (ath === null) return null;
    const ex = await source.extremes(pc.asset, plan.from, end);
    if (!ex) return null;
    const said = `${pc.asset} high was ${priceText(ex.high)} on ${source.venue}, all-time high before the call ${priceText(ath)}.`;
    if (ex.high > ath) return { outcome: "yes", said };
    if (!ready) return "wait";
    return { outcome: "no", said };
  }
  // The price at the open: which way an "either" looks, and whether any touch
  // was already met. An up or down touch with no price at the open is looked
  // for as before; an "either" cannot be.
  const ref = await source.priceAt(pc.asset, openedAt);
  if (ref === null && pc.dir === "either") return null;
  const open = ref === null ? null : touchAtOpen(pc, ref);
  const dir = open?.dir ?? (pc.dir === "either" ? "up" : pc.dir);
  if (open?.met) {
    if (!ready) return "wait";
    const p = await source.priceAt(pc.asset, plan.to);
    if (p === null) return null;
    const zone = pc.until.kind === "clock" ? pc.until : undefined;
    const yes = dir === "up" ? p >= pc.level : p <= pc.level;
    return { outcome: yes ? "yes" : "no", said: `${pc.asset} was ${priceText(p)} at ${timeLabel(plan.to, zone)} on ${source.venue}.` };
  }
  const ex = await source.extremes(pc.asset, plan.from, end);
  if (!ex) return null;
  const touched = dir === "up" ? ex.high >= pc.level : ex.low <= pc.level;
  const mark = dir === "up" ? `${pc.asset} high was ${priceText(ex.high)}` : `${pc.asset} low was ${priceText(ex.low)}`;
  if (touched) return { outcome: "yes", said: `${mark} on ${source.venue}.` };
  if (!ready) return "wait";
  return { outcome: "no", said: `${mark} on ${source.venue}.` };
}

/** What the room hears about when a price call settles. `atEnd`: a touch the
 *  price was already past at the open, read where its window ends. */
/**
 * WHEN IT SETTLES, SAID AS IT OPENS (Bee Empire, 26 Nov: a call on "the next
 * 15m candle" opened at :51 settled at the quarter after next, and the close
 * in between, with nothing said, read as oddie forgetting it). A candle under
 * a day names its own minutes; anything else says when, as the lock does.
 */
export function settlesText(pc: PriceCall, plan: PricePlan): string {
  if (pc.kind === "candle") {
    if (plan.to - plan.from >= 24 * 60 * 60_000) return `Settles at ${timeLabel(plan.to)}, when the ${sizeLabel(pc.size)} candle closes.`;
    return `Settles at ${timeLabel(plan.to)}, on the ${timeLabel(plan.from).replace(/ UTC$/, "")}-${timeLabel(plan.to).replace(/ UTC$/, "")} candle.`;
  }
  return `Settles ${whenText(pc, plan)}.`;
}

export function whenText(pc: PriceCall, plan: PricePlan, atEnd = false): string {
  if (pc.kind === "candle") return `when the ${sizeLabel(pc.size)} candle closes`;
  if (pc.kind === "at") return `at ${timeLabel(plan.to, pc.when.kind === "clock" ? pc.when : undefined)}`;
  const until = pc.until.kind === "candle" ? `when the ${sizeLabel(pc.until.size)} candle closes`
    : `at ${timeLabel(plan.to, pc.until.kind === "clock" ? pc.until : undefined)}`;
  if (atEnd) return until;
  if (pc.kind === "hold") return `the moment ${pc.asset} trades ${pc.dir === "above" ? "below" : "above"} ${priceText(pc.level)}, or ${until}`;
  if (pc.kind === "ath") return `the moment ${pc.asset} trades above its all-time high, or ${until}`;
  return `the moment ${pc.asset} touches ${priceText(pc.level)}, or ${until}`;
}

/* -------------------------------------------------------------- source -- */

const BINANCE = "https://data-api.binance.vision/api/v3/klines";
type Kline = [number, string, string, string, string, string, number];

/** Every kline that opens in [start, end), a thousand at a time. */
async function klines(asset: string, interval: string, start: number, end: number): Promise<Kline[]> {
  const out: Kline[] = [];
  let from = start;
  while (from < end) {
    const url = `${BINANCE}?symbol=${encodeURIComponent(asset)}USDT&interval=${interval}&startTime=${from}&endTime=${end - 1}&limit=1000`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`binance klines ${res.status}`);
    const rows = (await res.json()) as Kline[];
    out.push(...rows);
    if (rows.length < 1000) break;
    from = rows[rows.length - 1][0] + 1;
  }
  return out;
}

export const binancePrices: PriceSource = {
  venue: "Binance",
  async candle(asset, size, openAt) {
    const [k] = await klines(asset, size, openAt, openAt + 1);
    // Only the exact, finished candle counts, never the live one.
    if (!k || k[0] !== openAt || k[6] >= Date.now()) return null;
    const open = Number(k[1]);
    const close = Number(k[4]);
    return Number.isFinite(open) && Number.isFinite(close) ? { open, close } : null;
  },
  async priceAt(asset, t) {
    const second = Math.floor(t / 1000) * 1000;
    const rows = (await klines(asset, "1s", second - 60_000, second + 1000)).filter((k) => k[0] <= second);
    const k = rows[rows.length - 1];
    if (!k) return null;
    // That second's first trade; a quiet second has none, so the last one before it.
    const p = Number(k[0] === second ? k[1] : k[4]);
    return Number.isFinite(p) ? p : null;
  },
  async extremes(asset, from, to) {
    // Whole minutes as minutes, the edges by the second: a touch a few seconds
    // before the call opened is not a touch the room called.
    const fm = Math.ceil(from / 60_000) * 60_000;
    const tm = Math.floor(to / 60_000) * 60_000;
    const rows = fm < tm
      ? [...await klines(asset, "1s", from, fm), ...await klines(asset, "1m", fm, tm), ...await klines(asset, "1s", tm, to)]
      : await klines(asset, "1s", from, to);
    if (!rows.length) return null;
    let high = -Infinity;
    let low = Infinity;
    for (const k of rows) { high = Math.max(high, Number(k[2])); low = Math.min(low, Number(k[3])); }
    return Number.isFinite(high) && Number.isFinite(low) ? { high, low } : null;
  },
  async highBefore(asset, t) {
    // Months before this one, days before today, minutes before this one, then seconds.
    const d = new Date(t);
    const month = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const minute = Math.floor(t / 60_000) * 60_000;
    const rows = [
      ...await klines(asset, "1M", 0, month), ...await klines(asset, "1d", month, day),
      ...await klines(asset, "1m", day, minute), ...await klines(asset, "1s", minute, t),
    ];
    if (!rows.length) return null;
    const high = Math.max(...rows.map((k) => Number(k[2])));
    return Number.isFinite(high) ? high : null;
  },
};

/** One read when the live clock starts, so the log says whether price calls
 *  can be settled from where the server runs. */
export async function probePriceSource(log: (line: string, extra?: Record<string, unknown>) => void, source: PriceSource = binancePrices): Promise<boolean> {
  const minute = Math.floor(Date.now() / 60_000) * 60_000 - 2 * 60_000;
  try {
    const c = await source.candle("BTC", "1m", minute);
    log("live price source", { venue: source.venue, ok: !!c, btc: c?.close ?? null });
    return !!c;
  } catch (e) {
    log("live price source", { venue: source.venue, ok: false, err: (e as Error).message.slice(0, 200) });
    return false;
  }
}
