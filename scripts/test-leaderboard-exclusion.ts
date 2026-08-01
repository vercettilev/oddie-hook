// The @oddiefun exclusion — the brand's own account must never appear on a
// public standings/social surface (leaderboard edge/streak/winnings boards,
// the Recently Settled winners list) even though its activity is real.
// Against the real store on the in-memory backend.
//
// Run with: npm run test-leaderboard-exclusion
//
// Ordering note: the chosen-handle blocks all reuse ONE device (`oddie`) for
// the "oddiefun" handle, because device_balance.handle is unique — a second
// device can't also claim it. The X-linked block runs LAST and deliberately:
// deviceForTwitterHandle prefers a linked X account over a chosen handle, so
// once that block links "OddieFun" to a device, EVERY later resolution of
// "oddiefun" would follow the link instead of `oddie`'s chosen handle —
// fine for that block's own assertions, but it would silently break every
// earlier block if it ran first.

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database — unset DATABASE_URL");
  process.exit(1);
}

import {
  createCommunityMarket, openCommunityMarkets, placeCall, markCommunityResolved, settleMarket,
  setHandle, leaderboard, leaderboardStreaks, leaderboardWinnings, recentlySettled,
  _resetExcludedHandleCache,
} from "../src/store/markets.js";
import { linkAccount } from "../src/store/accounts.js";
import { readFileSync } from "node:fs";
import type { Market } from "../src/venues/types.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
}

const soon = () => Math.floor(Date.now() / 1000) + 86_400;
const mk = async (question: string, yesPct = 50): Promise<string> =>
  (await createCommunityMarket({ question, category: "Sports", yesPct, closeTime: soon() })).slug;
async function call(slug: string, deviceId: string, side: "yes" | "no" = "yes", tokens = 10): Promise<void> {
  const live = (await openCommunityMarkets()) as unknown as Market[];
  const r = await placeCall(slug, side, tokens, deviceId, live);
  if (!r.ok) throw new Error(`placeCall ${slug} ${deviceId}: ${JSON.stringify(r)}`);
}
async function resolve(slug: string, outcome: "yes" | "no"): Promise<void> {
  await markCommunityResolved(slug, outcome);
  await settleMarket(slug, outcome);
}
// A "correct" or "wrong" pick at a chosen entry price, resolved immediately.
async function pick(deviceId: string, entryPct: number, correct: boolean): Promise<void> {
  const slug = await mk(`excl-test pick for ${deviceId} @ ${entryPct}-${Math.random()}?`, entryPct);
  await call(slug, deviceId, "yes");
  await resolve(slug, correct ? "yes" : "no");
}

const DEV = (n: number) => `dev-${String(n).padStart(8, "0")}${"a".repeat(24)}`;
const oddie = DEV(1); // the one device that holds the chosen "oddiefun" handle throughout

console.log("\nleaderboard() (edge board): excludes oddiefun, backfills the freed slot");
{
  await setHandle(oddie, "oddiefun");
  _resetExcludedHandleCache();
  const a = DEV(2), b = DEV(3), c = DEV(4);
  // 10 closed positions each — clears PROVISIONAL_BELOW so all four are
  // eligible to actually rank, not just sit provisional off the board.
  // Distinct, deterministic edges so ranking order is unambiguous:
  // oddie best (would be #1), then a, b, c in strictly descending order.
  for (let i = 0; i < 10; i++) await pick(oddie, 10, true); // edge ~ +0.9 (best)
  for (let i = 0; i < 10; i++) await pick(a, 30, true);      // edge ~ +0.7
  for (let i = 0; i < 10; i++) await pick(b, 50, true);      // edge ~ +0.5
  for (let i = 0; i < 10; i++) await pick(c, 70, true);      // edge ~ +0.3

  const top3 = await leaderboard(3);
  check("oddiefun never appears", !top3.some((r) => r.handle.toLowerCase() === "oddiefun"), JSON.stringify(top3.map((r) => r.handle)));
  check("still exactly 3 rows — the 4th-best real user backfilled oddiefun's freed #1 slot, not a shrunk board",
    top3.length === 3, String(top3.length));
  check("backfilled with a, b, AND c — nobody silently dropped, oddiefun's slot went to the real next-best",
    top3.every((r) => [a, b, c].includes(r.deviceId)), JSON.stringify(top3.map((r) => r.deviceId)));
}

console.log("\nleaderboardStreaks() and leaderboardWinnings(): same exclusion");
{
  _resetExcludedHandleCache();
  const real = DEV(6);
  await pick(oddie, 50, true);
  await pick(real, 50, true);

  const streaks = await leaderboardStreaks(20);
  check("oddiefun absent from the streak board", !streaks.some((r) => r.handle.toLowerCase() === "oddiefun"));
  check("...but a real user with a real streak still shows", streaks.some((r) => r.deviceId === real));

  const winnings = await leaderboardWinnings(20);
  check("oddiefun absent from the winnings board", !winnings.some((r) => r.handle.toLowerCase() === "oddiefun"));
  check("...but the real user's winnings still show", winnings.some((r) => r.deviceId === real));
}

console.log("\nrecentlySettled(): oddiefun is never a NAMED winner");
{
  _resetExcludedHandleCache();
  const realWinner = DEV(9), loser = DEV(10);
  const slug = await mk("excl-test settled market with a real co-winner?");
  await call(slug, oddie, "yes");
  await call(slug, realWinner, "yes");
  await call(slug, loser, "no");
  await resolve(slug, "yes");

  const settled = await recentlySettled(10);
  const row = settled.find((s) => s.slug === slug)!;
  check("the settled market still appears (resolution is real, proof isn't hidden)", !!row);
  check("oddiefun is not in the named winners", !row.winners.some((w) => (w.handle ?? "").toLowerCase() === "oddiefun"), JSON.stringify(row.winners));
  check("the real co-winner IS named", row.winners.some((w) => w.side === "yes"));
  check("winnerTotal counts only the real winner, not oddiefun too", row.winnerTotal === 1, String(row.winnerTotal));
}

console.log("\nrecentlySettled(): a market oddiefun wins ALONE names nobody, not even it");
{
  _resetExcludedHandleCache();
  const loser = DEV(12);
  const slug = await mk("excl-test market oddiefun wins solo?");
  await call(slug, oddie, "yes");
  await call(slug, loser, "no");
  await resolve(slug, "yes");

  const settled = await recentlySettled(10);
  const row = settled.find((s) => s.slug === slug)!;
  check("the market still appears", !!row);
  check("no named winners at all — never credited even as the sole winner", row.winners.length === 0, JSON.stringify(row.winners));
  check("winnerTotal is 0, not 1 — the exclusion doesn't leak through the count either", row.winnerTotal === 0, String(row.winnerTotal));
}

console.log("\nleaderboard(): the exclusion is case-insensitive and covers a real X-linked account (run LAST — see file header)");
{
  const linked = DEV(13);
  // The REAL shape of a linked X account: mixed case AND carrying the "@" the
  // provider sent (this test previously used a bare "OddieFun", which is not
  // what actually gets stored — see the leaderboard() display note about
  // stripping one "@" before render). deviceForTwitterHandle prefers a link
  // over a chosen handle, so this now OUTRANKS oddie's chosen "oddiefun" for
  // resolution purposes — exactly why this block runs last.
  await linkAccount(linked, { provider: "twitter", uid: "oddiefun-x-uid", handle: "@OddieFun", name: "oddie" });
  _resetExcludedHandleCache();
  for (let i = 0; i < 10; i++) await pick(linked, 10, true);
  const top = await leaderboard(20);
  check("mixed-case X-linked '@OddieFun' is still excluded", !top.some((r) => r.deviceId === linked), JSON.stringify(top.filter((r) => r.deviceId === linked)));
}

/*
 * The Postgres path cannot be exercised here — this suite refuses to run with a
 * DATABASE_URL, so every check above runs against the in-memory store. That is
 * exactly how the "@" bug reached production: the mem lookup strips "@" from
 * BOTH the needle and the stored handle, so it matched and these tests passed,
 * while the SQL stripped only the needle and matched nothing. Behaviour tests
 * structurally cannot see that divergence, so this asserts it at the source
 * level instead — the one check that would actually have caught it.
 */
console.log("\nSQL/mem parity: Postgres handle lookups must strip '@' on the STORED side too");
{
  const src = readFileSync(new URL("../src/store/markets.ts", import.meta.url), "utf8");
  // Every comparison against account.handle must normalise the stored value,
  // because a linked X handle is persisted with its "@".
  const accountCmps = [...src.matchAll(/lower\(\s*(ltrim\(\s*)?(a\.)?handle/g)].map((m) => m[0]);
  const unstripped = [...src.matchAll(/FROM account[\s\S]{0,200}?lower\(handle\)/g)].map((m) => m[0]);
  check("no `lower(handle)` compared against a linked X handle without ltrim",
    unstripped.length === 0, unstripped.join(" || "));
  check("the account lookup normalises with ltrim(handle,'@')",
    /provider='twitter' AND lower\(ltrim\(handle,'@'\)\)=\$1/.test(src));
  check("the season-points handle subquery normalises the same way",
    /SELECT lower\(ltrim\(handle,'@'\)\) FROM account WHERE provider='twitter'/.test(src));
  check("sanity: the source was actually read", accountCmps.length > 0, String(accountCmps.length));
}

console.log(failures === 0 ? "\nall leaderboard-exclusion checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
