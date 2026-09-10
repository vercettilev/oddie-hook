/**
 * The fuel gauge, asserted.
 *
 * The admin wallet pays non-refundable rent for every market it mints, and
 * below MIN_LAMPORTS the mint is refused with nothing but a log line to show
 * for it. That is a cliff, and the whole point of chainRunway is to turn the
 * cliff into an approach, so the arithmetic of the approach gets a test rather
 * than a comment.
 *
 * Pure: no cluster, no keys, no RPC. chainRunway takes lamports and answers.
 */
import { chainRunway } from "../src/chain/oddieChain.js";

const SOL = 1_000_000_000;
const FLOOR = 0.01 * SOL;
const WARN = 0.05 * SOL;
/* THE TEST HELD THE OLD NUMBER AND KEPT IT ALIVE.
   This was 4,257,000, taken when Market was 314 bytes. The struct dropped to
   162 when the question became a hash, the real cost fell to 2,911,847, and
   this line went on asserting the stale figure - so the constant could not be
   corrected without the suite calling the correction a regression. A test that
   restates a number rather than checking a relationship does that.
   Kept as a number because chainRunway's whole job is arithmetic on one, but
   imported from the source of truth would be better still if it were exported.
   Measured with getMinimumBalanceForRentExemption on mainnet, 2026-09-10:
   1,836,570 (162B market) + 1,070,277 (41B vault) + 5,000 signature. */
const PER_MARKET = 2_911_847;

let failed = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
};

console.log("\nchain runway\n");

// --- the three bands ------------------------------------------------------
check("a funded wallet is ok", chainRunway(1 * SOL).state === "ok");
check("just above the warn line is still ok", chainRunway(WARN).state === "ok");
check("just below the warn line is low", chainRunway(WARN - 1).state === "low");
// The gate in mintMarket refuses on `bal < MIN_LAMPORTS`, so a wallet sitting
// EXACTLY on the floor is still allowed one mint. The gauge mirrors the gate
// rather than rounding its own way, because a gauge that disagrees with the
// thing it measures is worse than no gauge.
check("exactly on the floor is low, not stopped: the gate still lets it mint",
  chainRunway(FLOOR).state === "low", chainRunway(FLOOR).state);
check("a lamport under the floor is stopped",
  chainRunway(FLOOR - 1).state === "stopped");
check("an empty wallet is stopped", chainRunway(0).state === "stopped");

// --- unreadable is not empty ---------------------------------------------
// This is the money-losing direction: a throttled RPC that reads as "0 SOL"
// would paint a red STOPPED banner at an operator whose wallet is full, and
// one that reads as healthy would hide a wallet that is actually empty.
const unknown = chainRunway(null);
check("an unreadable balance is 'off', never 'stopped'", unknown.state === "off");
check("and it reports no balance rather than zero", unknown.balanceSol === null);
check("and no runway rather than zero markets", unknown.marketsLeft === null);
check("NaN is unreadable too, not a balance", chainRunway(NaN).state === "off");

// --- the number an operator actually acts on ------------------------------
// marketsLeft counts to the FLOOR, not to zero. A wallet sitting on the floor
// has a balance and no runway, and those two have to disagree or the gauge is
// decoration.
// Deliberately conservative by one: the gate would permit a single mint here,
// and the gauge still says zero. A fuel gauge is allowed to under-promise and
// is never allowed to over-promise.
check("a wallet on the floor has a balance but zero runway",
  chainRunway(FLOOR).balanceSol === 0.01 && chainRunway(FLOOR).marketsLeft === 0);
check("runway never goes negative", chainRunway(0).marketsLeft === 0);

const tenMarkets = FLOOR + PER_MARKET * 10;
check("floor plus ten markets' rent reports exactly ten",
  chainRunway(tenMarkets).marketsLeft === 10, chainRunway(tenMarkets).marketsLeft);
check("a partial market is not counted (floor, not round)",
  chainRunway(tenMarkets + PER_MARKET - 1).marketsLeft === 10);

// The recommended starting balance from the funding plan, restated as runway
// so the two can never drift apart silently.
const quarter = 0.25 * SOL;
// 82, not the 56 this said, and the difference is the whole point of the
// correction: a quarter of a SOL buys half again as many markets as the wallet
// was being told, because the number it was told was measured against an
// account that is no longer that size.
check("0.25 SOL is about 82 markets", chainRunway(quarter).marketsLeft === 82,
  chainRunway(quarter).marketsLeft);
check("0.25 SOL is comfortably ok, not low", chainRunway(quarter).state === "ok");

// --- the warn band is worth having ---------------------------------------
// A warning nobody can act on is noise. The band has to be wide enough that an
// operator who sees it still has markets left to serve while they fund.
check("the low band still has real runway in it (a warning you can act on)",
  chainRunway(WARN - 1).marketsLeft! >= 5, chainRunway(WARN - 1).marketsLeft);

console.log(failed === 0 ? "\nall runway checks passed.\n" : `\n${failed} FAILED\n`);
if (failed > 0) process.exit(1);
