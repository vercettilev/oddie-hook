// Did this market resolve, and which way?
//
// Asked per market, on demand, only for markets someone still holds — never as
// part of the bulk fetch. The bulk fetch deliberately filters resolved markets
// out (a settled market is not a card), so resolution has to be its own read.
//
// The answer is tri-state and the null matters: "yes"/"no" settles positions,
// null means DO NOTHING. A venue outage, an unlisted market, a market that
// closed for trading but has not resolved — all must come back null, because
// settling on anything less than the venue's explicit final outcome would pay
// people out of thin air (or confiscate a win).

import type { Venue } from "./types.js";

export type Outcome = "yes" | "no";

const TIMEOUT = 10_000;

/** Polymarket Gamma: the market's own record carries closed + final prices.
 *  `closed=true` is load-bearing: Gamma HIDES closed markets by default, so
 *  without it a resolved market comes back as zero rows — indistinguishable
 *  from "unknown", which reads as "not resolved yet", forever. Asking only for
 *  closed rows inverts that: a market still trading returns zero rows and we
 *  correctly wait. (Measured live: `condition_ids=X` alone → 0 rows for a
 *  market whose prices had already collapsed to ["1","0"].) */
async function polymarketOutcome(conditionId: string): Promise<Outcome | null> {
  const url = `https://gamma-api.polymarket.com/markets?condition_ids=${encodeURIComponent(conditionId)}&closed=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) return null;
  const list = (await res.json().catch(() => [])) as {
    conditionId?: string; closed?: boolean; outcomes?: string; outcomePrices?: string;
  }[];
  const m = Array.isArray(list) ? list.find((x) => x.conditionId === conditionId) : undefined;
  if (!m || !m.closed) return null;

  // A closed market's prices collapse to exactly 0 and 1. Anything else — a
  // half-resolved scalar market, a lagging feed — is not a settlement signal.
  let outcomes: string[], prices: number[];
  try {
    outcomes = JSON.parse(m.outcomes ?? "[]");
    prices = (JSON.parse(m.outcomePrices ?? "[]") as string[]).map(Number);
  } catch {
    return null;
  }
  const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
  if (yesIdx === -1 || prices.length !== outcomes.length) return null;
  const yesPrice = prices[yesIdx];
  if (yesPrice === 1) return "yes";
  if (yesPrice === 0) return "no";
  return null;
}

/** Kalshi: /markets/{ticker} reports status and, once settled, the result. */
async function kalshiOutcome(ticker: string): Promise<Outcome | null> {
  const url = `https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(ticker)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as {
    market?: { status?: string; result?: string };
  };
  const m = body.market;
  // Kalshi's lifecycle: active -> closed (trading over, outcome pending) ->
  // settled/finalized. Both terminal states carry a result; live data showed
  // "finalized" (the docs' word is "settled"), so accept either — but only
  // ever a terminal state. "closed" has no outcome yet and must stay null.
  if (!m || (m.status !== "settled" && m.status !== "finalized")) return null;
  if (m.result === "yes") return "yes";
  if (m.result === "no") return "no";
  return null;
}

/**
 * The venue's final word on a market, or null when it has none yet.
 * Network errors are null too: settlement can always wait for the next sweep;
 * a settlement on bad data cannot be waited back.
 */
export async function fetchResolution(venue: Venue, venueId: string): Promise<Outcome | null> {
  try {
    return venue === "polymarket" ? await polymarketOutcome(venueId) : await kalshiOutcome(venueId);
  } catch {
    return null;
  }
}
