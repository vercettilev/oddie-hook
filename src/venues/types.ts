// One shape for a market regardless of which venue it came from.
// Everything downstream (matcher, card, slug page) speaks this, never
// the raw Kalshi/Polymarket payloads.

export type Venue = "kalshi" | "polymarket" | "community";

export interface Market {
  venue: Venue;
  /** Stable id within the venue (Kalshi ticker, Polymarket conditionId). */
  venueId: string;
  /** The plain-language question, e.g. "Will Bitcoin close above $150k in 2026?" */
  question: string;
  /** YES probability as a percentage, 0–100, already rounded for display. */
  yesPct: number;
  /** ISO timestamp when the market closes/resolves, if known. */
  closesAt: string | null;
  /** 24h (or total) volume in USD, used as a tiebreaker + liquidity signal. */
  volumeUsd: number;
  /** Canonical link back to the market on its venue. */
  venueUrl: string;
  /** Free-text tags/category used to sharpen matching. */
  tags: string[];
}

/** Clamp + round a [0,1] or 0–100 probability into a clean display percent. */
export function toPct(raw: number): number {
  const p = raw <= 1 ? raw * 100 : raw;
  return Math.max(0, Math.min(100, Math.round(p)));
}
