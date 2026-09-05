/**
 * THE LEDGER'S MATHS, PURE.
 *
 * Every settled call, priced by the program's own payout rule, and rolled up
 * into standings. It lived inside server.ts, which cannot be imported by any
 * test (app.listen at module scope), so the one computation the board and a
 * wallet's page both depend on was the one computation nothing could check.
 * The old store functions it replaced (walletReceipts, walletLeaderboard)
 * priced off an ESTIMATE of the pool and never knew the winning side's share
 * of it -- the denominator of the payout -- so they agreed with the chain by
 * luck. This takes the market's frozen totals as input and never touches the
 * chain itself; the caller reads them.
 *
 * Rules that are load-bearing and tested:
 *   - right-or-wrong comes from OUR settlement and is always counted;
 *     money and points need the chain and wait when it cannot be read;
 *   - an unreadable market prices to null, never to zero;
 *   - standings are ordered by points, never by money and never by wins.
 */
import { payoutLamports } from "./economy.js";
import { receiptWeight, type SettledCall } from "./markets.js";

/** The frozen totals of a resolved market, as the program leaves them. */
export interface MarketTotals {
  resolved: boolean;
  winningSide: "yes" | "no" | null;
  totalYesLamports: number;
  totalNoLamports: number;
  creatorFeeLamports: number;
  protocolFeeLamports: number;
}

export interface PricedCall {
  wallet: string; slug: string; question: string;
  side: "yes" | "no"; outcome: "yes" | "no"; won: boolean;
  lamports: number; entryPct: number;
  poolLamports: number | null;
  payoutLamports: number | null;
  pnlLamports: number | null;
  weight: number | null;
}

export interface Standing {
  wallet: string; wins: number; losses: number; points: number;
  realizedLamports: number;
  /** Settled calls whose market could not be read, so they are in no total. */
  unpriced: number;
}

export function priceCall(c: SettledCall, m: MarketTotals | null): PricedCall {
  const base = {
    wallet: c.wallet, slug: c.slug, question: c.question, side: c.side,
    outcome: c.outcome, won: c.won, lamports: c.lamports, entryPct: c.entryPct,
  };
  if (!m || !m.resolved || !m.winningSide) {
    return { ...base, poolLamports: null, payoutLamports: null, pnlLamports: null, weight: null };
  }
  const pool = m.totalYesLamports + m.totalNoLamports;
  const payout = payoutLamports(c.lamports, c.side, { ...m, winningSide: m.winningSide });
  return {
    ...base,
    poolLamports: pool,
    payoutLamports: payout,
    pnlLamports: payout - c.lamports,
    // The chain's pool, not a store estimate: one number, one source.
    weight: receiptWeight({ entryPct: c.entryPct, won: c.won, poolLamports: pool }),
  };
}

export function standingsFrom(calls: PricedCall[]): Standing[] {
  const by = new Map<string, Standing>();
  for (const c of calls) {
    const st = by.get(c.wallet) ?? { wallet: c.wallet, wins: 0, losses: 0, points: 0, realizedLamports: 0, unpriced: 0 };
    // RIGHT-OR-WRONG AND HOW-MUCH ARE DIFFERENT QUESTIONS, and only the second
    // needs the chain. A market we could not price is still a call we know
    // they got right or wrong; dropping it from the record would understate
    // somebody's hit rate because an RPC blinked.
    if (c.won) st.wins++; else st.losses++;
    if (c.pnlLamports === null) st.unpriced++;
    else {
      st.points += c.weight ?? 0;
      st.realizedLamports += c.pnlLamports;
    }
    by.set(c.wallet, st);
  }
  // Points, then money as the tiebreak. Never wins: win count is the
  // bandwagon's own metric, and the board exists because the pool mechanics
  // pay the pile-on the same as the early call.
  return [...by.values()].sort((a, b) => b.points - a.points || b.realizedLamports - a.realizedLamports);
}

/** Dense rank over an already-ordered list: the rank advances per DISTINCT
 *  points total, so two people on the same points are the same place. Same
 *  rule as the Genesis board. */
export function denseRank<T extends { points: number }>(ordered: T[]): Array<T & { rank: number }> {
  let rank = 0, prev: number | null = null;
  return ordered.map((s) => {
    if (prev === null || s.points !== prev) { rank += 1; prev = s.points; }
    return { ...s, rank };
  });
}
