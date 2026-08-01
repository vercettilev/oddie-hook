// Drive the real store through a winning exit, a losing exit and a hold, then
// print exactly what /api/positions and /api/leaderboard would return. Used to
// render the screens against real server output when no venue will move its
// odds on command.
import { createSlug, getWallet, placeCall, positionsFor, sellPosition, leaderboard, slugFor } from "../src/store/markets.js";
import type { Market } from "../src/venues/types.js";

const mk = (id: string, q: string, yesPct: number): Market => ({
  venue: "polymarket", venueId: id, question: q, yesPct,
  closesAt: "2026-12-31T00:00:00Z", volumeUsd: 1000, venueUrl: "x", tags: [],
});
const move = async (m: Market, yesPct: number) => { const n = { ...m, yesPct }; await createSlug(n); return n; };

const DEV = "demo-device";
const btc = mk("BTC", "Will Bitcoin close above $70,000 in July?", 39);
const cup = mk("CUP", "Will France win the 2026 FIFA World Cup?", 39);
const fed = mk("FED", "Will the Fed increase interest rates by 25 bps in July?", 27);
for (const m of [btc, cup, fed]) await createSlug(m);

await getWallet(DEV);

// A win: YES at 39, sold at 44.
await placeCall(slugFor(btc), "yes", 50, DEV, [btc]);
const btc2 = await move(btc, 44);
let open = (await positionsFor(DEV, [btc2])).open.find((p) => p.slug === slugFor(btc))!;
await sellPosition(open.id, DEV, [btc2]);

// A loss: NO at 61, market rises, sold at 45.
await placeCall(slugFor(cup), "no", 100, DEV, [cup]);
const cup2 = await move(cup, 55);
open = (await positionsFor(DEV, [cup2])).open.find((p) => p.slug === slugFor(cup))!;
await sellPosition(open.id, DEV, [cup2]);

// Still open, and running a small profit.
await placeCall(slugFor(fed), "yes", 75, DEV, [fed]);
const fed2 = await move(fed, 33);

// A rival with a settled, better record.
const RIV = "rival-device";
for (let i = 0; i < 11; i++) {
  const m = mk(`R${i}`, `Will rival market ${i} settle in July?`, 40);
  await createSlug(m);
  await placeCall(slugFor(m), "yes", 10, RIV, [m]);
  const moved = await move(m, 48);
  const o = (await positionsFor(RIV, [moved])).open.find((p) => p.slug === slugFor(m))!;
  await sellPosition(o.id, RIV, [moved]);
}

const live = [btc2, cup2, fed2];
const pos = await positionsFor(DEV, live);
const w = await getWallet(DEV);
const board = await leaderboard(20);

console.log(JSON.stringify({
  positions: { ...pos, tokens: w.tokens },
  leaderboard: {
    rows: board.map((r, i) => ({
      rank: i + 1, handle: `#${r.deviceId.slice(0, 4)}`, you: r.deviceId === DEV,
      avgEdge: Math.round(r.avgEdge * 10) / 10, closed: r.closed, provisional: r.provisional,
    })),
  },
}, null, 1));
