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

import { _setPriceFeed, type Candle, type Pair, type TokenInfo } from "../src/price/feed.js";
import { resolvePriceClaim, checkPrice, criteriaSentence, type PriceCheck } from "../src/price/index.js";
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
function serve(pairs: Pair[], infos: Record<string, TokenInfo | null>, candles: Candle[] = [], exhausted = true) {
  _setPriceFeed({
    async searchPairs() { return pairs; },
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
check("the deepest token wins when it dominates", r.ok && r.check.mint === "AAA", r.ok ? "" : r.why);

serve(
  [pair({ baseMint: "AAA", baseSymbol: "TOK", liquidityUsd: 150_000 }), pair({ baseMint: "BBB", baseSymbol: "TOK", liquidityUsd: 100_000 })],
  { AAA: info({ mint: "AAA" }) },
);
r = await resolvePriceClaim(claim(), WINDOW);
check("two tokens of similar size under one ticker are refused, not guessed", !r.ok && /none of them clearly is the one/.test((r as any).why));

serve([pair({ baseMint: "AAA", baseSymbol: "TOK", liquidityUsd: 900 })], { AAA: info({ mint: "AAA" }) });
r = await resolvePriceClaim(claim(), WINDOW);
check("a token too thin to price is refused", !r.ok && /too little liquidity|enough real volume/.test((r as any).why));

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

_setProposer(null as any);
_setPriceFeed(null);

console.log(failures ? `\n${failures} failure(s)\n` : "\nall green\n");
process.exit(failures ? 1 : 0);
