// THE GROWTH LADDER, AND THE CAP THAT BOUNDS IT.
//
// These three sections used to live in test-loud.ts, which was deleted with the
// share-to-earn mechanic it covered. They have nothing to do with posting, and
// each one is the ONLY coverage in the repo of what it tests: the geometric
// crowd rungs that pay a market's opener as strangers arrive, the membership
// the tagged feed partitions on, and the daily cap that bounds earning without
// bounding playing. Deleting the file without moving them would have taken all
// three out while the suite stayed green.
//
// Run with: npm run test-ladder

import {
  seasonPointsFor,
  surfacedSlugs,
  createCommunityMarket,
  openCommunityMarkets,
  placeCall,
  recordSurfacer,
  _memGrant,
  callsMadeFor,
  DAILY_EARNING_MARKETS,
  positionsFor,
} from "../src/store/markets.js";
import { CALL_COST } from "../src/store/economy.js";
import type { Market } from "../src/venues/types.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "\u2713" : "\u2717"} ${name}${detail ? " \u2014 " + detail : ""}`);
}

async function main(): Promise<void> {
console.log("\nthe crowd ladder: geometric rungs, once per market, to the surfacer");
{
  const SURFACER = "device-laddersurface1";
  const { slug } = await createCommunityMarket({
    question: "Will the ladder market fill up?",
    closeTime: Math.floor(Date.now() / 1000) + 86_400,
  });
  await recordSurfacer(slug, { deviceId: SURFACER });
  const live = (await openCommunityMarkets()) as unknown as Market[];
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const caller = (n: number) => `device-laddercall-${String(n).padStart(3, "0")}`;
  const call = async (n: number) => {
    _memGrant(caller(n), 10);
    const r = await placeCall(slug, n % 2 ? "yes" : "no", 5, caller(n), live);
    if (!r.ok) throw new Error(JSON.stringify(r));
    await flush();
  };

  const before = await seasonPointsFor(SURFACER);
  for (let n = 1; n <= 10; n++) await call(n);
  // 10 fresh players: the 3-player rung (100) + the 10-player rung (250) +
  // ten first-timer awards (10 × 100), all credited to the surfacer.
  const atTen = await seasonPointsFor(SURFACER);
  check("10 players pays three_players + ten_players + the first-timers",
    atTen - before === 100 + 250 + 10 * 100, `delta ${atTen - before}`);

  _memGrant(caller(1), 10);
  await placeCall(slug, "yes", 5, caller(1), live); await flush();
  check("a repeat caller moves nothing — rungs are distinct-player rungs",
    (await seasonPointsFor(SURFACER)) === atTen);

  for (let n = 11; n <= 25; n++) await call(n);
  const atTwentyFive = await seasonPointsFor(SURFACER);
  check("25 players adds the 750 rung (+ the new first-timers)",
    atTwentyFive - atTen === 750 + 15 * 100, `delta ${atTwentyFive - atTen}`);
}

console.log("\nsurfacedSlugs: the membership the tagged feed partitions on");
{
  // The distinction this exists for: an ANONYMOUS tag (a real surfacer row with
  // no handle and no source URL) is still tagged. surfacersFor cannot say so —
  // it returns the same all-null shape for "no row" — which is why the feed
  // asks this instead.
  await recordSurfacer("venue-tagged-anon", { deviceId: "device-anontagger01" });
  await recordSurfacer("venue-tagged-named", { handle: "@someone" });

  const hit = await surfacedSlugs(["venue-tagged-anon", "venue-tagged-named", "venue-untouched"]);
  check("a named tag is a member", hit.has("venue-tagged-named"));
  check("an ANONYMOUS tag is a member too — the whole point of this function",
    hit.has("venue-tagged-anon"));
  check("an untagged slug is not", !hit.has("venue-untouched"));
  check("...and nothing else sneaks in", hit.size === 2, [...hit].join(", "));
  check("an empty ask is an empty answer, with no query",
    (await surfacedSlugs([])).size === 0);
}

console.log("\nthe daily earning cap: bounds the reward, never the playing");
{
  const DEV = "device-dailycap000001";
  const live = (await openCommunityMarkets()) as unknown as Market[];
  const flush = () => new Promise((r) => setTimeout(r, 0));
  // More distinct markets in one day than the cap allows.
  const slugs: string[] = [];
  for (let i = 0; i < DAILY_EARNING_MARKETS + 6; i++) {
    const { slug } = await createCommunityMarket({
      question: `Cap market ${i}?`, closeTime: Math.floor(Date.now() / 1000) + 86_400,
    });
    slugs.push(slug);
  }
  const fresh = (await openCommunityMarkets()) as unknown as Market[];
  for (const slug of slugs) {
    _memGrant(DEV, 10);
    const r = await placeCall(slug, "yes", 0, DEV, fresh);
    check(`call on ${slug.slice(0, 12)} is accepted`, r.ok === true, JSON.stringify(r));
    if (!r.ok) break;
    await flush();
  }
  check("every call was accepted — the cap never blocks playing",
    (await positionsFor(DEV, fresh)).open.length === slugs.length,
    String((await positionsFor(DEV, fresh)).open.length));
  check(`...but only ${DAILY_EARNING_MARKETS} of them earn`,
    (await callsMadeFor(DEV)) === DAILY_EARNING_MARKETS, String(await callsMadeFor(DEV)));

  // The same market twice is not twice the volume.
  const before = await callsMadeFor(DEV);
  _memGrant(DEV, 10);
  await placeCall(slugs[0], "no", 0, DEV, fresh); await flush();
  check("a repeat call on a market already counted adds nothing",
    (await callsMadeFor(DEV)) === before, String(await callsMadeFor(DEV)));

  check("a device that never called earns nothing", (await callsMadeFor("device-nevercalled01")) === 0);
  check("...and calling is free, so an empty balance is not a wall", CALL_COST === 0);
}

  console.log(failures === 0 ? "\nall ladder checks passed.\n" : `\n${failures} ladder check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
