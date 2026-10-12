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
import { _setPriceFeed, type Candle, type Pair, type PoolHit, type TokenInfo } from "../src/price/feed.js";
import { resolvePriceClaim, checkPrice, criteriaSentence, mintsIn, priceNow, decidedAtOpen, readAtOpen, closeQuestion, closeHook, type PriceCheck } from "../src/price/index.js";
import { samePriceBet } from "../src/matching/duplicate.js";
import { unsettleablePhrase, addressInQuestion } from "../src/matching/extractClaim.js";
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
  check("...and the same holds under the line", decidedAtOpen({ ...SOL, symbol: "HYPE", op: "<", target: 100 }, 83.6) === "yes");
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
  const prompt = readFileSync("src/matching/extractClaim.ts", "utf8");
  check("the extractor reads a level over a period at the period's end",
    prompt.includes("8. A LEVEL OVER A PERIOD IS READ WHERE THE PERIOD ENDS.") && prompt.includes('"below X this week" (rule 8)'));
}

_setPriceFeed(null);

console.log(failures ? `\n${failures} failure(s)\n` : "\nall green\n");
process.exit(failures ? 1 : 0);
