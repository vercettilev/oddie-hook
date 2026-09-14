/**
 * THE SWEEP: settle what can be settled, hand the rest to a person.
 *
 * This loop used to live inside scripts/oracle.ts, which meant the oracle only
 * ever ran when somebody remembered to run it. Nothing in src/ imported
 * src/oracle at all, so in production no market was ever closed by anything but
 * a human clicking resolve -- while the landing said dated evidence closes it.
 *
 * Extracted rather than copied. A second loop would be a second set of gates to
 * keep in step (the retired filter, the retry record, the order in which the
 * decision is written down), and the first one to drift would be the one nobody
 * watches. The script and the server now differ in exactly two things they
 * SHOULD differ in: how they print, and how they settle.
 *
 * Everything it touches is injected, so this file talks to no database, no
 * model and no chain. That is also what makes it testable without either.
 */
import { shouldRetry, decisionWasPaid, type OracleDecision } from "./oracle.js";
import type { PriceCheck } from "../price/index.js";

export interface OracleSweepMarket {
  slug: string;
  question: string;
  closesAt: string | null;
  resolvedOutcome: "yes" | "no" | null;
  retiredAt: string | null;
}

export interface OracleSweepDeps {
  /** Every community market the admin list knows about. Filtered here, not by
   *  the caller, because "which markets may be settled" is a rule and rules
   *  live in one place. */
  board: () => Promise<OracleSweepMarket[]>;
  /**
   * The resolution criteria, and whether the read itself worked.
   *
   * A database error is NOT the same as a market created without criteria, and
   * collapsing both into null says exactly that: an operator reading "this
   * market carries no resolution criteria" would go and rewrite criteria that
   * were in the database all along. The sweep holds a connection through
   * minutes of model calls, so a mid-run reset is realistic.
   */
  criteria: (slug: string) => Promise<{ ok: true; criteria: string | null; priceCheck?: PriceCheck | null } | { ok: false; error: string }>;
  attempt: (slug: string) => Promise<{ lastGate: string | null; lastDecidedAt: string | null; paidAttempts: number }>;
  decide: (m: { slug: string; question: string; criteria: string | null; closeTime: string | null; priceCheck?: PriceCheck | null }, asOf?: Date) => Promise<OracleDecision>;
  record: (d: OracleDecision & { paid: boolean }) => Promise<void>;
  /**
   * Null means DRY RUN, and dry run is not a mock: every market is read, every
   * gate is applied and every decision is reached and recorded. It simply stops
   * before announcing one. That is the honest way to watch this before trusting
   * it, and it is the same shape the X bot uses.
   */
  settle: ((slug: string, outcome: "yes" | "no") => Promise<boolean>) | null;
  /** Ask again even where the record says not to. */
  force?: boolean;
  asOf?: Date;
  /**
   * Most decisions cost a model call, so an unbounded sweep is an unbounded
   * bill: the first tick after a quiet week would ask about every market that
   * has closed since. Counts markets ASKED ABOUT, not markets seen, so a board
   * full of held markets does not consume it.
   */
  limit?: number;
  on?: Partial<{
    unreadable: (slug: string, error: string) => void;
    held: (slug: string, why: string) => void;
    decided: (d: OracleDecision) => void;
    settled: (slug: string, outcome: "yes" | "no") => void;
    failed: (slug: string, outcome: "yes" | "no") => void;
  }>;
}

export interface OracleSweepResult {
  /** Open markets the sweep was allowed to consider. */
  seen: number;
  /** Reached a decision this run (the rest were held by the record). */
  decided: OracleDecision[];
  held: number;
  unreadable: number;
  /** Hit the limit and stopped early, so there is more to do next tick. */
  truncated: boolean;
  settled: number;
  failed: number;
}

export async function oracleSweep(deps: OracleSweepDeps): Promise<OracleSweepResult> {
  // Retired markets are off the board and must never be settled: the oracle
  // would be deciding a market nobody can see or stake in.
  const board = (await deps.board()).filter((m) => !m.resolvedOutcome && !m.retiredAt);
  const out: OracleSweepResult = {
    seen: board.length, decided: [], held: 0, unreadable: 0, truncated: false, settled: 0, failed: 0,
  };
  const limit = deps.limit ?? Infinity;

  for (const m of board) {
    if (out.decided.length >= limit) { out.truncated = true; break; }

    const read = await deps.criteria(m.slug).catch((e) => ({ ok: false as const, error: (e as Error).message }));
    if (!read.ok) {
      out.unreadable++;
      deps.on?.unreadable?.(m.slug, read.error);
      continue;
    }

    // Ask the record before spending anything. A market whose criteria the
    // model has already judged uncheckable answers the same way at the same
    // price every run, until a person rewrites them.
    const attempt = await deps.attempt(m.slug).catch(() => ({ lastGate: null, lastDecidedAt: null, paidAttempts: 0 }));
    const again = shouldRetry(attempt);
    if (!again.retry && !deps.force) {
      out.held++;
      deps.on?.held?.(m.slug, again.why);
      continue;
    }

    const d = await deps.decide(
      { slug: m.slug, question: m.question, criteria: read.criteria, closeTime: m.closesAt, priceCheck: read.priceCheck ?? null },
      deps.asOf,
    );
    out.decided.push(d);

    // Written down BEFORE anything is announced, and best-effort by
    // construction: the log going down must not take a settlement with it.
    await deps.record({ ...d, paid: decisionWasPaid(d) }).catch(() => {});
    deps.on?.decided?.(d);

    if (!d.settle || !deps.settle) continue;
    const ok = await deps.settle(m.slug, d.settle).catch(() => false);
    if (ok) { out.settled++; deps.on?.settled?.(m.slug, d.settle); }
    else { out.failed++; deps.on?.failed?.(m.slug, d.settle); }
  }
  return out;
}
