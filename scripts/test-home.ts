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
  markCommunityResolved, settleMarket, setHandle, recentlySettled,
} from "../src/store/markets.js";
import type { Market } from "../src/venues/types.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
}

/** Mirrors the gate in /api/home exactly: fewer than three RANKED callers and
 *  the teaser is omitted, because two rows is not a competition and a
 *  provisional row is a standing that hasn't settled yet. */
const HOME_TOP_CALLERS = 3;
async function topCallers() {
  const ranked = (await leaderboard(20)).filter((r) => !r.provisional);
  return ranked.length >= HOME_TOP_CALLERS ? ranked.slice(0, HOME_TOP_CALLERS) : [];
}

const soon = () => Math.floor(Date.now() / 1000) + 86_400;
const mk = async (question: string, yesPct = 50): Promise<string> =>
  (await createCommunityMarket({ question, category: "Sports", yesPct, closeTime: soon() })).slug;
/** placeCall prices against the live set; the open community markets ARE that
 *  set here, since this backend has no venue data. */
async function call(slug: string, deviceId: string, side: "yes" | "no", tokens = 10): Promise<void> {
  const live = (await openCommunityMarkets()) as unknown as Market[];
  const r = await placeCall(slug, side, tokens, deviceId, live);
  if (!r.ok) throw new Error(`placeCall ${slug} ${deviceId}: ${JSON.stringify(r)}`);
}
/** Resolve + settle, the same pair /api/community/resolve runs. */
async function resolve(slug: string, outcome: "yes" | "no"): Promise<void> {
  await markCommunityResolved(slug, outcome);
  await settleMarket(slug, outcome);
}

const DEV = (n: number) => `dev-${String(n).repeat(32).slice(0, 32)}`;

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
  // Two devices cross the provisional bar; a third deliberately does not.
  for (let i = 0; i < 11; i++) {
    const slug = await mk(`Ranked-bar filler ${i}?`, 50);
    await call(slug, DEV(5), "yes");
    await call(slug, DEV(6), "yes");
    if (i < 3) await call(slug, DEV(7), "yes");
    await resolve(slug, "yes");
  }
  const board = await leaderboard(20);
  const ranked = board.filter((r) => !r.provisional);
  check("two callers are ranked", ranked.length === 2, ranked.map((r) => r.handle).join(", "));
  check("the short-sample caller is on the board but provisional", board.some((r) => r.provisional));
  check("below three ranked callers the teaser stays empty", (await topCallers()).length === 0);

  for (let i = 0; i < 11; i++) {
    const slug = await mk(`Third-caller filler ${i}?`, 50);
    await call(slug, DEV(7), "yes");
    await resolve(slug, "yes");
  }
  const teaser = await topCallers();
  check("a third ranked caller opens the teaser", teaser.length === HOME_TOP_CALLERS, teaser.map((r) => r.handle).join(", "));
  check("no provisional caller is ever shown in it", teaser.every((r) => !r.provisional));
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
