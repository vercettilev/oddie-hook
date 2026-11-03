/**
 * THE FEE LEDGER, HELD UP AGAINST THE CHAIN.
 *
 * market_fee_log records what resolve_market fixed on each real-money market,
 * and the chain is the only place that number exists. The rate times the pool
 * is only its ceiling: the program takes nothing from a one-sided pool and
 * never more than the losing side staked (cap_fees in lib.rs, fixedFees in
 * src/odds.ts). Two things live here, and both talk to nothing but what they
 * are handed: booking a market's fee once its resolve has landed, and comparing
 * the ledger with the chain for the read-only report
 * (scripts/fee-ledger-report.ts).
 */
import type { MarketRead, OnChainMarketState } from "./chain/oddieChain.js";

/** The wait before the one second look. The Telegram notice waits the same
 *  4 s for the same reason: a confirmed resolve can land a beat before a read
 *  sees it. */
export const FEE_REREAD_MS = 4_000;

export interface FeeBookDeps {
  /** A fresh read, never a cached one: the cache can still hold the market as
   *  it was before the verdict. */
  read(pubkey: string): Promise<MarketRead>;
  wait(ms: number): Promise<void>;
  /** logRealFee: writes the amounts it is given, and no row for a zero. */
  book(slug: string, totalVaultLamports: number, creatorFeeBps: number, fixed: { creator: number; protocol: number }): Promise<void>;
  log(evt: string, extra: Record<string, unknown>): void;
}

/** What one booking did, for the caller's log and for the tests. */
export type FeeBooking = "booked" | "empty" | "closed" | "unsettled" | "unreadable";

const poolOf = (s: OnChainMarketState): number => s.totalYesLamports + s.totalNoLamports;

/**
 * Book a market's fee, once its resolve has landed.
 *
 * Only ever called after resolveMarketOnChain came back ok, so a read that has
 * not seen the market settled is behind rather than right. It gets one more
 * look after a short wait, and that is all: the fee is never worked out from
 * the rate, so a market still unsettled on the second read is left unbooked and
 * said out loud (`fee_log_gap`), and the report finds it against the chain.
 */
export async function bookFeeAfterResolve(slug: string, pubkey: string, deps: FeeBookDeps): Promise<FeeBooking> {
  // An empty pool has no fee to wait for, and a closed account has no pool.
  const behind = (r: MarketRead): boolean =>
    r.ok ? !r.state.resolved && poolOf(r.state) > 0 : r.reason === "unreadable";
  let r = await deps.read(pubkey);
  if (behind(r)) {
    await deps.wait(FEE_REREAD_MS);
    r = await deps.read(pubkey);
  }
  if (!r.ok) {
    // Only an empty market is ever closed (closeMarketOnChain and the program
    // both refuse one that took a stake), and an empty market has no fee.
    if (r.reason === "absent") return "closed";
    deps.log("fee_log_gap", { slug, market: pubkey, why: "unreadable", error: r.error, report: "npm run fee-ledger-report" });
    return "unreadable";
  }
  const pool = poolOf(r.state);
  if (pool <= 0) return "empty";
  if (!r.state.resolved) {
    deps.log("fee_log_gap", { slug, market: pubkey, why: "not settled on the second read", pool, report: "npm run fee-ledger-report" });
    return "unsettled";
  }
  await deps.book(slug, pool, r.state.creatorFeeBps, {
    creator: r.state.creatorFeeLamports, protocol: r.state.protocolFeeLamports,
  });
  return "booked";
}

/**
 * Every minted market with its real-money rows, summed by half, for the
 * report. Rows with enforced = false are left out: logged, never charged (the
 * era before the program charged anything, and the fallback's rows on
 * one-sided pools, marked on 3 Nov 2026), they claim nothing.
 */
export const FEE_LEDGER_SQL = `
  SELECT cm.slug, cm.onchain_pubkey,
         COALESCE(SUM(f.fee_amount) FILTER (WHERE f.fee_kind = 'creator'), 0)::bigint AS creator_lamports,
         COALESCE(SUM(f.fee_amount) FILTER (WHERE f.fee_kind = 'protocol'), 0)::bigint AS protocol_lamports,
         COUNT(f.id)::int AS fee_rows,
         MIN(f.basis_amount)::bigint AS basis_min,
         MAX(f.basis_amount)::bigint AS basis_max,
         MAX(f.created_at) AS last_booked_at
    FROM community_market cm
    LEFT JOIN market_fee_log f
      ON f.slug = cm.slug AND f.market_kind = 'real' AND f.enforced = true
   WHERE cm.onchain_pubkey IS NOT NULL
   GROUP BY cm.slug, cm.onchain_pubkey, cm.market_id
   ORDER BY cm.market_id`;

/** One FEE_LEDGER_SQL row as node-postgres hands it back: bigint is a string. */
export type FeeLedgerRow = {
  slug: string;
  onchain_pubkey: string;
  creator_lamports: string;
  protocol_lamports: string;
  fee_rows: number;
  basis_min: string | null;
  basis_max: string | null;
  last_booked_at: Date | null;
};

/** One minted market's real-money rows, summed by half, as the report reads them. */
export interface LedgerMarket {
  slug: string;
  pubkey: string;
  /** `basis` is the pool the rows were booked against, null with no rows. */
  logged: { creator: number; protocol: number; rows: number; basis: { min: number; max: number } | null };
  lastBookedAt: string | null;
}

export function ledgerMarketFrom(r: FeeLedgerRow): LedgerMarket {
  return {
    slug: r.slug,
    pubkey: r.onchain_pubkey,
    logged: {
      creator: Number(r.creator_lamports),
      protocol: Number(r.protocol_lamports),
      rows: Number(r.fee_rows),
      basis: r.basis_min === null || r.basis_max === null ? null : { min: Number(r.basis_min), max: Number(r.basis_max) },
    },
    lastBookedAt: r.last_booked_at ? r.last_booked_at.toISOString() : null,
  };
}

export type FeeVerdict =
  /** The rows say what the chain fixed, a market with no fee and no row included. */
  | "agrees"
  /** Not settled on chain and nothing booked: nothing to compare yet. */
  | "open"
  /** An empty market closed for its rent, with no row: nothing to compare. */
  | "closed"
  /** The rows say more than the chain fixed. */
  | "over"
  /** The rows say less than the chain fixed. */
  | "under"
  /** The chain fixed a fee and there is no row for it. */
  | "missing"
  /** Rows for a market the chain has not settled: nothing backs them. */
  | "not-settled"
  /**
   * Rows booked against a pool this account does not hold. The mainnet
   * backfill re-minted every market at the address it had on devnet, so a row
   * from the devnet weeks names the same account and a different pool.
   * Comparing its fee with this account's would be comparing two markets.
   */
  | "other-pool"
  /** The market could not be read, so nothing is said about it. */
  | "unreadable";

export interface FeeAudit {
  slug: string;
  verdict: FeeVerdict;
  logged: LedgerMarket["logged"];
  /** The pool on chain now, when the read worked. */
  pool: number | null;
  /** What resolve_market fixed, when the read saw the market settled. */
  chain: { creator: number; protocol: number } | null;
  /** Logged minus chain, per half: positive is more in the ledger than on chain. */
  diff: { creator: number; protocol: number } | null;
  error?: string;
}

export function auditFeeLedger(m: LedgerMarket, read: MarketRead): FeeAudit {
  const base = { slug: m.slug, logged: m.logged, pool: null, chain: null, diff: null };
  if (!read.ok) {
    // Absent is an empty market closed for its rent, or the wrong cluster.
    // With rows against it, that is not something to judge from here.
    if (read.reason === "absent" && m.logged.rows === 0) return { ...base, verdict: "closed" };
    return { ...base, verdict: "unreadable", error: read.reason === "absent" ? "no such account on this cluster" : read.error };
  }
  const pool = poolOf(read.state);
  const basis = m.logged.basis;
  if (basis && (basis.min !== pool || basis.max !== pool)) return { ...base, pool, verdict: "other-pool" };
  if (!read.state.resolved) return { ...base, pool, verdict: m.logged.rows === 0 ? "open" : "not-settled" };
  const chain = { creator: read.state.creatorFeeLamports, protocol: read.state.protocolFeeLamports };
  const diff = { creator: m.logged.creator - chain.creator, protocol: m.logged.protocol - chain.protocol };
  const verdict: FeeVerdict =
    diff.creator === 0 && diff.protocol === 0 ? "agrees"
    : m.logged.rows === 0 ? "missing"
    : diff.creator > 0 || diff.protocol > 0 ? "over"
    : "under";
  return { ...base, pool, verdict, chain, diff };
}
