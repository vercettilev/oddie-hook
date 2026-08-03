// REGIME 2 · Polymarket markets, sourced through Jupiter's Prediction API.
//
// Separate from venues/polymarket.ts on purpose. That module reads Polymarket's
// own Gamma API for FREE-PLAY feed variety and carries no money. This one is
// the real-money path: markets that a user can put actual SOL behind, which
// means it inherits Jupiter's terms, Jupiter's jurisdiction list, and a much
// higher bar for what we're allowed to surface and to whom.
//
// KALSHI IS EXCLUDED, and deliberately twice over. `provider=polymarket` on the
// request is the polite way to ask; the filter on `m.provider === "polymarket"`
// in mapEvent is the one that actually guarantees it. A query parameter is a
// request, not a promise — if Jupiter ever changes its default, widens a
// response, or ships a bug, the request-side filter fails silently and open
// while the response-side filter fails closed. Verified live 2026-08-03:
// ?provider=kalshi returns 100% provider:"kalshi", so the field genuinely
// discriminates and this check has teeth. Do not remove it as redundant.
import { Market, toPct } from "./types.js";

const BASE = "https://api.jup.ag/prediction/v1";
const TIMEOUT_MS = 8000;

/**
 * Off by default, and gated SEPARATELY from ONCHAIN_ENABLED so the two can
 * never be conflated: this one controls whether we source venue markets at
 * all, the master flag controls whether any real money moves. Turning this on
 * alone gets you Polymarket markets for display; it does not open a wallet.
 */
export const JUPITER_PREDICT_ENABLED = process.env.ENABLE_JUPITER_PREDICT === "1";

/** Jupiter quotes prices in micro-USD (810000 === $0.81), and a binary
 *  contract's USD price IS its implied probability. */
const MICRO_USD = 1_000_000;

interface JupPricing { buyYesPriceUsd?: number; sellYesPriceUsd?: number; volume?: number }
interface JupMarket {
  provider?: string; marketId?: string; status?: string; title?: string;
  closeTime?: number; pricing?: JupPricing;
}
interface JupEvent {
  eventId?: string; category?: string; tags?: string[]; volumeUsd?: string | number;
  metadata?: { title?: string; slug?: string; closeTime?: string };
  markets?: JupMarket[];
}

/** One event → the tradeable Polymarket markets inside it, in our shape. */
function mapEvent(e: JupEvent): Market[] {
  const out: Market[] = [];
  const eventTitle = e.metadata?.title ?? "";
  for (const m of e.markets ?? []) {
    // THE Kalshi guard. See the file header — this is the load-bearing one.
    if (m.provider !== "polymarket") continue;
    if (m.status !== "open") continue;
    if (!m.marketId) continue;

    // Price is only meaningful when the book actually quotes one; a 0 here is
    // "no quote", not "0% likely", and letting it through would render a
    // confident 0% on a market nobody has priced.
    const raw = m.pricing?.buyYesPriceUsd ?? m.pricing?.sellYesPriceUsd ?? 0;
    if (!(raw > 0)) continue;
    // Clamped to 1..99 rather than left as toPct's raw rounding. A real quote
    // of $0.004 is a genuine longshot, but it ROUNDS to 0 — and a 0 here is
    // not cosmetic: the card renders "YES 0%" (reads as impossible, when the
    // book says otherwise) and computes its payout multiplier as 100/pct,
    // which at 0 is Infinity. Same clamp the parimutuel pricing uses, for the
    // same reason. The 4..96 bettability window is applied downstream by
    // isBettable, exactly as it is for the other venues — this clamp is about
    // never emitting an impossible number, not about what's tradeable.
    const yesPct = Math.max(1, Math.min(99, toPct(raw / MICRO_USD)));

    const question = eventTitle && m.title && m.title !== eventTitle
      ? `${eventTitle} — ${m.title}`
      : (eventTitle || m.title || "");
    if (!question) continue;

    out.push({
      venue: "polymarket",
      venueId: m.marketId,
      question,
      yesPct,
      closesAt: m.closeTime ? new Date(m.closeTime * 1000).toISOString() : null,
      volumeUsd: Number(m.pricing?.volume ?? 0) || 0,
      venueUrl: e.metadata?.slug ? `https://polymarket.com/event/${e.metadata.slug}` : "https://polymarket.com",
      tags: Array.isArray(e.tags) ? e.tags.slice(0, 6) : [],
    });
  }
  return out;
}

/**
 * Live Polymarket markets via Jupiter. Returns [] on any failure — a venue
 * being unreachable degrades the feed, it never breaks a request, which is the
 * same contract venues/polymarket.ts and venues/kalshi.ts already honour.
 */
export async function fetchJupiterPolymarketMarkets(limit = 60): Promise<Market[]> {
  if (!JUPITER_PREDICT_ENABLED) return [];
  const url = `${BASE}/events?provider=polymarket&limit=${Math.max(1, Math.min(100, limit))}`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`jupiter ${res.status}`);
    const body = (await res.json()) as { data?: JupEvent[] };
    return (body.data ?? []).flatMap(mapEvent);
  } catch (e) {
    console.error("[jupiter-predict] fetch failed:", (e as Error).message);
    return [];
  }
}

/**
 * Build (never sign) a Jupiter order. Non-custodial by the same contract the
 * rest of the real-money layer uses: `ownerPubkey` is the USER's wallet,
 * Jupiter returns an unsigned transaction, and the user's own wallet signs and
 * broadcasts it client-side. No key of ours touches this, and we never hold
 * the funds. Returns null on any failure rather than throwing into a route.
 */
export async function prepareVenueOrderTx(args: {
  marketId: string; ownerPubkey: string; isYes: boolean; isBuy: boolean;
  depositAmount: number; depositMint: string;
}): Promise<{ txBase64: string } | null> {
  if (!JUPITER_PREDICT_ENABLED) return null;
  try {
    const res = await fetch(`${BASE}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        ownerPubkey: args.ownerPubkey, marketId: args.marketId,
        isYes: args.isYes, isBuy: args.isBuy,
        depositAmount: args.depositAmount, depositMint: args.depositMint,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`jupiter orders ${res.status}`);
    const body = (await res.json()) as { transaction?: string };
    return body.transaction ? { txBase64: body.transaction } : null;
  } catch (e) {
    console.error("[jupiter-predict] order prepare failed:", (e as Error).message);
    return null;
  }
}
