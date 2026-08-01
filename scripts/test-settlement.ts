// Settlement and handles, against the in-memory store.
//
// The two claims that matter most here:
//   1. Settling pays the venue's terminal price through the SAME formula early
//      exit uses, so holders and scalpers score on one metric — and a losing
//      hold records its negative edge instead of vanishing.
//   2. Settling twice pays once. The double-settle is attempted, in several
//      costumes (repeat sweep, sell-then-settle, settle-then-sell).
//
// Run with: npm run test-settlement

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database — unset DATABASE_URL");
  process.exit(1);
}

import {
  createSlug, placeCall, sellPosition, settleMarket, positionsFor, getWallet,
  noticesFor, leaderboard, ensureHandle, setHandle, slugFor, STARTING_PREDICTIONS,
  _memGrant, winBonus,
} from "../src/store/markets.js";
import { validateHandle, randomHandle, HANDLE_RE } from "../src/store/handles.js";
import type { Market } from "../src/venues/types.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

/**
 * This suite calls placeCall directly at the store layer with deliberately
 * varied stakes, because settleMarket's payout math must be proven correct for
 * ANY stake size the store accepts, not just what the current UI happens to
 * send. Production itself only ever stakes CALL_COST (1) now (the redesign
 * enforces that at the HTTP route, not in placeCall itself — see
 * server.ts's /api/market/:slug/call) — no real device could reach these
 * balances, so every device here is topped up first, in the harness, to
 * exactly what its own call needs.
 */
const call = async (slug: string, side: "yes" | "no", tokens: number, deviceId: string, live: Market[]) => {
  _memGrant(deviceId, tokens);
  return placeCall(slug, side, tokens, deviceId, live);
};

const mk = (id: string, q: string, yesPct: number): Market => ({
  venue: "polymarket", venueId: id, question: q, yesPct,
  closesAt: "2026-12-31T00:00:00Z", volumeUsd: 1000, venueUrl: "x", tags: [],
});

const HOLDER = "holder-device-01";
const DOUBTER = "doubter-device-1";
const SCALPER = "scalper-device-1";

console.log("\nhandles: minted, stable, editable, unique");
{
  const h1 = await ensureHandle(HOLDER);
  check("a fresh device gets a readable random handle", HANDLE_RE.test(h1), h1);
  check("...which is stable across reads", (await ensureHandle(HOLDER)) === h1);

  const set = await setHandle(HOLDER, "Big_Call_9x");
  check("editing normalises and accepts a decent name", set.ok && set.handle === "big_call_9x", JSON.stringify(set));

  const steal = await setHandle(DOUBTER, "BIG_CALL_9X");
  check("a second device cannot take it, case-insensitively", !steal.ok && (steal as { reason: string }).reason === "already taken", JSON.stringify(steal));

  check("too short is rejected", !(await setHandle(DOUBTER, "ab")).ok);
  check("bad characters are rejected", !(await setHandle(DOUBTER, "cool name!")).ok);
  check("reserved names are rejected", !(await setHandle(DOUBTER, "admin")).ok);
  check("offensive content is rejected", !(await setHandle(DOUBTER, "nazi_hunter88")).ok);
  check("'class' survives the substring filter", validateHandle("class").ok);
  for (let i = 0; i < 200; i++) {
    const h = randomHandle();
    if (!HANDLE_RE.test(h)) { check("every random handle validates", false, h); break; }
    if (i === 199) check("every random handle validates (200 draws)", true);
  }
}

console.log("\na market resolves YES: the holder is paid, the doubter scores his loss");
{
  const m = mk("SETL", "Will the settlement test pass?", 40);
  await createSlug(m);
  await call(slugFor(m), "yes", 80, HOLDER, [m]);   // entry 40 (yes terms)
  await call(slugFor(m), "no", 60, DOUBTER, [m]);   // entry 60 (no terms)
  const holderBefore = (await getWallet(HOLDER)).tokens;
  const doubterBefore = (await getWallet(DOUBTER)).tokens;

  const settled = await settleMarket(slugFor(m), "yes");
  check("both open positions settle", settled.length === 2, `${settled.length}`);

  const win = settled.find((s) => s.deviceId === HOLDER)!;
  check("the winner settles at exit 100", win.exitPct === 100);
  // 100/40 = 2.5 -> rounds to 3 (winBonus, not the old proportional payout —
  // the bonus is the entire return, whatever the stake was staked at 40).
  check("...for winBonus(40) = 3 predictions", win.proceeds === winBonus(40), `${win.proceeds}`);
  check("...and a +60 edge", win.edge === 60, `${win.edge}`);

  const loss = settled.find((s) => s.deviceId === DOUBTER)!;
  check("the loser settles at exit 0, proceeds 0", loss.exitPct === 0 && loss.proceeds === 0);
  check("...and a NEGATIVE edge that will count", loss.edge === -60, `${loss.edge}`);

  check("winner's balance is credited", (await getWallet(HOLDER)).tokens === holderBefore + winBonus(40));
  check("loser's balance is untouched by settlement", (await getWallet(DOUBTER)).tokens === doubterBefore);

  const hp = await positionsFor(HOLDER, []);
  check("the settled hold lands in Closed with its edge", hp.closed.length === 1 && hp.closed[0].edge === 60);
  check("...and reputation counts it", hp.overall.avgEdge === 60, `${hp.overall.avgEdge}`);
  const dp = await positionsFor(DOUBTER, []);
  check("the losing hold lowers the loser's reputation", dp.overall.avgEdge === -60, `${dp.overall.avgEdge}`);

  const hn = await noticesFor(HOLDER);
  check("the winner gets a real notification", hn.length === 1 && hn[0].kind === "settle_win" && hn[0].body.includes(`+${winBonus(40)} predictions`), JSON.stringify(hn[0]));
  const dn = await noticesFor(DOUBTER);
  check("the loser is told the market resolved", dn.length === 1 && dn[0].kind === "settle_loss" && dn[0].body.includes("resolved YES"), JSON.stringify(dn[0]));
}

console.log("\nidempotency: the double-settle pays once, in every costume");
{
  const m = mk("IDEM", "Will settling twice pay twice?", 50);
  await createSlug(m);
  await call(slugFor(m), "yes", 50, HOLDER, [m]);
  const before = (await getWallet(HOLDER)).tokens;

  const first = await settleMarket(slugFor(m), "yes");
  // 100/50 = 2.0 exactly -> winBonus(50) = 2.
  check("first settle pays winBonus(50) = 2", first.length === 1 && first[0].proceeds === winBonus(50));
  const afterOnce = (await getWallet(HOLDER)).tokens;
  check("...into the balance", afterOnce === before + winBonus(50));

  // The mutation: the same resolution detected again — a second sweep, a
  // restart, a race. It must find zero open rows.
  const second = await settleMarket(slugFor(m), "yes");
  check("second settle settles NOTHING", second.length === 0, `${second.length}`);
  check("...and credits NOTHING", (await getWallet(HOLDER)).tokens === afterOnce);
  const flips = await settleMarket(slugFor(m), "no");
  check("...even claiming the opposite outcome", flips.length === 0 && (await getWallet(HOLDER)).tokens === afterOnce);

  const notices = (await noticesFor(HOLDER)).filter((n) => n.slug === slugFor(m));
  check("exactly one notification for the market", notices.length === 1, `${notices.length}`);
}

console.log("\nsell and settle cannot both pay the same position");
{
  const m = mk("RACE", "Will a sold position settle again?", 50);
  await createSlug(m);
  await call(slugFor(m), "yes", 40, SCALPER, [m]);
  const moved = { ...m, yesPct: 55 };
  await createSlug(moved);
  const open = (await positionsFor(SCALPER, [moved])).open[0];
  const sold = await sellPosition(open.id, SCALPER, [moved]);
  check("the scalper sells at the live price", sold.ok && sold.proceeds === 44, JSON.stringify(sold));

  const after = (await getWallet(SCALPER)).tokens;
  const settled = await settleMarket(slugFor(m), "yes");
  check("settlement finds the sold position already closed", settled.length === 0);
  check("...and pays nothing on top", (await getWallet(SCALPER)).tokens === after);

  // And the mirror: a settled position cannot then be sold.
  await call(slugFor(moved), "no", 30, SCALPER, [moved]);
  await settleMarket(slugFor(m), "yes");
  const pos = await positionsFor(SCALPER, []);
  const settledCall = pos.closed.find((c) => c.side === "no")!;
  const resell = await sellPosition(settledCall.id, SCALPER, [moved]);
  check("selling a settled position is refused", !resell.ok && (resell as { reason: string }).reason === "already-closed", JSON.stringify(resell));
}

console.log("\nresolution says who was right: the crowd clause (floor: 10)");
{
  const m = mk("CROWD", "Will the crowd clause fire?", 50);
  await createSlug(m);
  // Twelve poppers: two YES (right), ten NO (wrong). Enough for a percentage.
  for (const d of ["crowd-dev-yes-01", "crowd-dev-yes-02"])
    await call(slugFor(m), "yes", 10, d, [m]);
  for (let i = 1; i <= 10; i++)
    await call(slugFor(m), "no", 10, `crowd-dev-no-${String(i).padStart(3, "0")}`, [m]);
  await settleMarket(slugFor(m), "yes");

  const win = (await noticesFor("crowd-dev-yes-01"))[0];
  check("the winner is told the crowd was wrong", win.body.includes("83% of poppers were wrong"), win.body);
  const loss = (await noticesFor("crowd-dev-no-001"))[0];
  check("the loser is told who called it", loss.body.includes("17% of poppers called it"), loss.body);

  // Below the floor the clause is OMITTED — not softened, not "be the first".
  const small = mk("CROWD2", "Will a small crowd get a percentage?", 50);
  await createSlug(small);
  await call(slugFor(small), "yes", 10, "crowd-dev-yes-01", [small]);
  for (let i = 1; i <= 5; i++)
    await call(slugFor(small), "no", 10, `crowd-dev-no-${String(i).padStart(3, "0")}`, [small]);
  await settleMarket(slugFor(small), "yes");
  const solo = (await noticesFor("crowd-dev-yes-01"))[0];
  check("six poppers (under 10) -> no crowd clause at all", !solo.body.includes("popper"), solo.body);
}

console.log("\nshare tokens: owner-minted, stable, resolving");
{
  const { mintShareToken, getShareCall } = await import("../src/store/markets.js");
  const m = mk("SHARE", "Will the share card behave?", 40);
  await createSlug(m);
  const r = await call(slugFor(m), "yes", 50, HOLDER, [m]);
  const callId = (r as { id: number }).id;
  check("placeCall returns the call id", Number.isInteger(callId), JSON.stringify(r));

  const t1 = await mintShareToken(callId, HOLDER);
  check("the owner mints a token", t1.ok);
  const t2 = await mintShareToken(callId, HOLDER);
  check("...which is stable across mints", t2.ok && (t1 as { token: string }).token === (t2 as { token: string }).token);
  check("a stranger cannot mint it", !(await mintShareToken(callId, "stranger-dev-01")).ok);

  const token = (t1 as { token: string }).token;
  const open = await getShareCall(token);
  check("the card data reads back", open?.side === "yes" && open?.entryPct === 40 && open?.resolved === null, JSON.stringify(open));
  check("...with the handle attached", open?.handle === "big_call_9x", open?.handle);

  await settleMarket(slugFor(m), "yes");
  const settled = await getShareCall(token);
  check("after settlement the card knows the verdict", settled?.resolved === "yes", JSON.stringify(settled?.resolved));
  check("an unknown token is null", (await getShareCall("nope-token-xx")) === null);
}

console.log("\nsettlement email lookup (google address, verified only)");
{
  const { emailsFor } = await import("../src/store/markets.js");
  const { linkAccount } = await import("../src/store/accounts.js");
  await linkAccount("mail-dev-000001", { provider: "google", uid: "g-mail-1", name: "Maily", email: "maily@example.com" });
  await linkAccount("nomail-dev-00001", { provider: "google", uid: "g-mail-2", name: "NoMail" }); // no email claim
  const map = await emailsFor(["mail-dev-000001", "nomail-dev-00001", "stranger-dev-99"]);
  check("a google account's verified email resolves", map["mail-dev-000001"] === "maily@example.com", JSON.stringify(map));
  check("no email, no entry", !("nomail-dev-00001" in map));
  check("unknown devices are absent", !("stranger-dev-99" in map));
}

console.log("\nholders and scalpers share one leaderboard metric");
{
  const rows = await leaderboard(20);
  const holder = rows.find((r) => r.deviceId === HOLDER);
  // Three settled edges now: +60, +50, and the share-card market's +60.
  check("the holder is on the board with settled edges", !!holder && holder.closed === 3 && Math.abs(holder.avgEdge - 56.7) < 0.2, JSON.stringify(holder));
  check("...under his chosen handle", holder?.handle === "big_call_9x", holder?.handle);
  const scalper = rows.find((r) => r.deviceId === SCALPER);
  check("the scalper's early exits sit on the same metric", !!scalper && scalper.closed === 2, JSON.stringify(scalper));
}

console.log("\nthe gate: google + allowlist, and only that");
{
  const { gateFor, addToAllowlist } = await import("../src/store/markets.js");
  const { linkAccount } = await import("../src/store/accounts.js");
  const anon = await gateFor("gate-anon-dev-01");
  check("anonymous device is signed_out", !anon.allowed && (anon as {reason:string}).reason === "signed_out");

  await linkAccount("gate-goog-dev-01", { provider: "google", uid: "g-gate-1", name: "G", email: "gated@example.com" });
  const before = await gateFor("gate-goog-dev-01");
  check("google-but-not-listed is not_allowlisted", !before.allowed && (before as {reason:string}).reason === "not_allowlisted");

  await addToAllowlist("Gated@Example.com", "test", false);
  const after = await gateFor("gate-goog-dev-01");
  check("listed email passes (case-insensitive)", after.allowed === true, JSON.stringify(after));
  check("garbage emails are rejected", !(await addToAllowlist("not-an-email", "test", false)));

  // The X path: an engaged extension user signs in with X, matched by x_uid.
  await linkAccount("gate-x-dev-000001", { provider: "twitter", uid: "x-999", handle: "@poster", name: "Poster" });
  const xBefore = await gateFor("gate-x-dev-000001");
  check("X sign-in, not listed, is not_allowlisted", !xBefore.allowed && (xBefore as {reason:string}).reason === "not_allowlisted");
  check("...and echoes the X identity, X provider", (xBefore as {identity:string;provider:string}).identity === "@poster" && (xBefore as {provider:string}).provider === "twitter");
  await addToAllowlist("wave1@example.com", "wave1", true, "x-999", "poster");
  const xAfter = await gateFor("gate-x-dev-000001");
  check("allowlisted X uid passes the gate", xAfter.allowed === true, JSON.stringify(xAfter));
  check("...and the Google path still needs a Google email", !(await gateFor("gate-anon-dev-01")).allowed);
}

console.log("\nstreaks: consecutive active days");
{
  const { computeStreak } = await import("../src/store/markets.js");
  const T = "2026-07-12";
  check("empty history is 0/0", JSON.stringify(computeStreak([], T)) === JSON.stringify({current:0,best:0}));
  check("three straight days ending today", JSON.stringify(computeStreak(["2026-07-10","2026-07-11","2026-07-12"], T)) === JSON.stringify({current:3,best:3}));
  check("run ended yesterday still counts as current", computeStreak(["2026-07-10","2026-07-11"], T).current === 2);
  check("a broken run resets current, keeps best", JSON.stringify(computeStreak(["2026-07-05","2026-07-06","2026-07-07","2026-07-11"], T)) === JSON.stringify({current:1,best:3}));
  check("a run ended 2+ days ago is not current", computeStreak(["2026-07-08","2026-07-09"], T).current === 0);
  check("duplicate days collapse", computeStreak(["2026-07-11","2026-07-11","2026-07-12"], T).current === 2);
}

console.log("\nnet winnings: playing AND being right");
{
  const { leaderboardWinnings } = await import("../src/store/markets.js");
  const rows = await leaderboardWinnings(50);
  const holder = rows.find((r) => r.deviceId === HOLDER);
  check("winnings sum proceeds minus stakes", !!holder && holder.closed === 3, JSON.stringify(holder));
  const sorted = [...rows].map((r) => r.net);
  check("board sorts by net descending", sorted.every((n, i) => i === 0 || sorted[i - 1] >= n));
}

console.log(failures === 0 ? "\nall settlement checks passed.\n" : `\n${failures} settlement check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
