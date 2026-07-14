import { Market, toPct } from "./types.js";

// Public market-data host. No API key needed for reads.
// (Despite the historical "elections" alias, this serves ALL Kalshi markets.)
const BASE = "https://external-api.kalshi.com/trade-api/v2";

interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title?: string;
  /** The outcome this contract is about, when the title alone is a shared question. */
  yes_sub_title?: string;
  last_price_dollars?: string; // "0.5600"
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  close_time?: string;
  /** Contracts traded in the last 24h. NOT dollars — see volumeUsd24h below. */
  volume_24h_fp?: string;
  /** Contracts traded over the market's whole life. */
  volume_fp?: string;
  category?: string;
  /** Present only on multivariate-event (combo/parlay) markets. */
  mve_collection_ticker?: string;
  mve_selected_legs?: unknown[];
}

/**
 * Kalshi is a read-only ODDS SOURCE. Nobody signs in, nobody deposits, nothing
 * executes. Oddie never names it on a card — the card carries Oddie's brand
 * and the market's own numbers. It is here because Kalshi prices the economics
 * and US-politics questions Polymarket mostly does not.
 */
export const KALSHI_ENABLED = process.env.ENABLE_KALSHI === "1";

/**
 * Kalshi auto-generates vast numbers of multivariate-event markets: parlays
 * whose `title` is a comma-joined list of legs, e.g.
 *
 *   "yes 8+ corners,yes Lionel Messi: 1+,yes Erling Haaland: 1+,yes Argentina: 5"
 *
 * That string is not a question. It cannot be rendered on a card, and it matches
 * tweets on a single leg name ("messi is scoring tonight" hits one at 0.250), so
 * it would ship a public card with comma soup where the question should be.
 *
 * They are dropped, never repaired. Reconstructing a question from legs is
 * guesswork; the exclusion below reads structured fields Kalshi already sets,
 * so it is decidable per market. The title checks are a backstop for records
 * where the MVE fields are absent: a leg list starts with a side ("yes …"/"no …")
 * and chains legs with commas. Real titles clear both — "Bitcoin price on
 * Jul 9, 2026?" has one comma and does not start with a side.
 *
 * Kept even though the per-series queries below have never returned one. It
 * costs nothing, and a parlay leaking through is a public wrong card.
 */
function isMultiLeg(m: KalshiMarket): boolean {
  if (m.mve_collection_ticker) return true;
  if (Array.isArray(m.mve_selected_legs) && m.mve_selected_legs.length > 0) return true;
  if (m.event_ticker?.startsWith("KXMVE")) return true;

  const title = m.title ?? "";
  if (/^\s*(yes|no)\s/i.test(title)) return true; // leg list, not a question
  if ((title.match(/,/g)?.length ?? 0) >= 2) return true; // chained legs
  return false;
}

/**
 * Hand-picked series, not a broad crawl.
 *
 * `/events?status=open&limit=200&with_nested_markets=true` paginates cleanly and
 * carries zero parlays — but eight pages yield 10,514 markets, 4,278 of them
 * bettable, against Polymarket's ~950. One series alone (KXMIDTERMMOV, "margin
 * of victory for Republicans in <district>") is 1,429 near-identical markets.
 * Ingesting that would bury the feed and hand the matcher a thousand fresh ways
 * to be confidently wrong.
 *
 * So: the questions Polymarket does not price. Every ticker below was verified
 * to return open, priced markets. Series tickers are not derivable — get new
 * ones from /events or /series, never by guessing.
 */
export const KALSHI_SERIES = [
  // economics — the gap Polymarket leaves
  "KXFEDDECISION",
  "KXCPI",
  "KXU3",
  "KXGDP",
  "KXRECSSNBER",
  // crypto, priced by strike rather than by narrative
  "KXBTCD",
  // US politics
  "KXPRESPERSON",
  "KXPRESNOMD",
  "KXPRESNOMR",
  "KXPRESPARTY",
  "KXHOUSEPOPVOTEMARGIN",
  "KXTRUMPREMOVE",
  "KXGREENLAND",
  "KXINSURRECTION",
] as const;

const TIMEOUT_MS = 15_000;

/**
 * Dollars, not contracts — and 24-hour, not lifetime.
 *
 * Kalshi reports `volume_fp` as CONTRACTS traded over a market's whole life;
 * Polymarket reports `volume24hr` as DOLLARS traded in a day. Putting the raw
 * Kalshi number in the same field would have been a silent unit error with two
 * visible consequences: a card reading "$38.3M in play" for a market that traded
 * 38.3M contracts, and "For you" — which ranks on volume alone — turning
 * all-Kalshi, because a lifetime count beats a daily one.
 *
 * A contract settles at $1, so contracts × price is the dollars that changed
 * hands, to within the spread. Measured across the series above: $900k of 24h
 * notional, busiest market $224k. Polymarket's busiest is $5.9M. Same units,
 * same order of magnitude, comparable rankings.
 */
function volumeUsd24h(m: KalshiMarket, prob: number): number {
  const contracts = parseFloat(m.volume_24h_fp ?? "0") || 0;
  return contracts * prob;
}

function dollarsToProb(m: KalshiMarket): number {
  // Prefer last traded price; fall back to bid/ask midpoint.
  const last = parseFloat(m.last_price_dollars ?? "");
  if (!Number.isNaN(last) && last > 0) return last;
  const bid = parseFloat(m.yes_bid_dollars ?? "");
  const ask = parseFloat(m.yes_ask_dollars ?? "");
  if (!Number.isNaN(bid) && !Number.isNaN(ask)) return (bid + ask) / 2;
  return Number.isNaN(bid) ? 0 : bid;
}

function normalize(m: KalshiMarket, question: string): Market | null {
  const prob = dollarsToProb(m);
  const yesPct = toPct(prob);
  if (!(yesPct > 0 && yesPct < 100)) return null; // settled or unpriced
  const volumeUsd = volumeUsd24h(m, prob);
  if (!(volumeUsd > 0)) return null; // nothing traded today — a "$0 in play" card

  return {
    venue: "kalshi",
    venueId: m.ticker,
    question,
    yesPct,
    closesAt: m.close_time ?? null,
    volumeUsd,
    venueUrl: `https://kalshi.com/markets/${m.event_ticker}`,
    tags: [m.category].filter(Boolean) as string[],
  };
}

/**
 * Kalshi reuses ONE title across every outcome of a multi-outcome event: thirty
 * markets all called "Who will win the next presidential election?", told apart
 * only by `yes_sub_title` ("Ro Khanna", "Rahm Emanuel", …). Ingested as-is they
 * are literal twins — the matcher cannot tell them apart and the volume
 * tie-break picks one at random. Measured: 107 colliding titles across 698 of
 * 4,278 bettable markets.
 *
 * The subtitle is folded in, but ONLY where the title actually collides. "Will
 * CPI rise more than -0.3% in July 2026?" already carries its own number and
 * would read worse as "…? — Above -0.3%".
 */
function disambiguate(raw: KalshiMarket[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const m of raw) counts.set(m.title ?? "", (counts.get(m.title ?? "") ?? 0) + 1);

  const out = new Map<string, string>();
  for (const m of raw) {
    const title = m.title ?? m.yes_sub_title ?? m.ticker;
    const sub = m.yes_sub_title?.trim();
    const collides = (counts.get(m.title ?? "") ?? 0) > 1;
    const needsSub = collides && sub && !title.toLowerCase().includes(sub.toLowerCase());
    out.set(m.ticker, needsSub ? `${title} — ${sub}` : title);
  }
  return out;
}

/**
 * Sequential, with a pause between requests.
 *
 * Kalshi rate-limits hard: firing all fourteen series in parallel returns 429 on
 * six of them on the first call and thirteen of fourteen on the next, so the
 * venue would have quietly contributed two markets instead of 167 — a silent
 * coverage collapse that no error surfaces, because `Promise.allSettled` treats
 * a rejected series as "one hole in one topic". Serially with a 120ms gap, all
 * fourteen return 200. It costs 4.7s, spent once per 60s cache window.
 */
const GAP_MS = 120;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchSeries(series: string): Promise<KalshiMarket[]> {
  const url = `${BASE}/markets?status=open&series_ticker=${series}&limit=200`;
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Kalshi ${series} ${res.status}`);
  const body = (await res.json()) as { markets?: KalshiMarket[] };
  return body.markets ?? [];
}

let announcedDisabled = false;

/**
 * One request per series. A single series failing is not an outage: the others
 * still answer, and the venue only "fails" when every one of them does.
 */
export async function fetchKalshiMarkets(): Promise<Market[]> {
  if (!KALSHI_ENABLED) {
    if (!announcedDisabled) {
      console.log("[kalshi] disabled (set ENABLE_KALSHI=1; see NOTES/kalshi.md)");
      announcedDisabled = true;
    }
    return [];
  }

  const raw: KalshiMarket[] = [];
  const failed: string[] = [];
  for (const series of KALSHI_SERIES) {
    try {
      raw.push(...(await fetchSeries(series)));
    } catch (e) {
      failed.push(series);
    }
    await sleep(GAP_MS);
  }
  if (failed.length === KALSHI_SERIES.length) throw new Error("Kalshi: every series failed");
  if (failed.length) console.warn(`[kalshi] ${failed.length}/${KALSHI_SERIES.length} series failed: ${failed.join(", ")}`);

  const singles = raw.filter((m) => !isMultiLeg(m));
  if (singles.length !== raw.length) {
    console.warn(`[kalshi] dropped ${raw.length - singles.length}/${raw.length} multi-leg (parlay) markets`);
  }

  const questions = disambiguate(singles);
  const markets = singles
    .map((m) => normalize(m, questions.get(m.ticker)!))
    .filter((m): m is Market => m !== null);

  console.log(`[kalshi] ${markets.length} markets from ${KALSHI_SERIES.length - failed.length}/${KALSHI_SERIES.length} series`);
  return markets;
}
