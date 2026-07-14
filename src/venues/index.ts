import { Market, Venue } from "./types.js";
import { categorize } from "../matching/categorize.js";
import { fetchKalshiMarkets, KALSHI_ENABLED } from "./kalshi.js";
import { fetchPolymarketMarkets } from "./polymarket.js";

export * from "./types.js";

/**
 * Which venues we are choosing to run. A disabled venue contributes no markets
 * and is not expected to — that is different from a venue that is down, and the
 * tests must be able to tell the two apart.
 */
export const VENUE_ENABLED: Record<Venue, boolean> = {
  kalshi: KALSHI_ENABLED, // read-only odds source; see NOTES/kalshi.md
  polymarket: true,
};

export interface VenueStatus {
  /** False only when the venue was asked and failed. A disabled venue is not "not ok". */
  ok: boolean;
  count: number;
  enabled: boolean;
  error?: string;
}

/**
 * A market priced at 1% or 99% is not a take, it is a formality — there is
 * nothing to argue about and nothing worth ten tokens. Both ends are cut, so
 * the bar reads as a real split whichever side you land on.
 */
export const MIN_YES_PCT = 4;
export const MAX_YES_PCT = 96;

export const isBettable = (m: Market): boolean => m.yesPct >= MIN_YES_PCT && m.yesPct <= MAX_YES_PCT;

/**
 * The feed shows five chips and nothing else.
 *
 * The matcher's universe is deliberately wider than the feed's: it should find a
 * market for a take about WTI crude or the S&P, because a card about the thing
 * someone actually tweeted is the whole product. But those families have no chip,
 * and dropping them into the feed would turn a third of it into "Other" — a
 * bucket that means "we had nowhere to put this".
 *
 * So membership is decided by category, not by which request a market arrived
 * on. Anything the categorizer can name belongs to a chip and may be scrolled;
 * anything it cannot stays in the matcher's universe until it earns a chip of
 * its own. Adding a chip is therefore the single act that makes a family visible.
 */
export const inFeed = (m: Market): boolean => categorize(m) !== "Other";

export interface MarketData {
  /**
   * The MATCHER's universe: everything bettable, including families the feed has
   * no chip for. Wider than `feed` on purpose.
   */
  markets: Market[];
  /** The FEED's universe: bettable AND belonging to one of the five chips. */
  feed: Market[];
  /**
   * Everything the venues returned, lopsided ones included. Slug resolution
   * reads this: a market that drifts to 2% must still resolve the link someone
   * already tweeted, and still refresh that card's odds. It is simply never
   * offered as a new match.
   */
  all: Market[];
  venues: Record<Venue, VenueStatus>;
  /** True when both venues came back empty and we fell back to the last good set. */
  stale: boolean;
  /** Age of the data being served, in ms. 0 for a fresh fetch. */
  ageMs: number;
}

let cache: { at: number; markets: Market[]; venues: Record<Venue, VenueStatus> } | null = null;

const TTL_MS = 60_000; // markets don't move fast enough to refetch per request

/**
 * How old the last good set may be before we call it unusable. Odds a few
 * minutes stale still make an honest card; hour-old odds do not.
 */
const MAX_STALE_MS = 10 * 60_000;

function statusOf(r: PromiseSettledResult<Market[]>, venue: Venue): VenueStatus {
  const enabled = VENUE_ENABLED[venue];
  if (r.status === "fulfilled") return { ok: true, count: r.value.length, enabled };
  return { ok: false, count: 0, enabled, error: r.reason?.message ?? String(r.reason) };
}

/**
 * Pull both venues in parallel and merge. If one venue errors we still return
 * the other — a hook that half-works beats one that 500s.
 *
 * An empty result is NEVER cached. Writing `[]` with a fresh timestamp would
 * pin "no markets" for a full TTL, and every tweet arriving in that window
 * would come back as a confident "no market fits" when the truth is that we
 * never looked. Instead we serve the last good set (marked stale) and leave
 * the old timestamp alone, so the next call retries the venues immediately.
 */
export async function getMarketData(force = false): Promise<MarketData> {
  const now = Date.now();

  if (!force && cache && now - cache.at < TTL_MS) {
    const markets = cache.markets.filter(isBettable);
    return { markets, feed: markets.filter(inFeed), all: cache.markets, venues: cache.venues, stale: false, ageMs: now - cache.at };
  }

  const [k, p] = await Promise.allSettled([fetchKalshiMarkets(), fetchPolymarketMarkets()]);
  const venues: Record<Venue, VenueStatus> = { kalshi: statusOf(k, "kalshi"), polymarket: statusOf(p, "polymarket") };

  for (const [name, st] of Object.entries(venues)) {
    if (st.enabled && !st.ok) console.warn(`[venues] ${name} failed:`, st.error);
  }

  const all: Market[] = [];
  if (k.status === "fulfilled") all.push(...k.value);
  if (p.status === "fulfilled") all.push(...p.value);

  if (all.length > 0) {
    // Cache the raw set. The bettable filter is a view over it, not a fact about
    // the fetch — a market that crosses 4% between requests must not need a refetch.
    cache = { at: Date.now(), markets: all, venues };
    const markets = all.filter(isBettable);
    const feed = markets.filter(inFeed);
    console.log(
      `[venues] ${all.length} fetched, ${markets.length} bettable (${MIN_YES_PCT}–${MAX_YES_PCT}% yes) ` +
        `= matcher universe; ${feed.length} in a feed chip`,
    );
    return { markets, feed, all, venues, stale: false, ageMs: 0 };
  }

  // Nothing usable came back. Do not touch the cache.
  const ageMs = cache ? Date.now() - cache.at : Infinity;
  if (cache && ageMs <= MAX_STALE_MS) {
    console.warn(
      `[venues] no markets from either venue; serving last good set ` +
        `(${cache.markets.length} markets, ${Math.round(ageMs / 1000)}s old)`,
    );
    const markets = cache.markets.filter(isBettable);
    return { markets, feed: markets.filter(inFeed), all: cache.markets, venues, stale: true, ageMs };
  }

  console.warn("[venues] no markets from either venue and no usable cache — reporting no data");
  return { markets: [], feed: [], all: [], venues, stale: false, ageMs };
}
