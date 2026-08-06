// The creator-economy surfaces: feed discovery modes (pure), the creator
// leaderboard, and the My Markets dashboard. Against the in-memory store.
//
// Run with: npm run test-creators

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database — unset DATABASE_URL");
  process.exit(1);
}

import { sortFeedItems } from "../src/venues/feedSort.js";
import {
  createSlug, createCommunityMarket, markCommunityResolved, placeCall, settleMarket,
  slugFor, recordSurfacer, leaderboardCreators, marketsSurfacedBy, _memGrant,
} from "../src/store/markets.js";
import type { Market } from "../src/venues/types.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

console.log("\nsortFeedItems: a lens, never a filter");
{
  const items = [
    { slug: "v-big",   community: false, volumeUsd: 900, closesAt: "2026-09-01T00:00:00Z" },
    { slug: "v-small", community: false, volumeUsd: 100, closesAt: null },
    { slug: "c-hot",   community: true,  callsToday: 5, poolTokens: 9, marketId: 100, closesAt: "2026-12-01T00:00:00Z" },
    { slug: "c-warm",  community: true,  callsToday: 2, poolTokens: 20, marketId: 300, closesAt: "2026-08-10T00:00:00Z" },
    { slug: "c-quiet", community: true,  callsToday: 0, poolTokens: 0, marketId: 200, closesAt: null },
  ];
  const order = (s: Parameters<typeof sortFeedItems>[1]) => sortFeedItems(items, s).map((i) => i.slug).join(",");

  check("foryou leaves the caller's order untouched", order("foryou") === "v-big,v-small,c-hot,c-warm,c-quiet", order("foryou"));
  check("trending: active community by callsToday, then venue by volume, quiet last",
    order("trending") === "c-hot,c-warm,v-big,v-small,c-quiet", order("trending"));
  check("new: community by recency (marketId) first, venue keeps its own order",
    order("new") === "c-warm,c-quiet,c-hot,v-big,v-small", order("new"));
  check("resolving: soonest deadline first across BOTH types, no-deadline last",
    order("resolving") === "c-warm,v-big,c-hot,v-small,c-quiet" || order("resolving") === "c-warm,v-big,c-hot,c-quiet,v-small",
    order("resolving"));
  check("every mode returns the full set — a market never vanishes by switching tabs",
    (["foryou","trending","new","resolving"] as const).every((m) => sortFeedItems(items, m).length === items.length));
  check("the input array is never mutated",
    items.map((i) => i.slug).join(",") === "v-big,v-small,c-hot,c-warm,c-quiet");
}

const mk = (id: string, q: string): Market => ({
  venue: "community", venueId: id, question: q, yesPct: 50,
  closesAt: "2026-12-31T00:00:00Z", volumeUsd: 0, venueUrl: "", tags: [],
});
const call = async (slug: string, side: "yes" | "no", tokens: number, deviceId: string, live: Market[]) => {
  _memGrant(deviceId, tokens);
  return placeCall(slug, side, tokens, deviceId, live);
};

console.log("\nleaderboardCreators + marketsSurfacedBy: the creator economy, end to end");
{
  // EARNER tags a market that resolves with a real pool -> real fees. Built
  // through the REAL creation+resolution path (createCommunityMarket, then
  // markCommunityResolved + settleMarket — the same pair the resolve route
  // calls). An earlier version of this test shortcut it with createSlug +
  // settleMarket alone and then asserted on resolvedOutcome, which only
  // community-market metadata carries — the check failed against the test's
  // own setup, not against the product.
  const { slug: earnSlug, market: m1 } = await createCommunityMarket({
    question: "Will the earner's market pay?", closeTime: 2_000_000_000,
  });
  await recordSurfacer(earnSlug, { deviceId: "creator-earner-01" });
  await call(earnSlug, "yes", 120, "cr-caller-a", [m1]);
  await call(earnSlug, "no", 80, "cr-caller-b", [m1]);
  await markCommunityResolved(earnSlug, "yes");
  await settleMarket(earnSlug, "yes");   // 200 pool -> +6 fee

  // BUILDER tags two markets nobody trades: zero fees, real markets.
  for (const id of ["CR2", "CR3"]) {
    const m = mk(id, `Builder market ${id}?`);
    await createSlug(m);
    await recordSurfacer(slugFor(m), { deviceId: "creator-builder-01" });
  }

  const board = await leaderboardCreators(10);
  const earner = board.find((r) => r.deviceId === "creator-earner-01");
  const builder = board.find((r) => r.deviceId === "creator-builder-01");
  check("the earner charts with real fees", earner?.earnings === 6 && earner?.marketsCreated === 1, JSON.stringify(earner));
  check("a zero-fee builder still charts — an empty early board teaches nothing",
    builder?.earnings === 0 && builder?.marketsCreated === 2, JSON.stringify(builder));
  check("earnings outrank market count", board.indexOf(earner!) < board.indexOf(builder!));
  check("every row has a public handle, never a bare device id",
    board.every((r) => r.handle.length > 0 && !r.handle.includes("creator-earner")), JSON.stringify(board.map((r) => r.handle)));

  const mine = await marketsSurfacedBy("creator-earner-01");
  check("My Markets lists exactly this device's markets", mine.length === 1 && mine[0].slug === earnSlug, JSON.stringify(mine));
  check("...with the resolved outcome and the fee actually earned",
    mine[0].resolvedOutcome === "yes" && mine[0].feesEarned === 6, JSON.stringify(mine[0]));
  check("...and the callers who traded it", mine[0].callers === 2);

  const theirs = await marketsSurfacedBy("creator-builder-01");
  check("a builder sees their untraded markets at zero, not hidden",
    theirs.length === 2 && theirs.every((r) => r.poolTokens === 0 && r.feesEarned === 0), JSON.stringify(theirs));

  check("an unknown device gets an empty list, not an error",
    (await marketsSurfacedBy("nobody-here-0001")).length === 0);
}

console.log(failures === 0 ? "\nall creator checks passed.\n" : `\n${failures} creator check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
