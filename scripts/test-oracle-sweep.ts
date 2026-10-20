/**
 * THE GATES BETWEEN A CLOSED MARKET AND A SETTLED ONE.
 *
 * The loop these guard used to live in a hand-run script, so none of it was
 * covered and none of it ran in production: nothing in src/ imported src/oracle
 * at all, and markets were only ever settled by a person clicking resolve. Now
 * the server runs the same sweep on a timer, which turns every one of these
 * gates from a thing a careful operator does into a thing the code must do
 * unattended.
 *
 * Each check below is a way the sweep could spend money or settle something it
 * must not:
 *
 *   - a retired market is off the board; settling one decides a market nobody
 *     can see or stake in
 *   - a resolved market must never be settled twice
 *   - a dry run must reach and RECORD a real decision and stop before acting,
 *     or watching it before trusting it tells you nothing
 *   - a failed database read is not a market without criteria, and treating it
 *     as one sends an operator to rewrite rules that were there all along
 *   - the retry record must be consulted BEFORE the model, or a market held by
 *     a permanent gate is re-bought on every tick forever
 *   - the limit must count markets ASKED ABOUT, not markets seen, or a board
 *     full of held markets starves the ones worth asking about
 *
 * Every dependency is injected, so this touches no database, no model and no
 * chain. Run with: npm run test-oracle-sweep
 */
import { oracleSweep, type OracleSweepMarket } from "../src/oracle/sweep.js";
import type { OracleDecision } from "../src/oracle/oracle.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const market = (slug: string, over: Partial<OracleSweepMarket> = {}): OracleSweepMarket => ({
  slug, question: `Will ${slug}?`, closesAt: "2020-01-01T00:00:00.000Z",
  resolvedOutcome: null, retiredAt: null, ...over,
});

/** A decision that WOULD settle, so anything that does not settle in these
 *  tests was stopped by a gate rather than by the oracle abstaining. */
const yes = (slug: string): OracleDecision =>
  ({ slug, settle: "yes", gate: "settled", reason: "test" } as OracleDecision);

function harness(board: OracleSweepMarket[], over: Partial<Parameters<typeof oracleSweep>[0]> = {}) {
  const asked: string[] = [];
  const recorded: string[] = [];
  const settled: string[] = [];
  const deps = {
    board: async () => board,
    criteria: async () => ({ ok: true as const, criteria: "a rule long enough to pass the code gate" }),
    attempt: async () => ({ lastGate: null, lastDecidedAt: null, paidAttempts: 0 }),
    decide: async (m: { slug: string }) => { asked.push(m.slug); return yes(m.slug); },
    record: async (d: OracleDecision) => { recorded.push(d.slug); },
    settle: async (slug: string) => { settled.push(slug); return true; },
    ...over,
  };
  return { deps: deps as Parameters<typeof oracleSweep>[0], asked, recorded, settled };
}

console.log("\nmarkets that must never be touched");
{
  const h = harness([
    market("retired", { retiredAt: "2025-01-01T00:00:00.000Z" }),
    market("already-resolved", { resolvedOutcome: "no" }),
    market("open"),
  ]);
  const r = await oracleSweep(h.deps);
  check("a retired market is not even asked about", !h.asked.includes("retired"));
  check("nor is a resolved one", !h.asked.includes("already-resolved"));
  check("the open one is", h.asked.includes("open"));
  check("and only it can settle", h.settled.join(",") === "open", `settled: ${h.settled.join(",") || "none"}`);
  check("seen counts only the eligible board", r.seen === 1, `seen ${r.seen}`);
}

console.log("\na dry run decides and records, and settles nothing");
{
  const h = harness([market("a"), market("b")], { settle: null });
  const r = await oracleSweep(h.deps);
  check("both markets reached the oracle", h.asked.length === 2);
  check("both decisions were written down", h.recorded.length === 2);
  check("nothing was settled", r.settled === 0 && h.settled.length === 0);
  check("and the decisions are still reported", r.decided.length === 2);
}

console.log("\na database that will not answer is not a market without a rule");
{
  const h = harness([market("unreadable")], {
    criteria: async () => ({ ok: false as const, error: "connection terminated" }),
  });
  const r = await oracleSweep(h.deps);
  check("the oracle is never asked", h.asked.length === 0, "asking would spend money on a read that failed");
  check("nothing is settled", r.settled === 0);
  check("and it is counted as unreadable, not as a decision", r.unreadable === 1 && r.decided.length === 0);
}

console.log("\nthe retry record is consulted before the model");
{
  const h = harness([market("held")], {
    // "not-checkable" is the one PERMANENT gate: the model looked and said the
    // question cannot be checked by anyone, and only a person editing the
    // criteria changes that. Deliberately not one of the free gates
    // (no-criteria, not-closed) -- those are reached without spending anything,
    // so retrying them costs nothing and the record lets them through.
    attempt: async () => ({ lastGate: "not-checkable", lastDecidedAt: new Date().toISOString(), paidAttempts: 1 }),
  });
  const r = await oracleSweep(h.deps);
  check("no model call is made", h.asked.length === 0);
  check("and it is counted as held", r.held === 1);
}

console.log("\na price rule is arithmetic, so a paid past does not hold it");
{
  // gold and five more on 20 Oct: three paid rounds of failed citations each,
  // then a price rule. The record said wait a day; candles cost nothing.
  const pc = { chain: "bybit", mint: "XAUUSDT", symbol: "XAU", name: "gold (XAU/USD)", pool: "XAUUSDT", supply: 0, metric: "price", op: "<", target: 4200, mode: "at-close", from: "2026-10-12T19:46:01.262Z", to: "2026-10-16T21:00:00.000Z" } as const;
  const paidPast = async () => ({ lastGate: "citations-failed", lastDecidedAt: new Date().toISOString(), paidAttempts: 3 });
  const seen: Array<unknown> = [];
  const h = harness([market("gold"), market("words-only")], {
    criteria: async (slug: string) => ({ ok: true as const, criteria: "a rule long enough to pass the code gate", priceCheck: slug === "gold" ? { ...pc } : null }),
    attempt: paidPast,
    decide: async (m: { slug: string; priceCheck?: unknown }) => { h.asked.push(m.slug); seen.push(m.priceCheck); return yes(m.slug); },
  });
  const r = await oracleSweep(h.deps);
  check("the market with a price rule is asked at once", h.asked.join(",") === "gold", `asked ${h.asked.join(",")}`);
  check("...with its rule handed to the oracle", (seen[0] as { pool?: string } | null)?.pool === "XAUUSDT");
  check("...while one with only words still waits out its paid rounds", r.held === 1 && h.settled.join(",") === "gold", `held ${r.held}`);
}

console.log("\nthe limit bounds the bill, and counts the right thing");
{
  const h = harness([market("a"), market("b"), market("c")], { limit: 2 });
  const r = await oracleSweep(h.deps);
  check("only two markets reached the oracle", h.asked.length === 2, `asked ${h.asked.join(",")}`);
  check("and the sweep says there is more to do", r.truncated);
}
{
  // Held markets must not consume the limit, or one permanently-held market at
  // the top of the board starves everything behind it, every tick, forever.
  const h = harness([market("held"), market("a"), market("b")], {
    limit: 2,
    attempt: async (slug: string) => slug === "held"
      ? { lastGate: "not-checkable", lastDecidedAt: new Date().toISOString(), paidAttempts: 1 }
      : { lastGate: null, lastDecidedAt: null, paidAttempts: 0 },
  });
  await oracleSweep(h.deps);
  check("a held market does not eat a slot", h.asked.join(",") === "a,b", `asked ${h.asked.join(",")}`);
}
{
  // 20 Oct: the board comes newest first, its five newest were all still open,
  // and with a limit of five the closed gold market below them was never asked.
  const later = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const open = ["o1", "o2", "o3", "o4", "o5", "o6"].map((s) => market(s, { closesAt: later }));
  const h = harness([...open, market("gold")], { limit: 5 });
  const r = await oracleSweep(h.deps);
  check("markets still open do not use up the limit", h.asked.join(",") === "gold", `asked ${h.asked.join(",")}`);
  check("...so a closed market behind them is settled", h.settled.join(",") === "gold" && !r.truncated, `settled ${h.settled.join(",")}`);
}

console.log("\na price rule its candles can decide is read before its close");
{
  /* 20 Oct: Bee's ETH market traded at $2,478 the day it opened and took bets
     for five more days. An open market with a touch or a hold is read every
     sweep; a read that decides nothing is not written down, and none of it
     takes a slot from the limit. */
  const later = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const pc = (mode: string) => ({ chain: "binance", mint: "ETHUSDT", symbol: "ETH", name: "Ethereum (ETH)", pool: "ETHUSDT", supply: 0, metric: "price", op: ">", target: 2400, mode, from: "2026-10-20T12:05:38.584Z", to: later }) as unknown as OracleSweepMarket["priceCheck"];
  const board = [
    market("eth-touch", { closesAt: later, priceCheck: pc("touch") }),
    market("btc-hold", { closesAt: later, priceCheck: pc("always") }),
    market("near-close", { closesAt: later, priceCheck: pc("at-close") }),
    market("fed-words", { closesAt: later }),
    market("gold"),
  ];
  const rule = async (slug: string) => ({ ok: true as const, criteria: "a rule long enough to pass the code gate", priceCheck: board.find((m) => m.slug === slug)?.priceCheck ?? null });
  const still = (slug: string) => ({ slug, settle: null, gate: "not-closed", reason: "still open" } as OracleDecision);
  const h = harness(board, {
    limit: 1,
    criteria: rule,
    decide: async (m: { slug: string }) => { h.asked.push(m.slug); return m.slug === "btc-hold" ? still(m.slug) : yes(m.slug); },
  });
  const r = await oracleSweep(h.deps);
  check("open markets whose touch or hold can be decided are read, and only they", h.asked.join(",") === "eth-touch,btc-hold,gold", `asked ${h.asked.join(",")}`);
  check("...a decided one settles before its close", h.settled.join(",") === "eth-touch,gold", `settled ${h.settled.join(",")}`);
  check("...one that decides nothing is not written down", h.recorded.join(",") === "eth-touch,gold", `recorded ${h.recorded.join(",")}`);
  check("...and none of it takes the limit's one slot from the closed market", r.early === 2 && !r.truncated, `early ${r.early}, truncated ${r.truncated}`);

  const past = harness([market("a"), market("b"), market("eth-touch", { closesAt: later, priceCheck: pc("touch") })], {
    limit: 1,
    criteria: rule,
    decide: async (m: { slug: string }) => { past.asked.push(m.slug); return yes(m.slug); },
  });
  const r2 = await oracleSweep(past.deps);
  check("past the limit the sweep still reads the open price markets below it",
    past.asked.join(",") === "a,eth-touch" && r2.truncated && past.settled.join(",") === "a,eth-touch", `asked ${past.asked.join(",")}, truncated ${r2.truncated}`);
}

console.log("\na settlement that fails is reported, not swallowed");
{
  const h = harness([market("a")], { settle: async () => false });
  const r = await oracleSweep(h.deps);
  check("it counts as failed", r.failed === 1 && r.settled === 0);
}

console.log(failures === 0
  ? "\nall oracle-sweep checks passed.\n"
  : `\n${failures} oracle-sweep check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
