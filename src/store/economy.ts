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

/** What one call costs. Flat, always — there is no larger or smaller call. */
export const CALL_COST = 1;

/**
 * The daily claim — an ACTIVE retention hook, not a passive tick. A player taps
 * once per window to collect, and a streak of consecutive claimed days is the
 * visible reason to come back tomorrow. A claim within STREAK_WINDOW of the
 * last continues the streak; a longer gap (a missed day) resets it to 1 — the
 * streak resets, never the balance.
 */
export const DAILY_CLAIM = 5;
export const CLAIM_INTERVAL_MS = 24 * 3_600_000;   // one claim per day
export const STREAK_WINDOW_MS = 48 * 3_600_000;    // claim before this → streak lives

/** Below this many closed positions, a reputation is noise wearing a number. */
export const PROVISIONAL_BELOW = 10;

/**
 * Granted once when an account is created, never again.
 *
 * Once per ACCOUNT, not once per device: the device is a browser, and browsers
 * are free. The account is the thing a person can only have one of per Google
 * `sub` or X user id, so that is where the bonus is spent. One full day's
 * refill, handed over the moment identity stops being anonymous.
 */
export const CONNECT_BONUS = 5;

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
 * Real-money community markets DO hold a real, on-chain vault — but the
 * deployed Solana program (create_market / resolve_market / take_position /
 * claim_winnings — see oddie_chain_idl.json) has no fee-taking instruction,
 * and this repo has no program source to add one and redeploy. CREATOR_FEE_
 * BPS_REAL and PROTOCOL_FEE_BPS_REAL are therefore PROPOSED rates only: shown
 * to users for transparency and logged as an "intended fee" for future
 * reconciliation, but never actually deducted from the vault. See
 * logRealFeeIntent in markets.ts and the "not yet enforced on-chain" copy
 * next to every place these rates are displayed — do not let a future change
 * present these as if they were being charged until the on-chain program
 * actually supports taking them.
 */
export const CREATOR_FEE_BPS_PLAY = 300;   // 3% of total pool (both sides), additive bonus to the creator
export const CREATOR_FEE_BPS_REAL = 200;   // 2% of the vault — proposed, NOT yet enforced on-chain
export const PROTOCOL_FEE_BPS_REAL = 300;  // 3% of the vault — proposed, NOT yet enforced on-chain

/** Floors to 0 on small pools rather than paying out a fractional token — a
 *  market needs roughly 34+ total tokens staked before the 3% fee rounds up
 *  to even 1, which quietly protects against dust/degenerate-pool noise. */
export function creatorFeePlay(totalPoolTokens: number): number {
  return Math.floor((totalPoolTokens * CREATOR_FEE_BPS_PLAY) / 10000);
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
