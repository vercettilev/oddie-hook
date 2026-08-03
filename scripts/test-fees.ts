// The creator fee — play-token (additive bonus, actually credited) and
// real-money (proposed rate, logged but never deducted — see economy.ts for
// why the on-chain program can't be charged from this repo). Against the
// in-memory store.
//
// Run with: npm run test-fees

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database — unset DATABASE_URL");
  process.exit(1);
}

import {
  createSlug, placeCall, settleMarket, getWallet, noticesFor, slugFor,
  recordSurfacer, feeLog, logRealFeeIntent, _memGrant,
} from "../src/store/markets.js";
import { creatorFeePlay, CREATOR_FEE_BPS_PLAY, CREATOR_FEE_BPS_REAL, PROTOCOL_FEE_BPS_REAL } from "../src/store/economy.js";
import type { Market } from "../src/venues/types.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

const call = async (slug: string, side: "yes" | "no", tokens: number, deviceId: string, live: Market[]) => {
  _memGrant(deviceId, tokens);
  return placeCall(slug, side, tokens, deviceId, live);
};

const mk = (id: string, q: string, yesPct: number): Market => ({
  venue: "community", venueId: id, question: q, yesPct,
  closesAt: "2026-12-31T00:00:00Z", volumeUsd: 0, venueUrl: "", tags: [],
});

console.log("\ncreatorFeePlay: pure formula");
{
  check("3% of a 200-token pool is 6", creatorFeePlay(200) === 6, String(creatorFeePlay(200)));
  check("floors down, doesn't round up", creatorFeePlay(199) === 5, String(creatorFeePlay(199))); // 5.97 -> 5
  check("a pool under ~34 tokens floors to 0 — no dust payouts", creatorFeePlay(33) === 0 && creatorFeePlay(10) === 0);
  check("zero pool is zero fee", creatorFeePlay(0) === 0);
  check("the rate itself is 3% (300 bps)", CREATOR_FEE_BPS_PLAY === 300);
}

console.log("\nplay-token creator fee: paid to the surfacer, from the total pool, on resolve");
{
  const CREATOR = "fee-creator-dev-01";
  const m = mk("FEE1", "Will the creator fee land?", 50);
  await createSlug(m);
  await recordSurfacer(slugFor(m), { deviceId: CREATOR });
  // 120 on yes + 80 on no = 200 total pool -> 3% = 6.
  await call(slugFor(m), "yes", 120, "fee-caller-a", [m]);
  await call(slugFor(m), "no", 80, "fee-caller-b", [m]);
  const before = (await getWallet(CREATOR)).tokens;

  await settleMarket(slugFor(m), "yes");
  const after = (await getWallet(CREATOR)).tokens;
  check("creator's balance rose by exactly the 6-token fee", after === before + 6, `${before} -> ${after}`);

  const log = await feeLog(50);
  const row = log.find((r) => r.slug === slugFor(m));
  check("a fee-log row exists for this market", !!row, JSON.stringify(row));
  check("...correctly attributed: play/creator, this device, enforced", !!row &&
    row.marketKind === "play" && row.feeKind === "creator" && row.recipientDeviceId === CREATOR && row.enforced === true,
    JSON.stringify(row));
  check("...with the right basis and amount", !!row && row.basisAmount === 200 && row.feeAmount === 6 && row.rateBps === 300, JSON.stringify(row));

  const notices = (await noticesFor(CREATOR)).filter((n) => n.slug === slugFor(m));
  check("the creator gets a transparent notice, not a silent credit",
    notices.length === 1 && notices[0].kind === "creator_fee" && notices[0].delta === 6 && notices[0].body.includes("6 predictions"),
    JSON.stringify(notices[0]));

  // Idempotency: re-settling (already-closed positions) must not charge the fee twice.
  const beforeSecond = (await getWallet(CREATOR)).tokens;
  await settleMarket(slugFor(m), "yes");
  check("settling again does not re-charge the creator fee", (await getWallet(CREATOR)).tokens === beforeSecond);
  const logAfter = await feeLog(50);
  check("...and does not write a second log row", logAfter.filter((r) => r.slug === slugFor(m)).length === 1);
}

console.log("\ncreatorFeesPaidFor: the receipt behind a card's \"earned\" line");
{
  const { creatorFeesPaidFor } = await import("../src/store/markets.js");
  const CREATOR = "fee-receipt-dev-01";
  const m = mk("FEERCPT", "Will the receipt lookup work?", 50);
  await createSlug(m);
  await recordSurfacer(slugFor(m), { deviceId: CREATOR });
  await call(slugFor(m), "yes", 120, "receipt-caller-a", [m]);
  await call(slugFor(m), "no", 80, "receipt-caller-b", [m]);

  const before = await creatorFeesPaidFor([slugFor(m)]);
  check("an UNRESOLVED market has paid nothing — the card must show the promise, not a receipt",
    before[slugFor(m)] === undefined, JSON.stringify(before));

  await settleMarket(slugFor(m), "yes");
  const after = await creatorFeesPaidFor([slugFor(m)]);
  check("once settled, the lookup reports what the tagger actually earned",
    after[slugFor(m)]?.amount === 6, JSON.stringify(after));
  check("...and only for the slugs asked for",
    Object.keys(await creatorFeesPaidFor(["nope-not-a-slug"])).length === 0);
}

console.log("\nedge cases: fees can never produce a negative or broken payout");
{
  // A pool too small to clear the fee floor: nobody is charged, nobody logged.
  const CREATOR = "fee-creator-dev-02";
  const tiny = mk("FEE2", "Will a tiny pool skip the fee?", 50);
  await createSlug(tiny);
  await recordSurfacer(slugFor(tiny), { deviceId: CREATOR });
  await call(slugFor(tiny), "yes", 10, "fee-caller-c", [tiny]); // 10-token pool, 3% floors to 0
  const before = (await getWallet(CREATOR)).tokens;
  await settleMarket(slugFor(tiny), "yes");
  check("a tiny pool credits nothing to the creator", (await getWallet(CREATOR)).tokens === before);
  check("...and logs nothing (there was no fee to log)", (await feeLog(200)).every((r) => r.slug !== slugFor(tiny)));

  // No identifiable creator at all: a big pool, but nobody surfaced this
  // market. The fee simply isn't charged — there's no one to credit it to,
  // and an uncredited "fee" logged against nobody would be meaningless.
  const orphan = mk("FEE3", "Will an orphan market skip the fee?", 50);
  await createSlug(orphan);
  await call(slugFor(orphan), "yes", 120, "fee-caller-d", [orphan]);
  await call(slugFor(orphan), "no", 80, "fee-caller-e", [orphan]);
  const winnerBefore = (await getWallet("fee-caller-d")).tokens;
  await settleMarket(slugFor(orphan), "yes");
  check("the winner's own payout is completely unaffected by the missing creator", (await getWallet("fee-caller-d")).tokens > winnerBefore);
  check("no fee-log row is written when there's no creator to pay", (await feeLog(200)).every((r) => r.slug !== slugFor(orphan)));

  // Self-dealing: the creator is the ONLY caller on their own market. The fee
  // is additive (funded by the house, not deducted from any payout), so
  // there's no exploit and no risk of a negative balance either way.
  const SOLO = "fee-creator-dev-03";
  const solo = mk("FEE4", "Will a solo creator-caller be safe?", 40);
  await createSlug(solo);
  await recordSurfacer(slugFor(solo), { deviceId: SOLO });
  await call(slugFor(solo), "yes", 40, SOLO, [solo]); // 40-token pool -> 3% = 1
  const soloBefore = (await getWallet(SOLO)).tokens;
  const settled = await settleMarket(slugFor(solo), "yes");
  const soloAfter = (await getWallet(SOLO)).tokens;
  check("the solo creator's balance only ever goes up (win payout + creator fee, never negative)",
    soloAfter > soloBefore, `${soloBefore} -> ${soloAfter}`);
  check("...specifically: win payout PLUS the 1-token creator fee, both credited",
    soloAfter === soloBefore + settled[0].proceeds + 1, `expected ${soloBefore + settled[0].proceeds + 1}, got ${soloAfter}`);
}

console.log("\nreal-money fee: logged as intent only, never enforced — see economy.ts");
{
  const CREATOR = "fee-creator-dev-real";
  const m = mk("FEEREAL", "Will the real-money fee intent log correctly?", 50);
  await createSlug(m);
  const realSlug = slugFor(m);
  await recordSurfacer(realSlug, { deviceId: CREATOR });

  const TOTAL_LAMPORTS = 10_000_000_000; // 10 SOL
  await logRealFeeIntent(realSlug, TOTAL_LAMPORTS);
  const log = (await feeLog(200)).filter((r) => r.slug === realSlug);
  check("exactly two rows: creator + protocol", log.length === 2, JSON.stringify(log));

  const creatorRow = log.find((r) => r.feeKind === "creator");
  check("creator row: 2% of the vault, attributed, NOT enforced", !!creatorRow &&
    creatorRow.marketKind === "real" && creatorRow.rateBps === CREATOR_FEE_BPS_REAL &&
    creatorRow.feeAmount === 200_000_000 && creatorRow.recipientDeviceId === CREATOR && creatorRow.enforced === false,
    JSON.stringify(creatorRow));

  const protocolRow = log.find((r) => r.feeKind === "protocol");
  check("protocol row: 3% of the vault, no personal recipient, NOT enforced", !!protocolRow &&
    protocolRow.marketKind === "real" && protocolRow.rateBps === PROTOCOL_FEE_BPS_REAL &&
    protocolRow.feeAmount === 300_000_000 && protocolRow.recipientDeviceId === null && protocolRow.enforced === false,
    JSON.stringify(protocolRow));

  // An empty vault (nobody staked real money) logs nothing — there's no fee to propose.
  const emptySlug = "fee-real-market-empty";
  await logRealFeeIntent(emptySlug, 0);
  check("a zero-lamport vault logs nothing", (await feeLog(300)).every((r) => r.slug !== emptySlug));
}

console.log(failures === 0 ? "\nall fee checks passed.\n" : `\n${failures} fee check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
