// The home page's three data-driven sections, against the real store on the
// in-memory backend. The contract under test is not "does it render" but "does
// it render NOTHING when the data isn't there" — the landing page is the one
// surface where a placeholder row would read as a real settled market or a real
// ranked player, so each section has to be provably absent on thin data.
//
// Run with: npm run test-home

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database — unset DATABASE_URL");
  process.exit(1);
}

import {
  createCommunityMarket, openCommunityMarkets, placeCall, leaderboard,
  markCommunityResolved, settleMarket, setHandle, recentlySettled, homeActivity,
  _memGrant,
} from "../src/store/markets.js";
import type { Market } from "../src/venues/types.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
}

/** Mirrors the gate in /api/home exactly: ONE ranked caller is enough to render
 *  (at low volume, requiring three hid the board completely), it lists at most
 *  three, and a provisional caller is never eligible — that's a standing which
 *  hasn't settled yet. */
const HOME_TOP_CALLERS_SHOWN = 3;
const HOME_MIN_RANKED = 1;
async function topCallers() {
  const ranked = (await leaderboard(20)).filter((r) => !r.provisional);
  return ranked.length >= HOME_MIN_RANKED ? ranked.slice(0, HOME_TOP_CALLERS_SHOWN) : [];
}

const soon = () => Math.floor(Date.now() / 1000) + 86_400;
const mk = async (question: string, yesPct = 50): Promise<string> =>
  (await createCommunityMarket({ question, category: "Sports", yesPct, closeTime: soon() })).slug;
/** placeCall prices against the live set; the open community markets ARE that
 *  set here, since this backend has no venue data. */
async function call(slug: string, deviceId: string, side: "yes" | "no", tokens = 10): Promise<void> {
  const live = (await openCommunityMarkets()) as unknown as Market[];
  _memGrant(deviceId, tokens); // see test-settlement.ts's note: production only ever stakes CALL_COST now
  const r = await placeCall(slug, side, tokens, deviceId, live);
  if (!r.ok) throw new Error(`placeCall ${slug} ${deviceId}: ${JSON.stringify(r)}`);
}
/** Resolve + settle, the same pair /api/community/resolve runs. */
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

console.log("\nnothing has happened yet");
{
  check("no settled markets → the section has no rows to render", (await recentlySettled(2)).length === 0);
  check("no ranked callers → the teaser has no rows to render", (await topCallers()).length === 0);
  check("no open markets → that section has no rows either", (await openCommunityMarkets()).length === 0);
}

console.log("\nan open market is not a settled one");
{
  const open = await mk("Will an unresolved market leak into the settled list?");
  await call(open, DEV(1), "yes");
  check("an open market with calls stays out of recentlySettled", (await recentlySettled(2)).length === 0);
  check("...and is still counted as an open market", (await openCommunityMarkets()).length === 1);
}

console.log("\na winner with no handle of any kind");
{
  const slug = await mk("Does an unnamed winner come back as null?", 40);
  await call(slug, DEV(9), "yes");
  await resolve(slug, "yes");
  const row = (await recentlySettled(2)).find((r) => r.slug === slug);
  check("the market now appears", !!row);
  check("its outcome is reported, not inferred", row?.outcome === "yes");
  // null is the contract: the client renders "anonymous caller" for it rather
  // than inventing a name or dropping the row.
  check("the winner's handle is null, not a placeholder", row?.winners[0]?.handle === null, JSON.stringify(row?.winners));
  check("the winner's odds are the price actually taken", row?.winners[0]?.pct === 40, String(row?.winners[0]?.pct));
}

console.log("\na market where every caller was wrong");
{
  const slug = await mk("Will everybody get this one wrong?", 70);
  await call(slug, DEV(2), "yes");
  await call(slug, DEV(3), "yes");
  await resolve(slug, "no");
  const row = (await recentlySettled(5)).find((r) => r.slug === slug);
  // No winning row exists to read the outcome off, so this is the case that
  // proves the resolved_outcome fallback is doing real work.
  check("the market still appears — the verdict is the proof", !!row);
  check("its outcome comes from the resolution, not from a winning call", row?.outcome === "no");
  check("it reports zero winners rather than naming someone", row?.winnerTotal === 0);
  check("its callers are still counted", row?.callers === 2, String(row?.callers));
}

console.log("\nsettled markets are ordered by when they settled");
{
  const first = await mk("Which settled first?", 50);
  await call(first, DEV(4), "yes");
  await resolve(first, "yes");
  const second = await mk("Which settled second?", 50);
  await call(second, DEV(4), "yes");
  await resolve(second, "yes");
  const rows = await recentlySettled(2);
  check("the most recently settled market leads", rows[0]?.slug === second, rows.map((r) => r.question).join(" | "));
  check("`limit` is respected", rows.length === 2);
}

console.log("\nthe leaderboard teaser's ranked-caller gate");
{
  // Nothing so far has crossed the provisional bar — every earlier device has a
  // handful of closed positions at most.
  check("with zero ranked callers the teaser is empty", (await topCallers()).length === 0);

  // One device over the bar; another deliberately left short of it.
  for (let i = 0; i < 11; i++) {
    const slug = await mk(`Ranked-bar filler ${i}?`, 50);
    await call(slug, DEV(5), "yes");
    if (i < 3) await call(slug, DEV(7), "yes"); // 3 closed -> stays provisional
    await resolve(slug, "yes");
  }
  const board = await leaderboard(20);
  check("exactly one caller is ranked", board.filter((r) => !r.provisional).length === 1);
  check("the short-sample caller is on the board but provisional", board.some((r) => r.provisional));
  const one = await topCallers();
  // The point of the lowered threshold: one name to beat is a real competition.
  check("ONE ranked caller is enough to render the teaser", one.length === 1, one.map((r) => r.handle).join(", "));
  check("the provisional caller is not in it", one.every((r) => !r.provisional));

  // Four ranked callers total — the teaser must cap, not grow.
  for (const d of [6, 7, 10]) {
    for (let i = 0; i < 11; i++) {
      const slug = await mk(`Filler for dev ${d}, ${i}?`, 50);
      await call(slug, DEV(d), "yes");
      await resolve(slug, "yes");
    }
  }
  const ranked = (await leaderboard(20)).filter((r) => !r.provisional);
  check("four callers are now ranked", ranked.length === 4, String(ranked.length));
  const teaser = await topCallers();
  check("the teaser caps at three rows", teaser.length === HOME_TOP_CALLERS_SHOWN, String(teaser.length));
  check("no provisional caller is ever shown in it", teaser.every((r) => !r.provisional));
}

console.log("\nlive-activity counters");
{
  const a = await homeActivity();
  // Everything above resolved its markets, so there are open markets only from
  // the one deliberately-unresolved market created near the top of this file.
  check("open markets counted (resolved ones excluded)", a.marketsOpen === 1, String(a.marketsOpen));
  check("calls in the last 24h counted", a.callsToday > 0, String(a.callsToday));
  check("points won in the last 24h counted", a.pointsWonToday > 0, String(a.pointsWonToday));
  check("every counter is a finite non-negative integer",
    [a.marketsOpen, a.callsToday, a.pointsWonToday].every((n) => Number.isInteger(n) && n >= 0),
    JSON.stringify(a));
}

console.log("\na linked handle names the winner");
{
  await setHandle(DEV(8), "oddsmith");
  const slug = await mk("Does a chosen handle reach the settled row?", 30);
  await call(slug, DEV(8), "yes");
  await resolve(slug, "yes");
  const row = (await recentlySettled(1))[0];
  check("the settled row names them", row?.winners.some((w) => w.handle === "oddsmith"), JSON.stringify(row?.winners));
}

console.log(failures === 0 ? "\nall home checks passed.\n" : `\n${failures} home check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
