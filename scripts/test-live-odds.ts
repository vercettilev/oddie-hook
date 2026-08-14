// The live tote-board: community-market odds move with the crowd, not with
// the admin's opening line frozen forever — against the real store on the
// in-memory backend.
//
// The price is made of PEOPLE now (crowdPct), not staked tokens. Calling is
// free, so a stake-weighted pool would be permanently empty and every
// community market would sit at whatever it opened on. The opening line is
// carried as a prior worth PRICE_ANCHOR_WEIGHT callers so a single tap cannot
// print a price, and it fades as real people arrive. poolPct survives below
// because the on-chain real-money layer still weighs actual value.
//
// Run with: npm run test-live-odds

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database — unset DATABASE_URL");
  process.exit(1);
}

import {
  createCommunityMarket, openCommunityMarkets, placeCall, sellPosition, positionsFor, poolPct, crowdPct, slugFor,
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

console.log("\ncrowdPct: the anchor holds the early price, the crowd takes it over");
{
  // The property the whole formula exists for: one caller must not be able to
  // print a price. A raw ratio would say 100 here.
  check("nobody has called yet, so the opening line stands", crowdPct(50, 0, 0) === 50);
  check("one caller nudges rather than seizes", crowdPct(50, 1, 0) === 58, String(crowdPct(50, 1, 0)));
  check("...and cannot reach the edge alone", crowdPct(50, 1, 0) < 99);

  // Convergence: the operator's guess fades as real people arrive.
  check("7-3 reads 63 with the anchor still counting", crowdPct(50, 7, 3) === 63, String(crowdPct(50, 7, 3)));
  check("70-30 has all but shed the anchor (69 vs a true 70)", crowdPct(50, 70, 30) === 69, String(crowdPct(50, 70, 30)));
  check("700-300 is the crowd's own number", crowdPct(50, 700, 300) === 70, String(crowdPct(50, 700, 300)));

  // A lopsided opening line is still a starting point, not a verdict.
  check("a 20% open with no callers stays 20", crowdPct(20, 0, 0) === 20);
  check("...and the crowd can drag it up", crowdPct(20, 20, 0) === 84, String(crowdPct(20, 20, 0)));

  // Never a literal 0 or 100: those are settled markets, not quotes.
  check("a huge one-sided crowd clamps to 99", crowdPct(50, 10_000, 0) === 99);
  check("...and the other way to 1", crowdPct(50, 0, 10_000) === 1);
  check("negative counts cannot corrupt it", crowdPct(50, -5, -5) === 50);
}

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

console.log("\nopenCommunityMarkets(): yesPct is the live crowd, not the stored opening line");
{
  const slug = await mk("Will the live-odds test market resolve YES?", 50);
  const before = (await openCommunityMarkets()).find((m) => slugFor(m) === slug)!;
  check("an untouched market shows its stored opening line", before.yesPct === 50, String(before.yesPct));

  // The anchor is worth PRICE_ANCHOR_WEIGHT people, so four callers move the
  // price a long way without seizing it: (0.5*5 + 4) / (5 + 4) = 72%.
  for (let i = 0; i < 4; i++) await call(slug, "yes", DEV(i));
  const afterYes = (await openCommunityMarkets()).find((m) => slugFor(m) === slug)!;
  check("four one-sided YES callers move the price a long way, short of seizing it",
    afterYes.yesPct === 72, String(afterYes.yesPct));

  // (0.5*5 + 4) / (5 + 5) = 65%.
  await call(slug, "no", DEV(4));
  const balanced = (await openCommunityMarkets()).find((m) => slugFor(m) === slug)!;
  check("a NO caller pulls it back down", balanced.yesPct === 65, String(balanced.yesPct));
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
  // And the point of the anchor: ONE caller nudges the price, it does not
  // print 99% and quote the second arrival a number invented by a single tap.
  const after = (await openCommunityMarkets()).find((m) => slugFor(m) === slug)!;
  check("...the price moves for that one caller without being seized by them",
    after.yesPct === 58, String(after.yesPct));
}

console.log("\na sold (early-exit) position leaves the live pool");
{
  const slug = await mk("Will the sold-position test market resolve YES?", 50);
  await call(slug, "yes", DEV(20));
  const held = (await openCommunityMarkets()).find((m) => slugFor(m) === slug)!;
  check("one open YES call moves the price", held.yesPct === 58, String(held.yesPct));

  const live = (await openCommunityMarkets()) as unknown as Market[];
  const open = (await positionsFor(DEV(20), live)).open.find((p) => p.slug === slug)!;
  const sold = await sellPosition(open.id, DEV(20), live);
  check("the sell succeeds", sold.ok, JSON.stringify(sold));

  const afterSell = (await openCommunityMarkets()).find((m) => slugFor(m) === slug)!;
  check("with the only caller gone, the price falls back to the opening line (50)",
    afterSell.yesPct === 50, String(afterSell.yesPct));
}

console.log(failures === 0 ? "\nall live-odds checks passed.\n" : `\n${failures} live-odds check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
