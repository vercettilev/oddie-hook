// Oddie Score motion — weeklyScoreDeltaFor and rankMovementFor — against the
// real store on the in-memory backend.
//
// Run with: npm run test-score-motion

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database — unset DATABASE_URL");
  process.exit(1);
}

import {
  createCommunityMarket, openCommunityMarkets, placeCall, markCommunityResolved, settleMarket,
  weeklyScoreDeltaFor, rankMovementFor, seasonRankFor, _memCalls, _resetStandingsCache,
  _memGrant,
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
  _memGrant(deviceId, tokens); // see test-settlement.ts's note: production only ever stakes CALL_COST now
  const r = await placeCall(slug, side, tokens, deviceId, live);
  if (!r.ok) throw new Error(`placeCall ${slug} ${deviceId}: ${JSON.stringify(r)}`);
}
async function resolve(slug: string, outcome: "yes" | "no"): Promise<void> {
  await markCommunityResolved(slug, outcome);
  await settleMarket(slug, outcome);
}
// A "correct" or "wrong" pick at a chosen entry price, resolved immediately —
// the building block every scenario below composes from.
async function pick(deviceId: string, entryPct: number, correct: boolean): Promise<void> {
  const slug = await mk(`pick for ${deviceId} @ ${entryPct}?`, entryPct);
  const side: "yes" | "no" = "yes";
  await call(slug, deviceId, side, 5);
  await resolve(slug, correct ? side : "no");
}
// Backdates the MOST RECENT settled call for (deviceId) so weeklyScoreDeltaFor
// sees it as outside the 7-day window — the only way to test "before the
// window" without a test that actually waits a week. placeCall unshifts (not
// pushes) new rows onto memCalls, so it's already newest-first — NOT reversed.
function backdateLastCallFor(deviceId: string, daysAgo: number): void {
  const c = _memCalls.find((c) => c.deviceId === deviceId && c.closedAt);
  if (!c) throw new Error(`no settled call found for ${deviceId} to backdate`);
  c.closedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

const DEV = (n: number) => `dev-${String(n).padStart(8, "0")}${"a".repeat(24)}`;

console.log("\nweeklyScoreDeltaFor: hidden with nothing to show");
{
  const nobody = DEV(1);
  check("no resolutions at all -> null", (await weeklyScoreDeltaFor(nobody)) === null);

  const stale = DEV(2);
  for (let i = 0; i < 5; i++) { await pick(stale, 50, true); backdateLastCallFor(stale, 10); }
  check("hasEnough with a real score, but every resolution predates the window -> null (hidden, not stale)",
    (await weeklyScoreDeltaFor(stale)) === null);

  const notEnoughYet = DEV(3);
  await pick(notEnoughYet, 50, true);
  await pick(notEnoughYet, 50, true);
  // Two resolutions this week, still short of the ACCURACY floor of 5 — but the
  // score is activity-led and no longer waits on that floor, so there IS motion
  // to report. The old expectation (null) belonged to a score that was pure
  // accuracy; keeping it would have meant hiding real activity from the one
  // person it happened to.
  check("resolutions this week report motion even below the accuracy floor",
    ((await weeklyScoreDeltaFor(notEnoughYet))?.delta ?? 0) > 0);
}

console.log("\nweeklyScoreDeltaFor: a real delta from resolved history vs. this week");
{
  const dev = DEV(4);
  // THE TRADE-OFF, PINNED SO IT CANNOT DRIFT SILENTLY.
  //
  // Under the activity-led score a single loss on top of a strong record can
  // still move the week UP, because playing once more adds base while the
  // quality multiplier barely moves (and here does not move at all — an edge of
  // +0.5 pins it at the 1.5x ceiling, so the loss costs nothing on that axis).
  //
  // That is not a bug, it is the weighting Lev asked for stated in numbers:
  // showing up counts for more than being right. It is asserted rather than
  // merely tolerated so that nobody later "fixes" it without deciding to.
  for (let i = 0; i < 5; i++) { await pick(dev, 50, true); backdateLastCallFor(dev, 10); }
  await pick(dev, 50, false);
  const wd = await weeklyScoreDeltaFor(dev);
  check("one loss on a saturated record still nets UP — activity outweighs accuracy, by design",
    (wd?.delta ?? 0) > 0, JSON.stringify(wd));
}
{
  const dev = DEV(5);
  for (let i = 0; i < 5; i++) { await pick(dev, 50, false); backdateLastCallFor(dev, 10); }
  await pick(dev, 50, true);
  const wd = await weeklyScoreDeltaFor(dev);
  check("direction is up", wd?.direction === "up", JSON.stringify(wd));
  check("a winning week moves the score up by a real amount", (wd?.delta ?? 0) > 0, JSON.stringify(wd));
}
{
  const dev = DEV(6);
  // 4 historical wins, backdated -> still short of the accuracy floor (before.hasEnough === false).
  for (let i = 0; i < 4; i++) { await pick(dev, 50, true); backdateLastCallFor(dev, 10); }
  // The 5th win, THIS week, crosses the floor -> the baseline is what the
  // pre-week activity would score at market-neutral edge, not null and not a
  // literal 500 (which only ever meant "neutral" under the old formula).
  await pick(dev, 50, true);
  const wd = await weeklyScoreDeltaFor(dev);
  // 4 pre-week calls at neutral edge = 40 base; the 5th win takes it to 5 calls
  // at a saturated 1.5x = 75. The delta is the 35 between them. Asserted as a
  // real positive rather than a pinned figure, since the weights are allowed to
  // move: what must hold is that crossing the floor reports motion instead of
  // the "no score" it would have reported before.
  check("crossing the floor this week still produces a delta, not a missing score",
    (wd?.delta ?? 0) > 0 && wd?.direction === "up", JSON.stringify(wd));
}

console.log("\nrankMovementFor: unranked/provisional devices are skipped entirely");
{
  const dev = DEV(7);
  check("zero resolutions -> null", (await rankMovementFor(dev)) === null);
  for (let i = 0; i < 3; i++) await pick(dev, 50, true); // still short of the ranking floor (5)
  check("3 resolved, still provisional -> null", (await rankMovementFor(dev)) === null);
  for (let i = 0; i < 2; i++) await pick(dev, 50, true); // now 5 — ranked for the first time
  _resetStandingsCache();
  check("becoming ranked for the FIRST time is not a 'move' — no prior baseline to compare against",
    (await rankMovementFor(dev)) === null);
  check("a second read with nothing changed since is also null",
    (await rankMovementFor(dev)) === null);
}

console.log("\nrankMovementFor: fires once on a real move, then goes quiet");
{
  const dev = DEV(8);
  for (let i = 0; i < 5; i++) await pick(dev, 50, false); // deliberately bad — starts near the bottom
  _resetStandingsCache();
  const rank1 = (await seasonRankFor(dev))!.rank;
  check("first-ever view establishes the baseline silently", (await rankMovementFor(dev)) === null);
  check("re-reading immediately (nothing changed) is still null", (await rankMovementFor(dev)) === null);

  // A strong second half pulls the overall record up sharply -> should climb.
  for (let i = 0; i < 5; i++) await pick(dev, 10, true);
  _resetStandingsCache();
  const rank2 = (await seasonRankFor(dev))!.rank;
  check("the device's rank number actually improved (this is a real move, not a fixture assumption)",
    rank2 < rank1, `rank1=${rank1} rank2=${rank2}`);

  const move = await rankMovementFor(dev);
  check("reports moving up", move?.direction === "up", JSON.stringify(move));
  check("spots matches the real rank delta", move?.spots === rank1 - rank2, JSON.stringify(move));
  check("rank matches the new rank", move?.rank === rank2, JSON.stringify(move));

  check("shown exactly once — a second read after the same move reports nothing",
    (await rankMovementFor(dev)) === null);
}

console.log(failures === 0 ? "\nall score-motion checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
