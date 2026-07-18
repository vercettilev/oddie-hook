// Offline, hermetic checks for the paper economy. No network, no database, no
// wall clock — every price and every timestamp is injected, so a full cycle
// (call → odds move → early exit → reputation) is proven here rather than
// waited for in production.
//
// Run with: npm run test-economy

import {
  DAILY_TOPUP, PROVISIONAL_BELOW, STARTING_TOKENS, TOKEN_FLOOR, TOPUP_INTERVAL_MS,
  applyTopUp, edgePts, nextTopUpIn, proceedsFor, reputationOf, sharesFor, tokenDeltaPct,
} from "../src/store/economy.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// ---------------------------------------------------------------------------
// Shares and proceeds. The "win 2.6×" on the card and the payout on exit have
// to be the same arithmetic, or a position is worth one thing to the feed and
// another to Positions.
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
// The top-up. A player who cannot afford a single call has left the product.
// ---------------------------------------------------------------------------
console.log("\ntokens are renewable");
{
  const t0 = 1_000_000_000_000;
  const day = TOPUP_INTERVAL_MS;

  check("a new device starts at 200", STARTING_TOKENS === 200);

  check("nothing is granted before the window is up", applyTopUp(0, t0, t0 + day - 1).granted === 0);
  check("a broke device is topped up after a day", applyTopUp(0, t0, t0 + day).tokens === DAILY_TOPUP);
  check("a device at the floor gets nothing", applyTopUp(TOKEN_FLOOR, t0, t0 + day).granted === 0);
  check("a device above the floor is never reduced", applyTopUp(1500, t0, t0 + day).tokens === 1500);

  // The window advances even when nothing was granted, so sitting rich does not
  // bank a free grant for the moment you spend down.
  const rich = applyTopUp(TOKEN_FLOOR, t0, t0 + day);
  check("a full device's window still advances", rich.toppedUpAt === t0 + day);

  // Waiting is not a strategy: a month away is still one grant.
  check("thirty missed days grant 200, not 6000", applyTopUp(0, t0, t0 + 30 * day).tokens === DAILY_TOPUP);

  // The grant never overshoots the floor.
  check("a top-up is capped at the floor", applyTopUp(TOKEN_FLOOR - 50, t0, t0 + day).tokens === TOKEN_FLOOR);
  check("...granting only the shortfall", applyTopUp(TOKEN_FLOOR - 50, t0, t0 + day).granted === 50);

  check("a full device is told about no next top-up", nextTopUpIn(TOKEN_FLOOR, t0, t0) === null);
  check("a broke device counts down a day", nextTopUpIn(0, t0, t0) === day);
  check("...and never counts below zero", nextTopUpIn(0, t0, t0 + 5 * day) === 0);
}

// ---------------------------------------------------------------------------
// The full cycle the product is: stake, watch, exit, be judged.
// ---------------------------------------------------------------------------
console.log("\none device, three positions, one of them wrong");
{
  let balance = STARTING_TOKENS;
  const edges: number[] = [];

  // 1. Call YES at 39, market drifts to 44, sell.
  balance -= 50;
  const win = proceedsFor(50, 39, 44);
  balance += win; edges.push(edgePts(39, 44));
  check("sold into a rise: 50 -> 56 tokens", win === 56, `${win}`);

  // 2. Call NO at 61 (market 39% yes), market rises to 55% yes, NO now 45. Wrong.
  balance -= 100;
  const loss = proceedsFor(100, 61, 45);
  balance += loss; edges.push(edgePts(61, 45));
  check("sold into a fall: 100 -> 74 tokens", loss === 74, `${loss}`);
  check("...and the edge is -16", edges[1] === -16);

  // 3. Call YES at 20, held, resolves true.
  balance -= 10;
  const settled = proceedsFor(10, 20, 100);
  balance += settled; edges.push(edgePts(20, 100));
  check("held to a winning settlement: 10 -> 50 tokens", settled === 50, `${settled}`);

  check("balance tracks every leg", balance === STARTING_TOKENS - 50 + 56 - 100 + 74 - 10 + 50, `${balance}`);

  const rep = reputationOf(edges);
  check("reputation averages +23 across the three", near(rep.avgEdge!, (5 - 16 + 80) / 3), `${rep.avgEdge}`);
  check("the losing leg is IN the average", rep.closed === 3);
  check("...and dragged it below the two winners' mean", rep.avgEdge! < (5 + 80) / 2);
  check("three closed positions is still provisional", rep.provisional);
}

console.log(failures === 0 ? "\nall economy checks passed.\n" : `\n${failures} economy check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
