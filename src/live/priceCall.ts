/**
 * A live call oddie can settle by itself: a coin's candle.
 *
 * WHY. The first outside streamer opened "will BTC close current 30min candle
 * above 82k?", watched the candle close, and asked where oddie's result was.
 * A call is the channel's to settle because most are moments no source can
 * see ("clutch this round?"). A candle is not one of those: its close is a
 * public number the second it happens, so the room should not wait on a mod.
 *
 * NARROW ON PURPOSE. Only a question that names one coin, one candle and one
 * test is read: close above or below a level, or close green or red. Anything
 * else (two coins, "not", "hit 82k" which is a wick, a candle size an exchange
 * does not have) stays the channel's, exactly as before. A wrong result in a
 * live chat costs more than a mod typing !call yes.
 *
 * ONE SOURCE, NAMED IN THE LINE. Binance's public market data (no key), the
 * venue most chart-watchers have open. The result line says which venue and
 * which number, so a viewer on another chart sees why.
 */

export type CandleSize = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "6h" | "8h" | "12h" | "1d";

export type CandleTest =
  | { kind: "above" | "below"; level: number }
  | { kind: "green" | "red" };

export interface PriceCall {
  /** The coin's ticker, upper case: BTC. */
  asset: string;
  size: CandleSize;
  /** The candle in progress when the call opened, or the one after it. */
  which: "current" | "next";
  test: CandleTest;
}

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

export const candleMs = (size: CandleSize): number => MINUTES[size] * 60_000;

/** How a candle size reads in chat: "30m", "1h", "daily". */
export const sizeLabel = (size: CandleSize): string => (size === "1d" ? "daily" : size);

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

function testFrom(text: string): CandleTest | null {
  const colors = [...new Set([...text.matchAll(/\b(green|red)\b/g)].map((m) => m[1]))];
  const levels = [...text.matchAll(/\b(above|over|below|under)\s+\$?(\d[\d,]*(?:\.\d+)?)\s*(k|m)?\b/g)];
  if (colors.length + levels.length !== 1) return null;
  if (colors.length) return { kind: colors[0] as "green" | "red" };
  const [, word, num, unit] = levels[0];
  // A level is about where the candle CLOSES. "Go above 82k this candle" is a
  // wick, which is a different number; that one stays the channel's.
  if (!/\bclos(e|es|ed|ing)\b/.test(text)) return null;
  const level = levelFrom(num, unit);
  if (level === null) return null;
  return { kind: word === "above" || word === "over" ? "above" : "below", level };
}

/** The candle call in a question, or null when oddie should leave it to the channel. */
export function parsePriceCall(question: string): PriceCall | null {
  const raw = String(question ?? "");
  const text = raw.toLowerCase().replace(/\s+/g, " ");
  if (!/\bcandles?\b/.test(text)) return null;
  // "won't close above" turns the answer around; not worth guessing.
  if (/\bnot\b|n't\b|\bnever\b/.test(text)) return null;
  const asset = assetFrom(raw);
  const size = sizeFrom(text);
  const test = testFrom(text);
  if (!asset || !size || !test) return null;
  const which = /\bnext\b/.test(text) ? "next" : "current";
  return { asset, size, which, test };
}

/** When the call's candle opens and closes, in ms. Candles start on UTC
 *  boundaries counted from the epoch, which is how Binance cuts them. */
export function candleWindow(pc: PriceCall, openedAt: number): { openAt: number; closeAt: number } {
  const ms = candleMs(pc.size);
  const openAt = Math.floor(openedAt / ms) * ms + (pc.which === "next" ? ms : 0);
  return { openAt, closeAt: openAt + ms };
}

export interface Candle { open: number; close: number }

export function outcomeFor(test: CandleTest, c: Candle): "yes" | "no" {
  switch (test.kind) {
    case "above": return c.close > test.level ? "yes" : "no";
    case "below": return c.close < test.level ? "yes" : "no";
    case "green": return c.close > c.open ? "yes" : "no";
    case "red": return c.close < c.open ? "yes" : "no";
  }
}

/* -------------------------------------------------------------- source -- */

export interface CandleSource {
  /** Where the number comes from, as the result line names it. */
  venue: string;
  /** The finished candle that opened at `openAt`, or null when it is not
   *  finished or not there. Throws when the source did not answer. */
  candle(asset: string, size: CandleSize, openAt: number): Promise<Candle | null>;
}

const BINANCE = "https://data-api.binance.vision/api/v3/klines";

export const binanceCandles: CandleSource = {
  venue: "Binance",
  async candle(asset, size, openAt) {
    const url = `${BINANCE}?symbol=${encodeURIComponent(asset)}USDT&interval=${size}&startTime=${openAt}&limit=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`binance klines ${res.status}`);
    const rows = (await res.json()) as Array<[number, string, string, string, string, string, number]>;
    const k = rows[0];
    // Binance answers with the next candle when this one is missing, and with
    // the live one before it ends: only the exact, finished candle counts.
    if (!k || k[0] !== openAt || k[6] >= Date.now()) return null;
    const open = Number(k[1]);
    const close = Number(k[4]);
    return Number.isFinite(open) && Number.isFinite(close) ? { open, close } : null;
  },
};

/** A price as chat reads it: 82,182.01 or 0.00001234. */
export function priceText(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 2 : 8 });
}
