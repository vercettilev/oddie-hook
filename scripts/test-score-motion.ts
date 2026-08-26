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
  _memGrant, _memSeasonCredit, recordSurfacer, accuracyFor, leaderboard, reputationFor,
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

/* weeklyScoreDeltaFor measures THE LOUDNESS LADDER now.
 *
 * It used to recompute accuracy with and without the week's resolutions and
 * report the difference. Resolutions no longer move the score at all, so that
 * reading returned a permanent null. It reads the growth ledger instead: what
 * was credited in the last seven days, at the same weight the total uses.
 */
console.log("\nweeklyScoreDeltaFor: hidden with nothing to show");
{
  check("nothing credited at all -> null", (await weeklyScoreDeltaFor(DEV(1))) === null);

  const stale = DEV(2);
  _memSeasonCredit(stale, 150, 10);
  check("credited, but outside the window -> null (hidden, not stale)",
    (await weeklyScoreDeltaFor(stale)) === null);

  // THE CHANGE, PINNED. Taking calls and resolving them earns nothing here,
  // because the score is loudness and a position is not loudness. Betting has
  // its own reward and that reward is money.
  const bettor = DEV(3);
  for (let i = 0; i < 5; i++) await pick(bettor, 50, true);
  check("five winning calls this week move the week's score by nothing",
    (await weeklyScoreDeltaFor(bettor)) === null);
}

console.log("\nweeklyScoreDeltaFor: what the week actually added");
{
  const dev = DEV(4);
  _memSeasonCredit(dev, 50);            // surfaced a market
  const wd = await weeklyScoreDeltaFor(dev);
  check("a surfaced market this week reports motion", (wd?.delta ?? 0) > 0, JSON.stringify(wd));
  check("direction is up", wd?.direction === "up", JSON.stringify(wd));
  check("the delta is the ledger amount at the score's own weight",
    wd?.delta === 100, JSON.stringify(wd));   // 50 points x contribution weight 2
}
{
  const dev = DEV(5);
  _memSeasonCredit(dev, 50, 10);        // last week, must not count
  _memSeasonCredit(dev, 150);           // this week
  const wd = await weeklyScoreDeltaFor(dev);
  check("only the last seven days count", wd?.delta === 300, JSON.stringify(wd));
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
  // Rank moves on the ladder the score is made of. It used to be moved here by
  // taking better calls, which is no longer a thing the score can see: playing
  // well earns money, and being loud earns rank.
  const dev = DEV(8);
  _memSeasonCredit(dev, 50);   // one surfaced market: on the board, near the bottom
  _resetStandingsCache();
  const rank1 = (await seasonRankFor(dev))!.rank;
  check("first-ever view establishes the baseline silently", (await rankMovementFor(dev)) === null);
  check("re-reading immediately (nothing changed) is still null", (await rankMovementFor(dev)) === null);

  // A loud week: several markets surfaced and a post cleared review.
  _memSeasonCredit(dev, 2500);
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

/**
 * The board has to be climbable by the ONE act the product asks for.
 *
 * Score, rank and every badge used to be computed from resolved play
 * positions. Real money moved to the chain and nothing settles those rows any
 * more, so all three had quietly frozen: someone who did exactly what the
 * landing page asks (tag @oddiefun and put a market up) earned a null score,
 * no rank, no tier and no row on the leaderboard, forever. Each of the four
 * checks below failed before this was fixed.
 */
console.log("\ntagging a market alone is enough to be on the board");
{
  _resetStandingsCache();
  const tagger = "dev-tagger-only";
  const slug = await mk("does tagging alone put you on the board?");
  await recordSurfacer(slug, { deviceId: tagger });

  const acc = await accuracyFor(tagger);
  check("a market you tagged is a score", (acc.oddieScore ?? 0) > 0, JSON.stringify(acc.oddieScore));
  check("...and a record worth showing, with no position ever taken", acc.hasEnough);

  _resetStandingsCache();
  check("...which is enough to be ranked", (await seasonRankFor(tagger)) != null);
  check("...and to appear on the leaderboard",
    (await leaderboard(50)).some((r) => r.deviceId === tagger));

  const rep = await reputationFor(tagger);
  check("...and to wear a tier for it", rep.tier?.id === "proven", JSON.stringify(rep.tier));
}

console.log(failures === 0 ? "\nall score-motion checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
