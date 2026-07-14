// The paper economy, as arithmetic. No database, no clock of its own, no I/O —
// every function here takes what it needs and returns what it computed, so the
// whole cycle (call → odds move → exit → reputation) can be proven offline with
// injected prices instead of waiting for a real market to move.
//
// Virtual tokens only. Nothing here converts to money in either direction, and
// no function in this file has any idea what a dollar is.

/** A new device's stake in the game. */
export const STARTING_TOKENS = 1000;

/**
 * Tokens are renewable, because a locked-out player is a lost player. A device
 * below the floor collects a grant once every window, until it is back at the
 * floor. Above the floor nothing is granted — the top-up is a safety net, not
 * an income.
 */
export const TOKEN_FLOOR = 1000;
export const DAILY_TOPUP = 200;
export const TOPUP_INTERVAL_MS = 24 * 3_600_000;

/** Below this many closed positions, a reputation is noise wearing a number. */
export const PROVISIONAL_BELOW = 10;

/**
 * Granted once when an account is created, never again.
 *
 * Once per ACCOUNT, not once per device: the device is a browser, and browsers
 * are free. The account is the thing a person can only have one of per Google
 * `sub` or X user id, so that is where the bonus is spent.
 */
export const CONNECT_BONUS = 100;

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

export interface TopUp {
  tokens: number;
  toppedUpAt: number;
  granted: number;
}

/**
 * Lazy, idempotent, and safe to call on every balance read.
 *
 * The window advances whether or not tokens were granted. Freezing it while a
 * device sits above the floor would hand it an instant grant the moment it
 * spent down — a rich player would be topped up faster than a poor one, which
 * is precisely backwards.
 *
 * One grant per window, never more, no matter how many windows were missed. A
 * player who vanishes for a month comes back to 200, not 6000: the top-up
 * exists so you can play today, not so that waiting is a strategy.
 */
export function applyTopUp(tokens: number, toppedUpAt: number, now: number): TopUp {
  if (now - toppedUpAt < TOPUP_INTERVAL_MS) return { tokens, toppedUpAt, granted: 0 };
  if (tokens >= TOKEN_FLOOR) return { tokens, toppedUpAt: now, granted: 0 };
  const next = Math.min(TOKEN_FLOOR, tokens + DAILY_TOPUP);
  return { tokens: next, toppedUpAt: now, granted: next - tokens };
}

/** Milliseconds until the next grant, or null when there is nothing to grant. */
export function nextTopUpIn(tokens: number, toppedUpAt: number, now: number): number | null {
  if (tokens >= TOKEN_FLOOR) return null;
  return Math.max(0, toppedUpAt + TOPUP_INTERVAL_MS - now);
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
