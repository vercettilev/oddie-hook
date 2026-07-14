// The full cycle through the real store, on the in-memory backend: call at a
// price, move the price, sell, watch the balance and the reputation move with
// it. No database, no venue — the odds are injected, so a losing exit is a
// thing this file can *cause* rather than a thing we wait for.
//
// Run with: npm run test-positions

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database — unset DATABASE_URL");
  process.exit(1);
}

import { createSlug, getWallet, placeCall, positionsFor, sellPosition, leaderboard, slugFor, STARTING_TOKENS } from "../src/store/markets.js";
import type { Market } from "../src/venues/types.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
}

const mk = (venueId: string, question: string, yesPct: number): Market => ({
  venue: "polymarket", venueId, question, yesPct,
  closesAt: "2026-12-31T00:00:00Z", volumeUsd: 1_000, venueUrl: "x", tags: [],
});

/** Move the market. createSlug refreshes the snapshot for an existing (venue, venueId). */
const priceAt = async (m: Market, yesPct: number) => { const moved = { ...m, yesPct }; await createSlug(moved); return moved; };

const DEV = "test-device-0001";
const OTHER = "test-device-0002";

const btc = mk("BTC", "Will Bitcoin close above $70,000 in July?", 39);
const cup = mk("CUP", "Will France win the 2026 FIFA World Cup?", 39);
const fed = mk("FED", "Will the Fed increase interest rates in July?", 20);
for (const m of [btc, cup, fed]) await createSlug(m);

console.log("\na fresh device");
{
  const w = await getWallet(DEV);
  check("starts at 1000 tokens", w.tokens === STARTING_TOKENS && w.tokens === 1000, `${w.tokens}`);
  check("is at the floor, so no top-up is pending", w.nextTopUpMs === null);
}

console.log("\ncall YES at 39, market rises to 44, sell");
{
  const r = await placeCall(slugFor(btc), "yes", 50, DEV, [btc]);
  check("the call locks at the live price", r.ok && r.pctAt === 39, JSON.stringify(r));
  check("the stake leaves the balance", (await getWallet(DEV)).tokens === 950);

  const moved = await priceAt(btc, 44);
  const pos = await positionsFor(DEV, [moved]);
  const p = pos.open[0];
  check("the open position shows entry and today's price", p.entryPct === 39 && p.nowPct === 44, JSON.stringify(p));
  check("...and the edge it is currently running", p.edgeNow === 5);
  check("...and what selling would return", p.valueNow === 56, `${p.valueNow}`);
  check("...and what holding to a win would return", p.toWin === 128, `${p.toWin}`);
  check("no reputation yet: nothing is closed", pos.overall.avgEdge === null);

  const sold = await sellPosition(p.id, DEV, [moved]);
  check("selling pays 56 tokens", sold.ok && sold.proceeds === 56, JSON.stringify(sold));
  check("...records a +5 edge", sold.ok && sold.edge === 5);
  check("the tokens come back", (await getWallet(DEV)).tokens === 950 + 56);

  const again = await sellPosition(p.id, DEV, [moved]);
  check("selling twice pays once", !again.ok && again.reason === "already-closed", JSON.stringify(again));
}

console.log("\ncall NO at 61, market rises to 55% yes, sell at a loss");
{
  // A NO call on a 39%-yes market enters at 61. The market moving UP is the
  // thing that hurts a NO holder — this is the deliberate loss.
  const r = await placeCall(slugFor(cup), "no", 100, DEV, [cup]);
  check("the NO call locks at 61, not 39", r.ok && r.pctAt === 61, JSON.stringify(r));

  const moved = await priceAt(cup, 55); // NO is now 45
  const pos = await positionsFor(DEV, [moved]);
  const p = pos.open[0];
  check("the NO position is underwater", p.edgeNow === -16, `${p.edgeNow}`);

  const before = (await getWallet(DEV)).tokens;
  const sold = await sellPosition(p.id, DEV, [moved]);
  check("selling returns 74 of the 100 staked", sold.ok && sold.proceeds === 74, JSON.stringify(sold));
  check("...and records a NEGATIVE edge of -16", sold.ok && sold.edge === -16);
  check("the balance rises by the proceeds, not the stake", (await getWallet(DEV)).tokens === before + 74);
}

console.log("\nreputation counts the loss");
{
  const pos = await positionsFor(DEV, []);
  check("two closed positions", pos.closed.length === 2, `${pos.closed.length}`);
  check("reputation is the mean of +5 and -16", pos.overall.avgEdge === -5.5, `${pos.overall.avgEdge}`);
  check("...which is worse than the winning one alone", pos.overall.avgEdge! < 5);
  check("...and it is provisional under 10", pos.overall.provisional);

  const cats = Object.fromEntries(pos.byCategory.map((c) => [c.category, c.avgEdge]));
  check("crypto scored +5 on its own", cats.Crypto === 5, JSON.stringify(cats));
  check("sports scored -16 on its own", cats.Sports === -16, JSON.stringify(cats));
}

console.log("\nprovisional clears at ten");
{
  // Eight more closed positions, each a small win, to cross the threshold.
  for (let i = 0; i < 8; i++) {
    const m = mk(`X${i}`, `Will thing ${i} happen by July?`, 50);
    await createSlug(m);
    await placeCall(slugFor(m), "yes", 10, DEV, [m]);
    const moved = await priceAt(m, 60);
    const open = (await positionsFor(DEV, [moved])).open.find((p) => p.slug === slugFor(m))!;
    await sellPosition(open.id, DEV, [moved]);
  }
  const pos = await positionsFor(DEV, []);
  check("ten closed positions", pos.closed.length === 10, `${pos.closed.length}`);
  check("...clears provisional", pos.overall.provisional === false);
  check("...and the average is (5 - 16 + 8×10) / 10", pos.overall.avgEdge === 6.9, `${pos.overall.avgEdge}`);
}

console.log("\nthe leaderboard ranks edge, not tokens");
{
  // A whale: one huge stake, a tiny edge. It must lose to the device above.
  const m = mk("WHALE", "Will the whale learn by July?", 40);
  await createSlug(m);
  await placeCall(slugFor(m), "yes", 900, OTHER, [m]);
  const moved = await priceAt(m, 42);
  const open = (await positionsFor(OTHER, [moved])).open[0];
  const sold = await sellPosition(open.id, OTHER, [moved]);
  check("the whale wins far more tokens", sold.ok && sold.proceeds - 900 > 40, JSON.stringify(sold));

  const board = await leaderboard();
  const me = board.find((r) => r.deviceId === DEV)!;
  const whale = board.find((r) => r.deviceId === OTHER)!;
  check("the whale's edge is only +2", whale.avgEdge === 2, `${whale.avgEdge}`);
  check("the established player outranks the whale", board.indexOf(me) < board.indexOf(whale));
  check("...because the whale is still provisional", whale.provisional && !me.provisional);
}

console.log("\na sale needs a price");
{
  const m = mk("GONE", "Will the venue stop quoting this by July?", 30);
  await createSlug(m);
  await placeCall(slugFor(m), "yes", 10, DEV, [m]);
  const open = (await positionsFor(DEV, [m])).open.find((p) => p.slug === slugFor(m))!;
  // The venue no longer lists it: nothing to sell into.
  const sold = await sellPosition(open.id, DEV, []);
  check("an unpriced market cannot be sold", !sold.ok && sold.reason === "unpriced", JSON.stringify(sold));
  const pos = await positionsFor(DEV, []);
  check("...and the position stays open", pos.open.some((p) => p.slug === slugFor(m)));
  check("...and its odds read as unknown, not as zero", pos.open.find((p) => p.slug === slugFor(m))!.nowPct === null);
}

console.log("\nyou cannot sell what is not yours");
{
  const pos = await positionsFor(DEV, []);
  const mine = pos.open[0];
  const theft = await sellPosition(mine.id, OTHER, []);
  check("another device's position is not found", !theft.ok && theft.reason === "not-found");
}

console.log(failures === 0 ? "\nall position checks passed.\n" : `\n${failures} position check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
