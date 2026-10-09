/**
 * ONE DEFINITION OF WHAT A POOL IS WORTH.
 *
 * This existed twice, and the two copies disagreed by 41 points on a live
 * market. The card drew crowdPct -- a 50 anchor blended with a count of PEOPLE
 * -- and printed "50%". The API divided the money and published 99. Same
 * market, same second, two numbers, and the card is the surface that travels
 * on X.
 *
 * Worse than the disagreement: the card derived its PAYOUT MULTIPLE from the
 * people number. The chain pays winning_leg x (pool - fees) / winning_total,
 * which is money and only money. With 0.5 SOL on yes and nothing on no, the
 * card promised "yes pays 1.9x" for a bet that, if yes wins, returns the stake
 * and no more -- there is nothing on the other side to win. A multiple printed
 * under a stranger's tweet is a promise, and that one could not be kept.
 *
 * So: money decides, here, once. A pari-mutuel price IS the money split; a
 * count of heads is a different claim and does not belong in the same slot.
 *
 * The third state is the point of the rewrite. A pool with everything on one
 * side has no price to quote -- "99%" reads as a settled argument when what
 * actually happened is that nobody has taken the other side yet, and it talks
 * the second bettor (the one the market needs) out of showing up. Both callers
 * already render a missing percentage correctly, so the honest state costs no
 * new UI: markets.html passes pctText null and market.html leaves poolNow null.
 */

/** Basis points of the pool the winners never see. Both legs of the 4%. */
export interface Takeout {
  creatorBps: number;
  protocolBps: number;
}

export type OddsView =
  /** The chain would not answer. Never draw this as an empty pool. */
  | { state: "unreadable" }
  /** Nothing staked at all. First one in sets the line. */
  | { state: "unpriced" }
  /** Everything on one side: no price, and nothing to win on that side. */
  | { state: "one-sided"; side: "yes" | "no"; totalLamports: number }
  /** Both sides funded: a real price and a real multiple. */
  | {
      state: "priced";
      yesPct: number;
      /** What one unit on that side collects if it wins, net of takeout. */
      yesPays: number;
      noPays: number;
      totalLamports: number;
    };

/** Two decimals, because a card prints "1.9x" and not "1.8999999999x". */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The two fees resolve_market fixes, in lamports, when the pool settles with
 * `winningLamports` on the winning side.
 *
 * The program's own rule (lib.rs, resolve_market and cap_fees): nothing when
 * nobody won or nobody lost; otherwise each fee is its rate of the whole pool,
 * floored on its own, and the two together never pass what the losing side
 * staked, scaled down in step when they would. That last part is what keeps a
 * winner from collecting less than they put in. BigInt, because pool x bps
 * passes 2^53 at pools this program can hold.
 */
export function fixedFees(
  poolLamports: number,
  winningLamports: number,
  takeout: Takeout,
): { creator: number; protocol: number } {
  const pool = BigInt(Math.max(0, Math.floor(poolLamports)));
  const winning = BigInt(Math.max(0, Math.floor(winningLamports)));
  if (winning === BigInt(0) || pool <= winning) return { creator: 0, protocol: 0 };
  const rate = (bps: number) => (pool * BigInt(Math.max(0, Math.floor(bps)))) / BigInt(10_000);
  let creator = rate(takeout.creatorBps), protocol = rate(takeout.protocolBps);
  const losing = pool - winning, fees = creator + protocol;
  if (fees > losing) {
    creator = (creator * losing) / fees;
    protocol = (protocol * losing) / fees;
  }
  return { creator: Number(creator), protocol: Number(protocol) };
}

/**
 * @param yesLamports  staked on yes, from the vault
 * @param noLamports   staked on no, from the vault
 * @param takeout      the market's own rates, which are frozen at creation and
 *                     differ per market: one with no creator to pay charges no
 *                     creator fee, and quoting a response-level constant against
 *                     it overstates the takeout.
 */
export function oddsFromPools(
  yesLamports: number | null | undefined,
  noLamports: number | null | undefined,
  takeout: Takeout,
): OddsView {
  if (!Number.isFinite(yesLamports as number) || !Number.isFinite(noLamports as number)) {
    return { state: "unreadable" };
  }
  const yes = Math.max(0, Math.floor(yesLamports as number));
  const no = Math.max(0, Math.floor(noLamports as number));
  const total = yes + no;
  if (total <= 0) return { state: "unpriced" };
  if (no === 0) return { state: "one-sided", side: "yes", totalLamports: total };
  if (yes === 0) return { state: "one-sided", side: "no", totalLamports: total };

  /* What one unit on a side collects if it wins, after the fees the program
     would fix for that outcome. On a thin other side the cap holds the fee to
     what that side staked, so the crowded side pays at least 1x, never less. */
  const pays = (winning: number): number => {
    const f = fixedFees(total, winning, takeout);
    return round2((total - f.creator - f.protocol) / winning);
  };
  /* NOT CLAMPED TO [1,99]. The old API line clamped, which is how a pool that
     was 100% one way published itself as 99 -- a number nobody's money made.
     Inside this branch both sides are funded, so the raw share is already
     strictly between 0 and 100 and has no need of a floor. Rounding can still
     land on 0 or 100 for a lopsided-but-real pool; that is the true reading of
     the money and the caller may show it as such. */
  return {
    state: "priced",
    yesPct: Math.round((yes / total) * 100),
    yesPays: pays(yes),
    noPays: pays(no),
    totalLamports: total,
  };
}
