// The paper economy, as arithmetic. No database, no clock of its own, no I/O —
// every function here takes what it needs and returns what it computed, so the
// whole cycle (call → odds move → exit → reputation) can be proven offline with
// injected prices instead of waiting for a real market to move.
//
// Virtual predictions only. Nothing here converts to money in either direction,
// and no function in this file has any idea what a dollar is.
//
// The unit is a "prediction": one flat-cost tap on YES/NO, not a variable-size
// stake. There is no picker, no "how much do you want to put on this" — the
// entire economy is a count going up and down by whole numbers, on purpose,
// so it reads like a casual game's lives/energy meter, not a trading account.

/** A new device's stake in the game — a small handful, enough for a first
 *  session without feeling like a grant that needs rationing. */
export const STARTING_PREDICTIONS = 5;

/**
 * What one call costs: NOTHING.
 *
 * It was 1, against a starting balance of 5, which made a wall in exactly the
 * wrong place. What the product needs more of is people with a resolved call
 * and their name on it, because that is the only thing a verdict post can be
 * made out of, and reach on X comes from those original posts. Charging for a
 * call throttled the one input that produces distributable content, and it hit
 * the most engaged arrival hardest: five taps in, a stranger who came from a
 * tweet met a "come back tomorrow".
 *
 * Participation is now unlimited. The reward is what gets bounded instead —
 * see DAILY_EARNING_MARKETS in markets.ts, which caps the oddies a day's
 * calling can earn without ever capping the calling itself.
 *
 * Kept as a named constant at 0 rather than deleted: the settlement and
 * position code still stakes and pays through it, and a zero flows through
 * that arithmetic correctly while a removed constant would mean touching every
 * one of those paths at once.
 */
export const CALL_COST = 0;

/* The daily claim and its streak are gone, together with the sign-in bonus
 * below. Both were grants: score handed over for showing up or for creating an
 * account. The score is earned now, and only by the loop the product is about,
 * so every path into it goes through SEASON_POINTS in markets.ts: tagging a
 * market into existence, that market growing, it resolving cleanly, and being
 * loud about it. Nothing pays for merely arriving. */

/** Below this many closed positions, a reputation is noise wearing a number. */
export const PROVISIONAL_BELOW = 10;


/**
 * Prices are the SIDE's percentage, not the market's. A market at 39% yes
 * offers YES at 39 and NO at 61, and both sides pay out 100 if they land. That
 * single convention is what lets one formula serve both sides, and it is the
 * same number `pct_at` has always stored.
 */
export type SidePct = number;

/**
 * What a stake buys. At 39 a token buys 1/0.39 of a claim on 100, which is why
 * the card has always read "win 2.6×" — this is that number, not a new one.
 */
export function sharesFor(stake: number, entryPct: SidePct): number {
  if (!(entryPct > 0)) throw new Error(`entry price must be positive, got ${entryPct}`);
  return stake / (entryPct / 100);
}

/**
 * What those shares fetch at some later price. Selling early and holding to
 * settlement are the SAME operation: settlement is just an exit at 100 (your
 * side happened) or 0 (it didn't).
 *
 *   sold at 44 after entering at 39 : 50 × 44/39 = 56 tokens
 *   held, side resolves true        : 50 × 100/39 = 128 tokens
 *   held, side resolves false       : 50 × 0/39   = 0 tokens
 *
 * Rounded to whole tokens, and never below zero. Rounding is the house's only
 * edge and it is worth at most half a token, in either direction.
 */
export function proceedsFor(stake: number, entryPct: SidePct, exitPct: SidePct): number {
  return Math.max(0, Math.round(sharesFor(stake, entryPct) * (exitPct / 100)));
}

/**
 * Skill, in percentage points, independent of how much was staked.
 *
 * The user's two rules — `exit − entry` for YES, `entry − exit` for NO — are one
 * rule once prices are quoted per side: NO's price is `100 − yes`, so
 * `exitNo − entryNo` expands to `entryYes − exitYes` on its own. Called YES at
 * 39 and sold at 31? That is −8, and it counts. A reputation that cannot fall
 * is not a measurement.
 */
export function edgePts(entryPct: SidePct, exitPct: SidePct): number {
  return exitPct - entryPct;
}

/** The token change a human reads on the receipt, which is NOT the edge. */
export function tokenDeltaPct(entryPct: SidePct, exitPct: SidePct): number {
  return (exitPct / entryPct - 1) * 100;
}

/**
 * Bonus predictions on a win — the entire spendable-fuel model's payout, and
 * the one piece of arithmetic the whole redesign hangs off. It rides directly
 * on the multiplier already printed on the card (100/entryPct): a longshot win
 * pays a stack of predictions, a favorite win pays a little, and the user never
 * has to learn a second number — the one they saw before they called IS the
 * bonus, rounded.
 *
 *   90% favorite  (1.1×) wins ->  1
 *   50% coin flip (2.0×) wins ->  2
 *   21% longshot  (4.8×) wins ->  5
 *   10% longshot (10.0×) wins -> 10  (cap)
 *    5% longshot (20.0×) wins -> 10  (capped, not 20)
 *
 * This IS the entire return — approved explicitly as "the bonus is the whole
 * return, not a stake refund plus a bonus": a 2.0× win credits 2 predictions
 * at settlement, full stop. The 1 prediction spent to make the call is not
 * separately refunded (it was already spent, at call time, as its own step).
 *
 * The floor of 1 falls out of the clamp for free — the lowest multiplier
 * possible is 100/99 ≈ 1.01×, which always rounds to 1 — but it is written
 * explicitly rather than relied upon, since that is the honest floor either
 * way. BONUS_CAP exists so a true extreme-longshot win (100/1 = 100×) still
 * reads as a jackpot without handing out a month of free play in one resolve.
 *
 * settleMarket's SQL branch inlines this exact formula (ROUND + GREATEST/LEAST
 * against the same 1/10 literals) because Postgres can't call a JS function —
 * the two must be changed together, and a comment there points back here.
 */
export const BONUS_FLOOR = 1;
export const BONUS_CAP = 10;
export function winBonus(entryPct: SidePct): number {
  if (!(entryPct > 0)) throw new Error(`entry price must be positive, got ${entryPct}`);
  return Math.max(BONUS_FLOOR, Math.min(BONUS_CAP, Math.round(100 / entryPct)));
}

/**
 * The creator fee — the incentive to make markets, not just call them.
 *
 * Play-token markets do NOT hold a real, conserved pool: winBonus above pays
 * each winner off their OWN entry odds, not a share of what losers put in (the
 * house prints every payout on demand). So a play-token creator fee cannot be
 * a deduction from anyone's proceeds — there's no real pool to deduct from.
 * It is instead an ADDITIVE bonus grant to the market's creator, sized off the
 * pool's total activity (both sides' staked tokens) as a proxy for "how much
 * this market mattered." Because it never touches the winBonus formula, it
 * structurally cannot make a payout negative or smaller than it would
 * otherwise be — see creatorFeePlay below and its call site in settleMarket.
 *
 * The creator fee is now REAL and ENFORCED ON-CHAIN. This paragraph used to
 * say the opposite, and it was true when written: the deployed program had no
 * fee-taking instruction and the repo had no source to add one. Both facts
 * changed. oddie_chain now stores creator_fee_bps per market, fixes the amount
 * out of the pool at resolve, and pays it through claim_creator_fee, which is
 * what turns "being loud pays" from a slogan into a transaction.
 *
 * The PROTOCOL fee did NOT survive that change and is zeroed below. The
 * program takes a creator fee and nothing else, so oddie's own cut is really
 * zero, and a displayed 3% house fee would be a number nobody charges. That is
 * the exact failure this comment used to warn about, pointed the other way.
 *
 * Zeroed rather than deleted on purpose. The fee-intent logging in markets.ts
 * and its test still describe the shape of a house fee, and keeping the
 * constant means the day one is introduced it goes back to being a rate
 * change rather than a re-plumbing. Reintroducing it is a program change
 * first, this constant second, copy last, in that order.
 */
export const CREATOR_FEE_BPS_PLAY = 300;   // 3% of total pool (both sides), additive bonus to the creator

/**
 * 3% of the vault to whoever tagged the argument, deducted at resolve before
 * winners are paid, claimed by them with their own signature.
 *
 * It was 200 (2%) while it was only a proposal. Raised to match the 3% already
 * printed on every market card, in every reply oddie posts and on the landing
 * page: the number people were promised is the number that should arrive, and
 * quietly shipping a smaller one the moment it became real money is the worst
 * possible first impression for a fee.
 *
 * The program caps this at 1000 (10%) and mintMarket rejects anything outside
 * 0..1000 before spending a transaction fee to find out.
 */
export const CREATOR_FEE_BPS_REAL = 200;

/**
 * Oddie's own half. 2%, matching the creator's, for a 4% total takeout.
 *
 * It was zero, and the reason it stopped being zero is arithmetic rather than
 * appetite: a market costs us rent on Solana plus a reply on X and returned
 * nothing, so every market the product succeeded at made it poorer. At 2% a
 * market pays for itself at roughly a quarter of a SOL in the pool.
 *
 * WHY 4% TOTAL, AND WHY THIS SPLIT. Polymarket and Kalshi both land near 3.5%
 * of money at risk on a 50/50 market, and they charge it on every trade; ours
 * is taken once, from the pool, at resolve. Traditional pari-mutuel takeout,
 * which is the mechanic we actually are, runs 15-25%. So 4% once is cheap
 * against both comparisons. Down the middle because the half that pays a
 * stranger for starting an argument is the half that brings the next market,
 * and it should not be the junior partner.
 *
 * The program stores BOTH rates on the market at creation, so changing either
 * number here reprices nothing that already exists. Markets minted while this
 * was zero settle at zero forever. That is the property that makes a rate
 * change honest rather than a rug.
 */
export const PROTOCOL_FEE_BPS_REAL = 200;

/** Floors to 0 on small pools rather than paying out a fractional token — a
 *  market needs roughly 34+ total tokens staked before the 3% fee rounds up
 *  to even 1, which quietly protects against dust/degenerate-pool noise. */
export function creatorFeePlay(totalPoolTokens: number): number {
  return Math.floor((totalPoolTokens * CREATOR_FEE_BPS_PLAY) / 10000);
}

/* ------------------------------------------------------------ caller tiers --
 * The answer to "accuracy accumulates, so what?".
 *
 * Before real money, the payoff for being right has to be STATUS, and status
 * needs a name: "top 8%" is a measurement, "Loudest" is something you tell
 * people you are. These tiers put a claimable noun on the numbers the product
 * already computes (oddieScore from economy, topPct from the season
 * standings), so a good record becomes an identity rather than a statistic.
 *
 * Deliberately hard to get and deliberately few. Three tiers, all above the
 * market: a tier you earn by showing up is not status, and a ladder with a
 * rung for everybody is a participation trophy. Below "proven" there is no
 * tier at all — the honest answer to a below-market record is silence, not a
 * consolation label.
 */
export type CallerTierId = "oracle" | "sharp" | "proven";

export interface CallerTier {
  id: CallerTierId;
  /** The claimable noun — what a user calls themselves. */
  label: string;
  /** One line of "what this means", for the profile and the share card. */
  blurb: string;
}

/** Percentile cutoffs. Lower topPct = better standing. */
export const ORACLE_TOP_PCT = 5;
export const SHARP_TOP_PCT = 25;

/* ------------------------------------------------------------ the score -----
 * ONE number, and it rewards SHOWING UP more than being right.
 *
 * It used to be two. The visible Oddie Score was 500 + 1000·edge — pure
 * calibration, nothing else — and a second, invisible "Season Points" ledger
 * counted contribution (surfacing a market, reaching players, resolving
 * cleanly) but was documented as never shown and never used for rank. So the
 * product had a working activity economy that no player could see and that
 * changed nothing.
 *
 * Now: activity sets the MAGNITUDE, accuracy scales it.
 *
 *     base    = 10·resolved calls + 25·markets created + contribution points
 *     quality = 1 + 2·meanEdge, clamped to 0.5 … 1.5
 *     score   = base × quality
 *
 * The weighting is deliberate and worth stating plainly: someone who plays a
 * lot and reads the market averagely will outrank someone who is sharper but
 * barely plays. That is the ask. The guard against it being farmable is that
 * base only counts things that COST something — a call costs a prediction and
 * predictions are rate-limited by the daily claim, a market needs a real post
 * on X — and that quality goes BELOW 1, so being consistently wrong actively
 * shrinks a big base rather than merely failing to grow it.
 */
export const SCORE_WEIGHTS = {
  // VOLUME, paid the moment it happens. Only resolved calls used to count, which
  // made the score useless as a farming target: a call made today showed nothing
  // until the market closed, sometimes months out. Nobody farms a scoreboard
  // that does not move. It pays on the call and again on the resolution, so
  // playing through still beats abandoning positions.
  // Both frozen: nothing writes a play call any more, and a real position never
  // reaches this database. Kept at zero rather than deleted so the shape of the
  // ledger, and the reason these stopped counting, stays visible.
  callMade: 0,
  resolvedCall: 0,
  // X ACTIVITY, and it is deliberately the loud one. A market only exists
  // because somebody tagged @oddiefun under a post, so this is the axis that
  // buys reach: one created market outweighs twenty calls before its surfacing
  // award is even counted.
  marketCreated: 100,
  // Growth-ledger points doubled into oddies. Every event in that ledger is a
  // growth event — surfacing a market, it reaching three players, it bringing
  // somebody's first-ever call, a post about oddie clearing review — so it is
  // the closest thing the product has to a measure of noise made on X.
  //
  // Applied OUTSIDE the quality multiplier (see oddieScoreFrom): these are the
  // amounts the product PROMISES ("+150 oddies when your post clears"), and a
  // promise the multiplier could quietly rescale to +75 or +225 is not a
  // promise. Play is multiplied by skill; noise pays face value.
  contribution: 2,
} as const;
/** How far accuracy can move the base, either way. */
export const SCORE_QUALITY_MIN = 0.5;
export const SCORE_QUALITY_MAX = 1.5;

export interface ScoreInputs {
  /** Every call taken, counted immediately. */
  callsMade?: number;
  resolvedCalls: number;
  marketsCreated: number;
  contributionPoints: number;
  /** −1..1, mean(outcome − impliedProb). null when nothing has resolved. */
  meanEdge: number | null;
}


/**
 * Pure. The single definition of the one currency — ODDIES — and every surface
 * reads this one. (Function and field names keep the oddieScore identifier;
 * only the user-facing label changed when the point systems were unified.)
 *
 * Two halves, deliberately treated differently:
 *   - PLAY (calls, resolutions, created markets) is multiplied by quality —
 *     skill amplifies what you did in the markets.
 *   - NOISE (the growth ledger: shares, cleared posts, weekly loudest) is
 *     flat-added at face value, outside the multiplier. These amounts are
 *     PROMISED in the UI as exact numbers, and a promise the multiplier could
 *     quietly turn +150 into +75 is not a promise.
 */
/**
 * THE LOUDNESS LADDER, and now it is only that.
 *
 * It used to add a term for every call taken and every call resolved, and then
 * scale the whole base by accuracy. All three of those read the play-token
 * positions table, and nothing writes to that table any more: a call costs
 * nothing to make because there is no such thing as a play call, and a real
 * position is a wallet signing a transaction that never touches this database.
 * So the two volume terms were frozen at whatever a device happened to have
 * before the pivot, and the accuracy multiplier scaled everyone's score by a
 * constant derived from a game that stopped existing.
 *
 * A score that pretends to reward playing and cannot is worse than one that
 * does not claim to. What moves it now is what the product actually wants:
 * markets tagged, and the growth ledger behind being loud about them.
 *
 * Real-money betting deliberately earns NOTHING here. It has its own reward and
 * that reward is money. Mixing the two would make the leaderboard a function of
 * how much SOL somebody has, which is the opposite of what it is for.
 */
export function oddieScoreFrom(a: ScoreInputs): number {
  const tagged = Math.max(0, a.marketsCreated) * SCORE_WEIGHTS.marketCreated;
  /* THE MULTIPLIER IS GONE WITH THE MECHANIC THAT FED IT. It scaled the tagged
     half by cleared posts about oddie in the trailing 30 days, which is the
     shape X banned on 2026-01-15. A score is now tagged markets plus the growth
     ledger, and nothing a person posts moves it. */
  return Math.max(0, tagged + Math.max(0, a.contributionPoints) * SCORE_WEIGHTS.contribution);
}

/**
 * The tier a record earns, or null for "no tier yet" — which is the correct
 * answer both for a provisional record (not enough resolved calls to mean
 * anything) and for a settled record that hasn't beaten the market. Never
 * invents a flattering tier for a weak record: the whole point is that the
 * label is worth something because it can be withheld.
 */
export function callerTier(r: {
  hasEnough: boolean;
  oddieScore: number | null;
  /** Kept so old callers still type-check; no tier reads it any more. */
  meanEdge?: number | null;
  marketsCreated?: number | null;
  topPct: number | null;
}): CallerTier | null {
  if (!r.hasEnough || r.oddieScore == null) return null;
  if (r.topPct != null && r.topPct <= ORACLE_TOP_PCT) {
    return { id: "oracle", label: "Loudest", blurb: `top ${ORACLE_TOP_PCT}% on the board` };
  }
  if (r.topPct != null && r.topPct <= SHARP_TOP_PCT) {
    return { id: "sharp", label: "Loud", blurb: `top ${SHARP_TOP_PCT}% on the board` };
  }
  // The third rung used to be "beats the odds they take", checked against edge.
  // Edge is no longer part of the score, so that badge could only ever have
  // labelled people by a number the app had stopped believing in. The rung a
  // loudness ladder actually has underneath its ranked tiers is the entry one:
  // you put a market on the board, so you are on it.
  if (r.marketsCreated != null && r.marketsCreated > 0) {
    return { id: "proven", label: "Tagger", blurb: "put a market on the board" };
  }
  return null;
}

export interface Reputation {
  /** Mean edge in percentage points across closed positions. Null when there are none. */
  avgEdge: number | null;
  closed: number;
  /** True until the sample is big enough for the number to mean anything. */
  provisional: boolean;
}

/**
 * The average edge, and nothing else.
 *
 * Deliberately not token PnL: PnL rewards whoever started with the most tokens
 * and bet them the hardest. Averaging edge puts a scalper who takes +5 twenty
 * times and a holder who takes +61 once on the same axis, which is the point —
 * both are reading the market correctly, at different tempos.
 */
export function reputationOf(edges: number[]): Reputation {
  const closed = edges.length;
  if (closed === 0) return { avgEdge: null, closed: 0, provisional: true };
  const avg = edges.reduce((a, b) => a + b, 0) / closed;
  return { avgEdge: avg, closed, provisional: closed < PROVISIONAL_BELOW };
}

/**
 * THE PROGRAM'S PAYOUT, MIRRORED. Keep identical to lib.rs:claim_winnings.
 *
 * Off-chain this is the only way to answer "what did that call actually make",
 * because the Position account is CLOSED when it is claimed: after collection
 * the chain remembers the market's frozen totals but not the individual stake,
 * so a realized-money number has to be recomputed from the market plus our own
 * stamped entry. Which means it has to be right.
 *
 *   winningTotal == 0  -> everyone refunded, no fee was taken
 *   wrong side         -> 0
 *   otherwise          -> floor(stake x (pool - creatorFee - protocolFee) / winningTotal)
 *
 * Truncating division, deliberately, exactly as the program does: rounding up
 * is how a pari-mutuel ends one lamport short for the last claimant, and a
 * mirror that rounds differently would quietly overstate everybody.
 */
export interface SettledMarketTotals {
  winningSide: "yes" | "no";
  totalYesLamports: number;
  totalNoLamports: number;
  creatorFeeLamports: number;
  protocolFeeLamports: number;
}

export function payoutLamports(
  stakeLamports: number, side: "yes" | "no", m: SettledMarketTotals,
): number {
  if (!Number.isFinite(stakeLamports) || stakeLamports <= 0) return 0;
  const pool = m.totalYesLamports + m.totalNoLamports;
  const winningTotal = m.winningSide === "yes" ? m.totalYesLamports : m.totalNoLamports;
  // Nobody backed the winner: the program refunds every stake and takes no fee.
  // This is NOT a loss, and treating it as one would invent losses out of the
  // markets where the house behaved best.
  if (winningTotal === 0) return stakeLamports;
  if (side !== m.winningSide) return 0;
  const distributable = pool - m.creatorFeeLamports - m.protocolFeeLamports;
  if (distributable <= 0) return 0;
  return Math.floor((stakeLamports * distributable) / winningTotal);
}
