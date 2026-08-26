// The creator fee, in both economies it has lived in:
//
//   · play-token: an additive bonus credited by the house, still here because
//     the markets opened before the pivot settle out under the rules they were
//     opened under.
//   · real-money: 3% deducted from the vault by oddie_chain at resolve, then
//     claimed by the creator's own signature. This half used to be a proposed
//     rate that was logged and never charged, because the deployed program had
//     no fee instruction and this repo had no source to add one. Both of those
//     stopped being true, and the tests below are what pin that.
//
// Against the in-memory store.
//
// Run with: npm run test-fees

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database — unset DATABASE_URL");
  process.exit(1);
}

import {
  createSlug, placeCall, settleMarket, getWallet, noticesFor, slugFor,
  recordSurfacer, feeLog, logRealFee, _memGrant,
} from "../src/store/markets.js";
import { creatorFeePlay, CREATOR_FEE_BPS_PLAY, CREATOR_FEE_BPS_REAL, PROTOCOL_FEE_BPS_REAL } from "../src/store/economy.js";
import { linkAccount } from "../src/store/accounts.js";
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

console.log("\nreal-money fee: the creator fee, deducted on-chain at resolve");
{
  const CREATOR = "fee-creator-dev-real";
  const m = mk("FEEREAL", "Will the real-money fee intent log correctly?", 50);
  await createSlug(m);
  const realSlug = slugFor(m);
  await recordSurfacer(realSlug, { deviceId: CREATOR });

  const TOTAL_LAMPORTS = 10_000_000_000; // 10 SOL
  await logRealFee(realSlug, TOTAL_LAMPORTS);
  const log = (await feeLog(200)).filter((r) => r.slug === realSlug);

  // TWO rows now, and that is the change. The house fee stopped being zero
  // when the program grew claim_protocol_fee, so a settled market records both
  // halves of the 4%. One row appearing here would mean a half went missing.
  check("two rows: both halves of the takeout", log.length === 2, JSON.stringify(log));

  const creatorRow = log.find((r) => r.feeKind === "creator");
  // enforced: true, because resolve_market really does take this out of the
  // pool before winners are paid. It is not yet COLLECTED (that needs the
  // creator's own claim_creator_fee signature), which is a different fact and
  // is why creatorFeesPaidFor still refuses to count real rows as earnings.
  check("creator row: 2% of the vault, attributed, and genuinely enforced", !!creatorRow &&
    creatorRow.marketKind === "real" && creatorRow.rateBps === CREATOR_FEE_BPS_REAL &&
    creatorRow.feeAmount === 200_000_000 && creatorRow.recipientDeviceId === CREATOR && creatorRow.enforced === true,
    JSON.stringify(creatorRow));

  // The house fee stopped being zero. Both halves are now real, both are
  // deducted by resolve_market, and both are pulled by their own signature.
  const protoRow = log.find((r) => r.feeKind === "protocol");
  check("protocol row: 2% of the vault, and enforced like the creator's", !!protoRow &&
    protoRow.marketKind === "real" && protoRow.rateBps === PROTOCOL_FEE_BPS_REAL &&
    protoRow.feeAmount === 200_000_000 && protoRow.enforced === true,
    JSON.stringify(protoRow));

  check("the creator's rate matches what the program is told to charge", CREATOR_FEE_BPS_REAL === 200);
  check("oddie's rate matches too", PROTOCOL_FEE_BPS_REAL === 200);
  // The number a staker actually loses is the sum, so that is the one with a
  // ceiling on it. The program refuses anything over 1000 bps.
  check("the total takeout is 4% and stays under the program's cap",
    CREATOR_FEE_BPS_REAL + PROTOCOL_FEE_BPS_REAL === 400 &&
    CREATOR_FEE_BPS_REAL + PROTOCOL_FEE_BPS_REAL <= 1000);
  check("the two halves are equal, which is the promise made on the card",
    CREATOR_FEE_BPS_REAL === PROTOCOL_FEE_BPS_REAL);

  // An empty vault (nobody staked real money) logs nothing: there is no fee.
  const emptySlug = "fee-real-market-empty";
  await logRealFee(emptySlug, 0);
  check("a zero-lamport vault logs nothing", (await feeLog(300)).every((r) => r.slug !== emptySlug));
}

// --- the tagger signs up AFTER their market exists ---------------------------
//
// The shape of the whole funnel, and the one the fee used to fail on. Somebody
// on X tags @oddiefun under an argument. They have no Oddie account, so
// recordSurfacer stores their handle with a NULL device — there is no device to
// store yet. They sign in some days later, which is the point of the fee. Then
// the market resolves.
//
// Settlement used to read the surfacer row as written and pay only if it
// already held a device, so the 3% was skipped for exactly the people it exists
// to recruit, on the markets they brought in themselves. It now re-resolves the
// handle at settlement, the way awardSeasonPoints always has.
console.log("\nthe 3% finds a tagger who signed up after the fact");
{
  const m: Market = {
    venue: "community", venueId: "LATE", question: "Will the late signup get paid?", yesPct: 50,
    closesAt: "2026-12-31T00:00:00Z", volumeUsd: 0, venueUrl: "", tags: [],
  };
  await createSlug(m);
  const slug = slugFor(m);

  // Tagged by someone with no account yet: handle known, device unknown.
  await recordSurfacer(slug, { handle: "@latecomer" });

  await call(slug, "yes", 100, "player-a-0001", [m]);
  await call(slug, "no", 100, "player-b-0001", [m]);

  // ...and NOW they sign in. This is the only step that changes anything.
  const LATE_DEVICE = "latecomer-device-1";
  await linkAccount(LATE_DEVICE, { provider: "twitter", uid: "late-1", handle: "@latecomer" });
  const before = (await getWallet(LATE_DEVICE)).tokens;

  await settleMarket(slug, "yes");

  const after = (await getWallet(LATE_DEVICE)).tokens;
  const expected = creatorFeePlay(200);
  check("the fee is greater than zero, so this test can fail", expected > 0, `${expected}`);
  check("the late signup is credited the creator fee", after - before === expected, `${before} -> ${after}, wanted +${expected}`);

  const notice = (await noticesFor(LATE_DEVICE)).find((n) => n.kind === "creator_fee");
  check("...and told about it", !!notice, JSON.stringify(notice ?? null));

  // The audit log must name who was actually paid, not the null the row held.
  const logged = (await feeLog()).find((f) => f.slug === slug && f.feeKind === "creator");
  check("...and the audit log names the device that was paid",
    logged?.recipientDeviceId === LATE_DEVICE, JSON.stringify(logged ?? null));
  check("...and still carries the handle it was tagged by",
    (logged?.recipientHandle ?? "").replace(/^@+/, "") === "latecomer", JSON.stringify(logged?.recipientHandle));
}

// --- finding the markets whose creator fee has nowhere to go ----------------
//
// Under real money the fee is paid on chain to an address fixed when the market
// was minted, and at that moment the tagger has no wallet, so it is minted with
// the program's unnamed sentinel. Nothing repairs that on its own: the fee
// accrues at resolve to an address nobody holds a key to and sits in the vault.
// onchainMarketsSurfacedBy is what a wallet connection uses to go back and
// name them, so its job is to find every on-chain market a device tagged and
// to leave out the ones there is nothing to name.

console.log("\nonchainMarketsSurfacedBy: what to point at a freshly connected wallet");
{
  const { onchainMarketsSurfacedBy, setCommunityOnchain, createCommunityMarket } =
    await import("../src/store/markets.js");
  const TAGGER = "onchain-surfacer-dev-1";
  const OTHER = "onchain-surfacer-dev-2";

  const minted = await createCommunityMarket({ question: "Minted on chain?", closeTime: 4102444800 });
  await recordSurfacer(minted.slug, { deviceId: TAGGER });
  await setCommunityOnchain(minted.slug, "MintedPubkey1111111111111111111111111111111", "sig1");

  // Same tagger, but the mint failed, so there is no account to name anybody on.
  const unminted = await createCommunityMarket({ question: "Never reached the chain?", closeTime: 4102444800 });
  await recordSurfacer(unminted.slug, { deviceId: TAGGER });

  // Somebody else's market, minted. The classic leak: paying a fee to the
  // wrong wallet because the query forgot whose markets it was asked for.
  const theirs = await createCommunityMarket({ question: "Somebody else's market?", closeTime: 4102444800 });
  await recordSurfacer(theirs.slug, { deviceId: OTHER });
  await setCommunityOnchain(theirs.slug, "MintedPubkey2222222222222222222222222222222", "sig2");

  const found = await onchainMarketsSurfacedBy(TAGGER);
  const slugs = found.map((f) => f.slug);
  check("the tagger's minted market is returned", slugs.includes(minted.slug), JSON.stringify(slugs));
  check("a market that never reached the chain is left out", !slugs.includes(unminted.slug), JSON.stringify(slugs));
  check("somebody else's market is never returned", !slugs.includes(theirs.slug), JSON.stringify(slugs));
  check("the on-chain address comes back with it, so the caller can name on it",
    found.find((f) => f.slug === minted.slug)?.onchainPubkey === "MintedPubkey1111111111111111111111111111111",
    JSON.stringify(found));

  const none = await onchainMarketsSurfacedBy("device-that-tagged-nothing");
  check("a device that tagged nothing gets an empty list, not everything", none.length === 0, JSON.stringify(none));
}

console.log(failures === 0 ? "\nall fee checks passed.\n" : `\n${failures} fee check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
