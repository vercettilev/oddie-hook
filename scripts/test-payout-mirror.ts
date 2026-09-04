/**
 * The off-chain payout mirror, against the program's own rules.
 *
 * payoutLamports exists because a claimed Position is CLOSED: after somebody
 * collects, the chain still has the market's frozen totals but no longer has
 * their stake, so "what did that call make" has to be recomputed off-chain from
 * the market plus our stamped entry. A mirror that drifts from
 * lib.rs:claim_winnings does not fail loudly — it just prints a slightly wrong
 * amount of somebody's money on a public board.
 *
 * Every case here is one of the program's own branches or one of the safety
 * properties its header pins.
 */
import { payoutLamports, type SettledMarketTotals } from "../src/store/economy.js";

let failed = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
};

const SOL = 1_000_000_000;
/** 3 SOL on YES, 1 SOL on NO, YES won, 4% split 2/2 of the 4 SOL pool. */
const m: SettledMarketTotals = {
  winningSide: "yes",
  totalYesLamports: 3 * SOL, totalNoLamports: 1 * SOL,
  creatorFeeLamports: 0.08 * SOL, protocolFeeLamports: 0.08 * SOL,
};

console.log("\npayout mirror\n");

// distributable = 4 - 0.16 = 3.84; a 1 SOL YES stake is 1/3 of the winning side
check("a winner is paid their share of pool-minus-fee",
  payoutLamports(1 * SOL, "yes", m) === Math.floor((1 * SOL * 3.84 * SOL) / (3 * SOL)),
  payoutLamports(1 * SOL, "yes", m));
check("and that is a profit, not a return of stake",
  payoutLamports(1 * SOL, "yes", m) > 1 * SOL);

check("the losing side is paid nothing", payoutLamports(1 * SOL, "no", m) === 0);

// The whole winning side splits at most the distributable amount, never more.
check("the winning side cannot be paid more than the pool minus fees",
  payoutLamports(3 * SOL, "yes", m) <= 3.84 * SOL, payoutLamports(3 * SOL, "yes", m));

// SAFETY PROPERTY 2 from the program header: truncating division, so the sum of
// claims is at most distributable. Three equal winners must not over-draw.
const thirds: SettledMarketTotals = {
  winningSide: "yes", totalYesLamports: 3, totalNoLamports: 7,
  creatorFeeLamports: 0, protocolFeeLamports: 0,
};
const each = payoutLamports(1, "yes", thirds);
check("truncation leaves dust rather than over-paying the last claimant",
  each * 3 <= 10, { each, total: each * 3 });

// NOBODY BACKED THE WINNER: the program refunds every stake and takes no fee.
// Counting this as a loss would invent losses out of the markets where the
// house behaved best.
const noWinners: SettledMarketTotals = {
  winningSide: "yes", totalYesLamports: 0, totalNoLamports: 2 * SOL,
  creatorFeeLamports: 0, protocolFeeLamports: 0,
};
check("with nobody on the winning side every stake is refunded in full",
  payoutLamports(0.5 * SOL, "no", noWinners) === 0.5 * SOL);
check("and that refund is break-even, not a win",
  payoutLamports(0.5 * SOL, "no", noWinners) - 0.5 * SOL === 0);

// A market whose fees somehow exceed the pool must not pay a negative amount
// or a giant one through a sign flip.
const broken: SettledMarketTotals = {
  winningSide: "yes", totalYesLamports: 1 * SOL, totalNoLamports: 0,
  creatorFeeLamports: 5 * SOL, protocolFeeLamports: 0,
};
check("fees larger than the pool pay zero, never a negative", payoutLamports(1 * SOL, "yes", broken) === 0);

check("a zero stake pays zero", payoutLamports(0, "yes", m) === 0);
check("a nonsense stake pays zero rather than NaN", payoutLamports(NaN, "yes", m) === 0);

// The NO side winning is the mirror image, and getting the branch backwards
// would pay exactly the wrong people.
const noWins: SettledMarketTotals = { ...m, winningSide: "no" };
check("when NO wins it is the NO stakes that are paid", payoutLamports(1 * SOL, "no", noWins) > 0);
check("and the YES stakes that get nothing", payoutLamports(1 * SOL, "yes", noWins) === 0);

console.log(failed === 0 ? "\nall payout mirror checks passed.\n" : `\n${failed} FAILED\n`);
if (failed > 0) process.exit(1);
