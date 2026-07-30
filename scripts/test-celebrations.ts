// The resolution celebration's store layer, against the real store on the
// in-memory backend. The contract under test: celebrationsFor() returns
// exactly the newly-resolved, not-yet-shown positions with a correct
// before/after Oddie Score and streak, and markCelebrationsSeen() makes each
// one disappear from that list permanently — "fires exactly once" is the
// whole point of this feature, so it's the thing most worth proving here.
//
// Run with: npm run test-celebrations

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database — unset DATABASE_URL");
  process.exit(1);
}

import {
  createCommunityMarket, openCommunityMarkets, placeCall, markCommunityResolved,
  settleMarket, recordSurfacer, celebrationsFor, markCelebrationsSeen,
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
async function call(slug: string, deviceId: string, side: "yes" | "no", tokens = 10): Promise<void> {
  const live = (await openCommunityMarkets()) as unknown as Market[];
  const r = await placeCall(slug, side, tokens, deviceId, live);
  if (!r.ok) throw new Error(`placeCall ${slug} ${deviceId}: ${JSON.stringify(r)}`);
}
async function resolve(slug: string, outcome: "yes" | "no"): Promise<void> {
  await markCommunityResolved(slug, outcome);
  await settleMarket(slug, outcome);
}

// NOT String(n).repeat(32).slice(0,32) — for single-repeated-digit n (1, 11,
// 111...) that collapses to the same 32-char string for every n sharing a
// digit, so DEV(1) and DEV(11) silently collided (both "1111...1", 32 chars).
// Padding n into a fixed-width prefix BEFORE any repetition makes collision
// impossible for n up to 8 digits.
const DEV = (n: number) => `dev-${String(n).padStart(8, "0")}${"a".repeat(24)}`;

console.log("\nno resolved positions at all");
{
  check("nothing to celebrate", (await celebrationsFor(DEV(1))).length === 0);
}

console.log("\none fresh win, before the accuracy floor (fewer than 5 resolved)");
{
  const slug = await mk("Will this resolve YES?", 50);
  await call(slug, DEV(2), "yes", 10);
  await resolve(slug, "yes");
  const rows = await celebrationsFor(DEV(2));
  check("exactly one celebration", rows.length === 1, String(rows.length));
  const c = rows[0];
  check("it's a win", c?.won === true);
  check("outcome matches", c?.outcome === "yes");
  check("payout is the real proceeds, not null", typeof c?.proceeds === "number" && c.proceeds > 0, String(c?.proceeds));
  check("score baseline is the neutral 500 (not enough resolved yet)", c?.scoreBefore === 500, String(c?.scoreBefore));
  check("scoreAfter is still null below the accuracy floor", c?.scoreAfter === null, String(c?.scoreAfter));
  check("streak starts at 1, not flagged as 'extended' (threshold is >= 2)", c?.streakAfter === 1 && c?.streakExtended === false);
}

console.log("\nfiring exactly once: re-fetching after no seen-mark still returns it");
{
  const rows = await celebrationsFor(DEV(2));
  check("still there — nothing has marked it seen yet", rows.length === 1);
}

console.log("\nmarking seen makes it disappear for good");
{
  const before = await celebrationsFor(DEV(2));
  await markCelebrationsSeen(DEV(2), before.map((c) => c.noticeId));
  const after = await celebrationsFor(DEV(2));
  check("gone after marking seen", after.length === 0, JSON.stringify(after));
}

console.log("\na loss: honest, no payout, score can still move");
{
  const slug = await mk("Will this resolve NO for the caller?", 60);
  await call(slug, DEV(3), "yes", 10);
  await resolve(slug, "no");
  const rows = await celebrationsFor(DEV(3));
  check("one celebration", rows.length === 1);
  const c = rows[0];
  check("it's a loss", c?.won === false);
  check("outcome is the real resolution, not their side", c?.outcome === "no" && c?.side === "yes");
  check("no payout on a loss", c?.proceeds === null, String(c?.proceeds));
  check("streak resets to 0 on a loss", c?.streakAfter === 0);
}

console.log("\ncrossing the accuracy floor mid-batch: scoreAfter appears exactly once enough exist");
{
  const dev = DEV(4);
  // 4 more resolved wins (5 total including this batch's 5th) to cross MIN_RESOLVED_FOR_ACCURACY.
  for (let i = 0; i < 4; i++) {
    const slug = await mk(`Warm-up win ${i}?`, 50);
    await call(slug, dev, "yes", 10);
    await resolve(slug, "yes");
  }
  await markCelebrationsSeen(dev, (await celebrationsFor(dev)).map((c) => c.noticeId)); // clear the warm-up batch
  const slug = await mk("The fifth resolved call — crosses the floor", 40);
  await call(slug, dev, "yes", 10);
  await resolve(slug, "yes");
  const rows = await celebrationsFor(dev);
  check("one celebration for the 5th call", rows.length === 1, String(rows.length));
  const c = rows[0];
  check("scoreBefore is still the neutral baseline (4 resolved, not enough yet)", c?.scoreBefore === 500);
  check("scoreAfter is now a real number (5 resolved crosses the floor)", typeof c?.scoreAfter === "number", String(c?.scoreAfter));
  check("a 5-call win streak is real and flagged extended", c?.streakAfter === 5 && c?.streakExtended === true);
}

console.log("\nmultiple resolutions land in one batch (the swipe-through sequence)");
{
  const dev = DEV(5);
  const slugs: string[] = [];
  for (let i = 0; i < 3; i++) {
    const slug = await mk(`Batch market ${i}?`, 50);
    await call(slug, dev, i === 1 ? "no" : "yes", 10); // middle one is a deliberate loss
    slugs.push(slug);
  }
  // Resolve all three before the device ever checks in — this is the
  // cold-open case: tap a notification link, land in the app, everything
  // that happened while away shows up as one batch.
  await resolve(slugs[0], "yes");
  await resolve(slugs[1], "yes"); // that device took "no" -> a loss
  await resolve(slugs[2], "yes");
  const rows = await celebrationsFor(dev);
  check("all three resolutions arrive together", rows.length === 3, String(rows.length));
  check("exactly one of the three is a loss", rows.filter((c) => !c.won).length === 1);
  check("each has a distinct noticeId (nothing collapsed/deduped incorrectly)",
    new Set(rows.map((c) => c.noticeId)).size === 3);
}

console.log("\nchallengeHandle carries through from the market's surfacer");
{
  const dev = DEV(6);
  const slug = await mk("Will the tagged claim resolve YES?", 50);
  await recordSurfacer(slug, { sourceUrl: "https://twitter.com/originalclaimer/status/1234567890" });
  await call(slug, dev, "yes", 10);
  await resolve(slug, "yes");
  const rows = await celebrationsFor(dev);
  check("challengeHandle resolved from the source tweet", rows[0]?.challengeHandle === "originalclaimer",
    String(rows[0]?.challengeHandle));
}

console.log("\nno surfacer at all -> challengeHandle is null, not a placeholder");
{
  const dev = DEV(7);
  const slug = await mk("An organic market with no tagged source?", 50);
  await call(slug, dev, "yes", 10);
  await resolve(slug, "yes");
  const rows = await celebrationsFor(dev);
  check("challengeHandle is null", rows[0]?.challengeHandle === null, String(rows[0]?.challengeHandle));
}

console.log("\nmarking seen is scoped to the device — cannot clear someone else's celebration");
{
  const mine = DEV(8), theirs = DEV(9);
  const slug = await mk("Whose celebration is this?", 50);
  await call(slug, theirs, "yes", 10);
  await resolve(slug, "yes");
  const theirRows = await celebrationsFor(theirs);
  await markCelebrationsSeen(mine, theirRows.map((c) => c.noticeId)); // wrong device — must no-op
  check("the real owner's celebration survives an unrelated device's seen-call",
    (await celebrationsFor(theirs)).length === 1);
}

console.log(failures === 0 ? "\nall celebration checks passed.\n" : `\n${failures} celebration check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
