/**
 * A live call oddie can settle by itself: a coin's price.
 *
 * WHY. The first outside streamer opened "will BTC close current 30min candle
 * above 82k?", watched the candle close, and asked where oddie's result was.
 * A call is the channel's to settle because most are moments no source can
 * see ("clutch this round?"). A price is not one of those: it is a public
 * number the second it happens, so the room should not wait on a mod.
 *
 * THREE SHAPES, each read the way a trader means it:
 *   candle  "will BTC close the 30m candle above 82k?"  the candle's close
 *           "will the next 5m BTC candle close green?"  close against open
 *   at      "will SOL be under 150 in 10 minutes?"      the price at that second
 *           "ETH above 4k at 18:00 UTC?"
 *   touch   "will BTC hit 83k in the next 15 min?"      the high or low on the way,
 *           "will BTC dip to 81k this hour?"            settled the moment it touches
 *
 * NARROW ON PURPOSE. Only a question that names one coin, one level or colour
 * and one time is read. Anything else (two coins, "not", "stay above", a clock
 * time with no time zone, "today" whose day depends on where you sit) stays
 * the channel's, exactly as before. A wrong result in a live chat costs more
 * than a mod typing !call yes.
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
  | { kind: "touch"; asset: string; level: number; dir: "up" | "down" | "either"; until: When };

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
};
/** Tickers that are also English words: read only as $TON or TON. */
const SHOUTED_ONLY: Record<string, string> = { ton: "TON", link: "LINK", dot: "DOT" };

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
const DOWN_VERBS = String.raw`lose|loses|(?:dip|dips|drop|drops|fall|falls|dump|dumps|go|goes|get|gets|sink|sinks|slip|slips|break|breaks)\s+(?:below|under|to)`;
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
  return ways.length === 1 ? ways[0] : null;
}

function candleCall(text: string, asset: string): PriceCall | null {
  if (!/\bcandles?\b/.test(text)) return null;
  const size = sizeFrom(text);
  if (!size) return null;
  const colors = [...new Set([...text.matchAll(/\b(green|red)\b/g)].map((m) => m[1]))];
  const level = levelTestFrom(text);
  if (level === "many" || colors.length + (level ? 1 : 0) !== 1) return null;
  const which = /\bnext\b/.test(text) ? "next" : "current";
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

/** The price call in a question, or null when oddie should leave it to the channel. */
export function parsePriceCall(question: string): PriceCall | null {
  const raw = String(question ?? "");
  const text = raw.toLowerCase().replace(/\s+/g, " ");
  // "won't close above" turns the answer around, and "stay above" asks about
  // every second of a window: not worth guessing at either.
  if (/\bnot\b|n't\b|\bnever\b|\b(stay|stays|hold|holds|remain|remains|keep|keeps)\b/.test(text)) return null;
  // "83k or 80k", "10 or 15 minutes": two answers to one question.
  if (/\b(or|and)\s+\$?\d/.test(text)) return null;
  const asset = assetFrom(raw);
  if (!asset) return null;
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
}

/** A price as chat reads it: 82,182.01 or 0.00001234. */
export function priceText(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 2 : 8 });
}

/** How long after a moment its second is on the source for good. */
export const PRICE_SETTLE_LAG_MS = 3_000;

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
  let dir = pc.dir;
  if (dir === "either") {
    const ref = await source.priceAt(pc.asset, openedAt);
    if (ref === null) return null;
    dir = pc.level >= ref ? "up" : "down";
  }
  const ex = await source.extremes(pc.asset, plan.from, end);
  if (!ex) return null;
  const touched = dir === "up" ? ex.high >= pc.level : ex.low <= pc.level;
  const mark = dir === "up" ? `${pc.asset} high was ${priceText(ex.high)}` : `${pc.asset} low was ${priceText(ex.low)}`;
  if (touched) return { outcome: "yes", said: `${mark} on ${source.venue}.` };
  if (!ready) return "wait";
  return { outcome: "no", said: `${mark} on ${source.venue}.` };
}

/** What the room hears about when a price call settles. */
export function whenText(pc: PriceCall, plan: PricePlan): string {
  if (pc.kind === "candle") return `when the ${sizeLabel(pc.size)} candle closes`;
  if (pc.kind === "at") return `at ${timeLabel(plan.to, pc.when.kind === "clock" ? pc.when : undefined)}`;
  const until = pc.until.kind === "candle" ? `when the ${sizeLabel(pc.until.size)} candle closes`
    : `at ${timeLabel(plan.to, pc.until.kind === "clock" ? pc.until : undefined)}`;
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
