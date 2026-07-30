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
  await pick(notEnoughYet, 50, true); // 2 resolved this week, still short of the accuracy floor (5)
  check("resolutions THIS week but still below the accuracy floor -> null, not a score from thin air",
    (await weeklyScoreDeltaFor(notEnoughYet)) === null);
}

console.log("\nweeklyScoreDeltaFor: a real delta from resolved history vs. this week");
{
  const dev = DEV(4);
  // 5 historical wins at pct 50 (edge +0.5 each), backdated -> baseline oddieScore 1000.
  for (let i = 0; i < 5; i++) { await pick(dev, 50, true); backdateLastCallFor(dev, 10); }
  // One loss THIS week at pct 50 (edge -0.5) -> meanEdge over 6 = (2.5-0.5)/6 = 0.3333 -> score 833.
  await pick(dev, 50, false);
  const wd = await weeklyScoreDeltaFor(dev);
  check("direction is down", wd?.direction === "down", JSON.stringify(wd));
  check("delta is exactly -167 (1000 -> 833)", wd?.delta === -167, JSON.stringify(wd));
}
{
  const dev = DEV(5);
  // 5 historical losses at pct 50, backdated -> baseline oddieScore 0.
  for (let i = 0; i < 5; i++) { await pick(dev, 50, false); backdateLastCallFor(dev, 10); }
  // One win THIS week -> meanEdge over 6 = (-2.5+0.5)/6 = -0.3333 -> score 167.
  await pick(dev, 50, true);
  const wd = await weeklyScoreDeltaFor(dev);
  check("direction is up", wd?.direction === "up", JSON.stringify(wd));
  check("delta is exactly +167 (0 -> 167)", wd?.delta === 167, JSON.stringify(wd));
}
{
  const dev = DEV(6);
  // 4 historical wins, backdated -> still short of the accuracy floor (before.hasEnough === false).
  for (let i = 0; i < 4; i++) { await pick(dev, 50, true); backdateLastCallFor(dev, 10); }
  // The 5th win, THIS week, crosses the floor -> before falls back to the neutral 500, not null.
  await pick(dev, 50, true);
  const wd = await weeklyScoreDeltaFor(dev);
  check("crossing the floor this week: baseline is the neutral 500, not a missing score",
    wd?.delta === 500 && wd?.direction === "up", JSON.stringify(wd));
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
