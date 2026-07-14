import { Market, toPct } from "./types.js";

// Gamma is Polymarket's public read-only catalogue. No auth.
// (For sub-second-fresh prices you'd read the CLOB order book by token id;
//  Gamma's outcomePrices can lag a few seconds. Fine for the hook.)
const GAMMA = "https://gamma-api.polymarket.com";

/**
 * Two fetches, for two different jobs.
 *
 * PER-TAG, five requests. `tag_slug` is silently IGNORED on /markets — it
 * returns identical rows for `crypto` and for `zzznonsense` — and honoured only
 * on /events, which is why this reads events and unpacks their markets. A market
 * that arrives this way carries the venue's own category, and categorize()
 * trusts that over any keyword. Order is the tie-break: a market tagged both
 * `crypto` and `politics` is Crypto. Same order as CATEGORIES.
 *
 * WIDE, untagged and paginated. The matcher should be able to find a market for
 * any take, including the ones the five chips have no bucket for — WTI crude,
 * the S&P, tomorrow's high in Ankara. Those markets enter the MATCHER's universe
 * and stay out of the FEED, which shows only the five categories. See
 * MarketData in ./index.ts: `markets` is wide, `feed` is curated.
 *
 * The tag fetch is not redundant with the wide one. It is what gives a market a
 * venue-declared category, and it guarantees each chip has coverage even when a
 * whole category sits below the wide fetch's volume cutoff — which is exactly
 * what happened to crypto in World Cup season.
 */
export const TAG_SLUGS = ["crypto", "sports", "politics", "pop-culture", "tech"] as const;
export type TagSlug = (typeof TAG_SLUGS)[number];

/** Events per tag. 50 already yields ~1000 bettable markets across the five. */
const EVENTS_PER_TAG = 50;

/**
 * Gamma caps /events at 100 per request whatever `limit` says, so breadth costs
 * pages. Measured, volume-ordered: page 0 yields 709 usable markets, page 5 is
 * still adding ~430, page 11 adds ~400 — the tail does not converge, it just
 * gets quieter. Six pages is the point where the marginal page is markets nobody
 * traded much of, and every extra market is another chance for the matcher to be
 * confidently wrong about a take it should have stayed silent on.
 */
const WIDE_PAGES = 6;
const EVENTS_PER_PAGE = 100;

/** Requests run in parallel, ~16MB. A slow page must not hold the hook open. */
const TIMEOUT_MS = 15_000;

interface GammaMarket {
  conditionId: string;
  question: string;
  slug?: string;
  // These arrive as STRINGIFIED JSON arrays, e.g. '["Yes","No"]'.
  outcomes?: string;
  outcomePrices?: string; // '["0.73","0.27"]'
  volume24hr?: number;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
}
interface GammaEvent {
  slug?: string;
  markets?: GammaMarket[];
}

function parseArr(s: string | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * An event can be open while the markets inside it have already resolved —
 * a closed leg still carries a price of exactly 0 or 1. Every gate below is
 * load-bearing.
 */
function normalize(m: GammaMarket, event: GammaEvent, tag: TagSlug | null): Market | null {
  if (!m.active || m.closed || m.archived) return null;

  const outcomes = parseArr(m.outcomes);
  const prices = parseArr(m.outcomePrices);
  if (outcomes.length !== 2) return null; // binary only
  const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
  if (yesIdx < 0) return null;

  const price = parseFloat(prices[yesIdx] ?? "");
  if (Number.isNaN(price)) return null;
  const yesPct = toPct(price);
  if (!(yesPct > 0 && yesPct < 100)) return null;

  // No 24h volume means nobody has touched it today. Those markets make a card
  // that reads "$0 in play" and a match the bot should never have offered.
  const volumeUsd = Number(m.volume24hr ?? 0);
  if (!(volumeUsd > 0)) return null;

  const slug = event.slug ?? m.slug;
  return {
    venue: "polymarket",
    venueId: m.conditionId,
    question: m.question,
    yesPct,
    closesAt: m.endDate ?? null,
    volumeUsd,
    venueUrl: slug ? `https://polymarket.com/event/${slug}` : "https://polymarket.com",
    // The venue's own word for what this is. categorize() trusts it over keywords.
    // Empty for the wide fetch: those markets are categorized by their text, and
    // the ones that land in "Other" are the ones the feed leaves out.
    tags: tag ? [tag] : [],
  };
}

async function fetchEvents(url: string, tag: TagSlug | null, label: string): Promise<Market[]> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Polymarket ${label} ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const body = (await res.json()) as GammaEvent[];
  if (!Array.isArray(body)) return [];

  const out: Market[] = [];
  for (const event of body)
    for (const m of event.markets ?? []) {
      const n = normalize(m, event, tag);
      if (n) out.push(n);
    }
  return out;
}

const tagUrl = (tag: TagSlug) =>
  `${GAMMA}/events?active=true&closed=false&archived=false` +
  `&order=volume24hr&ascending=false&limit=${EVENTS_PER_TAG}&tag_slug=${tag}`;

const wideUrl = (page: number) =>
  `${GAMMA}/events?active=true&closed=false&archived=false` +
  `&order=volume24hr&ascending=false&limit=${EVENTS_PER_PAGE}&offset=${page * EVENTS_PER_PAGE}`;

/**
 * Every active binary market we can see: the five tagged categories plus a wide
 * untagged sweep, deduped by conditionId.
 *
 * The tagged rows are inserted FIRST and win the dedupe, so a market that
 * appears in both keeps its venue-declared category. Losing that would push
 * markets into the text categorizer unnecessarily, and a chip would go thin the
 * moment the keywords missed one.
 */
export async function fetchPolymarketMarkets(): Promise<Market[]> {
  const tagJobs = TAG_SLUGS.map((t) => fetchEvents(tagUrl(t), t, t));
  const wideJobs = Array.from({ length: WIDE_PAGES }, (_, p) => fetchEvents(wideUrl(p), null, `wide p${p}`));
  const settled = await Promise.allSettled([...tagJobs, ...wideJobs]);

  const byId = new Map<string, Market>();
  const counts: string[] = [];
  let tagFailures = 0;
  let wideFailures = 0;

  // Tagged first — TAG_SLUGS order decides the category of a multi-tagged market.
  settled.slice(0, TAG_SLUGS.length).forEach((r, i) => {
    const tag = TAG_SLUGS[i];
    if (r.status === "rejected") {
      tagFailures++;
      console.warn(`[polymarket] ${tag} failed:`, r.reason?.message ?? r.reason);
      return;
    }
    let fresh = 0;
    for (const m of r.value)
      if (!byId.has(m.venueId)) {
        byId.set(m.venueId, m);
        fresh++;
      }
    counts.push(`${tag} ${fresh}`);
  });

  let wideFresh = 0;
  for (const r of settled.slice(TAG_SLUGS.length)) {
    if (r.status === "rejected") {
      wideFailures++;
      continue;
    }
    for (const m of r.value)
      if (!byId.has(m.venueId)) {
        byId.set(m.venueId, m);
        wideFresh++;
      }
  }

  // Every tag down is an outage. The wide sweep failing is a narrower universe,
  // not a dead venue — the chips still have their coverage.
  if (tagFailures === TAG_SLUGS.length && wideFailures === WIDE_PAGES) throw new Error("Polymarket: every request failed");
  if (wideFailures) console.warn(`[polymarket] ${wideFailures}/${WIDE_PAGES} wide pages failed`);
  console.log(`[polymarket] ${byId.size} markets (${counts.join(", ")}, wide +${wideFresh})`);

  return [...byId.values()];
}
