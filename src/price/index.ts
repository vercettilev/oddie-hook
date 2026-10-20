// Price claims: how "$BULLSHIT hits 4m this month" becomes a settleable market.
//
// THE DIVISION OF LABOUR IS THE POINT. A model reads the sentence and says what
// was claimed; it never says which token. Symbol -> mint is resolved HERE, by
// code, against live liquidity, and the answer is frozen into the market at
// creation. A hallucinated mint address is a plausible string that moves real
// money to the wrong outcome, so the model is never asked for one.
//
// AND IT IS FROZEN, not looked up again at settle. Between a market opening and
// closing, a copycat can deploy the same ticker and out-liquidity the original;
// resolving the symbol a second time would let that rewrite the bet after people
// staked on it. The mint, the pool and the supply are decided once, in front of
// the people who are about to bet, and the settle path only reads history.
//
// THE ASYMMETRY MIRRORS THE REST OF THE ORACLE. Over in audit.ts a quotation
// dated before the deadline can prove an event happened early but can never
// prove one failed to happen. The same shape holds here: one candle above the
// target proves a touch, while proving it NEVER touched requires the whole
// window. So a YES can settle on partial history and a NO cannot.

import { priceFeed, BYBIT_CHAIN, BINANCE_CHAIN, type Candle } from "./feed.js";

export type PriceOp = ">=" | ">" | "<=" | "<";
/** touch: true at any point in the window. at-close: true at the close time.
 *  always: true at every point in the window.
 *  within: a level over a period with no move named ("SOL above $100 in
 *  October"). Above means above and below means below: the price at the open
 *  decides which of the other two it is (readAtOpen), so "within" never reaches
 *  the oracle. */
export type PriceMode = "touch" | "at-close" | "always" | "within";

/** What a model is allowed to produce: language, and nothing identifying. */
export interface PriceClaim {
  symbol: string;
  metric: "mc" | "price";
  op: PriceOp;
  target: number;
  mode: PriceMode;
}

/** What gets frozen onto the market and handed to the oracle at settle. */
export interface PriceCheck {
  chain: string;
  mint: string;
  symbol: string;
  name: string;
  pool: string;
  /** Whole tokens at the moment the market opened. See the note above on why
   *  this is not re-read later. */
  supply: number;
  metric: "mc" | "price";
  op: PriceOp;
  target: number;
  mode: PriceMode;
  /** ISO. The window the claim covers; `to` is the market's close time. */
  from: string;
  to: string;
}

/* ONLY SOLANA, AND THIS IS A CORRECTNESS RULE RATHER THAN A PRODUCT ONE.
   DexScreener's search answers with about thirty pairs. For a ticker with any
   history that is a SAMPLE, not the candidate set, and the real token can be
   missing from it entirely -- which is how "$WIF" resolved, live, to a coin
   called "World is Flat" on the Robinhood chain while dogwifhat never appeared
   in the response at all. Dominance computed over a truncated, cross-chain
   sample is not dominance; it is the loudest thing that happened to fit in the
   page. Narrowing to the chain oddie actually settles on removes that entire
   class of impostor, and a claim about a token elsewhere is refused rather than
   answered with the wrong coin. */
const CHAIN = "solana";

/* LIQUIDITY IS NOT A GATE HERE, AND MEASURING IT IS WHY.
   DexScreener reports liquidity.usd as 0 for pumpswap and several bonding-curve
   pools -- the exact venues Solana memecoins are born on. $NVIDA, doing
   $153,248,387 of volume in twenty-four hours, reports zero liquidity on its
   main pool. A floor on that field therefore refused the most heavily traded
   tokens on the chain while letting quiet ones through, which is backwards. The
   field is used only where it exists and never to reject. Volume is reported
   everywhere and is the harder number to fake, so it carries the gate alone. */
export const MIN_VOLUME_24H_USD = 10_000;
/** The leader must be this many times the runner-up. 15 tokens answer to
 *  "BULLSHIT" and 21 to "WIF"; picking among them by a nose would mean settling
 *  somebody's money on a coin flip over which one the tweet meant. */
export const DOMINANCE = 5;
/** Circulating and total supply must agree this closely, or "market cap" does
 *  not name one number and the claim cannot be pinned. */
export const SUPPLY_AGREEMENT = 0.01;
/** Tickers whose MARKET CAP is a fact about an asset, not about the token that
 *  trades under that ticker on a DEX. The pool for SOL is wrapped SOL, and the
 *  wrapper's supply is whatever happens to be wrapped right now, so multiplying
 *  it by the price gives a number that is not SOL's market cap and is not
 *  anything else either. Their PRICE is fine and stays allowed. */
const MAJORS = new Set(["SOL", "BTC", "ETH", "BNB", "USDC", "USDT", "WBTC", "WETH", "WSOL"]);

const HOUR = 3600;
const DAY = 86_400;

export interface ResolveOk { ok: true; check: PriceCheck; sentence: string }
export interface ResolveNo { ok: false; why: string }

/** Base58 strings the length of a Solana mint. Deliberately loose: every
 *  candidate is then verified against the ticker that was actually claimed, so
 *  a coincidental match cannot become the market's token. Tweet ids and status
 *  URLs are digits and too short to reach 32 base58 characters. */
export function mintsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[1-9A-HJ-NP-Za-km-z]{32,44}/g)) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out.slice(0, 4);
}

/**
 * Symbol -> a specific token, or a refusal naming what was ambiguous.
 *
 * `window.from` is only meaningful for "touch"/"always"; an "at-close" claim
 * uses `to` alone.
 */
export async function resolvePriceClaim(
  claim: PriceClaim,
  window: { from: string; to: string },
  opts: { text?: string | null } = {},
): Promise<ResolveOk | ResolveNo> {
  const symbol = claim.symbol.replace(/^\$/, "").trim();
  if (!symbol) return { ok: false, why: "no ticker to look up" };
  if (!(claim.target > 0)) return { ok: false, why: "the target is not a positive number" };

  /* AN ADDRESS IN THE TEXT BEATS EVERY HEURISTIC BELOW, and this room pastes
     addresses constantly. Everything after this point is inference about which
     token a ticker means -- inference that correctly refuses eleven of thirty
     measured tickers and still picks a different issuer on some of the rest,
     because a ticker is not an identity. A contract address IS one. So if the
     claim carries one, the guessing is skipped entirely.

     It is still VERIFIED rather than trusted: the address must belong to a
     token whose symbol is the one that was claimed. Otherwise a stray base58
     string, or a pasted pair address, would quietly become the coin somebody's
     money settles against. */
  for (const candidate of opts.text ? mintsIn(opts.text) : []) {
    let info;
    try {
      info = await priceFeed().tokenInfo(CHAIN, candidate);
    } catch {
      break; // the source is down; fall through to the search path
    }
    if (!info) continue;
    if (info.symbol.replace(/^\$/, "").toUpperCase() !== symbol.toUpperCase()) continue;
    if (claim.metric === "mc" && !(info.totalSupply && info.totalSupply > 0)) continue;
    const pool = info.topPools[0];
    if (!pool) continue;
    const named: PriceCheck = {
      chain: CHAIN, mint: info.mint, symbol: info.symbol.replace(/^\$/, ""), name: info.name, pool,
      supply: info.totalSupply ?? 0, metric: claim.metric, op: claim.op, target: claim.target,
      mode: claim.mode, from: window.from, to: window.to,
    };
    return { ok: true, check: named, sentence: criteriaSentence(named) };
  }

  /* TWO INDEXES, UNIONED, AND THE UNION IS A SAFETY DEVICE.
     DexScreener's search and GeckoTerminal's search disagree about how many
     tokens answer to a ticker, and measuring that disagreement is what exposed
     the real defect. Searching "GOOGL" on DexScreener returns two Solana
     tokens, one of them 12,000x the other, so the dominance test below passed
     and a market opened. GeckoTerminal returns TEN, three of them within 10% of
     each other at $34-38M of daily volume apiece. The ticker never identified a
     token; one index simply could not see that.

     Unioning is fail-safe by construction: more candidates can only make
     dominance harder to reach, never easier. A token that still dominates the
     union dominates everything either source knows about. */
  let pairs, hits;
  try {
    [pairs, hits] = await Promise.all([priceFeed().searchPairs(symbol), priceFeed().searchPools(symbol)]);
  } catch (e) {
    return { ok: false, why: `the token search failed: ${(e as Error).message}` };
  }

  // One entry per token: volume and liquidity summed across its pools, deepest
  // pool kept as the one to read history from.
  const byMint = new Map<string, { chain: string; mint: string; name: string; symbol: string; liq: number; vol: number; mc: number | null; fdv: number | null; pool: string; poolVol: number }>();
  for (const p of pairs) {
    if (p.chainId !== CHAIN) continue;
    if (p.baseSymbol.replace(/^\$/, "").toUpperCase() !== symbol.toUpperCase()) continue;
    const key = `${p.chainId}:${p.baseMint}`;
    const e = byMint.get(key) ?? { chain: p.chainId, mint: p.baseMint, name: p.baseName, symbol: p.baseSymbol, liq: 0, vol: 0, mc: p.marketCap, fdv: p.fdv, pool: "", poolVol: -1 };
    e.liq += p.liquidityUsd;
    e.vol += p.volumeH24;
    // The pool to read candles from is the BUSIEST, not the deepest, for the
    // same reason: depth reads 0 on the venues that matter and picking by it
    // chose an arbitrary dead pool whose candles say nothing.
    if (p.volumeH24 > e.poolVol) { e.poolVol = p.volumeH24; e.pool = p.pairAddress; }
    if (e.mc === null) e.mc = p.marketCap;
    if (e.fdv === null) e.fdv = p.fdv;
    byMint.set(key, e);
  }

  /* RANKED BY TRADING, NOT BY DEPTH, AND THAT CORRECTION MATTERS.
     The first version of this sorted by liquidity, and measuring it broke it:
     the top two tokens answering to "WIF" showed a BILLION dollars of liquidity
     each, a market cap equal to that liquidity to the cent, and FOUR DOLLARS of
     volume in twenty-four hours. Nothing was trading them. A nominal pool
     balance is cheap to post and it ranked those two above everything real, so
     anyone willing to post one could have become "$WIF" as far as this oracle
     was concerned, and then collected on a market about somebody else's coin.
     Volume is what the room is actually doing, and faking it costs fees on every
     wash trade. Real $BULLSHIT, by the same measure: $125k traded on $128k of
     depth. The ghosts lose by five orders of magnitude.

     RESIDUAL RISK, STATED RATHER THAN PAPERED OVER: a determined wash trader can
     still buy volume. What stands behind this is that the chosen mint is printed
     in the criteria on the market page, so anybody staking can see which coin
     they are staking on before they do it. */
  // The candle source's own view, merged in. Volume is taken as the MAX of what
  // the two report rather than the sum: they index the same pools, so adding
  // them would double-count a token into looking dominant.
  for (const h of hits) {
    if (h.symbol.replace(/^\$/, "").toUpperCase() !== symbol.toUpperCase()) continue;
    const key = `${CHAIN}:${h.mint}`;
    const e = byMint.get(key);
    if (!e) {
      byMint.set(key, { chain: CHAIN, mint: h.mint, name: h.symbol, symbol: h.symbol, liq: 0, vol: h.volumeH24, mc: null, fdv: null, pool: h.pool, poolVol: h.volumeH24 });
      continue;
    }
    e.vol = Math.max(e.vol, h.volumeH24);
    // Prefer a pool the candle source itself named: reading history from a pool
    // that index does not know is how a market ends up with no candles at all.
    if (h.volumeH24 >= e.poolVol) { e.poolVol = h.volumeH24; e.pool = h.pool; }
  }

  const ranked = [...byMint.values()].sort((a, b) => b.vol - a.vol);
  if (ranked.length === 0) return { ok: false, why: `no Solana token trading as $${symbol} was found` };

  const top = ranked[0];
  if (top.vol < MIN_VOLUME_24H_USD) {
    return { ok: false, why: `nothing trading as $${symbol} has enough real volume to say which one is meant` };
  }
  const second = ranked[1];
  if (second && top.vol < second.vol * DOMINANCE) {
    return { ok: false, why: `${ranked.length} different tokens trade as $${symbol} and none of them clearly is the one` };
  }
  if (claim.metric === "mc" && MAJORS.has(top.symbol.replace(/^\$/, "").toUpperCase())) {
    return { ok: false, why: `the market cap of $${symbol} is not something its on-chain pool can be read for` };
  }
  if (claim.metric === "mc" && top.mc !== null && top.fdv !== null && top.fdv > 0) {
    if (Math.abs(top.mc - top.fdv) / top.fdv > SUPPLY_AGREEMENT) {
      return { ok: false, why: `$${symbol} has locked supply, so "market cap" and fully diluted are different numbers and the claim does not say which` };
    }
  }

  let info;
  try {
    info = await priceFeed().tokenInfo(top.chain, top.mint);
  } catch (e) {
    return { ok: false, why: `the price source did not answer: ${(e as Error).message}` };
  }
  if (!info) return { ok: false, why: `no price history is published for $${symbol}` };
  if (claim.metric === "mc" && !(info.totalSupply && info.totalSupply > 0)) {
    return { ok: false, why: `the supply of $${symbol} could not be read, so a market cap cannot be computed` };
  }
  const pool = info.topPools[0] || top.pool;
  if (!pool) return { ok: false, why: `no pool to read $${symbol} history from` };

  const check: PriceCheck = {
    chain: top.chain,
    mint: top.mint,
    symbol: top.symbol.replace(/^\$/, ""),
    name: top.name,
    pool,
    supply: info.totalSupply ?? 0,
    metric: claim.metric,
    op: claim.op,
    target: claim.target,
    mode: claim.mode,
    from: window.from,
    to: window.to,
  };
  return { ok: true, check, sentence: criteriaSentence(check) };
}

/** The commodities a claim can name, by the symbol the extractor gives them:
 *  each pinned to its Bybit perpetual (src/price/feed.ts), whose candles are
 *  read at the open and at settle like a token's pool. */
export const COMMODITIES: Readonly<Record<string, { pool: string; name: string; short: string }>> = {
  XAU: { pool: "XAUUSDT", name: "gold (XAU/USD)", short: "Gold" },
  XAG: { pool: "XAGUSDT", name: "silver (XAG/USD)", short: "Silver" },
  CL: { pool: "CLUSDT", name: "WTI crude oil (CL)", short: "WTI" },
  BZ: { pool: "BZUSDT", name: "Brent crude oil (BZ)", short: "Brent" },
};

/** A commodity's price claim pinned to its Bybit perpetual, or null for
 *  anything else. A unit price only: a metal has no market cap. */
export function commodityCheck(claim: PriceClaim, window: { from: string; to: string }): PriceCheck | null {
  const symbol = claim.symbol.replace(/^\$/, "").trim().toUpperCase();
  const c = COMMODITIES[symbol];
  if (!c || claim.metric !== "price" || !(claim.target > 0)) return null;
  return {
    chain: BYBIT_CHAIN, mint: c.pool, symbol, name: c.name, pool: c.pool, supply: 0,
    metric: "price", op: claim.op, target: claim.target, mode: claim.mode, from: window.from, to: window.to,
  };
}

/** The big coins, each read from its USDT pair on Binance spot (src/price/feed.ts):
 *  the coins the stream votes settle from Binance (src/live/priceCall.ts
 *  BINANCE_ASSETS), all but TON, whose pair there has not traded since June.
 *  The name is what the rule calls the coin. */
export const SPOT_COINS: Readonly<Record<string, string>> = {
  BTC: "Bitcoin (BTC)", ETH: "Ethereum (ETH)", SOL: "Solana (SOL)", BNB: "BNB", XRP: "XRP",
  DOGE: "Dogecoin (DOGE)", ADA: "Cardano (ADA)", AVAX: "Avalanche (AVAX)", SUI: "Sui (SUI)",
  LTC: "Litecoin (LTC)", TRX: "TRON (TRX)", PEPE: "Pepe (PEPE)", WIF: "dogwifhat (WIF)",
  BONK: "Bonk (BONK)", SHIB: "Shiba Inu (SHIB)", LINK: "Chainlink (LINK)", DOT: "Polkadot (DOT)",
};

/** A big coin's price claim pinned to its Binance spot pair, or null for
 *  anything else. A unit price only: a spot pair has no supply to multiply. */
export function spotCheck(claim: PriceClaim, window: { from: string; to: string }): PriceCheck | null {
  const symbol = claim.symbol.replace(/^\$/, "").trim().toUpperCase();
  const name = SPOT_COINS[symbol];
  if (!name || claim.metric !== "price" || !(claim.target > 0)) return null;
  const pool = `${symbol}USDT`;
  return {
    chain: BINANCE_CHAIN, mint: pool, symbol, name, pool, supply: 0,
    metric: "price", op: claim.op, target: claim.target, mode: claim.mode, from: window.from, to: window.to,
  };
}

/** The rails on an exchange: a pair that trades every minute, read to the minute. */
const EXCHANGES: ReadonlySet<string> = new Set([BYBIT_CHAIN, BINANCE_CHAIN]);

const money = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2)}M`
  : n >= 1_000 ? `$${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`
  : `$${n}`;

const day = (iso: string) => iso.slice(0, 10);

/** The criteria a stranger reads on the market page. It names the mint, because
 *  the ticker alone is not an identity and whoever is betting deserves to see
 *  which coin their money is on. */
export function criteriaSentence(c: PriceCheck): string {
  const what = c.metric === "mc" ? "market cap" : "price";
  /* FOUR OPERATORS, FOUR SENTENCES. This collapsed ">" into ">=" and "<" into
     "<=", so a market whose rule is "strictly above 115" published the words
     "at or above 115" -- and the published words are the half that gets hashed,
     shown to bettors and pointed at when somebody disputes a settlement. Line
     309 has always compared strictly for ">"; on a token that closes exactly on
     the number, the code paid NO while the criteria promised YES. */
  const dir = c.op === ">=" ? "at or above"
    : c.op === ">" ? "above"
    : c.op === "<=" ? "at or below"
    : "below";
  // The window opens when the MARKET opens, never earlier, and the sentence says
  // so. Backdating it to the start of the calendar month the tweet mentioned
  // would let somebody tag a level the token already touched and collect on a
  // question that was answered before anyone could take the other side.
  const when =
    c.mode === "touch" ? `at any point between this market opening on ${day(c.from)} and ${day(c.to)} UTC`
    : c.mode === "always" ? `continuously from this market opening on ${day(c.from)} to ${day(c.to)} UTC`
    : `at ${day(c.to)} UTC`;
  /* THE SUPPLY IS ONLY PART OF THE RULE WHEN THE RULE MULTIPLIES BY IT.
     A market cap is price x supply, so freezing the supply is a real term of
     the deal and belongs in the sentence. A price market never touches it, and
     printing it there put a number in front of bettors that has nothing to do
     with how their market settles -- on $SOL it read "a supply of 12,491,824
     tokens" next to a coin with a few hundred million. Immutable once minted,
     because this sentence is what criteria_hash commits to. */
  const basis = c.metric === "mc"
    ? ` against a supply of ${Math.round(c.supply).toLocaleString("en-US")} tokens fixed when this market opened`
    : "";
  /* AN EXCHANGE RAIL NAMES ITS VENUE, THE PAIR AND THE MINUTE. A commodity is
     read on its Bybit perpetual and a big coin on its Binance spot pair, the
     level in full ("$4,250" is the rule, where a rounded "$4.3K" would be a
     different one), and the close to the minute the market closes on, which is
     the minute exchangeWindow reads. */
  if (c.chain === BYBIT_CHAIN || c.chain === BINANCE_CHAIN) {
    const [venue, pair] = c.chain === BYBIT_CHAIN ? ["Bybit", "perpetual"] : ["Binance", "spot pair"];
    const level = exactUsd(c.target);
    const at = `${minuteOf(c.to)} UTC on ${day(c.to)}`;
    const read = `read from the ${c.pool} candles on ${venue}`;
    const rule =
      c.mode === "touch" ? `YES if its price is ${dir} ${level} at any point between this market's opening on ${day(c.from)} and ${at}, ${read}. NO otherwise.`
      : c.mode === "always" ? `YES if its price stays ${dir} ${level} from this market's opening on ${day(c.from)} until ${at}, ${read}. NO if it trades ${dirWords(flipOp(c.op))} ${level} at any point in that period.`
      : `YES if its price is ${dir} ${level} at ${at}, ${read}. NO otherwise.`;
    return `Settles from the price of ${c.name} on ${venue}'s ${c.pool} ${pair}. ${rule}`;
  }
  return `Settles from the on-chain price of $${c.symbol} (${c.chain} mint ${c.mint}). YES if its ${what} is ${dir} ${money(c.target)} ${when}, read from the hourly candles of its deepest pool on GeckoTerminal${basis}. NO otherwise.`;
}

/* ------------------------------------------------------ the open -- */

/* A PERIOD ALREADY DECIDED WHEN ITS MARKET OPENS IS READ AT ITS END.
   Live on 2026-10-12 a streamer typed "Solana above $100 in october?" with SOL
   at $108. The claim came out as a touch, "above $100 at any point between
   this market opening and October 31", which is a YES on the first hourly
   candle: whoever took NO had lost before they staked, and the market sat
   open for nineteen days waiting for a close that could not change it. Asked
   inside October with the price already past the level, the question is where
   SOL ends the month (Lev), so that is the market that opens: the same level,
   read at the close. The mirror holds for "always": a hold already broken at
   the open is a NO from the first candle, and where it ends the period is the
   question left.
   The window still opens at the market's open, so the at-close value is a
   candle formed after it, and the question and headline are rewritten from
   the check, because the model's words said "at any point". */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** When an at-close market is read, in a bettor's words. A close in the last
 *  hour of a UTC day (or on midnight) is that day's end, on a month's last day
 *  the month's end; any other close names its hour. `short` is for a headline. */
function closeWhen(iso: string, short = false): string {
  let t = new Date(iso);
  if (t.getUTCHours() === 0 && t.getUTCMinutes() === 0) t = new Date(t.getTime() - 60_000);
  const y = t.getUTCFullYear();
  const mo = t.getUTCMonth();
  const d = t.getUTCDate();
  const month = MONTHS[mo];
  if (t.getUTCHours() === 23) {
    const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    if (d === lastDay) return short ? `at end of ${month.slice(0, 3)}` : `at the end of ${month} ${y}`;
    return short ? `on ${month.slice(0, 3)} ${d}` : `at the end of ${month} ${d}, ${y} (UTC)`;
  }
  const hm = `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")} UTC`;
  return short ? `at ${hm}` : `at ${hm} on ${month} ${d}, ${y}`;
}

const dirWords = (op: PriceOp) =>
  op === ">=" ? "at or above" : op === ">" ? "above" : op === "<=" ? "at or below" : "below";

/** What an at-close question is built from: a pinned check, or a claim on a coin no token is pinned for. */
type CloseRead = Pick<PriceCheck, "symbol" | "metric" | "op" | "target" | "to"> & { chain?: string };

/** Who the question is about: "$SOL", "$TOK's market cap", "gold (XAU/USD)". */
const subjectOf = (c: CloseRead) => c.chain === BYBIT_CHAIN
  ? COMMODITIES[c.symbol]?.name ?? c.symbol
  : c.metric === "mc" ? `$${c.symbol}'s market cap` : `$${c.symbol}`;
/** The same in a headline: "SOL", "TOK mc", "Gold". */
const shortOf = (c: CloseRead) => c.chain === BYBIT_CHAIN
  ? COMMODITIES[c.symbol]?.short ?? c.symbol
  : `${c.symbol}${c.metric === "mc" ? " mc" : ""}`;
/** The level as the rail writes it: on an exchange always in full. */
const levelOf = (c: CloseRead, usd: (n: number) => string) => (EXCHANGES.has(c.chain ?? "") ? exactUsd : usd)(c.target);

/** A level written out in full: "$83,250", "$1.3075", "$0.00002". Where the
 *  words are the whole rule, a rounded "$83.3K" would be a different level, and
 *  so would "$1.31" for a coin quoted to four places. */
const exactUsd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 2 : n >= 1 ? 4 : 12 })}`;

/** The question an at-close check asks, for a market whose own words read it another way. */
export function closeQuestion(c: CloseRead, usd: (n: number) => string = money): string {
  return `Will ${subjectOf(c)} be ${dirWords(c.op)} ${levelOf(c, usd)} ${closeWhen(c.to)}?`;
}

/** Its headline, short like the extractor's: "SOL above $100 at end of Oct?".
 *  Null when a long ticker pushes it past what a headline holds; the question
 *  stands in for it then. */
export function closeHook(c: CloseRead, usd: (n: number) => string = money): string | null {
  const dir = c.op === ">=" || c.op === ">" ? "above" : "below";
  const hook = `${shortOf(c)} ${dir} ${levelOf(c, usd)} ${closeWhen(c.to, true)}?`;
  return hook.length <= 40 ? hook : null;
}

/** Already on that side at the open: does it stay there. "Will $SOL stay above $100 through the end of October 2026?" */
export function holdQuestion(c: CloseRead, usd: (n: number) => string = money): string {
  return `Will ${subjectOf(c)} stay ${dirWords(c.op)} ${levelOf(c, usd)} ${untilWhen(c.to)}?`;
}
export function holdHook(c: CloseRead, usd: (n: number) => string = money): string | null {
  const dir = c.op === ">=" || c.op === ">" ? "above" : "below";
  const hook = `${shortOf(c)} stays ${dir} ${levelOf(c, usd)} ${untilWhen(c.to, true)}?`;
  return hook.length <= 40 ? hook : null;
}
/** Not there at the open: does it get there. "Will $SOL trade above $150 at any point before the end of October 2026?" */
export function reachQuestion(c: CloseRead, usd: (n: number) => string = money): string {
  return `Will ${subjectOf(c)} ${c.metric === "mc" ? "be" : "trade"} ${dirWords(c.op)} ${levelOf(c, usd)} at any point ${beforeWhen(c.to)}?`;
}
export function reachHook(c: CloseRead, usd: (n: number) => string = money): string | null {
  const dir = c.op === ">=" || c.op === ">" ? "above" : "below";
  const hook = `${shortOf(c)} ${dir} ${levelOf(c, usd)} ${beforeWhen(c.to, true)}?`;
  return hook.length <= 40 ? hook : null;
}

/* A HOLD RUNS UP TO THE CLOSE, A REACH HAPPENS BEFORE IT. closeWhen names the
   moment; these name the stretch that ends there, in the same words. */
function untilWhen(iso: string, short = false): string {
  const at = closeWhen(iso, short);
  if (short) return at.startsWith("at end of ") ? `through ${at.slice(10)}` : at.startsWith("on ") ? `through ${at.slice(3)}` : `until ${at.slice(3)}`;
  return at.startsWith("at the end of ") ? `through the end of ${at.slice(14)}` : `until ${at.slice(3)}`;
}
function beforeWhen(iso: string, short = false): string {
  const at = closeWhen(iso, short);
  if (short) return at.startsWith("at end of ") ? `by end of ${at.slice(10)}` : `by ${at.slice(3)}`;
  return at.startsWith("at the end of ") ? `before the end of ${at.slice(14)}` : `before ${at.slice(3)}`;
}


/** The price now, read where the oracle reads it at settle: the newest hourly
 *  candle of the pinned pool, in the claim's own metric. Never throws. */
export async function priceNow(check: PriceCheck): Promise<{ ok: true; value: number } | { ok: false; why: string }> {
  const unit = check.metric === "mc" ? check.supply : 1;
  if (!(unit > 0)) return { ok: false, why: "no supply was recorded for this market" };
  let candles: Candle[];
  try {
    candles = await priceFeed().ohlcv(check.chain, check.pool, "hour", 1);
  } catch (e) {
    return { ok: false, why: `the price could not be read: ${(e as Error).message}` };
  }
  // The newest by its start, whatever order the source sends them in. Its
  // close is the last trade, which is the price now on a pool.
  let newest: Candle | null = null;
  for (const c of candles) if (!newest || c[0] > newest[0]) newest = c;
  if (!newest || !(newest[4] > 0)) return { ok: false, why: "the pool has no candle to read" };
  // An exchange pair trades every minute, so a newest hour long before the
  // window opens is a pair that stopped trading, not a quiet one: TON's pair on
  // Binance last moved in June, and its June price is not the price now.
  if (EXCHANGES.has(check.chain) && newest[0] < Date.parse(check.from) / 1000 - 2 * HOUR) {
    return { ok: false, why: `${check.pool} has not traded since ${new Date(newest[0] * 1000).toISOString().slice(0, 10)}` };
  }
  return { ok: true, value: newest[4] * unit };
}

/** What the price at the open already says: a touch met now is a YES, an
 *  "always" broken now is a NO. Null while still open, and always for
 *  "at-close", which only the close decides. */
export function decidedAtOpen(check: Pick<PriceCheck, "mode" | "op" | "target">, value: number): "yes" | "no" | null {
  if (check.mode === "touch") return satisfies(value, check.op, check.target) ? "yes" : null;
  if (check.mode === "always") return satisfies(value, check.op, check.target) ? null : "no";
  return null;
}

export type AtOpen =
  /** Nothing to change: an at-close claim, or one the price has not decided. */
  | { kind: "as-is"; now: number | null }
  /** The price could not be read: the market opens as it reads, and the caller logs why. */
  | { kind: "unread"; why: string }
  /** Decided at the open, so read at the close: the check, the criteria, the question and the headline to open under. */
  | { kind: "reread"; now: number; was: "yes" | "no"; check: PriceCheck; sentence: string; question: string; hook: string | null }
  /** A level over a period, made concrete by the price at the open: a hold if
   *  the price is already on that side, a reach if not, and the close if the
   *  price could not be read (`why`). */
  | { kind: "within"; now: number | null; reading: "hold" | "reach" | "close"; why?: string; check: PriceCheck; sentence: string; question: string; hook: string | null };

/** Read a pinned check against the price at the open, before anything is minted. */
export async function readAtOpen(check: PriceCheck): Promise<AtOpen> {
  /* ABOVE MEANS ABOVE, BELOW MEANS BELOW (Lev, 13 Oct). "Solana above $100 in
     October?" asked with SOL at $108 is "does it stay above $100 until October
     ends"; asked with SOL at $90 it is "does it get above $100 before then".
     The words are the same and only the price at the open tells them apart,
     so this is where the reading is made. A price that cannot be read gets the
     one reading the open cannot decide: where the period ends. */
  if (check.mode === "within") {
    const now = await priceNow(check);
    if (!now.ok) {
      const atClose: PriceCheck = { ...check, mode: "at-close" };
      return { kind: "within", now: null, reading: "close", why: now.why, check: atClose,
        sentence: criteriaSentence(atClose), question: closeQuestion(atClose), hook: closeHook(atClose) };
    }
    const there = satisfies(now.value, check.op, check.target);
    const next: PriceCheck = { ...check, mode: there ? "always" : "touch" };
    return { kind: "within", now: now.value, reading: there ? "hold" : "reach", check: next, sentence: criteriaSentence(next),
      question: there ? holdQuestion(next) : reachQuestion(next), hook: there ? holdHook(next) : reachHook(next) };
  }
  if (check.mode === "at-close") return { kind: "as-is", now: null };
  const now = await priceNow(check);
  if (!now.ok) return { kind: "unread", why: now.why };
  const was = decidedAtOpen(check, now.value);
  if (!was) return { kind: "as-is", now: now.value };
  const atClose: PriceCheck = { ...check, mode: "at-close" };
  return {
    kind: "reread", now: now.value, was, check: atClose,
    sentence: criteriaSentence(atClose), question: closeQuestion(atClose), hook: closeHook(atClose),
  };
}

/* A BIG COIN IS READ WHERE A CHART WATCHER READS IT, AND SETTLED THERE TOO.
   BTC, ETH and the rest are not Solana tokens, so until 20 Oct their markets
   were read at the open from Binance's spot price and then left to a rule that
   named CoinMarketCap, for an oracle that settles from a page. No page it can
   open shows a price at a minute, so every one of them closed into a wall of
   failed citations. Now a big coin is pinned to its Binance pair at the open
   like gold to its Bybit perpetual (spotCheck), read there by readAtOpen, and
   settled from the same pair's candles by code. */

const flipOp = (op: PriceOp): PriceOp => (op === ">" ? "<=" : op === ">=" ? "<" : op === "<" ? ">=" : ">");
const minuteOf = (iso: string) => {
  const t = new Date(iso);
  return `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
};

export interface PriceVerdict {
  outcome: "yes" | "no" | null;
  why: string;
  /** The number the verdict rests on, in the claim's own metric. */
  observed: number | null;
  candles: number;
}

const satisfies = (v: number, op: PriceOp, target: number) =>
  op === ">=" ? v >= target : op === ">" ? v > target : op === "<=" ? v <= target : v < target;

/** The extreme that decides the claim: a ">=" touch is decided by the highest
 *  the price ever got, a "<=" touch by the lowest. */
const extremeOf = (c: Candle, op: PriceOp) => (op === ">=" || op === ">" ? c[2] : c[3]);

/**
 * Read the window and answer. Never throws: a source that is down is `null`,
 * which the oracle reports as a market a person still has to look at.
 */
export async function checkPrice(check: PriceCheck): Promise<PriceVerdict> {
  // readAtOpen turns "within" into a hold, a reach or a close before anything
  // is stored; one that reaches the oracle was never read, and has no verdict.
  if (check.mode === "within") return { outcome: null, why: "a level over a period that was never read at the open", observed: null, candles: 0 };
  const from = Math.floor(new Date(check.from).getTime() / 1000);
  const to = Math.floor(new Date(check.to).getTime() / 1000);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return { outcome: null, why: "the window on this market is not a window", observed: null, candles: 0 };
  }
  const unit = check.metric === "mc" ? check.supply : 1;
  if (!(unit > 0)) return { outcome: null, why: "no supply was recorded for this market", observed: null, candles: 0 };

  let read: WindowRead;
  try {
    read = EXCHANGES.has(check.chain) ? await exchangeWindow(check, from, to) : await poolWindow(check, from, to);
  } catch (e) {
    return { outcome: null, why: `the price history could not be read: ${(e as Error).message}`, observed: null, candles: 0 };
  }
  const { inside, full } = read;
  if (inside.length === 0) {
    return { outcome: null, why: "no price history covers this market's window", observed: null, candles: 0 };
  }
  // A coin at $1.3072 is not "$1": on an exchange the number is written in full.
  const usd = EXCHANGES.has(check.chain) ? exactUsd : (n: number) => money(Math.round(n));

  if (check.mode === "at-close") {
    // The newest candle inside the window IS the value at close: the query asked
    // for everything up to the close, so a later candle would have come back if
    // one existed, and an hour with no trade leaves the previous close standing.
    const last = inside[inside.length - 1];
    const value = last[4] * unit;
    const ok = satisfies(value, check.op, check.target);
    return { outcome: ok ? "yes" : "no", why: `${usd(value)} at close`, observed: value, candles: inside.length };
  }

  if (check.mode === "touch") {
    const best = inside.reduce((m, c) => {
      const v = extremeOf(c, check.op);
      return m === null ? v : check.op === ">=" || check.op === ">" ? Math.max(m, v) : Math.min(m, v);
    }, null as number | null)!;
    const value = best * unit;
    if (satisfies(value, check.op, check.target)) {
      // Positive proof. A gap elsewhere in the window cannot unmake a candle
      // that is right there, so partial history is enough for this one.
      return { outcome: "yes", why: `it reached ${usd(value)} inside the window`, observed: value, candles: inside.length };
    }
    if (!full) {
      return { outcome: null, why: "part of the window has no price history, so it cannot be shown it never got there", observed: value, candles: inside.length };
    }
    return { outcome: "no", why: `the furthest it got was ${usd(value)}`, observed: value, candles: inside.length };
  }

  // "always": one violation is positive proof of NO; a clean run needs the
  // whole window to mean anything.
  let worst: number | null = null;
  for (const c of inside) {
    const v = (check.op === ">=" || check.op === ">" ? c[3] : c[2]) * unit;
    if (worst === null || (check.op === ">=" || check.op === ">" ? v < worst : v > worst)) worst = v;
  }
  if (worst !== null && !satisfies(worst, check.op, check.target)) {
    return { outcome: "no", why: `it broke the condition at ${usd(worst)}`, observed: worst, candles: inside.length };
  }
  if (!full) {
    return { outcome: null, why: "part of the window has no price history, so a clean run cannot be confirmed", observed: worst, candles: inside.length };
  }
  return { outcome: "yes", why: `it held the condition the whole window, worst was ${usd(worst ?? 0)}`, observed: worst, candles: inside.length };
}

interface WindowRead {
  /** Every candle wholly inside the window, oldest first. */
  inside: Candle[];
  /** The history reaches back to the window's start, so a NO from a touch and
   *  a YES from a hold may rest on it. */
  full: boolean;
}

/** A token's pool, read the way it always was: one request, hourly or daily. */
async function poolWindow(check: PriceCheck, from: number, to: number): Promise<WindowRead> {
  // Hourly while the window fits inside one request, daily beyond that. The
  // limit is the source's, not ours, and paging would buy precision nobody is
  // betting on: a three-month claim does not turn on which hour of a day.
  const span = to - from;
  const timeframe: "hour" | "day" = span <= 1000 * HOUR ? "hour" : "day";
  const step = timeframe === "hour" ? HOUR : DAY;
  const need = Math.ceil(span / step) + 2;

  const limit = Math.min(need, 1000);
  const candles = await priceFeed().ohlcv(check.chain, check.pool, timeframe, limit, to + step);
  // A short answer means the pool has no history older than what came back.
  // That is the difference between "we did not look far enough" and "there is
  // nothing further to look at", and it decides whether a NO is allowed below.
  const exhausted = candles.length < limit;

  // A candle counts only if it lies WHOLLY inside the window. A candle that
  // straddles the close would let a move made after the deadline settle the
  // market, which is the one error no amount of liquidity makes up for.
  const inside = candles.filter((c) => c[0] >= from && c[0] + step <= to).sort((a, b) => a[0] - b[0]);

  // COVERAGE IS NOT A CANDLE COUNT, and counting was the first thing this got
  // wrong. On a DEX a candle exists only where somebody traded, so a quiet
  // memecoin produces 341 hourly candles across a 744-hour month and every one
  // of the 403 gaps is an hour in which the price, by definition, did not move.
  // Demanding a candle per hour refused every honest NO on exactly the tokens
  // this path was built for.
  //
  // What actually matters is that the window is BRACKETED. The request asked for
  // everything before the close, so the newest candle returned is the newest
  // that exists: the close end is covered by construction. The other end is
  // covered if history reaches back past the window start, or if the pool simply
  // has nothing older.
  return { inside, full: inside.length > 0 && (inside[0][0] <= from + step || exhausted) };
}

const MINUTE = 60;

/* AN EXCHANGE PAIR IS READ TO THE MINUTE. Read by the hour like a pool, the
   window lost both ends: a market opened at 19:49 began counting at 20:00, and
   one closing at 23:59 was read at 23:00, an hour before the minute its rule
   names. So the close is the last whole minute before it, and a hold or a
   reach is read by the minute at both ends and by the hour between them, which
   is the same high and low: an hour's high is the highest of its minutes. */
async function exchangeWindow(check: PriceCheck, from: number, to: number): Promise<WindowRead> {
  if (check.mode === "at-close") {
    // An hour of minutes always holds the last one on a pair that trades every minute.
    const inside = await candlesIn(check, "minute", Math.max(from, to - HOUR), to);
    return { inside, full: inside.length > 0 };
  }
  const h0 = Math.ceil(from / HOUR) * HOUR;
  const h1 = Math.floor(to / HOUR) * HOUR;
  const inside = h1 > h0
    ? [...await candlesIn(check, "minute", from, h0), ...await candlesIn(check, "hour", h0, h1), ...await candlesIn(check, "minute", h1, to)]
    : await candlesIn(check, "minute", from, to);
  // Bracketed the way a pool's history is (see poolWindow): it reaches back to
  // the window's start, and a minute with no candle is a minute nothing traded.
  return { inside, full: inside.length > 0 && inside[0][0] < from + HOUR };
}

/** Every candle of one size wholly inside [a, b), oldest first, paged back
 *  from b a thousand at a time. */
async function candlesIn(check: PriceCheck, timeframe: "minute" | "hour", a: number, b: number): Promise<Candle[]> {
  const step = timeframe === "hour" ? HOUR : MINUTE;
  const first = Math.ceil(a / step) * step;
  const last = Math.floor(b / step) * step - step;
  const out = new Map<number, Candle>();
  for (let end = last, pages = 0; end >= first && pages < 50; pages++) {
    const want = Math.min(Math.floor((end - first) / step) + 1, 1000);
    const got = await priceFeed().ohlcv(check.chain, check.pool, timeframe, want, end);
    for (const c of got) if (c[0] >= first && c[0] <= last) out.set(c[0], c);
    const oldest = got.reduce((m, c) => Math.min(m, c[0]), Infinity);
    // A short page is the start of the pair's history; a page with nothing at
    // or before `end` would ask the same thing again forever.
    if (got.length < want || !(oldest <= end)) break;
    end = oldest - step;
  }
  return [...out.values()].sort((x, y) => x[0] - y[0]);
}

/** One read of each exchange rail at boot, so the log says whether the markets
 *  pinned to it can be opened and settled from where the server runs. Bybit
 *  had never been read from production when gold and oil were pinned to it. */
export async function probeExchangeRails(log: (line: Record<string, unknown>) => void): Promise<void> {
  const rails = [{ chain: BINANCE_CHAIN, pool: "BTCUSDT" }, { chain: BYBIT_CHAIN, pool: "XAUUSDT" }];
  const out: Record<string, unknown> = { evt: "price_rails" };
  for (const r of rails) {
    try {
      const [newest] = (await priceFeed().ohlcv(r.chain, r.pool, "minute", 1)).sort((a, b) => b[0] - a[0]);
      out[r.chain] = newest ? { ok: true, pool: r.pool, close: newest[4], at: new Date(newest[0] * 1000).toISOString() } : { ok: false, pool: r.pool, why: "no candle" };
    } catch (e) {
      out[r.chain] = { ok: false, pool: r.pool, why: (e as Error).message.slice(0, 200) };
    }
  }
  /* AND THE TWO PUBLIC ARCHIVES that could stand in for Bybit's live API, which
     answers this server 403 (20 Oct): Binance's daily minute candles for its
     gold and oil perpetuals, and Bybit's own daily trade files. Only whether
     they answer from here; nothing reads them yet. */
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  for (const [name, url] of [
    ["binanceArchive", `https://data.binance.vision/data/futures/um/daily/klines/CLUSDT/1m/CLUSDT-1m-${yesterday}.zip`],
    ["bybitArchive", "https://public.bybit.com/trading/CLUSDT/"],
  ] as const) {
    try {
      const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000), headers: { "user-agent": "oddie/1.0 (+https://oddie.fun)" } });
      out[name] = { status: res.status, url };
    } catch (e) {
      out[name] = { status: null, url, why: (e as Error).message.slice(0, 200) };
    }
  }
  log(out);
}
