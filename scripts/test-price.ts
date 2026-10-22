// The price oracle's rules, pinned without the internet deciding them.
//
// Everything here guards a settlement that would be WRONG rather than merely
// absent, which is the only kind of error this path can make that money does
// not come back from:
//
//   - settling against the wrong token that shares a ticker
//   - counting a price move that happened after the market closed
//   - counting a move that happened before the market opened
//   - reading a quiet hour as missing data and refusing an honest NO
//   - spending a model call on a question that is arithmetic
//
// Run with: npm run test-price
if (process.env.DATABASE_URL) { console.error("refusing to run against a database"); process.exit(1); }

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { _setPriceFeed, priceFeed, type Candle, type Pair, type PoolHit, type TokenInfo } from "../src/price/feed.js";
import { resolvePriceClaim, checkPrice, criteriaSentence, mintsIn, priceNow, decidedAtOpen, readAtOpen, closeQuestion, closeHook, holdQuestion, holdHook, reachQuestion, reachHook, commodityCheck, spotCheck, SPOT_COINS, type PriceCheck } from "../src/price/index.js";
import { parsePriceUpdate, pythPrice, _setPythReader, PYTH_ACCOUNTS, PYTH_FRESH_S } from "../src/price/pyth.js";
import { BINANCE_ASSETS } from "../src/live/priceCall.js";
import { samePriceBet } from "../src/matching/duplicate.js";
import { unsettleablePhrase, addressInQuestion } from "../src/matching/extractClaim.js";
import { retryOnDeadlock, PRICE_RULES_2026_10_20_SQL, COIN_RULES_2026_10_20_SQL } from "../src/store/markets.js";
import { decide } from "../src/oracle/oracle.js";
import { _setProposer } from "../src/oracle/verdict.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.error(`  ✗ ${n}`); if (d) console.error(`      ${d}`); }
};

const pair = (o: Partial<Pair> & { baseMint: string; baseSymbol: string; liquidityUsd: number }): Pair => ({
  chainId: "solana", pairAddress: `pool-${o.baseMint}`, baseName: o.baseSymbol, priceUsd: 1,
  // Volume defaults to the liquidity so the older cases still read naturally;
  // the cases that are ABOUT volume set it themselves.
  volumeH24: o.liquidityUsd, marketCap: 1_000_000, fdv: 1_000_000, ...o,
});

const info = (o: Partial<TokenInfo> & { mint: string }): TokenInfo => ({
  symbol: "TOK", name: "Token", decimals: 6, totalSupply: 1_000_000, priceUsd: 1, topPools: [`pool-${o.mint}`], ...o,
});

/** A feed serving one search result set and one candle list. */
function serve(pairs: Pair[], infos: Record<string, TokenInfo | null>, candles: Candle[] = [], exhausted = true, hits: PoolHit[] = []) {
  _setPriceFeed({
    async searchPairs() { return pairs; },
    async searchPools() { return hits; },
    async tokenInfo(_c, mint) { return infos[mint] ?? null; },
    async ohlcv(_c, _p, _tf, limit) {
      // "exhausted" means the source had nothing older: it returns FEWER rows
      // than asked for. That distinction is the whole coverage rule, so the
      // fake has to be able to express both sides of it.
      if (exhausted) return candles;
      const out = candles.slice();
      while (out.length < limit) out.push(out[out.length - 1] ?? ([0, 1, 1, 1, 1, 0] as Candle));
      return out.slice(0, limit);
    },
  });
}

const T0 = Date.parse("2026-08-01T00:00:00Z") / 1000;
const HOUR = 3600;
/** A flat candle at `price`, `h` hours after the window start. */
const c = (h: number, price: number, high = price, low = price): Candle => [T0 + h * HOUR, price, high, low, price, 1];

const WINDOW = { from: "2026-08-01T00:00:00Z", to: "2026-08-03T00:00:00Z" };

const claim = (o: Partial<Parameters<typeof resolvePriceClaim>[0]> = {}) =>
  ({ symbol: "TOK", metric: "mc" as const, op: ">=" as const, target: 4_000_000, mode: "touch" as const, ...o });

console.log("\nWhich token the ticker means");

serve(
  [pair({ baseMint: "AAA", baseSymbol: "TOK", liquidityUsd: 150_000 }), pair({ baseMint: "BBB", baseSymbol: "TOK", liquidityUsd: 6_000 })],
  { AAA: info({ mint: "AAA" }) },
);
let r = await resolvePriceClaim(claim(), WINDOW);
check("the most traded token wins when it dominates", r.ok && r.check.mint === "AAA", r.ok ? "" : r.why);

// The pool the candles come from is the busiest one, not the deepest.
serve(
  [
    pair({ baseMint: "AAA", baseSymbol: "TOK", pairAddress: "deep-dead", liquidityUsd: 900_000, volumeH24: 100 }),
    pair({ baseMint: "AAA", baseSymbol: "TOK", pairAddress: "busy", liquidityUsd: 0, volumeH24: 400_000 }),
  ],
  { AAA: info({ mint: "AAA", topPools: [] }) },
);
r = await resolvePriceClaim(claim(), WINDOW);
check("candles are read from the busiest pool, not the deepest", r.ok && r.check.pool === "busy", r.ok ? r.check.pool : (r as any).why);

serve(
  [pair({ baseMint: "AAA", baseSymbol: "TOK", liquidityUsd: 150_000 }), pair({ baseMint: "BBB", baseSymbol: "TOK", liquidityUsd: 100_000 })],
  { AAA: info({ mint: "AAA" }) },
);
r = await resolvePriceClaim(claim(), WINDOW);
check("two tokens of similar size under one ticker are refused, not guessed", !r.ok && /none of them clearly is the one/.test((r as any).why));

// Measured: DexScreener reports zero liquidity for pumpswap and bonding-curve
// pools, so $NVIDA showed 0 depth against $153M of daily volume. A liquidity
// floor refused the busiest tokens on the chain.
serve([pair({ baseMint: "AAA", baseSymbol: "TOK", liquidityUsd: 0, volumeH24: 153_000_000 })], { AAA: info({ mint: "AAA" }) });
r = await resolvePriceClaim(claim(), WINDOW);
check("a heavily traded token whose pool reports no liquidity still opens", r.ok, r.ok ? "" : (r as any).why);

// The measured attack: a billion dollars of posted liquidity and four dollars
// of actual trading. Ranking by depth handed this token the ticker.
serve(
  [
    pair({ baseMint: "GHOST", baseSymbol: "TOK", liquidityUsd: 1_000_000_000, volumeH24: 4 }),
    pair({ baseMint: "REAL", baseSymbol: "TOK", liquidityUsd: 128_000, volumeH24: 125_000 }),
  ],
  { REAL: info({ mint: "REAL" }), GHOST: info({ mint: "GHOST" }) },
);
r = await resolvePriceClaim(claim(), WINDOW);
check("a fake pool cannot buy a ticker with posted liquidity alone", r.ok && r.check.mint === "REAL", r.ok ? r.check.mint : (r as any).why);

serve([pair({ baseMint: "QUIET", baseSymbol: "TOK", liquidityUsd: 500_000, volumeH24: 40 })], { QUIET: info({ mint: "QUIET" }) });
// (a deep pool nobody trades is still refused: depth is not the signal)
r = await resolvePriceClaim(claim(), WINDOW);
check("a ticker nobody is trading is refused rather than guessed", !r.ok && /enough real volume/.test((r as any).why));

// Live, "$WIF" resolved to a coin called "World is Flat" on another chain while
// dogwifhat was missing from the truncated search response altogether.
serve(
  [pair({ chainId: "robinhood", baseMint: "IMPOSTOR", baseSymbol: "TOK", liquidityUsd: 900_000, volumeH24: 900_000 })],
  { IMPOSTOR: info({ mint: "IMPOSTOR" }) },
);
r = await resolvePriceClaim(claim(), WINDOW);
check("a same-ticker token on another chain never wins the market", !r.ok && /no Solana token/.test((r as any).why), r.ok ? (r as any).check.mint : "");

serve([pair({ baseMint: "AAA", baseSymbol: "TOK", liquidityUsd: 150_000, marketCap: 400_000, fdv: 1_000_000 })], { AAA: info({ mint: "AAA" }) });
r = await resolvePriceClaim(claim(), WINDOW);
check("locked supply makes \"market cap\" ambiguous and is refused", !r.ok && /locked supply/.test((r as any).why));

serve([pair({ baseMint: "SOL1", baseSymbol: "SOL", liquidityUsd: 9_000_000 })], { SOL1: info({ mint: "SOL1", symbol: "SOL" }) });
r = await resolvePriceClaim(claim({ symbol: "SOL" }), WINDOW);
check("a wrapped major's market cap is refused (its pool cannot answer it)", !r.ok && /not something its on-chain pool can be read for/.test((r as any).why));
r = await resolvePriceClaim(claim({ symbol: "SOL", metric: "price", target: 300 }), WINDOW);
check("the same major's PRICE is allowed", r.ok);

serve([pair({ baseMint: "AAA", baseSymbol: "TOK", liquidityUsd: 150_000 })], { AAA: null });
r = await resolvePriceClaim(claim(), WINDOW);
check("a token with no published history is refused", !r.ok && /no price history is published/.test((r as any).why));

serve([pair({ baseMint: "AAA", baseSymbol: "TOK", liquidityUsd: 150_000 })], { AAA: info({ mint: "AAA" }) });
r = await resolvePriceClaim(claim(), WINDOW);
check("the criteria a bettor reads name the mint, not just the ticker",
  r.ok && r.sentence.includes("AAA") && r.sentence.includes("$TOK"));
check("the criteria say the window starts when the market opened",
  r.ok && /this market opening/.test(r.sentence));

const CHECK: PriceCheck = {
  chain: "solana", mint: "AAA", symbol: "TOK", name: "Token", pool: "pool-AAA", supply: 1_000_000,
  metric: "mc", op: ">=", target: 4_000_000, mode: "touch", from: WINDOW.from, to: WINDOW.to,
};

// The measured defect: one index sees two GOOGLs and the other sees ten.
serve(
  [
    pair({ baseMint: "ISSUER_A", baseSymbol: "TOK", volumeH24: 34_000_000, liquidityUsd: 0 }),
    pair({ baseMint: "TINY", baseSymbol: "TOK", volumeH24: 2_800, liquidityUsd: 0 }),
  ],
  { ISSUER_A: info({ mint: "ISSUER_A" }), ISSUER_B: info({ mint: "ISSUER_B" }) },
  [], true,
  [{ mint: "ISSUER_B", symbol: "TOK", pool: "pool-b", volumeH24: 37_800_000 }],
);
r = await resolvePriceClaim(claim(), WINDOW);
check("a rival the other index can see stops a false-confident match",
  !r.ok && /none of them clearly is the one/.test((r as any).why), r.ok ? (r as any).check.mint : "");

console.log("\nA price claim that cannot be pinned");

// Measured on the live ledger: "@levvercetti: it wont pass 100k this year" under
// a Bitcoin post graded as a price claim, correctly, and BTC is not a Solana
// token. The market was then refused OUTRIGHT, because the extractor had been
// told it could leave the criteria empty and let the price path write them. A
// new capability had silently removed an old one: the same claim opened an
// ordinary citation-settled market two hours earlier.
serve([], { }, [], true, []);
r = await resolvePriceClaim(claim({ symbol: "BTC", metric: "price", target: 100_000 }), WINDOW);
check("a major asset's price claim finds no Solana token, and says so plainly",
  !r.ok && /no Solana token/.test((r as any).why), r.ok ? "" : (r as any).why);
check("the refusal is a REASON, not an exception: the caller can fall back", !r.ok && typeof (r as any).why === "string");

console.log("\nAn address in the text");

// Three tokens that all pass as "TOK" -- the search path would refuse. The
// address says which one, so it opens.
serve(
  [pair({ baseMint: "A1", baseSymbol: "TOK", liquidityUsd: 0, volumeH24: 500_000 }), pair({ baseMint: "A2", baseSymbol: "TOK", liquidityUsd: 0, volumeH24: 480_000 })],
  {
    A1: info({ mint: "A1", symbol: "TOK" }),
    So11111111111111111111111111111111111111112: info({ mint: "So11111111111111111111111111111111111111112", symbol: "TOK", name: "The one they meant" }),
  },
);
r = await resolvePriceClaim(claim(), WINDOW);
check("without an address, look-alikes refuse", !r.ok, r.ok ? (r as any).check.mint : "");
r = await resolvePriceClaim(claim(), WINDOW, { text: "$TOK hits 4m this month, CA So11111111111111111111111111111111111111112" });
check("an address in the text pins the token outright",
  r.ok && r.check.mint === "So11111111111111111111111111111111111111112", r.ok ? "" : (r as any).why);

// A pasted address for a DIFFERENT coin must not become this market's token.
r = await resolvePriceClaim(claim(), WINDOW, { text: "compare it to 4nKiBzUscGCKkEpz1Jz8upgbaRySigVF94FcDZ6RN5u5 lol" });
check("an address whose token is not the claimed ticker is ignored", !r.ok, r.ok ? (r as any).check.mint : "");

check("a tweet id is never mistaken for a mint", mintsIn("https://x.com/a/status/1966549201234567890").length === 0);

console.log("\nReading the window");

// 48 hours of candles, but only 5 of them: a quiet memecoin trades in bursts.
serve([], {}, [c(0, 1), c(5, 1), c(20, 1), c(30, 1), c(46, 1)]);
let v = await checkPrice(CHECK);
check("gaps between trades are not missing data, so an honest NO still settles",
  v.outcome === "no", `${v.outcome}: ${v.why}`);

serve([], {}, [c(0, 1), c(20, 5), c(46, 1)]);
v = await checkPrice(CHECK);
check("one candle over the target settles YES", v.outcome === "yes" && v.observed === 5_000_000, v.why);

// Not exhausted (the source had more to give) and nothing before hour 10.
serve([], {}, [c(10, 1), c(20, 1), c(46, 1)], false);
v = await checkPrice(CHECK);
check("a real hole in the history cannot prove it never got there", v.outcome === null, `${v.outcome}: ${v.why}`);

serve([], {}, [c(10, 9), c(20, 1)], false);
v = await checkPrice(CHECK);
check("but a hole does not unmake a candle that IS there: YES still settles", v.outcome === "yes", v.why);

// Hour 47 straddles the close at hour 48 only if step overruns; hour 48 is past it.
serve([], {}, [c(0, 1), c(48, 9)]);
v = await checkPrice(CHECK);
check("a spike at the close time itself is outside the window and does not count",
  v.outcome === "no", `${v.outcome}: ${v.why}`);

serve([], {}, [c(0, 1), c(20, 3), c(46, 2)]);
v = await checkPrice({ ...CHECK, mode: "at-close", target: 1_500_000 });
check("at-close reads the last candle inside the window, not the highest",
  v.outcome === "yes" && v.observed === 2_000_000, `${v.outcome} ${v.observed}: ${v.why}`);
v = await checkPrice({ ...CHECK, mode: "at-close", target: 2_500_000 });
check("at-close settles NO when the close is short of the target", v.outcome === "no", v.why);

serve([], {}, [c(0, 2), c(20, 2, 2, 0.5), c(46, 2)]);
v = await checkPrice({ ...CHECK, mode: "always", target: 1_000_000 });
check("\"always\" breaks on a single dip below the line", v.outcome === "no" && v.observed === 500_000, v.why);
serve([], {}, [c(0, 2), c(20, 2), c(46, 2)]);
v = await checkPrice({ ...CHECK, mode: "always", target: 1_000_000 });
check("\"always\" holds when nothing breaks it", v.outcome === "yes", v.why);

serve([], {}, []);
v = await checkPrice(CHECK);
check("no history at all is undetermined, never a NO", v.outcome === null && v.candles === 0, v.why);

console.log("\nThe oracle's price branch");

let proposerCalls = 0;
_setProposer(async () => { proposerCalls++; return { checkable: true, outcome: "yes", confidence: "high", reasoning: "", citations: [], dropped: 0 } as any; });

serve([], {}, [c(0, 1), c(20, 5), c(46, 1)]);
let d = await decide(
  { slug: "s", question: "does TOK hit 4m?", criteria: criteriaSentence(CHECK), closeTime: WINDOW.to, priceCheck: CHECK },
  new Date("2026-08-04T00:00:00Z"),
);
check("a price market settles from candles", d.settle === "yes" && d.gate === "settled", `${d.gate}: ${d.reason}`);
check("and never asks the model", proposerCalls === 0, `proposer ran ${proposerCalls} time(s)`);
check("so it is recorded as costing nothing", d.proposal === undefined);

serve([], {}, []);
d = await decide(
  { slug: "s", question: "q", criteria: criteriaSentence(CHECK), closeTime: WINDOW.to, priceCheck: CHECK },
  new Date("2026-08-04T00:00:00Z"),
);
check("a source that did not answer is a retryable gate", d.gate === "price-unreadable" && d.settle === null, d.gate);

serve([], {}, [c(10, 1), c(20, 1)], false);
d = await decide(
  { slug: "s", question: "q", criteria: criteriaSentence(CHECK), closeTime: WINDOW.to, priceCheck: CHECK },
  new Date("2026-08-04T00:00:00Z"),
);
check("a window the history cannot cover asks for a person", d.gate === "price-undetermined" && d.settle === null, d.gate);

d = await decide(
  { slug: "s", question: "q", criteria: criteriaSentence(CHECK), closeTime: "2099-01-01T00:00:00Z", priceCheck: CHECK },
  new Date("2026-08-04T00:00:00Z"),
);
check("an open price market is still refused for being open", d.gate === "not-closed", d.gate);

/* 20 OCT: A PRICE RULE ITS CANDLES HAVE DECIDED SETTLES BEFORE ITS CLOSE.
   Bee's ETH market traded at $2,478 the day it opened and took bets for five
   more days. A touch made or a hold broken settles at once; anything else, and
   every price AT the close, waits for the close. */
{
  const MID = new Date("2026-08-02T06:30:00Z");   // hour 30.5 of 48: still open
  const open = (pc: PriceCheck) => decide({ slug: "s", question: "q", criteria: criteriaSentence(pc), closeTime: WINDOW.to, priceCheck: pc }, MID);
  const failing = (count: () => void) => _setPriceFeed({
    searchPairs: async () => [], searchPools: async () => [], tokenInfo: async () => null,
    async ohlcv() { count(); throw new Error("429 Too Many Requests"); },
  });

  serve([], {}, [c(0, 1), c(20, 5), c(29, 1)]);
  d = await open(CHECK);
  check("a touch already made settles YES before the close", d.settle === "yes" && d.gate === "settled" && /before the close/.test(d.reason), `${d.gate}: ${d.reason}`);
  check("...without a model", proposerCalls === 0, `proposer ran ${proposerCalls} time(s)`);

  serve([], {}, [c(0, 1), c(20, 1), c(40, 5)]);
  d = await open(CHECK);
  check("a candle after now cannot settle it early", d.gate === "not-closed" && d.settle === null, `${d.gate}: ${d.reason}`);

  serve([], {}, [c(0, 1), c(20, 1), c(29, 1)]);
  d = await open(CHECK);
  check("a touch not made yet waits for the close: never an early NO", d.gate === "not-closed" && d.settle === null, `${d.gate}: ${d.reason}`);

  const hold: PriceCheck = { ...CHECK, mode: "always", target: 1_000_000 };
  serve([], {}, [c(0, 2), c(20, 2, 2, 0.5), c(29, 2)]);
  d = await open(hold);
  check("a hold already broken settles NO before the close", d.settle === "no" && d.gate === "settled" && /before the close/.test(d.reason), `${d.gate}: ${d.reason}`);

  serve([], {}, [c(0, 2), c(20, 2), c(29, 2)]);
  d = await open(hold);
  check("a hold still holding waits for the close: never an early YES", d.gate === "not-closed" && d.settle === null, `${d.gate}: ${d.reason}`);

  let reads = 0;
  failing(() => reads++);
  d = await open({ ...CHECK, mode: "at-close" });
  check("a price at the close is never read before the close", d.gate === "not-closed" && reads === 0, `${d.gate}, ${reads} read(s)`);

  failing(() => reads++);
  d = await open(CHECK);
  check("a source that did not answer leaves it open, not unreadable", d.gate === "not-closed" && d.settle === null && reads > 0, `${d.gate}: ${d.reason}`);

  serve([], {}, [c(0, 1), c(20, 5), c(29, 1)]);
  d = await decide({ slug: "s", question: "q", criteria: criteriaSentence(CHECK), closeTime: WINDOW.to, priceCheck: CHECK }, new Date(Date.parse(WINDOW.from) - 3600_000));
  check("a market read before its window opens decides nothing", d.gate === "not-closed", `${d.gate}: ${d.reason}`);
  check("...and none of it asked the model", proposerCalls === 0, `proposer ran ${proposerCalls} time(s)`);
}

_setProposer(null as any);
/* THE PUBLISHED SENTENCE IS THE HASHED ONE, so it has to say what the code
   does. Both of these shipped wrong: ">" printed "at or above" while line 309
   compared strictly, and a price market printed a frozen supply it never
   multiplies by. Neither is fixable after a mint -- criteria_hash commits to
   this exact string. */
{
  const base = { symbol: "TOK", chain: "solana", mint: "M", target: 115, supply: 12_491_824,
    from: WINDOW.from, to: WINDOW.to, mode: "at-close" } as unknown as PriceCheck;
  const strict = criteriaSentence({ ...base, metric: "price", op: ">" } as PriceCheck);
  const orEqual = criteriaSentence({ ...base, metric: "price", op: ">=" } as PriceCheck);
  check("a strictly-above rule does not publish 'at or above'",
    /is above /.test(strict) && !/at or above/.test(strict), strict);
  check("...and an at-or-above rule still says so", /at or above/.test(orEqual), orEqual);
  const below = criteriaSentence({ ...base, metric: "price", op: "<" } as PriceCheck);
  check("...and the same holds under the line", /is below /.test(below) && !/at or below/.test(below), below);
  check("a price market publishes no supply it never multiplies by",
    !/supply/.test(strict), strict);
  const mc = criteriaSentence({ ...base, metric: "mc", op: ">" } as PriceCheck);
  check("a market-cap market still freezes one, because that IS the rule",
    /supply of 12,491,824 tokens/.test(mc), mc);
}

console.log("\nA period already decided when its market opens");
{
  /* LIVE ON 2026-10-12: "!oddie Solana above $100 in october?" opened as a
     touch, "above $100 at any point between this market opening and October
     31", with SOL at $108. YES on the first candle, NO lost before it was
     staked. Asked inside October with the price already past the level, the
     question is where SOL ends the month (Lev): the same level, at the close.
     The numbers here are that market's: its pool, and the two newest hourly
     candles GeckoTerminal served for it at 20:02 UTC that day, newest first. */
  const SOL: PriceCheck = {
    chain: "solana", mint: "So11111111111111111111111111111111111111112", symbol: "SOL", name: "Wrapped SOL",
    pool: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE", supply: 12_491_824,
    metric: "price", op: ">", target: 100, mode: "touch",
    from: "2026-10-12T19:40:00.000Z", to: "2026-10-31T23:59:00.000Z",
  };
  const H20 = Date.parse("2026-10-12T20:00:00Z") / 1000;
  const live: Candle[] = [[H20, 108.34, 108.69, 108.34, 108.46, 1], [H20 - 3600, 107.49, 108.75, 107.12, 108.34, 1]];
  const asked: Array<{ pool: string; timeframe: string }> = [];
  const quote = (candles: Candle[] | Error) => _setPriceFeed({
    searchPairs: async () => [], searchPools: async () => [], tokenInfo: async () => null,
    async ohlcv(_chain, pool, timeframe) {
      asked.push({ pool, timeframe });
      if (candles instanceof Error) throw candles;
      return candles;
    },
  });

  quote(live);
  const now = await priceNow(SOL);
  check("the price at the open is the newest candle's close, on the pool the oracle reads",
    now.ok && now.value === 108.46 && asked[0]?.pool === SOL.pool && asked[0]?.timeframe === "hour", JSON.stringify({ now, asked }));
  quote([...live].reverse());
  const flipped = await priceNow(SOL);
  check("...the newest by its start, whatever order the source sends", flipped.ok && flipped.value === 108.46);
  quote(live);
  const cap = await priceNow({ ...SOL, metric: "mc", supply: 1_000_000 });
  check("...and a market cap multiplies it by the frozen supply", cap.ok && cap.value === 108_460_000);

  check("a touch the price already meets is decided YES at the open", decidedAtOpen(SOL, 108.46) === "yes");
  check("...one it has not met yet is still a market", decidedAtOpen({ ...SOL, target: 150 }, 108.46) === null);
  // bee_empire's HYPE market the same day: "below $100 at any point during
  // October" with bridged HYPE at about $83.6.
  check("...and the same holds under the line", decidedAtOpen({ ...SOL, op: "<", target: 100 }, 83.6) === "yes");
  const HOLD: PriceCheck = { ...SOL, op: ">=", mode: "always" };
  check("an \"always\" already broken at the open is decided NO", decidedAtOpen(HOLD, 95) === "no");
  check("...one that holds is still a market", decidedAtOpen(HOLD, 108.46) === null);
  check("an at-close claim is never decided by the open", decidedAtOpen({ ...SOL, mode: "at-close" }, 108.46) === null);

  quote(live);
  const sol = await readAtOpen(SOL);
  check("the SOL market is read at the close instead", sol.kind === "reread" && sol.was === "yes" && sol.now === 108.46, JSON.stringify(sol));
  if (sol.kind === "reread") {
    check("...same token, pool, level and window, mode at-close",
      sol.check.mode === "at-close" && sol.check.mint === SOL.mint && sol.check.pool === SOL.pool && sol.check.op === ">"
      && sol.check.target === 100 && sol.check.from === SOL.from && sol.check.to === SOL.to, JSON.stringify(sol.check));
    check("...asking where SOL ends October", sol.question === "Will $SOL be above $100 at the end of October 2026?", sol.question);
    check("...under a headline that says so", sol.hook === "SOL above $100 at end of Oct?", String(sol.hook));
    check("...and criteria that read the close, never \"at any point\"",
      sol.sentence === criteriaSentence(sol.check) && /is above \$100 at 2026-10-31 UTC/.test(sol.sentence) && !/at any point/.test(sol.sentence), sol.sentence);
    check("...which pass the wall every market is born behind",
      unsettleablePhrase(sol.sentence) === null && unsettleablePhrase(sol.question) === null
      && addressInQuestion(sol.question) === null && sol.question.length <= 180);
    quote(live);
    const again = await readAtOpen(SOL);
    check("...and the same claim read twice is one market, not a twin beside it",
      again.kind === "reread" && samePriceBet(again.check, sol.check) && !samePriceBet(sol.check, SOL));

    // What the oracle then does with it: the first hour after the open stands
    // at $115, which would have settled the touch YES, and SOL ends the month
    // at $95. The touch says YES; the market that opened says what happened at the close.
    const firstHour = Date.parse("2026-10-12T20:00:00Z") / 1000;
    const lastHour = Date.parse("2026-10-31T22:00:00Z") / 1000;
    const month = (end: number): Candle[] => [[firstHour, 109, 115, 108, 115, 1], [lastHour, 97, 98, end - 1, end, 1]];
    serve([], {}, month(95));
    let settled = await checkPrice(SOL);
    check("(the touch as it opened was a YES from its first hour)", settled.outcome === "yes", settled.why);
    settled = await checkPrice(sol.check);
    check("the market read at the close settles on the close: NO at $95", settled.outcome === "no" && settled.observed === 95, settled.why);
    serve([], {}, month(104));
    settled = await checkPrice(sol.check);
    check("...and YES at $104", settled.outcome === "yes" && settled.observed === 104, settled.why);
  }

  quote([[H20, 83.7, 83.9, 83.4, 83.6, 1]]);
  const hype = await readAtOpen({ ...SOL, symbol: "HYPE", op: "<", target: 100 });
  check("HYPE below $100, already below at the open, is read at the close too",
    hype.kind === "reread" && hype.question === "Will $HYPE be below $100 at the end of October 2026?" && hype.hook === "HYPE below $100 at end of Oct?",
    JSON.stringify(hype));
  quote([[H20, 95, 95, 95, 95, 1]]);
  const held = await readAtOpen(HOLD);
  check("an \"always\" broken at the open becomes where it ends the period",
    held.kind === "reread" && held.was === "no" && held.check.mode === "at-close"
    && held.question === "Will $SOL be at or above $100 at the end of October 2026?", JSON.stringify(held));

  quote(live);
  const open = await readAtOpen({ ...SOL, target: 150 });
  check("a touch still ahead of the price opens as it reads", open.kind === "as-is" && open.now === 108.46, JSON.stringify(open));
  asked.length = 0;
  const close = await readAtOpen({ ...SOL, mode: "at-close" });
  check("an at-close claim opens as it reads, without asking for a price", close.kind === "as-is" && asked.length === 0);
  quote(new Error("https://api.geckoterminal.com/... answered 429"));
  const down = await readAtOpen(SOL);
  check("a price that cannot be read leaves the market as it reads, with the reason",
    down.kind === "unread" && /answered 429/.test(down.why), JSON.stringify(down));
  quote([]);
  const empty = await readAtOpen(SOL);
  check("...as does a pool with no candle", empty.kind === "unread", JSON.stringify(empty));

  // The words for other closes: a day's end, an hour, a midnight close, a market cap.
  const at = (to: string, o: Partial<PriceCheck> = {}) => ({ ...SOL, mode: "at-close" as const, to, ...o });
  check("a close at a day's end names the day",
    closeQuestion(at("2026-10-17T23:59:00Z")) === "Will $SOL be above $100 at the end of October 17, 2026 (UTC)?"
    && closeHook(at("2026-10-17T23:59:00Z")) === "SOL above $100 on Oct 17?", closeQuestion(at("2026-10-17T23:59:00Z")));
  check("...a close in the day names the hour",
    closeQuestion(at("2026-10-13T15:00:00Z")) === "Will $SOL be above $100 at 15:00 UTC on October 13, 2026?"
    && closeHook(at("2026-10-13T15:00:00Z")) === "SOL above $100 at 15:00 UTC?", closeQuestion(at("2026-10-13T15:00:00Z")));
  check("...a close on midnight is the end of the day before it",
    closeQuestion(at("2026-11-01T00:00:00Z")) === "Will $SOL be above $100 at the end of October 2026?", closeQuestion(at("2026-11-01T00:00:00Z")));
  check("...a market cap says so",
    closeQuestion(at("2026-10-31T23:59:00Z", { symbol: "TOK", metric: "mc", op: ">=", target: 4_000_000 })) === "Will $TOK's market cap be at or above $4M at the end of October 2026?");
  check("...and a ticker too long for a headline leaves only the question",
    closeHook(at("2026-10-31T23:59:00Z", { symbol: "VERYLONGTICKER16", metric: "mc", target: 123_450_000 })) === null);

  /* ABOVE MEANS ABOVE, BELOW MEANS BELOW (Lev, 13 Oct). The extractor marks a
     level over a period with no move named as "within", and the price at the
     open makes it concrete: already on that side, does it stay there until the
     period ends; not there, does it get there before then. */
  const WITHIN: PriceCheck = { ...SOL, mode: "within" };
  quote(live);
  const stays = await readAtOpen(WITHIN);
  check("SOL above $100 in October, with SOL at $108: does it stay above $100 to the end",
    stays.kind === "within" && stays.reading === "hold" && stays.now === 108.46 && stays.check.mode === "always"
    && stays.question === "Will $SOL stay above $100 through the end of October 2026?" && stays.hook === "SOL stays above $100 through Oct?",
    JSON.stringify(stays));
  if (stays.kind === "within") {
    check("...same token, pool, level and window",
      stays.check.mint === SOL.mint && stays.check.pool === SOL.pool && stays.check.op === ">" && stays.check.target === 100
      && stays.check.from === SOL.from && stays.check.to === SOL.to);
    check("...under criteria that hold the whole window from the open",
      stays.sentence === criteriaSentence(stays.check) && /is above \$100 continuously from this market opening on 2026-10-12 to 2026-10-31 UTC/.test(stays.sentence)
      && !/at any point/.test(stays.sentence), stays.sentence);
    check("...which pass the wall every market is born behind",
      unsettleablePhrase(stays.sentence) === null && unsettleablePhrase(stays.question) === null
      && addressInQuestion(stays.question) === null && stays.question.length <= 180);
    const firstHour = Date.parse("2026-10-12T20:00:00Z") / 1000;
    const lastHour = Date.parse("2026-10-31T22:00:00Z") / 1000;
    serve([], {}, [[firstHour, 108, 109, 101.6, 104, 1], [lastHour, 110, 111, 109, 110, 1]]);
    let held2 = await checkPrice(stays.check);
    check("...the oracle settles it YES when SOL never dips under $100", held2.outcome === "yes", held2.why);
    serve([], {}, [[firstHour, 108, 109, 99.5, 104, 1], [lastHour, 110, 111, 109, 110, 1]]);
    held2 = await checkPrice(stays.check);
    check("...and NO the hour it does, even if it ends the month above", held2.outcome === "no", held2.why);
  }
  quote([[H20, 83.7, 83.9, 83.4, 83.6, 1]]);
  const hypeStays = await readAtOpen({ ...WITHIN, symbol: "HYPE", op: "<", target: 100 });
  check("HYPE below $100 this month, with HYPE at $83.6: does it stay below $100",
    hypeStays.kind === "within" && hypeStays.reading === "hold" && hypeStays.check.mode === "always"
    && hypeStays.question === "Will $HYPE stay below $100 through the end of October 2026?" && hypeStays.hook === "HYPE stays below $100 through Oct?",
    JSON.stringify(hypeStays));
  quote(live);
  const gets = await readAtOpen({ ...WITHIN, target: 150 });
  check("SOL above $150 in October, with SOL at $108: does it get above $150 before the end",
    gets.kind === "within" && gets.reading === "reach" && gets.check.mode === "touch"
    && gets.question === "Will $SOL trade above $150 at any point before the end of October 2026?" && gets.hook === "SOL above $150 by end of Oct?"
    && /at any point between this market opening on 2026-10-12 and 2026-10-31 UTC/.test(gets.sentence), JSON.stringify(gets));
  quote(new Error("https://api.geckoterminal.com/... answered 429"));
  const unread = await readAtOpen(WITHIN);
  check("a price that cannot be read at the open gets the reading the open cannot decide: the close",
    unread.kind === "within" && unread.reading === "close" && unread.check.mode === "at-close" && /answered 429/.test(unread.why ?? "")
    && unread.question === "Will $SOL be above $100 at the end of October 2026?", JSON.stringify(unread));
  const never = await checkPrice({ ...SOL, mode: "within" });
  check("the oracle gives no verdict on a level over a period that was never read at the open", never.outcome === null, never.why);
  const hold = (to: string, o: Partial<PriceCheck> = {}) => ({ ...SOL, mode: "always" as const, to, ...o });
  check("a hold to a day's end, and to an hour, say so",
    holdQuestion(hold("2026-10-17T23:59:00Z")) === "Will $SOL stay above $100 through the end of October 17, 2026 (UTC)?"
    && holdHook(hold("2026-10-17T23:59:00Z")) === "SOL stays above $100 through Oct 17?"
    && holdQuestion(hold("2026-10-13T15:00:00Z")) === "Will $SOL stay above $100 until 15:00 UTC on October 13, 2026?"
    && holdHook(hold("2026-10-13T15:00:00Z")) === "SOL stays above $100 until 15:00 UTC?", holdQuestion(hold("2026-10-13T15:00:00Z")));
  check("...and so does a reach",
    reachQuestion(hold("2026-10-17T23:59:00Z")) === "Will $SOL trade above $100 at any point before the end of October 17, 2026 (UTC)?"
    && reachHook(hold("2026-10-13T15:00:00Z")) === "SOL above $100 by 15:00 UTC?", reachQuestion(hold("2026-10-17T23:59:00Z")));
}

console.log("\nThe big coins on Binance spot");
{
  /* BTC, ETH and the rest are not Solana tokens. Until 20 Oct their markets
     were read at the open from Binance and then left to a rule naming
     CoinMarketCap, which the page-settled oracle cannot open: ETH, XRP, BNB and
     SUI closed on 18 Oct and sat there. Now a big coin is pinned to its Binance
     pair like gold to Bybit's, and settled from that pair's candles. */
  const WIN = { from: "2026-10-12T20:38:18.000Z", to: "2026-10-16T23:59:00.000Z" };
  const btc = spotCheck({ symbol: "BTC", metric: "price", op: ">=", target: 80_000, mode: "touch" }, WIN);
  check("BTC is pinned to Binance's BTCUSDT, never searched for as a token",
    btc?.chain === "binance" && btc.pool === "BTCUSDT" && btc.mint === "BTCUSDT" && btc.symbol === "BTC" && btc.name === "Bitcoin (BTC)" && btc.supply === 0, JSON.stringify(btc));
  check("...however the ticker is written",
    spotCheck({ symbol: "$eth", metric: "price", op: ">", target: 2350, mode: "at-close" }, WIN)?.pool === "ETHUSDT"
    && spotCheck({ symbol: "Sol", metric: "price", op: ">", target: 100, mode: "within" }, WIN)?.pool === "SOLUSDT");
  check("...while a market cap, a coin Binance does not list and a metal are not this rail's",
    spotCheck({ symbol: "BTC", metric: "mc", op: ">", target: 1e12, mode: "touch" }, WIN) === null
    && spotCheck({ symbol: "HYPE", metric: "price", op: ">", target: 50, mode: "touch" }, WIN) === null
    && spotCheck({ symbol: "XAU", metric: "price", op: ">", target: 4000, mode: "touch" }, WIN) === null);
  check("the coins are the ones the stream votes read from Binance, and TON, whose pairs stopped trading in June, is in neither",
    Object.keys(SPOT_COINS).length === BINANCE_ASSETS.size && Object.keys(SPOT_COINS).every((s) => BINANCE_ASSETS.has(s))
    && !BINANCE_ASSETS.has("TON") && !("TON" in SPOT_COINS), Object.keys(SPOT_COINS).join(","));

  const AT = Date.parse(WIN.from) / 1000;
  const now = (price: number, newest = Math.floor(AT / 3600) * 3600) => _setPriceFeed({
    searchPairs: async () => [], searchPools: async () => [], tokenInfo: async () => null,
    async ohlcv(chain, pool) { return chain === "binance" && pool === "BTCUSDT" ? [[newest, price, price, price, price, 1]] as Candle[] : []; },
  });
  now(83_080.02);
  const hit = await readAtOpen(btc!);
  check("a touch BTC already meets at the open is read at the close", hit.kind === "reread" && hit.was === "yes" && hit.now === 83_080.02, JSON.stringify(hit));
  if (hit.kind === "reread") {
    check("...asking where BTC ends the window, the level in full",
      hit.question === "Will $BTC be at or above $80,000 at the end of October 16, 2026 (UTC)?", hit.question);
    check("...under a headline that says so", hit.hook === "BTC above $80,000 on Oct 16?", String(hit.hook));
    check("...and a rule naming Binance's pair and the minute it is read at",
      hit.sentence === "Settles from the price of Bitcoin (BTC) on Binance's BTCUSDT spot pair. YES if its price is at or above $80,000 at 23:59 UTC on 2026-10-16, read from the BTCUSDT candles on Binance. NO otherwise.", hit.sentence);
    check("...stored as the check the oracle settles by", hit.check.chain === "binance" && hit.check.mode === "at-close" && hit.check.pool === "BTCUSDT");
  }
  // Above means above, below means below (Lev, 13 Oct), on a big coin too.
  const stays = await readAtOpen({ ...btc!, op: ">", mode: "within" });
  check("BTC above $80,000 this week, with BTC at $83,080: does it stay above to the close",
    stays.kind === "within" && stays.reading === "hold" && stays.check.mode === "always"
    && stays.question === "Will $BTC stay above $80,000 through the end of October 16, 2026 (UTC)?"
    && stays.hook === "BTC stays above $80,000 through Oct 16?"
    && stays.sentence === "Settles from the price of Bitcoin (BTC) on Binance's BTCUSDT spot pair. YES if its price stays above $80,000 from this market's opening on 2026-10-12 until 23:59 UTC on 2026-10-16, read from the BTCUSDT candles on Binance. NO if it trades at or below $80,000 at any point in that period.",
    JSON.stringify(stays));
  const gets = await readAtOpen({ ...btc!, op: ">", target: 90_000, mode: "within" });
  check("BTC above $90,000 this week, with BTC at $83,080: does it get there before the close",
    gets.kind === "within" && gets.reading === "reach" && gets.check.mode === "touch"
    && gets.question === "Will $BTC trade above $90,000 at any point before the end of October 16, 2026 (UTC)?"
    && gets.sentence === "Settles from the price of Bitcoin (BTC) on Binance's BTCUSDT spot pair. YES if its price is above $90,000 at any point between this market's opening on 2026-10-12 and 23:59 UTC on 2026-10-16, read from the BTCUSDT candles on Binance. NO otherwise.",
    JSON.stringify(gets));
  check("...and every one of them passes the wall every market is born behind",
    hit.kind === "reread" && stays.kind === "within" && gets.kind === "within"
    && [hit.sentence, hit.question, stays.sentence, stays.question, gets.sentence, gets.question]
      .every((t) => unsettleablePhrase(t) === null && addressInQuestion(t) === null && t.length > 0)
    && [hit.question, stays.question, gets.question].every((q) => q.length <= 180));
  now(83_300);
  const odd = await readAtOpen({ ...btc!, target: 83_250 });
  check("a level that is not round is never rounded into another one",
    odd.kind === "reread" && odd.question.includes("$83,250") && odd.sentence.includes("$83,250"), JSON.stringify(odd));
  const xrp = criteriaSentence(spotCheck({ symbol: "XRP", metric: "price", op: ">", target: 1.3075, mode: "at-close" }, WIN)!);
  check("...nor a coin quoted to four places", xrp.includes("above $1.3075 at 23:59 UTC") && !xrp.includes("$1.31"), xrp);
  now(83_080.02, Math.floor(Date.parse("2026-06-30T00:00:00Z") / 1000));
  const dead = await readAtOpen({ ...btc!, op: ">", mode: "within" });
  check("a pair whose newest candle is months old is not read as the price now",
    dead.kind === "within" && dead.reading === "close" && /BTCUSDT has not traded since 2026-06-30/.test(dead.why ?? ""), JSON.stringify(dead));
}

console.log("\nAn exchange pair is read to the minute");
{
  /* An exchange that trades every minute, its candles built from one price per
     minute and served the way Binance and Bybit serve them: the newest `limit`
     that start at or before the time asked. Which sizes were asked is kept. */
  const asked: Array<{ timeframe: string; limit: number; before?: number }> = [];
  const market = (priceAt: (minute: number) => number) => {
    asked.length = 0;
    _setPriceFeed({
      searchPairs: async () => [], searchPools: async () => [], tokenInfo: async () => null,
      async ohlcv(_chain, _pool, timeframe, limit, before) {
        asked.push({ timeframe, limit, before });
        const step = timeframe === "minute" ? 60 : timeframe === "hour" ? 3600 : 86_400;
        const out: Candle[] = [];
        for (let t = Math.floor((before ?? 0) / step) * step; out.length < limit; t -= step) {
          let high = -Infinity;
          let low = Infinity;
          for (let m = t; m < t + step; m += 60) { high = Math.max(high, priceAt(m)); low = Math.min(low, priceAt(m)); }
          out.push([t, priceAt(t), high, low, priceAt(t + step - 60), 1]);
        }
        return out;
      },
    });
  };
  const sec = (iso: string) => Date.parse(iso) / 1000;
  const CLOSE = sec("2026-10-18T23:59:00Z");
  const ETH = spotCheck({ symbol: "ETH", metric: "price", op: ">", target: 2350, mode: "at-close" }, { from: "2026-10-15T19:01:17.498Z", to: "2026-10-18T23:59:00.000Z" })!;

  market((m) => (m >= CLOSE - 120 ? 2411.39 : 2300));
  let v = await checkPrice(ETH);
  check("a close at 23:59 is read at 23:59, the last whole minute, not at 23:00",
    v.outcome === "yes" && v.observed === 2411.39 && v.why === "$2,411.39 at close", `${v.outcome} ${v.observed}: ${v.why}`);
  check("...from minutes alone, an hour of them", asked.length === 1 && asked[0].timeframe === "minute" && asked[0].limit === 60 && asked[0].before === CLOSE - 60, JSON.stringify(asked));
  market((m) => (m >= CLOSE ? 2411.39 : 2300));
  v = await checkPrice(ETH);
  check("...and a move made in the minute the market closes on does not count", v.outcome === "no" && v.observed === 2300, `${v.outcome}: ${v.why}`);

  const OPEN = sec("2026-10-15T19:10:41.334Z");
  const SUI = spotCheck({ symbol: "SUI", metric: "price", op: ">", target: 1, mode: "always" }, { from: "2026-10-15T19:10:41.334Z", to: "2026-10-18T23:59:00.000Z" })!;
  const dipAt = (minute: number) => (m: number) => (m === minute ? 0.99 : 1.05);
  market(dipAt(sec("2026-10-15T19:15:00Z")));
  v = await checkPrice(SUI);
  check("a hold broken in the market's first minutes is broken, though no whole hour had begun",
    v.outcome === "no" && v.observed === 0.99, `${v.outcome}: ${v.why}`);
  check("...read by the minute at both ends and by the hour between",
    asked.map((a) => a.timeframe).join(",") === "minute,hour,minute", JSON.stringify(asked));
  market(dipAt(sec("2026-10-15T19:10:00Z")));
  v = await checkPrice(SUI);
  check("...while a dip in the minute the market opened inside does not count", v.outcome === "yes", `${v.outcome}: ${v.why}`);
  market(dipAt(sec("2026-10-18T23:30:00Z")));
  v = await checkPrice(SUI);
  check("...and one in the last hour, before the close, does", v.outcome === "no", `${v.outcome}: ${v.why}`);
  market(dipAt(CLOSE));
  v = await checkPrice(SUI);
  check("...but not one at the close itself", v.outcome === "yes" && v.why === "it held the condition the whole window, worst was $1.05", `${v.outcome}: ${v.why}`);

  const reach = spotCheck({ symbol: "SUI", metric: "price", op: ">=", target: 1.2, mode: "touch" }, { from: "2026-10-15T19:10:41.334Z", to: "2026-10-18T23:59:00.000Z" })!;
  market((m) => (m === sec("2026-10-18T23:41:00Z") ? 1.21 : 1.05));
  v = await checkPrice(reach);
  check("a reach made in the last minutes before the close is a YES", v.outcome === "yes" && v.observed === 1.21, `${v.outcome}: ${v.why}`);
  market(() => 1.05);
  v = await checkPrice(reach);
  check("...and none made is a NO, the whole window read", v.outcome === "no", `${v.outcome}: ${v.why}`);

  const LONG = spotCheck({ symbol: "BTC", metric: "price", op: ">", target: 80_000, mode: "always" }, { from: "2026-09-01T00:00:00.000Z", to: "2026-10-21T00:00:00.000Z" })!;
  market((m) => (m === sec("2026-09-01T03:07:00Z") ? 79_999 : 81_000));
  v = await checkPrice(LONG);
  check("fifty days of hours are read in pages, and a break on the first day is found",
    v.outcome === "no" && v.observed === 79_999 && asked.filter((a) => a.timeframe === "hour").length === 2, `${v.outcome}: ${v.why} ${JSON.stringify(asked)}`);

  /* 20 OCT: Bee's ETH market, read the evening it opened. ETH opened at
     $2,387 and traded at $2,478 that afternoon: a YES at once, read to the last
     whole minute before now and never from a minute after it. */
  const BEE = spotCheck({ symbol: "ETH", metric: "price", op: ">", target: 2400, mode: "touch" }, { from: "2026-10-20T12:05:38.584Z", to: "2026-10-25T23:59:00.000Z" })!;
  const EVENING = new Date("2026-10-20T19:30:20Z");
  const beeAt = () => decide({ slug: "e7bd97", question: "q", criteria: criteriaSentence(BEE), closeTime: BEE.to, priceCheck: BEE }, EVENING);
  market((m) => (m === sec("2026-10-20T15:42:00Z") ? 2478 : 2387));
  let early = await beeAt();
  check("an exchange touch made this afternoon settles YES this evening, five days before the close",
    early.settle === "yes" && early.gate === "settled" && early.reason.includes("$2,478") && early.reason.includes("by 2026-10-20T19:30:00.000Z"), `${early.gate}: ${early.reason}`);
  check("...asking for nothing that starts after the last whole minute", asked.length > 0 && asked.every((a) => (a.before ?? Infinity) < sec("2026-10-20T19:30:00Z")), JSON.stringify(asked));
  market((m) => (m === sec("2026-10-20T19:31:00Z") ? 2478 : 2387));
  early = await beeAt();
  check("...and a move after now is no move yet", early.gate === "not-closed" && early.settle === null, `${early.gate}: ${early.reason}`);

  _setPriceFeed(null);
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  const answer = (body: unknown, status = 200) => (async (u: string | URL | Request) => { urls.push(String(u)); return new Response(JSON.stringify(body), { status }); }) as typeof fetch;
  try {
    globalThis.fetch = answer([[1792540680000, "2412.61", "2413.00", "2411.00", "2411.39", "52.1", 1792540739999, "1", 1, "1", "1", "0"]]);
    const got = await priceFeed().ohlcv("binance", "ETHUSDT", "minute", 60, 1792540680);
    check("Binance's klines come back in the feed's shape, seconds and numbers",
      JSON.stringify(got) === JSON.stringify([[1792540680, 2412.61, 2413, 2411, 2411.39, 52.1]]), JSON.stringify(got));
    check("...asked of the public market-data host, by the minute, up to the moment given",
      /^https:\/\/data-api\.binance\.vision\/api\/v3\/klines\?symbol=ETHUSDT&interval=1m&limit=60&endTime=1792540680000$/.test(urls[0] ?? ""), urls[0]);
    globalThis.fetch = answer({ code: -1121, msg: "Invalid symbol." });
    const refused = await priceFeed().ohlcv("binance", "NOPEUSDT", "hour", 1).catch((e) => e as Error);
    check("...and an answer that is not candles is an error, never an empty history", refused instanceof Error && /Invalid symbol/.test(refused.message), String(refused));
    globalThis.fetch = answer({ retCode: 0, retMsg: "OK", result: { list: [] } });
    await priceFeed().ohlcv("bybit", "CLUSDT", "minute", 10, 1760400000);
    check("Bybit is asked for minutes as interval 1", /symbol=CLUSDT&interval=1&limit=10&end=1760400000000/.test(urls[urls.length - 1] ?? ""), urls[urls.length - 1]);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nGold, silver and oil on Bybit's candles");
{
  /* bee_empire's gold and CL markets (12 Oct) had no price behind them: no
     Solana pool trades the metal, so the open could not read it and the rule
     was prose for a page-settled oracle. Bybit lists all four as perpetuals and
     serves their candles with no key; a commodity now rides the token rail. */
  _setPriceFeed(null);
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  const bybit = (body: unknown) => (async (u: string | URL | Request) => { urls.push(String(u)); return new Response(JSON.stringify(body), { status: 200 }); }) as typeof fetch;
  try {
    globalThis.fetch = bybit({ retCode: 0, retMsg: "OK", result: { list: [
      ["1760353200000", "4188.44", "4194.45", "4186.71", "4193.07", "120.5", "1"],
      ["1760349600000", "4193.94", "4196.61", "4186.62", "4188.44", "98.1", "1"],
    ] } });
    const got = await priceFeed().ohlcv("bybit", "XAUUSDT", "hour", 2, 1760400000);
    check("Bybit's candles come back in the feed's shape, seconds and numbers",
      JSON.stringify(got) === JSON.stringify([[1760353200, 4188.44, 4194.45, 4186.71, 4193.07, 120.5], [1760349600, 4193.94, 4196.61, 4186.62, 4188.44, 98.1]]), JSON.stringify(got));
    check("...asked of the linear perpetual, hourly, up to the moment given",
      /api\.bybit\.com\/v5\/market\/kline\?category=linear&symbol=XAUUSDT&interval=60&limit=2&end=1760400000000/.test(urls[0] ?? ""), urls[0]);
    globalThis.fetch = bybit({ retCode: 10001, retMsg: "params error: symbol invalid" });
    const refused = await priceFeed().ohlcv("bybit", "NOPEUSDT", "hour", 1).catch((e) => e as Error);
    check("...and a refusal from Bybit is an error, never an empty history", refused instanceof Error && /symbol invalid/.test(refused.message), String(refused));
  } finally {
    globalThis.fetch = realFetch;
  }

  const WIN = { from: "2026-10-13T11:00:00.000Z", to: "2026-10-16T21:00:00.000Z" };
  const gold = commodityCheck({ symbol: "XAU", metric: "price", op: "<", target: 4200, mode: "within" }, WIN);
  check("gold is pinned to Bybit's XAUUSDT, never searched for as a token",
    gold?.chain === "bybit" && gold.pool === "XAUUSDT" && gold.mint === "XAUUSDT" && gold.symbol === "XAU", JSON.stringify(gold));
  check("...as are silver, WTI and Brent, however the symbol is written",
    commodityCheck({ symbol: "XAG", metric: "price", op: ">", target: 50, mode: "touch" }, WIN)?.pool === "XAGUSDT"
    && commodityCheck({ symbol: "$cl", metric: "price", op: ">", target: 90, mode: "touch" }, WIN)?.pool === "CLUSDT"
    && commodityCheck({ symbol: "BZ", metric: "price", op: "<", target: 80, mode: "touch" }, WIN)?.pool === "BZUSDT");
  check("...while a token is not a commodity, and a metal has no market cap",
    commodityCheck({ symbol: "SOL", metric: "price", op: ">", target: 100, mode: "touch" }, WIN) === null
    && commodityCheck({ symbol: "XAU", metric: "mc", op: ">", target: 1e12, mode: "touch" }, WIN) === null);

  const rule = criteriaSentence({ ...gold!, mode: "at-close", target: 4250 });
  check("its rule names the perpetual and the level in full",
    rule === "Settles from the price of gold (XAU/USD) on Bybit's XAUUSDT perpetual. YES if its price is below $4,250 at 21:00 UTC on 2026-10-16, read from the XAUUSDT candles on Bybit. NO otherwise.", rule);

  const H = Date.parse("2026-10-13T11:00:00Z") / 1000;
  const at = (price: number) => _setPriceFeed({
    searchPairs: async () => [], searchPools: async () => [], tokenInfo: async () => null,
    async ohlcv(chain, pool) { return chain === "bybit" && pool === "XAUUSDT" ? [[H, price, price, price, price, 1]] as Candle[] : []; },
  });
  at(4193.88);
  const stays = await readAtOpen(gold!);
  check("gold below $4,200 with gold at $4,193.88 asks whether it stays there",
    stays.kind === "within" && stays.reading === "hold" && stays.check.mode === "always"
    && stays.question === "Will gold (XAU/USD) stay below $4,200 until 21:00 UTC on October 16, 2026?"
    && stays.hook === "Gold stays below $4,200 until 21:00 UTC?", JSON.stringify(stays));
  check("...under a rule on Bybit's candles, the whole way", stays.kind === "within"
    && stays.sentence === "Settles from the price of gold (XAU/USD) on Bybit's XAUUSDT perpetual. YES if its price stays below $4,200 from this market's opening on 2026-10-13 until 21:00 UTC on 2026-10-16, read from the XAUUSDT candles on Bybit. NO if it trades at or above $4,200 at any point in that period.", stays.kind === "within" ? stays.sentence : "");
  at(4250);
  const gets = await readAtOpen(gold!);
  check("...and with gold above it, whether it gets there",
    gets.kind === "within" && gets.reading === "reach" && gets.question === "Will gold (XAU/USD) trade below $4,200 at any point before 21:00 UTC on October 16, 2026?", JSON.stringify(gets));
  at(4193.88);
  const hit = await readAtOpen({ ...gold!, op: "<=", target: 4250.5, mode: "touch" });
  check("a move already made at the open is read at the close, the level never rounded",
    hit.kind === "reread" && hit.question === "Will gold (XAU/USD) be at or below $4,250.5 at 21:00 UTC on October 16, 2026?", JSON.stringify(hit));

  if (stays.kind === "within") {
    serve([], {}, [[H + 3600, 4190, 4199, 4185, 4195, 1], [H + 7200, 4195, 4203, 4190, 4198, 1]]);
    const v = await checkPrice(stays.check);
    check("the oracle settles it from the candles: an hour over $4,200 ends the hold", v.outcome === "no" && v.observed === 4203, v.why);
  }
  {
    /* 20 OCT: BYBIT'S LIVE API ANSWERS THE SERVER 403. The server runs in the
       US. Bybit's own public archive of every trade, one file a day, answers,
       so a window is read from those trades. Last of the Bybit checks: once
       refused, the live API is not asked again for hours. */
    _setPriceFeed(null);
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    const s = (iso: string) => Date.parse(iso) / 1000;
    const file = (rows: Array<[string, number]>) => gzipSync(Buffer.from(["timestamp,symbol,side,size,price,tickDirection,trdMatchID,grossValue,homeNotional,foreignNotional",
      ...rows.map(([iso, p]) => `${(Date.parse(iso) / 1000).toFixed(4)},CLUSDT,Buy,2,${p},PlusTick,x,1,2,${p * 2}`)].join("\n")));
    // Out of order on purpose: a candle opens on its earliest trade, not its first line.
    const day16 = file([["2026-10-16T20:58:40Z", 91.2], ["2026-10-16T20:58:10Z", 91.5], ["2026-10-16T20:59:05Z", 91.0], ["2026-10-16T20:59:59Z", 91.3], ["2026-10-16T21:00:00Z", 95]]);
    globalThis.fetch = (async (u: string | URL | Request) => {
      const url = String(u);
      urls.push(url);
      if (url.startsWith("https://api.bybit.com")) return new Response("Forbidden", { status: 403 });
      if (url === "https://public.bybit.com/trading/CLUSDT/CLUSDT2026-10-16.csv.gz") return new Response(day16, { status: 200 });
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;
    try {
      const minutes = await priceFeed().ohlcv("bybit", "CLUSDT", "minute", 2, s("2026-10-16T20:59:00Z"));
      check("refused by Bybit's live API, the feed reads Bybit's own trade archive",
        urls[0]?.startsWith("https://api.bybit.com") === true && urls[1] === "https://public.bybit.com/trading/CLUSDT/CLUSDT2026-10-16.csv.gz", urls.join(" "));
      check("...into minute candles: open on the earliest trade, high, low, close on the latest",
        JSON.stringify(minutes.sort((a, b) => a[0] - b[0])) === JSON.stringify([[s("2026-10-16T20:58:00Z"), 91.5, 91.5, 91.2, 91.2, 4], [s("2026-10-16T20:59:00Z"), 91, 91.3, 91, 91.3, 4]]), JSON.stringify(minutes));
      const hour = await priceFeed().ohlcv("bybit", "CLUSDT", "hour", 1, s("2026-10-16T20:00:00Z"));
      check("...and hours from its minutes", JSON.stringify(hour) === JSON.stringify([[s("2026-10-16T20:00:00Z"), 91.5, 91.5, 91, 91.3, 8]]), JSON.stringify(hour));
      check("...without asking the live API again once it has refused", urls.filter((u) => u.startsWith("https://api.bybit.com")).length === 1, urls.join(" "));
      const cl = commodityCheck({ symbol: "CL", metric: "price", op: ">", target: 91, mode: "at-close" }, { from: "2026-10-16T20:00:00.000Z", to: "2026-10-16T21:00:00.000Z" })!;
      let v = await checkPrice(cl);
      check("the close is the last trade before it, and the trade at the close itself does not count", v.outcome === "yes" && v.observed === 91.3, `${v.outcome} ${v.observed}: ${v.why}`);
      v = await checkPrice({ ...cl, to: "2026-10-17T01:00:00.000Z", mode: "always", target: 90 });
      check("a day whose file is not out yet is unreadable, never a window cut short",
        v.outcome === null && v.candles === 0 && /no CLUSDT file for 2026-10-17 yet/.test(v.why), `${v.outcome}: ${v.why}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
  const silver = commodityCheck({ symbol: "XAG", metric: "price", op: "<", target: 4200, mode: "always" }, WIN)!;
  check("two gold claims alike are one market, and gold is never silver",
    samePriceBet(stays.kind === "within" ? stays.check : gold!, commodityCheck({ symbol: "XAU", metric: "price", op: "<", target: 4200, mode: "always" }, WIN)!)
    && !samePriceBet(silver, commodityCheck({ symbol: "XAU", metric: "price", op: "<", target: 4200, mode: "always" }, WIN)!));
}

console.log("\nGold at the open from Pyth on Solana, when Bybit cannot be read");
{
  /* 22 OCT: Bybit refuses this server and its archive is a day behind, so a
     gold market opened with no price, and "gold above $4,200 this week" could
     not be told apart as a hold or a reach. Pyth's gold on Solana stands in at
     the open, and only well clear of the level: measured that day, Pyth sat $8
     to $10 under Bybit's perpetual. */
  // The real account, read from mainnet at 10:28 UTC on 22 Oct: gold at $4,092.09.
  const REAL = Buffer.from("IvEjY51+9M0cRzfajUOUjvOlYNVt8J8QnvDN3omvjSjJtxOdRdRaswF2XSupBtvDLKF8wR9TEKienuH2QgUIxjhh8vi6TuNLsrpwPgAAAAAAeAAAAAAAAAD9////WeXZagAAAABY5dlqAAAAAL1dPgAAAAAAmgAAAAAAAADAEGsbAAAAAAA=", "base64");
  const u = parsePriceUpdate(REAL);
  check("Pyth's gold account is read: its feed, price, uncertainty and when it was published, fully verified",
    u?.feed === PYTH_ACCOUNTS.XAUUSDT.feed && u.price === 4092.09 && u.conf === 0.12 && u.publishTime === Date.parse("2026-10-22T10:28:41Z") / 1000 && u.full, JSON.stringify(u));
  check("...and bytes that are not a price account are not read", parsePriceUpdate(Buffer.alloc(134)) === null && parsePriceUpdate(REAL.subarray(0, 60)) === null);

  const PUB = u!.publishTime * 1000;
  const RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
  let reads: string[] = [];
  const account = (o: { owner?: string; data?: Buffer } | null | Error = {}) => _setPythReader(async (a) => {
    reads.push(a);
    if (o instanceof Error) throw o;
    return o === null ? null : { owner: o.owner ?? RECEIVER, data: o.data ?? REAL };
  });
  account();
  let p = await pythPrice("XAUUSDT", PUB + 30_000);
  check("a price published half a minute ago is the price now", p.ok && p.price === 4092.09 && reads[0] === PYTH_ACCOUNTS.XAUUSDT.account, JSON.stringify(p));
  p = await pythPrice("XAUUSDT", PUB + (PYTH_FRESH_S + 60) * 1000);
  check("...four minutes ago it is not: Pyth's gold stops with the gold market, Bybit's perpetual does not",
    !p.ok && /last published 4 minutes ago/.test(p.why), JSON.stringify(p));
  account({ owner: "11111111111111111111111111111111" });
  p = await pythPrice("XAUUSDT", PUB);
  check("an account Pyth's receiver did not write is not Pyth's price", !p.ok && /receiver/.test(p.why), JSON.stringify(p));
  // Partial verification carries a signature count: everything after it moves one byte.
  account({ data: Buffer.concat([REAL.subarray(0, 40), Buffer.from([0, 3]), REAL.subarray(41)]) });
  p = await pythPrice("XAUUSDT", PUB);
  check("...nor a price only partly verified", !p.ok && /partly verified/.test(p.why), JSON.stringify(p));
  const other = Buffer.from(REAL);
  other[41] ^= 0xff;
  account({ data: other });
  check("...nor an account holding another feed", !(await pythPrice("XAUUSDT", PUB)).ok);
  account(null);
  check("...nor an account that is not there, as on devnet", !(await pythPrice("XAUUSDT", PUB)).ok);
  account(new Error("the Solana RPC answered 429"));
  p = await pythPrice("XAUUSDT", PUB);
  check("an RPC that does not answer is no price, never a throw", !p.ok && /429/.test(p.why), JSON.stringify(p));
  reads = [];
  account();
  check("silver, WTI and Brent have no current Pyth price on Solana, and nothing is read for them",
    !(await pythPrice("XAGUSDT", PUB)).ok && !(await pythPrice("CLUSDT", PUB)).ok && !(await pythPrice("BZUSDT", PUB)).ok && reads.length === 0);

  /* Through the open itself, with Bybit failing as it does on the server. The
     price and publish time are rewritten into the real account: price at byte
     73, its exponent at 89, the publish time at 93. */
  const fresh = (price: number, at = Date.now()) => {
    const b = Buffer.from(REAL);
    b.writeBigInt64LE(BigInt(Math.round(price / 10 ** b.readInt32LE(89))), 73);
    b.writeBigInt64LE(BigInt(Math.floor(at / 1000)), 93);
    return b;
  };
  const unreadable = () => _setPriceFeed({
    searchPairs: async () => [], searchPools: async () => [], tokenInfo: async () => null,
    async ohlcv(_c, pool) { throw new Error(`Bybit's archive has no ${pool} file for today yet`); },
  });
  unreadable();
  const WEEK = { from: new Date().toISOString(), to: new Date(Date.now() + 3 * 86_400_000).toISOString() };
  const above = commodityCheck({ symbol: "XAU", metric: "price", op: ">", target: 4200, mode: "within" }, WEEK)!;
  account({ data: fresh(4092.09) });
  let o = await readAtOpen(above);
  check("gold above $4,200 this week with Pyth at $4,092.09: whether it gets there",
    o.kind === "within" && o.reading === "reach" && o.now === 4092.09 && o.check.mode === "touch", JSON.stringify(o));
  check("...still settled from Bybit's candles, as the rule says",
    o.kind === "within" && o.check.chain === "bybit" && /read from the XAUUSDT candles on Bybit/.test(o.sentence), o.kind === "within" ? o.sentence : "");
  o = await readAtOpen({ ...above, target: 4000 });
  check("...above $4,000: whether it stays there", o.kind === "within" && o.reading === "hold" && o.check.mode === "always", JSON.stringify(o));
  o = await readAtOpen({ ...above, target: 4100 });
  check("...above $4,100, 0.2% away, where Pyth and Bybit can disagree: where the week ends, as before",
    o.kind === "within" && o.reading === "close" && /too close to say which side Bybit is on/.test(o.why ?? ""), JSON.stringify(o));
  const met = await readAtOpen({ ...above, target: 4000, mode: "touch" });
  check("a touch Pyth says is already met is read at the close", met.kind === "reread" && met.was === "yes", JSON.stringify(met));
  account({ data: fresh(4092.09, Date.now() - 2 * 86_400_000) });
  o = await readAtOpen(above);
  check("over the weekend Pyth's Friday price is not the price now: where the week ends, as before",
    o.kind === "within" && o.reading === "close" && /last published/.test(o.why ?? ""), JSON.stringify(o));
  reads = [];
  account({ data: fresh(4092.09) });
  o = await readAtOpen(commodityCheck({ symbol: "XAG", metric: "price", op: ">", target: 50, mode: "within" }, WEEK)!);
  check("silver is read where its week ends, as before, without asking Pyth", o.kind === "within" && o.reading === "close" && reads.length === 0, JSON.stringify(o));
  o = await readAtOpen(spotCheck({ symbol: "BTC", metric: "price", op: ">", target: 90_000, mode: "within" }, WEEK)!);
  check("...and a coin on Binance never asks Pyth", reads.length === 0, JSON.stringify(o));
  _setPythReader(null);
  _setPriceFeed(null);
}

console.log("\nwired where every market is born");
{
  const server = readFileSync("src/server.ts", "utf8");
  const born = server.slice(server.indexOf("async function openMarketFromClaim("), server.indexOf("async function openerWalletFor("));
  const read = born.indexOf("const atOpen = await readAtOpen(r.check);");
  check("openMarketFromClaim reads the price at the open once the token is pinned", read > born.indexOf("const r = await resolvePriceClaim("));
  check("...before the wall and the twin check judge the market's words",
    read > 0 && read < born.indexOf("const hedged = unsettleablePhrase(") && read < born.indexOf("const twin = await findDuplicate("));
  check("...and the row, the room and every door get the words it opened under",
    /createCommunityMarket\(\{ question, [^}]*\bhook, marketId/.test(born) && born.includes("headline: foldIds(hook || question)")
    && born.includes("ok: true, slug, marketId, question, hook,") && (server.match(/question: out\.question, hook: out\.hook/g) ?? []).length === 3);
  check("a price that cannot be read is logged, never a refusal",
    born.includes('line: "price not read at the open, opened as it reads"') && born.includes("line: \"no pinned price at the open, opened on the model's rule\""));
  check("gold and oil are pinned to their Bybit perpetual and a big coin to its Binance pair, before any token search",
    /const exchange = commodityCheck\(input\.priceClaim, window\) \?\? spotCheck\(input\.priceClaim, window\);\s*const r = exchange\s*\? \{ ok: true as const, check: exchange, sentence: criteriaSentence\(exchange\) \}\s*: await resolvePriceClaim\(/.test(born));
  check("...so nothing reads a coin at the open and leaves its rule to a page any more", !born.includes("readSpotAtOpen") && !server.includes("binancePrices.venue"));
  const prompt = readFileSync("src/matching/extractClaim.ts", "utf8");
  check("the extractor names gold, silver and oil by the symbols the rail knows",
    prompt.includes("or about the PRICE of gold, silver or crude oil") && prompt.includes("exactly XAU for gold, XAG for silver, CL for WTI crude and for crude oil named without a grade, BZ for Brent crude"));
  check("the extractor marks a level over a period for the open to read: above means above, below means below",
    prompt.includes("8. A LEVEL OVER A PERIOD: ABOVE MEANS ABOVE, BELOW MEANS BELOW.") && prompt.includes('"within" for a level over a period with no move named')
    && prompt.includes('"below X this week" (rule 8)') && /enum: \["touch", "at-close", "always", "within"\]/.test(prompt));
}

console.log("\nthe one-way boot step lands even beside the schema");
{
  /* Live on 13 Oct: the deploy logged "[reread] failed (non-fatal): deadlock
     detected" and SOL, HYPE, CL and gold all kept yesterday's words. The step
     ran its UPDATEs without waiting for the schema, beside the boot DDL. */
  const store = readFileSync("src/store/markets.ts", "utf8");
  const step = store.slice(store.indexOf("export async function rereadMisreadMarkets("), store.indexOf("export async function retryOnDeadlock"));
  check("it waits for the schema before its first statement",
    step.indexOf("await ensureSchema();") > 0 && step.indexOf("await ensureSchema();") < step.indexOf("db().query"));
  check("...and runs each statement through the deadlock retry", /await retryOnDeadlock\(\(\) => db\(\)\.query/.test(step));
  const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });
  let calls = 0;
  const twice = await retryOnDeadlock(async () => { if (++calls < 3) throw deadlock; return "landed"; }, 3, 0).catch(() => "threw");
  check("a deadlock is run again until it lands", twice === "landed" && calls === 3, String(calls));
  calls = 0;
  const other = await retryOnDeadlock(async () => { calls++; throw Object.assign(new Error("syntax"), { code: "42601" }); }, 3, 0).catch((e) => e as Error);
  check("...anything else is thrown at once", other instanceof Error && other.message === "syntax" && calls === 1, String(calls));
  calls = 0;
  const stuck = await retryOnDeadlock(async () => { calls++; throw deadlock; }, 3, 0).catch((e) => e as Error);
  check("...and a deadlock that keeps coming is thrown after three goes", stuck === deadlock && calls === 3, String(calls));
}

console.log("\nsix closed markets get the price rule their words state, once");
{
  /* 20 Oct: gold, CL, ETH, XRP, BNB and SUI closed with rules that name a
     price at a minute, and the page-settled oracle could not read one. The
     boot step gives each a price_check and touches nothing else. */
  const sql = PRICE_RULES_2026_10_20_SQL;
  const store = readFileSync("src/store/markets.ts", "utf8");
  const rows = [...sql.matchAll(/\('([a-z0-9-]+)',\s*'((?:[^']|'')*)',\s*'(\{[^']*\})'::jsonb\)/g)]
    .map((m) => ({ slug: m[1], question: m[2].replace(/''/g, "'"), check: JSON.parse(m[3]) as PriceCheck }));
  check("six markets, each named by its slug and the words it closed under",
    rows.length === 6 && rows.every((r) => r.question.startsWith("Will ") && r.question.endsWith("?")), rows.map((r) => r.slug).join(","));
  check("gold and CL are read on Bybit, the coins on Binance, each on its own pair",
    rows.every((r) => r.check.chain === (["XAU", "CL"].includes(r.check.symbol) ? "bybit" : "binance") && r.check.pool === r.check.mint
      && r.check.pool === (r.check.chain === "bybit" ? commodityCheck({ symbol: r.check.symbol, metric: "price", op: ">", target: 1, mode: "touch" }, WINDOW)?.pool
        : spotCheck({ symbol: r.check.symbol, metric: "price", op: ">", target: 1, mode: "touch" }, WINDOW)?.pool)), JSON.stringify(rows.map((r) => r.check.pool)));
  check("each rule is the one its words state",
    rows.map((r) => `${r.check.symbol} ${r.check.op} ${r.check.target} ${r.check.mode} ${r.check.to.slice(0, 16)}`).join(" | ")
      === "XAU < 4200 at-close 2026-10-16T21:00 | CL > 90 always 2026-10-16T21:00 | ETH > 2350 at-close 2026-10-18T23:59 | XRP > 1.3 at-close 2026-10-18T23:59 | BNB > 710 at-close 2026-10-18T23:59 | SUI > 1 always 2026-10-18T23:59",
    rows.map((r) => `${r.check.symbol} ${r.check.op} ${r.check.target} ${r.check.mode} ${r.check.to}`).join(" | "));
  check("...each read from the minute its market opened, never earlier",
    rows.every((r) => /^2026-10-1[25]T19:\d\d:\d\d\.\d{3}Z$/.test(r.check.from) && Date.parse(r.check.from) < Date.parse(r.check.to)));
  check("only the price_check is set, and only where there is none, no outcome and no retirement",
    sql.slice(sql.indexOf("UPDATE"), sql.indexOf("FROM fix f")).trim() === "UPDATE community_market c SET price_check = f.pc"
    && sql.includes("c.price_check IS NULL AND c.resolved_outcome IS NULL AND c.retired_at IS NULL"));
  check("...and only while each still reads as it closed", sql.includes("JOIN market_slug s ON s.slug = f.slug AND s.question = f.question"));
  check("it runs at boot with the other one-way steps", /RETURN_GOLD_2026_10_15, PRICE_RULES_2026_10_20[,\]]/.test(store));
}

console.log("\nsix open coin markets get the price rule their words state, once");
{
  /* 20 Oct, evening: three Bitcoin markets from before any big coin had a
     venue, and three of Bee's opened 2h40m before the Binance rail, all six
     naming CoinMarketCap. The boot step pins each to its Binance pair and
     touches nothing else. */
  const sql = COIN_RULES_2026_10_20_SQL;
  const store = readFileSync("src/store/markets.ts", "utf8");
  const rows = [...sql.matchAll(/\('([a-z0-9-]+)',\s*'((?:[^']|'')*)',\s*'(\{[^']*\})'::jsonb\)/g)]
    .map((m) => ({ slug: m[1], question: m[2].replace(/''/g, "'"), check: JSON.parse(m[3]) as PriceCheck }));
  check("six markets, each named by its slug and the words it opened under",
    rows.length === 6 && rows.every((r) => r.question.startsWith("Will ") && r.question.endsWith("?")), rows.map((r) => r.slug).join(","));
  check("each is exactly the check a new market of its coin is pinned to",
    rows.every((r) => JSON.stringify(spotCheck({ symbol: r.check.symbol, metric: "price", op: r.check.op, target: r.check.target, mode: r.check.mode }, { from: r.check.from, to: r.check.to })) === JSON.stringify(r.check)),
    JSON.stringify(rows.map((r) => r.check.pool)));
  check("each rule is the one its words state",
    rows.map((r) => `${r.check.symbol} ${r.check.op} ${r.check.target} ${r.check.mode} ${r.check.to.slice(0, 16)}`).join(" | ")
      === "BTC >= 200000 touch 2026-12-31T23:59 | BTC >= 100000 touch 2026-12-31T23:59 | BTC > 126199.63 touch 2026-12-31T23:59 | BTC >= 80000 always 2026-10-25T23:59 | ETH > 2400 touch 2026-10-25T23:59 | BTC > 85000 touch 2026-10-30T23:59",
    rows.map((r) => `${r.check.symbol} ${r.check.op} ${r.check.target} ${r.check.mode} ${r.check.to}`).join(" | "));
  check("...each read from the minute its market opened, never earlier",
    rows.map((r) => r.check.from).join(",") === "2026-09-26T09:37:28.483Z,2026-09-27T07:28:50.562Z,2026-10-09T20:59:49.181Z,2026-10-20T12:05:03.230Z,2026-10-20T12:05:38.584Z,2026-10-20T12:07:28.139Z",
    rows.map((r) => r.check.from).join(","));
  check("only the price_check is set, and only where there is none, no outcome and no retirement",
    sql.slice(sql.indexOf("UPDATE"), sql.indexOf("FROM fix f")).trim() === "UPDATE community_market c SET price_check = f.pc"
    && sql.includes("c.price_check IS NULL AND c.resolved_outcome IS NULL AND c.retired_at IS NULL"));
  check("...and only while each still reads as it opened", sql.includes("JOIN market_slug s ON s.slug = f.slug AND s.question = f.question"));
  check("it runs at boot after the six closed ones", /PRICE_RULES_2026_10_20, COIN_RULES_2026_10_20\]/.test(store));
}

_setPriceFeed(null);

console.log(failures ? `\n${failures} failure(s)\n` : "\nall green\n");
process.exit(failures ? 1 : 0);
