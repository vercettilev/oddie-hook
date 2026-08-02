// The live tote-board: community-market odds are now a parimutuel pool share
// (poolPct), not the admin's opening line frozen forever — against the real
// store on the in-memory backend.
//
// Run with: npm run test-live-odds

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database — unset DATABASE_URL");
  process.exit(1);
}

import {
  createCommunityMarket, openCommunityMarkets, placeCall, sellPosition, positionsFor, poolPct, slugFor,
} from "../src/store/markets.js";
import type { Market } from "../src/venues/types.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
}

const soon = () => Math.floor(Date.now() / 1000) + 86_400;
const mk = async (question: string, yesPct = 50): Promise<string> =>
  (await createCommunityMarket({ question, category: "Sports", yesPct, closeTime: soon() })).slug;
const call = async (slug: string, side: "yes" | "no", deviceId: string): Promise<number> => {
  const live = (await openCommunityMarkets()) as unknown as Market[];
  const r = await placeCall(slug, side, 1, deviceId, live);
  if (!r.ok) throw new Error(`placeCall ${slug} ${deviceId}: ${JSON.stringify(r)}`);
  return r.pctAt;
};

// NOT String(n).repeat(...) — see test-return-triggers.ts for why that collides.
const DEV = (n: number) => `dev-${String(n).padStart(8, "0")}${"a".repeat(24)}`;

console.log("\npoolPct: pure arithmetic, no currency baked in");
{
  check("an empty pool has no opinion — null, not a guess", poolPct(0, 0) === null);
  check("a balanced pool reads 50", poolPct(5, 5) === 50);
  check("all-one-side is clamped to 99, never a literal 100", poolPct(10, 0) === 99);
  check("all-other-side is clamped to 1, never a literal 0", poolPct(0, 10) === 1);
  check("share is exact away from the edges", poolPct(25, 75) === 25);
  // Currency-agnostic: the same call with lamports-sized numbers must behave
  // identically — nothing here should special-case "small integer = predictions".
  check("the same ratio holds at real-money (lamport) scale", poolPct(250_000_000, 750_000_000) === 25);
}

console.log("\nopenCommunityMarkets(): yesPct is live pool share, not the stored opening line");
{
  const slug = await mk("Will the live-odds test market resolve YES?", 50);
  const before = (await openCommunityMarkets()).find((m) => slugFor(m) === slug)!;
  check("an untouched market shows its stored opening line", before.yesPct === 50, String(before.yesPct));

  for (let i = 0; i < 4; i++) await call(slug, "yes", DEV(i));
  const afterYes = (await openCommunityMarkets()).find((m) => slugFor(m) === slug)!;
  check("four one-sided YES calls compress the price toward 99, not just nudge it",
    afterYes.yesPct === 99, String(afterYes.yesPct));

  await call(slug, "no", DEV(4));
  const balanced = (await openCommunityMarkets()).find((m) => slugFor(m) === slug)!;
  check("a NO call pulls it back down (5 4 vs 1 4 -> 80)", balanced.yesPct === 80, String(balanced.yesPct));
}

console.log("\nentry price is the PRE-call pool, never the caller's own contribution");
{
  // The exact bug this feature shipped with once already: painting a live
  // update from a call's OWN entry price instead of the pool state after it
  // landed. Locking the store-level invariant down directly: on an empty
  // pool, the very first caller must be priced from the market's opening
  // line, not from a pool that already (impossibly) includes their own call.
  const slug = await mk("Will the entry-price test market resolve YES?", 50);
  const pctAt = await call(slug, "yes", DEV(10));
  check("the first-ever call prices at the opening line (50), not 99",
    pctAt === 50, String(pctAt));
  const after = (await openCommunityMarkets()).find((m) => slugFor(m) === slug)!;
  check("...but the market's live price NOW reflects that call (99)",
    after.yesPct === 99, String(after.yesPct));
}

console.log("\na sold (early-exit) position leaves the live pool");
{
  const slug = await mk("Will the sold-position test market resolve YES?", 50);
  await call(slug, "yes", DEV(20));
  const held = (await openCommunityMarkets()).find((m) => slugFor(m) === slug)!;
  check("one open YES call moves the price", held.yesPct === 99, String(held.yesPct));

  const live = (await openCommunityMarkets()) as unknown as Market[];
  const open = (await positionsFor(DEV(20), live)).open.find((p) => p.slug === slug)!;
  const sold = await sellPosition(open.id, DEV(20), live);
  check("the sell succeeds", sold.ok, JSON.stringify(sold));

  const afterSell = (await openCommunityMarkets()).find((m) => slugFor(m) === slug)!;
  check("with the only stake now sold, the price falls back to the opening line (50)",
    afterSell.yesPct === 50, String(afterSell.yesPct));
}

console.log(failures === 0 ? "\nall live-odds checks passed.\n" : `\n${failures} live-odds check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
