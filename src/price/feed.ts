// The price sources, and nothing else: two for tokens, and two exchanges for
// what is not a token (gold and oil on Bybit, the big coins on Binance; both
// at the bottom of this file).
//
// WHY THIS FILE EXISTS AT ALL. The rest of the oracle settles a market by
// reading a sentence off a page and auditing that the sentence is really there.
// A price claim has no such sentence. "$BULLSHIT hit 4m this month" is answered
// by a number nobody wrote down in prose, and the pages that do show it
// (DexScreener, Binance, CoinGecko's web UI) refuse automated readers, which is
// exactly why src/matching/extractClaim.ts forbids naming them as criteria. So
// the claim type most likely to travel on crypto X was, until this file, the one
// the oracle could never close.
//
// BOTH SOURCES ARE PUBLIC JSON AND NEITHER NEEDS A KEY. That is the whole reason
// these two were picked over Birdeye and friends: an oracle that needs a paid
// key for one claim type acquires a way to silently stop working when a card
// expires, and it would stop working on the category with the most money moving
// through it.
//
//   DexScreener  api.dexscreener.com   identity: which token is "$BULLSHIT"
//   GeckoTerminal api.geckoterminal.com history: what it was worth, and when
//
// The division is deliberate. DexScreener's search ranks every chain's pairs in
// one response, which is what makes the ambiguity check possible (see
// resolveSymbol). GeckoTerminal is the only free source that returns OHLCV, and
// the HIGH of a candle is the entire answer to "did it ever touch".

const DEXSCREENER = "https://api.dexscreener.com";
const GECKOTERMINAL = "https://api.geckoterminal.com/api/v2";
const FEED_TIMEOUT_MS = 20_000;

export interface Pair {
  chainId: string;
  pairAddress: string;
  baseMint: string;
  baseName: string;
  baseSymbol: string;
  priceUsd: number | null;
  liquidityUsd: number;
  /** Traded value over the last 24 hours. This, not liquidity, is what decides
   *  which token a ticker means. See the note in resolveSymbol. */
  volumeH24: number;
  marketCap: number | null;
  fdv: number | null;
}

export interface TokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Whole tokens, decimals already applied. */
  totalSupply: number | null;
  priceUsd: number | null;
  topPools: string[];
}

/** One candle: [start (unix seconds), open, high, low, close, volume]. */
export type Candle = [number, number, number, number, number, number];

/** A candidate from GeckoTerminal's own search: the same index the candles come
 *  from, which is why its pool address is the one worth keeping. */
export interface PoolHit {
  mint: string;
  symbol: string;
  pool: string;
  volumeH24: number;
}

export interface PriceFeed {
  searchPairs(query: string): Promise<Pair[]>;
  /** Candidates from the candle source. Separate from searchPairs because the
   *  two indexes disagree, and the disagreement is the whole point: see the
   *  union in resolvePriceClaim. */
  searchPools(query: string): Promise<PoolHit[]>;
  tokenInfo(chain: string, mint: string): Promise<TokenInfo | null>;
  /** Candles that start at or before `beforeUnix`. "minute" is asked of the
   *  exchange rails only (src/price/index.ts exchangeWindow). */
  ohlcv(chain: string, pool: string, timeframe: Timeframe, limit: number, beforeUnix?: number): Promise<Candle[]>;
}

export type Timeframe = "day" | "hour" | "minute";

/** Thrown when the SOURCE said this token does not exist, as opposed to the
 *  source not answering. Conflating the two told a user their coin had no price
 *  history when what actually happened was a rate limit. */
export class NotFound extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* THE FREE TIER'S RATE LIMIT IS THE REAL CONSTRAINT, not coverage.
   Measured 2026-09-14: of eight small Solana tokens probed, four came back with
   candles and the other four came back 429 -- every single failure was the rate
   limit, none was a missing token. A $4,885 market cap pump.fun coin had 183
   hourly candles. So the source knows these tokens fine, and the only way to
   lose them is to ask too fast.

   Which the oracle would: it sweeps the whole board in one pass. Hence one
   queue, module-wide, with a floor on the gap between GeckoTerminal calls. It
   makes a sweep slower and it makes it work. DexScreener is not queued; its
   limit is an order of magnitude higher and it is called once per market ever,
   at creation. */
const CHAIN_GT = "solana";
const GT_MIN_GAP_MS = 2200;
let gtQueue: Promise<unknown> = Promise.resolve();
let gtLast = 0;
function gtSlot(): Promise<void> {
  const mine = gtQueue.then(async () => {
    const wait = GT_MIN_GAP_MS - (Date.now() - gtLast);
    if (wait > 0) await sleep(wait);
    gtLast = Date.now();
  });
  gtQueue = mine.catch(() => {});
  return mine;
}

/** Longer than the usual couple of goes, because a 429 here is ordinary and the
 *  alternative to waiting is telling somebody their market cannot be settled. */
const BACKOFF_MS = [2_000, 5_000, 10_000];

async function getJson(url: string, tries = 4): Promise<any> {
  const queued = url.startsWith(GECKOTERMINAL);
  let last: Error = new Error("never ran");
  for (let i = 0; i < tries; i++) {
    if (queued) await gtSlot();
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), FEED_TIMEOUT_MS);
    try {
      // GeckoTerminal answers 403 to some endpoints without a user agent, and it
      // does it on the pool LIST and SEARCH routes rather than the ones probed
      // first, so this was invisible until the candidate union went in.
      const r = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json", "user-agent": "oddie/1.0 (+https://oddie.fun)" } });
      if (r.status === 404) throw new NotFound(`${url} answered 404`);
      // GeckoTerminal's free tier is ~30 calls a minute and the oracle sweeps a
      // whole board in one go, so 429 is an ordinary event here, not an error.
      if (r.status === 429 || r.status >= 500) throw new Error(`${url} answered ${r.status}`);
      if (!r.ok) throw new Error(`${url} answered ${r.status}`);
      return await r.json();
    } catch (e) {
      if (e instanceof NotFound) throw e;
      last = e as Error;
      if (i < tries - 1) await sleep(BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]);
    } finally {
      clearTimeout(t);
    }
  }
  throw last;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

const liveFeed: PriceFeed = {
  async searchPairs(query) {
    const d = await getJson(`${DEXSCREENER}/latest/dex/search?q=${encodeURIComponent(query)}`);
    const pairs: any[] = Array.isArray(d?.pairs) ? d.pairs : [];
    return pairs
      .filter((p) => p?.baseToken?.address && p?.chainId)
      .map((p) => ({
        chainId: String(p.chainId),
        pairAddress: String(p.pairAddress ?? ""),
        baseMint: String(p.baseToken.address),
        baseName: String(p.baseToken.name ?? ""),
        baseSymbol: String(p.baseToken.symbol ?? ""),
        priceUsd: num(p.priceUsd),
        liquidityUsd: num(p?.liquidity?.usd) ?? 0,
        volumeH24: num(p?.volume?.h24) ?? 0,
        marketCap: num(p.marketCap),
        fdv: num(p.fdv),
      }));
  },

  async searchPools(query) {
    let d: any;
    try {
      d = await getJson(`${GECKOTERMINAL}/search/pools?query=${encodeURIComponent(query)}&network=${CHAIN_GT}&page=1`);
    } catch {
      return [];
    }
    const out: PoolHit[] = [];
    for (const p of (d?.data ?? []) as any[]) {
      const a = p?.attributes ?? {};
      const mint = String(p?.relationships?.base_token?.data?.id ?? "").replace(/^[a-z0-9-]+_/i, "");
      // Pools are named "GOOGL / SOL"; the base side is the token searched for.
      const symbol = String(a.name ?? "").split("/")[0].trim();
      const pool = String(a.address ?? "");
      if (!mint || !symbol || !pool) continue;
      out.push({ mint, symbol, pool, volumeH24: num(a?.volume_usd?.h24) ?? 0 });
    }
    return out;
  },

  async tokenInfo(chain, mint) {
    // Only a 404 becomes null. Everything else propagates, so a caller can tell
    // "no such token" from "the source is down".
    let d: any;
    try {
      d = await getJson(`${GECKOTERMINAL}/networks/${encodeURIComponent(chain)}/tokens/${encodeURIComponent(mint)}`);
    } catch (e) {
      if (e instanceof NotFound) return null;
      throw e;
    }
    const a = d?.data?.attributes;
    if (!a) return null;
    const decimals = num(a.decimals) ?? 0;
    const rawSupply = num(a.total_supply);
    const pools: any[] = d?.data?.relationships?.top_pools?.data ?? [];
    return {
      mint: String(a.address ?? mint),
      symbol: String(a.symbol ?? ""),
      name: String(a.name ?? ""),
      decimals,
      // GeckoTerminal reports supply in base units, so a 6-decimal token comes
      // back as 978102719201972 for 978.1M tokens. Dividing here means every
      // caller works in whole tokens and a market cap is just price * supply.
      totalSupply: rawSupply === null ? null : rawSupply / Math.pow(10, decimals),
      priceUsd: num(a.price_usd),
      // Ids arrive namespaced ("solana_CD5H..."); the pool endpoints want the
      // bare address.
      topPools: pools.map((p) => String(p?.id ?? "").replace(/^[a-z0-9-]+_/i, "")).filter(Boolean),
    };
  },

  async ohlcv(chain, pool, timeframe, limit, beforeUnix) {
    if (chain === BYBIT_CHAIN) return bybitCandles(pool, timeframe, limit, beforeUnix);
    if (chain === BINANCE_CHAIN) return binanceCandles(pool, timeframe, limit, beforeUnix);
    const q = new URLSearchParams({ aggregate: "1", limit: String(Math.min(limit, 1000)) });
    if (beforeUnix) q.set("before_timestamp", String(beforeUnix));
    const d = await getJson(
      `${GECKOTERMINAL}/networks/${encodeURIComponent(chain)}/pools/${encodeURIComponent(pool)}/ohlcv/${timeframe}?${q}`,
    );
    const list: any[] = d?.data?.attributes?.ohlcv_list ?? [];
    return list
      .filter((c) => Array.isArray(c) && c.length >= 5 && c.every((x: unknown, i: number) => i > 4 || Number.isFinite(Number(x))))
      .map((c) => [Number(c[0]), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[5] ?? 0)] as Candle);
  },
};

/* GOLD, SILVER AND OIL ARE NOT TOKENS, AND BYBIT LISTS ALL FOUR.
   A claim about gold or crude had no price behind it here: no Solana pool
   trades the metal, and the page-settled oracle needs a page to read. Bybit
   runs linear perpetuals on gold (XAUUSDT), silver (XAGUSDT), WTI (CLUSDT) and
   Brent (BZUSDT), and serves their candles from a public endpoint with no key,
   the same shape GeckoTerminal serves a pool's. So a commodity rides the same
   rail as a token: its "pool" is the Bybit symbol, read at the open and at
   settle. "$CL above $90 this week?" on 12 Oct was about CLUSDT itself. */
export const BYBIT_CHAIN = "bybit";
const BYBIT = "https://api.bybit.com/v5/market";

async function bybitCandles(symbol: string, timeframe: Timeframe, limit: number, beforeUnix?: number): Promise<Candle[]> {
  const interval = timeframe === "minute" ? "1" : timeframe === "hour" ? "60" : "D";
  const q = new URLSearchParams({ category: "linear", symbol, interval, limit: String(Math.min(limit, 1000)) });
  if (beforeUnix) q.set("end", String(beforeUnix * 1000));
  const d = await getJson(`${BYBIT}/kline?${q}`);
  if (d?.retCode !== 0) throw new Error(`bybit kline ${symbol} answered ${d?.retCode}: ${d?.retMsg ?? "no message"}`);
  const list: any[] = d?.result?.list ?? [];
  // [start in ms, open, high, low, close, volume, turnover], newest first.
  return list
    .filter((k) => Array.isArray(k) && k.length >= 5 && k.slice(0, 5).every((x: unknown) => Number.isFinite(Number(x))))
    .map((k) => [Math.floor(Number(k[0]) / 1000), Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5] ?? 0)] as Candle);
}

/* BTC, ETH AND THE OTHER BIG COINS ARE READ ON BINANCE SPOT, like the metals on
   Bybit. They are not Solana tokens, so a market on one had no price behind it:
   its rule named CoinMarketCap, whose pages no reader can open, and on 20 Oct
   ETH, XRP, BNB and SUI sat closed for two days behind a wall of failed
   citations. Binance serves the same candles the stream votes already settle
   from (src/live/priceCall.ts), from its public market-data host, which answers
   from where the server runs. The "pool" is the USDT pair. */
export const BINANCE_CHAIN = "binance";
const BINANCE = "https://data-api.binance.vision/api/v3";

async function binanceCandles(symbol: string, timeframe: Timeframe, limit: number, beforeUnix?: number): Promise<Candle[]> {
  const interval = timeframe === "minute" ? "1m" : timeframe === "hour" ? "1h" : "1d";
  const q = new URLSearchParams({ symbol, interval, limit: String(Math.min(limit, 1000)) });
  if (beforeUnix) q.set("endTime", String(beforeUnix * 1000));
  const d = await getJson(`${BINANCE}/klines?${q}`);
  if (!Array.isArray(d)) throw new Error(`binance klines ${symbol} answered ${JSON.stringify(d).slice(0, 160)}`);
  // [open time in ms, open, high, low, close, volume, close time, ...], oldest first.
  return d
    .filter((k) => Array.isArray(k) && k.length >= 5 && k.slice(0, 5).every((x: unknown) => Number.isFinite(Number(x))))
    .map((k) => [Math.floor(Number(k[0]) / 1000), Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5] ?? 0)] as Candle);
}

let feed: PriceFeed = liveFeed;

/** Test seam. Same shape as every other `_set*` in this codebase: the rules get
 *  exercised without the internet deciding whether the suite passes. */
export function _setPriceFeed(f: PriceFeed | null): void {
  feed = f ?? liveFeed;
}

export const priceFeed = (): PriceFeed => feed;
