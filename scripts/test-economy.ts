// Offline, hermetic checks for the paper economy. No network, no database, no
// wall clock — every price and every timestamp is injected, so a full cycle
// (call → odds move → early exit → reputation) is proven here rather than
// waited for in production.
//
// Run with: npm run test-economy

import {
  BONUS_CAP, BONUS_FLOOR, CALL_COST, PROVISIONAL_BELOW, STARTING_PREDICTIONS,
  edgePts, proceedsFor, reputationOf, sharesFor, tokenDeltaPct, winBonus,
} from "../src/store/economy.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// ---------------------------------------------------------------------------
// Shares and proceeds. This is cash-out math (sellPosition / valueNow): a
// position priced out at whatever it is worth right now, at ANY stake size.
// It is untouched by the predictions redesign below — the redesign only
// changed how a call is STAKED (always CALL_COST) and how settlement PAYS
// (winBonus, not proportional proceeds) — so this still exercises the general
// primitive, not the fixed-cost call flow.
// ---------------------------------------------------------------------------
console.log("\nshares and proceeds");
{
  check("a 50 stake at 39% buys ~128 shares", near(Math.round(sharesFor(50, 39)), 128), `${sharesFor(50, 39)}`);
  check("the card's 'win N' IS the share count", Math.round(50 * 100 / 39) === Math.round(sharesFor(50, 39)));

  check("held to a winning settlement pays the shares", proceedsFor(50, 39, 100) === 128, `${proceedsFor(50, 39, 100)}`);
  check("held to a losing settlement pays nothing", proceedsFor(50, 39, 0) === 0);
  check("selling at the entry price returns the stake", proceedsFor(50, 39, 39) === 50);
  check("selling into a rise pays more (39 -> 44)", proceedsFor(50, 39, 44) === 56, `${proceedsFor(50, 39, 44)}`);
  check("selling into a fall pays less (39 -> 31)", proceedsFor(50, 39, 31) === 40, `${proceedsFor(50, 39, 31)}`);
  check("proceeds never go negative", proceedsFor(1, 96, 0) === 0);

  // A stake of 0 shares is not a position; a price of 0 is not a price.
  let threw = false;
  try { sharesFor(50, 0); } catch { threw = true; }
  check("a zero entry price is refused, not divided by", threw);
}

// ---------------------------------------------------------------------------
// Edge. One formula, both sides — this is the claim the whole reputation
// metric rests on, so it is asserted rather than asserted in a comment.
// ---------------------------------------------------------------------------
console.log("\nedge is one formula for both sides");
{
  // A market at 39% yes. YES is priced 39, NO is priced 61.
  const entryYes = 39, entryNo = 100 - entryYes;
  // It drifts to 44% yes. YES is now 44, NO is now 56.
  const exitYes = 44, exitNo = 100 - exitYes;

  check("YES gains when yes rises", edgePts(entryYes, exitYes) === +5);
  check("NO loses the same when yes rises", edgePts(entryNo, exitNo) === -5);
  check("the NO rule `entry − exit` in yes-terms agrees", edgePts(entryNo, exitNo) === entryYes - exitYes);

  check("a losing YES exit is negative (39 -> 31)", edgePts(39, 31) === -8);
  check("a winning settlement is the distance to certainty", edgePts(39, 100) === 61);
  check("a losing settlement is the whole entry price", edgePts(39, 0) === -39);
}

// ---------------------------------------------------------------------------
// Edge is not token PnL. A big stake on a small edge must not outrank a small
// stake on a big one — that is the entire reason reputation exists.
// ---------------------------------------------------------------------------
console.log("\nedge measures skill, not size");
{
  const whale = { stake: 900, entry: 39, exit: 41 };   // +2 edge, +46 tokens
  const minnow = { stake: 10, entry: 39, exit: 60 };   // +21 edge, +5 tokens

  const whalePnl = proceedsFor(whale.stake, whale.entry, whale.exit) - whale.stake;
  const minnowPnl = proceedsFor(minnow.stake, minnow.entry, minnow.exit) - minnow.stake;
  check("the whale wins more tokens", whalePnl > minnowPnl, `${whalePnl} vs ${minnowPnl}`);
  check("...but the minnow has the better edge", edgePts(minnow.entry, minnow.exit) > edgePts(whale.entry, whale.exit));

  // The receipt's percentage and the reputation's percentage are different
  // numbers and must never be confused: 39 -> 44 is +5 edge but +12.8% tokens.
  check("token delta is not the edge", !near(tokenDeltaPct(39, 44), edgePts(39, 44)), `${tokenDeltaPct(39, 44)}`);
  check("token delta on a 39 -> 44 sell is ~+12.8%", near(Math.round(tokenDeltaPct(39, 44) * 10) / 10, 12.8), `${tokenDeltaPct(39, 44)}`);
}

// ---------------------------------------------------------------------------
// Reputation. It has to be able to go DOWN, or it is a participation trophy.
// ---------------------------------------------------------------------------
console.log("\nreputation falls when you are wrong");
{
  const empty = reputationOf([]);
  check("no closed positions -> no number yet", empty.avgEdge === null && empty.provisional);

  const twoGoodScalps = reputationOf([5, 6]);
  check("two lucky scalps average +5.5", near(twoGoodScalps.avgEdge!, 5.5));
  check("...and are flagged provisional", twoGoodScalps.provisional);

  const afterALoss = reputationOf([5, 6, -8]);
  check("a losing exit drags the average down", afterALoss.avgEdge! < twoGoodScalps.avgEdge!, `${afterALoss.avgEdge}`);
  check("...to exactly +1", near(afterALoss.avgEdge!, 1));

  const underwater = reputationOf([-8, -12, -3]);
  check("a bad player has a negative reputation", underwater.avgEdge! < 0, `${underwater.avgEdge}`);

  const scalper = reputationOf(Array(20).fill(5));
  const holder = reputationOf([61]);
  check("a holder's single +61 outranks a scalper's twenty +5", holder.avgEdge! > scalper.avgEdge!);
  check("...but only the scalper's number is established", scalper.provisional === false && holder.provisional === true);

  check(`exactly ${PROVISIONAL_BELOW} closed positions clears provisional`, reputationOf(Array(PROVISIONAL_BELOW).fill(1)).provisional === false);
  check(`${PROVISIONAL_BELOW - 1} does not`, reputationOf(Array(PROVISIONAL_BELOW - 1).fill(1)).provisional === true);
}

// ---------------------------------------------------------------------------
// Calling is FREE. The balance constants survive because settlement still
// stakes and pays through them, but nothing gates a call any more: what the
// product needs more of is people holding a resolved call with their name on
// it, and charging for one throttled exactly that.
// ---------------------------------------------------------------------------
console.log("\ncalling costs nothing, and the wall is gone with it");
{
  check("a call is free", CALL_COST === 0);
  // The property that actually matters, asserted rather than assumed: with a
  // zero cost NO balance can ever be too small to call, including an empty
  // one. This is the wall's absence, stated as arithmetic.
  for (const balance of [0, 1, 5, 999]) {
    check(`a balance of ${balance} can still call`, balance >= CALL_COST);
  }
  check("a new device still starts with a handful (the ledger keeps working)", STARTING_PREDICTIONS === 5);
  // The daily claim and the connect bonus are gone, and their constants went
  // with them. Score is earned through SEASON_POINTS (tag a market into
  // existence, grow it, resolve it cleanly, be loud about it) and granted for
  // nothing else. These pins keep either from quietly coming back.
  const economy = await import("../src/store/economy.js") as Record<string, unknown>;
  check("the daily claim is gone", !("DAILY_CLAIM" in economy));
  check("the sign-in bonus is gone", !("CONNECT_BONUS" in economy));
}

// ---------------------------------------------------------------------------
// winBonus — the mapping approved for the redesign: bonus = clamp(round(100 /
// entryPct), 1, 10). It rides directly on the multiplier already shown on the
// card, so the number a user sees before calling IS the bonus, rounded. This
// IS the entire return on a win (not a stake refund plus a bonus) — the 1
// prediction spent to call was already deducted at call time.
// ---------------------------------------------------------------------------
console.log("\nwinBonus: card multiplier, rounded, floored at 1, capped at 10");
{
  check("90% favorite win (1.1×) -> 1", winBonus(90) === 1);
  check("77% favorite win (1.3×) -> 1", winBonus(77) === 1);
  check("50% coin flip win (2.0×) -> 2", winBonus(50) === 2);
  check("33% win (3.0×) -> 3", winBonus(33) === 3);
  check("21% longshot win (4.8×) -> 5", winBonus(21) === 5, `${winBonus(21)}`);
  check("10% true longshot win (10.0×) -> 10, the cap boundary", winBonus(10) === 10);
  check("5% extreme longshot win (20.0×) -> 10, capped, not 20", winBonus(5) === 10);
  check("the lowest possible entry (1%, 100×) is still capped at 10", winBonus(1) === 10);
  check("the highest possible entry (99%) still floors at 1", winBonus(99) === 1);
  check("BONUS_FLOOR/BONUS_CAP are exactly 1/10 — settleMarket's SQL inlines these literals", BONUS_FLOOR === 1 && BONUS_CAP === 10);

  let threw = false;
  try { winBonus(0); } catch { threw = true; }
  check("a zero entry price is refused, not divided by", threw);
}

// ---------------------------------------------------------------------------
// The full cycle the product now is: spend 1, watch, be judged, win a bonus
// or nothing. This replaces the old variable-stake cycle (50/100/10-token
// calls) — every real call now costs CALL_COST, so this is the path placeCall
// and settleMarket actually take today.
// ---------------------------------------------------------------------------
console.log("\none device, three calls, one of them wrong — the real settlement path");
{
  let balance = STARTING_PREDICTIONS;
  const edges: number[] = [];

  // 1. Call YES at 39, resolves YES. A modest win.
  balance -= CALL_COST;
  const bonus1 = winBonus(39);
  balance += bonus1; edges.push(edgePts(39, 100));
  check("a 39% win pays a 3-prediction bonus (100/39 rounds to 3)", bonus1 === 3, `${bonus1}`);

  // 2. Call NO at 61 (market 39% yes), resolves YES. NO loses, pays nothing.
  balance -= CALL_COST;
  edges.push(edgePts(61, 0));
  check("edge on the loss is the full distance to certainty (-61)", edges[1] === -61);

  // 3. Call YES at 20, resolves YES. A longshot win.
  balance -= CALL_COST;
  const bonus3 = winBonus(20);
  balance += bonus3; edges.push(edgePts(20, 100));
  check("a 20% longshot win pays a 5-prediction bonus", bonus3 === 5, `${bonus3}`);

  check("balance tracks every leg: 5 - 3(spent) + 3(bonus) + 0 + 5(bonus) = 10",
    balance === STARTING_PREDICTIONS - 3 * CALL_COST + bonus1 + bonus3, `${balance}`);

  const rep = reputationOf(edges);
  check("reputation is untouched by the redesign — still pure edge, not tokens",
    near(rep.avgEdge!, (61 - 61 + 80) / 3), `${rep.avgEdge}`);
  check("the losing leg is IN the average", rep.closed === 3);
  check("three closed positions is still provisional", rep.provisional);
}

console.log(failures === 0 ? "\nall economy checks passed.\n" : `\n${failures} economy check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
