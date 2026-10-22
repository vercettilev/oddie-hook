// Long markets park their idle SOL in swSOL and bring it home before the end
// (src/swsolSweep.ts). Bringing it home never waits for the switch, and nothing
// is decided about a vault that could not be read.
import {
  sweepSwsol, swsolAction, DAY_MS, ADMIN_FLOOR_LAMPORTS, PARK_COST_LAMPORTS,
  type SwsolCandidate, type SwsolMoveResult, type VaultView,
} from "../src/swsolSweep.js";

let failed = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || got === undefined ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!ok) failed++;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const NOW = Date.parse("2026-10-14T12:00:00Z");
const SOL = 1_000_000_000;
const RICH = 150_000_000; // the admin wallet, comfortably above the floor
const on = { parkEnabled: true, adminLamports: RICH };
const v = (daysLeft: number, idleSol: number, parkedSol = 0, resolved = false): VaultView =>
  ({ resolved, closeTimeMs: NOW + daysLeft * DAY_MS, idleLamports: Math.round(idleSol * SOL), parkedLamports: Math.round(parkedSol * SOL) });

console.log("\nwhat one vault does on one pass\n");
check("the Vibhu market as it stood: 79 days, 0.51 idle parks all of it",
  same(swsolAction(v(79, 0.51), NOW, on), { kind: "park", lamports: 510_000_000 }), swsolAction(v(79, 0.51), NOW, on));
check("parking off: nothing parks", swsolAction(v(79, 0.51), NOW, { ...on, parkEnabled: false }) === null);
check("under a week to go: nothing parks, even 5 SOL", swsolAction(v(6.9, 5), NOW, on) === null);
check("exactly a week: 2 SOL parks (14 SOL-days)", swsolAction(v(7, 2), NOW, on)?.kind === "park");
check("10 days, 1 SOL: 10 SOL-days parks", swsolAction(v(10, 1), NOW, on)?.kind === "park");
check("10 days, 0.5 SOL: 5 SOL-days would cost more than it earns", swsolAction(v(10, 0.5), NOW, on) === null);
check("79 days, 0.05 SOL: 3.95 SOL-days stays SOL", swsolAction(v(79, 0.05), NOW, on) === null);
check("an empty vault does nothing", swsolAction(v(79, 0), NOW, on) === null);
check("admin wallet under the floor: nothing parks",
  swsolAction(v(79, 3), NOW, { ...on, adminLamports: ADMIN_FLOOR_LAMPORTS - 1 }) === null);
check("admin wallet unreadable: nothing parks", swsolAction(v(79, 3), NOW, { ...on, adminLamports: null }) === null);
check("already parked, more idle arrives on a long market: the new SOL parks too",
  same(swsolAction(v(60, 1, 0.5), NOW, on), { kind: "park", lamports: SOL }));
check("parked, 3 days left: it keeps earning", swsolAction(v(3, 0, 0.5), NOW, on) === null);
check("parked, 23 hours left: it all comes home",
  same(swsolAction(v(23 / 24, 0.01, 0.5), NOW, on), { kind: "unpark", lamports: 500_000_000 }));
check("parked and past its close: home", swsolAction(v(-1, 0, 0.5), NOW, on)?.kind === "unpark");
check("parked and settled early, 70 days left: home", swsolAction(v(70, 0, 0.5, true), NOW, on)?.kind === "unpark");
check("home happens with parking OFF", swsolAction(v(0.5, 0, 0.5), NOW, { parkEnabled: false, adminLamports: null })?.kind === "unpark");
check("settled with nothing parked: nothing to do", swsolAction(v(70, 0.5, 0, true), NOW, on) === null);

console.log("\na pass over the board\n");
const row = (slug: string, pk: string | null, extra: Partial<SwsolCandidate> = {}): SwsolCandidate =>
  ({ slug, onchainPubkey: pk, resolvedOutcome: null, retiredAt: null, ...extra });
const close = (days: number) => Math.floor((NOW + days * DAY_MS) / 1000);
type Sweep = Parameters<typeof sweepSwsol>[0];
const calls: Array<[string, string, number]> = [];
const deps = (over: Partial<Sweep> = {}): Sweep => ({
  list: async () => [
    row("long-funded", "LONG"),
    row("unminted", null),
    row("settled-by-us", "OURS", { resolvedOutcome: "no" }),        // chain has not caught up
    row("retired-parked", "RETP", { retiredAt: "2026-10-12T00:00:00Z" }),
    row("retired-idle", "RETI", { retiredAt: "2026-10-12T00:00:00Z" }),
    row("market-unreadable", "MDOWN"),
    row("vault-unreadable", "VDOWN"),
    row("broken-park", "BROKEN"),
  ],
  markets: async (pks) => new Map(pks.map((pk) => [pk, pk === "MDOWN" ? null : {
    resolved: false,
    closeTime: close(pk === "RETP" ? -2 : 60),
  }])),
  holdings: async (pks) => new Map(pks.map((pk) => [pk, pk === "VDOWN" ? null : {
    solLamports: pk === "OURS" ? 0 : 2 * SOL,
    swsolLamports: pk === "OURS" ? 700_000_000 : pk === "RETP" ? 300_000_000 : 0,
  }])),
  adminLamports: async () => RICH,
  park: async (pk, l): Promise<SwsolMoveResult> => { calls.push(["park", pk, l]); return pk === "BROKEN" ? { ok: false, error: "0x1771" } : { ok: true, signature: `sig-${pk}` }; },
  unpark: async (pk, l): Promise<SwsolMoveResult> => { calls.push(["unpark", pk, l]); return { ok: true, signature: `sig-${pk}` }; },
  parkEnabled: true,
  now: () => NOW,
  ...over,
});

{
  const out = await sweepSwsol(deps());
  check("the long market parks its 2 SOL", calls.some((c) => same(c, ["park", "LONG", 2 * SOL])), calls);
  check("settled by us before the chain: its 0.7 swSOL comes home", calls.some((c) => same(c, ["unpark", "OURS", 700_000_000])), calls);
  check("a retired market brings its SOL home", calls.some((c) => same(c, ["unpark", "RETP", 300_000_000])), calls);
  check("a retired market never parks", !calls.some((c) => c[1] === "RETI"), calls);
  check("an unreadable market or vault is left alone", !calls.some((c) => c[1] === "MDOWN" || c[1] === "VDOWN"), calls);
  check("a failed park is reported, not counted as moved",
    out.failed.length === 1 && out.failed[0].slug === "broken-park" && out.failed[0].error === "0x1771", out.failed);
  check("everything else is reported with its signature",
    out.moved.length === 3 && out.moved.every((m) => m.signature === `sig-${m.market}`), out.moved);
}
{
  calls.length = 0;
  await sweepSwsol(deps({ parkEnabled: false }));
  check("parking off: no park at all", !calls.some((c) => c[0] === "park"), calls);
  check("parking off: parked SOL still comes home", calls.filter((c) => c[0] === "unpark").length === 2, calls);
}
{
  calls.length = 0;
  await sweepSwsol(deps({ adminLamports: async () => ADMIN_FLOOR_LAMPORTS + PARK_COST_LAMPORTS - 1 }));
  check("one park spends the admin's margin, and the next one waits",
    calls.filter((c) => c[0] === "park").length === 1, calls);
}
{
  calls.length = 0;
  const out = await sweepSwsol(deps({ list: async () => [row("unminted", null)] }));
  check("a board with nothing minted reads nothing and moves nothing", calls.length === 0 && out.moved.length === 0);
}

console.log("\nwhen Sanctum's program is not the one we reviewed\n");
{
  /* Audit, 22 Oct: park and unpark insist on one SOL a swSOL, and Sanctum's
     program is upgradeable. A redeploy brings every parked lamport home and
     parks nothing; a program we cannot read parks nothing. */
  const one = (over: Partial<Sweep>) => deps({
    list: async () => [row("long-parked", "LONGP")],
    holdings: async (pks) => new Map(pks.map((pk) => [pk, { solLamports: 2 * SOL, swsolLamports: 500_000_000 }])),
    ...over,
  });
  calls.length = 0;
  let out = await sweepSwsol(one({ sanctumChanged: async () => false }));
  check("the deploy we reviewed: a long market parks as before", same(calls, [["park", "LONGP", 2 * SOL]]) && out.sanctum === "same", calls);
  calls.length = 0;
  out = await sweepSwsol(one({ sanctumChanged: async () => true }));
  check("a new deploy: what is parked comes home two months early, and nothing more is parked",
    same(calls, [["unpark", "LONGP", 500_000_000]]) && out.sanctum === "changed", calls);
  calls.length = 0;
  out = await sweepSwsol(one({ sanctumChanged: async () => null }));
  check("a program we cannot read: nothing is parked, nothing forced home", calls.length === 0 && out.sanctum === "unread", calls);
  calls.length = 0;
  out = await sweepSwsol(one({ sanctumChanged: async () => { throw new Error("rpc down"); } }));
  check("...and a read that throws is the same as one we could not make", calls.length === 0 && out.sanctum === "unread", calls);
  check("a market a day from its close still comes home whatever Sanctum is doing",
    swsolAction(v(0.5, 0, 1), NOW, { ...on, parkEnabled: false })?.kind === "unpark");
}

console.log(failed === 0 ? "\nall swSOL sweep checks passed.\n" : `\n${failed} FAILED\n`);
if (failed > 0) process.exit(1);
