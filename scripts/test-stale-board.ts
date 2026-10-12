// Markets that closed two days ago, unsettled, with nothing in them leave the
// board (src/staleBoard.ts); everything else stays, and money is never hidden.
import { retireStaleMarkets, STALE_AFTER_MS, type StaleCandidate } from "../src/staleBoard.js";

let failed = 0;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; };

const NOW = Date.parse("2026-10-12T21:00:00Z");
const ago = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();
const m = (slug: string, closesAt: string | null, extra: Partial<StaleCandidate> = {}): StaleCandidate =>
  ({ slug, closesAt, resolvedOutcome: null, retiredAt: null, onchainPubkey: null, ...extra });

const board = [
  m("levvercetti-6k-today", ago(24 * 15)),                                   // the 12 Oct nine: unminted
  m("theptilla-ore", ago(24 * 15), { onchainPubkey: "EMPTY" }),             // minted, vault empty
  m("btc-130k-friday", ago(24 * 3)),
  m("closed-yesterday", ago(20)),                                           // inside the two days
  m("open-tonight", ago(-3)),                                               // still open
  m("no-close", null),
  m("settled", ago(24 * 10), { resolvedOutcome: "yes" }),
  m("already-retired", ago(24 * 10), { retiredAt: ago(24) }),
  m("funded", ago(24 * 5), { onchainPubkey: "FUNDED" }),                    // somebody's money
  m("unreadable", ago(24 * 5), { onchainPubkey: "DOWN" }),                  // chain unreachable
];
const vaults: Record<string, number | null> = { EMPTY: 0, FUNDED: 250_000_000, DOWN: null };
const retiredCalls: Array<[string, number | null]> = [];

const out = await retireStaleMarkets({
  list: async () => board,
  vault: async (pk) => vaults[pk] ?? null,
  // retireMarket's own guard, as the store applies it.
  retire: async (slug, v) => {
    retiredCalls.push([slug, v]);
    if (v === null) return { ok: false, reason: "the vault could not be read, so it was not retired" };
    if (v > 0) return { ok: false, reason: `holds ${(v / 1e9).toFixed(4)} SOL` };
    return { ok: true };
  },
  now: () => NOW,
});

check("two days after the close, unsettled and empty: retired",
  out.retired.join() === "levvercetti-6k-today,theptilla-ore,btc-130k-friday");
check("an unminted market is retired with an empty vault, a minted one with what the chain read",
  JSON.stringify(retiredCalls.slice(0, 2)) === JSON.stringify([["levvercetti-6k-today", 0], ["theptilla-ore", 0]]));
check("a funded vault is refused, and so is one that cannot be read",
  out.refused.map((r) => r.slug).join() === "funded,unreadable");
check("inside the two days, open, closeless, settled and retired markets are never touched",
  !retiredCalls.some(([s]) => ["closed-yesterday", "open-tonight", "no-close", "settled", "already-retired"].includes(s)));
check("the window is exactly two days", STALE_AFTER_MS === 48 * 3600_000);

// A vault read that throws is a refusal too, never a zero.
const thrown = await retireStaleMarkets({
  list: async () => [m("minted", ago(24 * 5), { onchainPubkey: "X" })],
  vault: async () => { throw new Error("rpc down"); },
  retire: async (_s, v) => (v === null ? { ok: false, reason: "unreadable" } : { ok: true }),
  now: () => NOW,
});
check("a vault read that throws is a refusal", thrown.retired.length === 0 && thrown.refused.length === 1);

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log("stale board: all passed");
