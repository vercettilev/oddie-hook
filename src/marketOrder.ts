/**
 * THE ORDER OF THE PUBLIC MARKET LIST (/api/v1/markets, the app's front page).
 *
 * Money first. Pool is the signal a trader is actually looking for: a market
 * with money in it is a market somebody disagreed about. Stakers comes next and
 * quietly handles the unreadable case, where the pool reads as 0 but our own
 * record knows wallets went in: an RPC we could not reach must not demote a
 * funded market below an empty one.
 *
 * THEN, AMONG MARKETS NOBODY HAS PUT MONEY IN YET, THE SOONEST CLOSE FIRST.
 * This was the latest close first, so a market closing in four hours sat at the
 * bottom of the page under ones with eighty days left, which is the one market
 * that could not wait (bee_empire, 12 Oct: "first should be shortest time till
 * that market resolves, last the longest"). A market past its close but not yet
 * settled can take nothing more, so it goes after every open one, the most
 * recently closed first. A market with no close time sorts as the furthest.
 * Views break a tie only after all of that, between markets closing at the
 * same moment.
 */
export interface Orderable {
  slug: string;
  closesAt: string | null;
  stakers: number;
  pool: { totalSol: number } | null;
}

const cmp = (x: number, y: number) => (x < y ? -1 : x > y ? 1 : 0);

export function byMarketOrder(views: Record<string, number>, now: number = Date.now()) {
  const close = (m: Orderable) => (m.closesAt ? Date.parse(m.closesAt) : Infinity);
  const over = (m: Orderable) => close(m) <= now;
  return (a: Orderable, b: Orderable): number =>
    cmp(b.pool?.totalSol ?? 0, a.pool?.totalSol ?? 0)
    || cmp(b.stakers ?? 0, a.stakers ?? 0)
    || cmp(Number(over(a)), Number(over(b)))
    || (over(a) ? cmp(close(b), close(a)) : cmp(close(a), close(b)))
    || cmp(views[b.slug] ?? 0, views[a.slug] ?? 0);
}
