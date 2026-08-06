// The feed's discovery modes — For You / Trending / New / Resolving Soon.
//
// One pure function, deliberately outside server.ts so it can be unit-tested
// without booting Express. It takes the ALREADY-ASSEMBLED feed items (the
// records /api/feed sends the client, community and venue mixed) and orders
// them for one mode. It never filters: a mode is a lens over the same set,
// and a market must not vanish because the viewer switched tabs.
//
// The honesty constraint that shaped every mode: community and venue markets
// do not share comparable numbers. Community markets have callsToday and a
// play-token pool but volumeUsd is always 0; venue markets have real dollar
// volume but no per-day call count and no creation time we know. So no mode
// pretends to a single cross-type key — each mode states its rule per type
// and keeps the types in blocks where their keys can't be compared.

export type FeedSort = "foryou" | "trending" | "new" | "resolving";

export const FEED_SORTS: readonly FeedSort[] = ["foryou", "trending", "new", "resolving"] as const;

export const isFeedSort = (v: unknown): v is FeedSort =>
  typeof v === "string" && (FEED_SORTS as readonly string[]).includes(v);

/** The fields the sort reads. Everything is optional — a missing number sorts
 *  as 0/none rather than throwing, because feed items are loose records. */
interface SortableItem {
  community?: unknown;
  callsToday?: unknown;
  poolTokens?: unknown;
  marketId?: unknown;
  volumeUsd?: unknown;
  closesAt?: unknown;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const closesMs = (v: unknown): number | null => {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/**
 * Order `items` for `sort`. Returns a NEW array; never mutates the input.
 *
 *  - foryou:    untouched — the caller's existing source-aware order IS the
 *               For You ranking, and re-sorting here would fight it.
 *  - trending:  activity first. Community markets rank by callsToday (their
 *               real 24h signal), then pool size; venue markets rank by their
 *               dollar volume. Active community markets lead — a market three
 *               people traded TODAY is livelier than one with lifetime volume
 *               — then venue by volume, then quiet community markets.
 *  - new:       newly tagged first. Community marketId is a creation
 *               timestamp, so it IS recency; venue markets have no creation
 *               time we know, so they follow in their existing order rather
 *               than pretending to one.
 *  - resolving: the one mode with a genuinely comparable cross-type key —
 *               both types carry closesAt. Soonest first, no-deadline last.
 */
// Constrained to `object`, not SortableItem: the feed's records are typed as
// Record<string, unknown>, and TS refuses to unify an index signature with
// named optional props at the constraint — inference then falls back to the
// constraint itself and the return type stops matching the caller. Reading
// through a cast keeps the call sites typed as what they actually hold.
export function sortFeedItems<T extends object>(items: T[], sort: FeedSort): T[] {
  const f = (i: T): SortableItem => i as SortableItem;
  const out = [...items];
  if (sort === "foryou") return out;

  if (sort === "trending") {
    const active = out.filter((i) => Boolean(f(i).community) && num(f(i).callsToday) > 0)
      .sort((a, b) => num(f(b).callsToday) - num(f(a).callsToday) || num(f(b).poolTokens) - num(f(a).poolTokens));
    const venue = out.filter((i) => !f(i).community)
      .sort((a, b) => num(f(b).volumeUsd) - num(f(a).volumeUsd));
    const quiet = out.filter((i) => Boolean(f(i).community) && num(f(i).callsToday) === 0);
    return [...active, ...venue, ...quiet];
  }

  if (sort === "new") {
    const community = out.filter((i) => Boolean(f(i).community))
      .sort((a, b) => num(f(b).marketId) - num(f(a).marketId));
    const venue = out.filter((i) => !f(i).community); // existing order kept — no honest recency key
    return [...community, ...venue];
  }

  // resolving
  return out.sort((a, b) => {
    const ta = closesMs(f(a).closesAt), tb = closesMs(f(b).closesAt);
    if (ta === null && tb === null) return 0;
    if (ta === null) return 1;   // no deadline sorts last
    if (tb === null) return -1;
    return ta - tb;
  });
}
