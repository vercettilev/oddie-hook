import { Market } from "../venues/types.js";

// Cheap keyword categorizer so the feed can do "same category first" and
// the chips have something to filter on. Good enough for Phase 1; replace
// with venue-native categories/embeddings later.
//
// Venue tags are empty in practice, so the question text is all we have. Two
// things fall out of that:
//
// Order matters. Politics is tested before Sports because the sportsbook
// shapes below ("X vs. Y", "Spread:", "O/U") are structural, not topical —
// "Trump vs. Newsom" is the same shape as "France vs. Morocco". A political
// name settles it; nothing in a real sports market says "senate".
//
// Sports needs shapes, not just sport names. Half the live set is
// "Exact Score: France 2 - 1 Morocco?" and "Wimbledon WTA: Kostyuk vs
// Noskova" — neither contains the word football or tennis. Matching the
// wagering vocabulary catches the whole family, not one match.

export const CATEGORIES = ["Crypto", "Sports", "Politics", "Culture", "Tech", "Other"] as const;
export type Category = (typeof CATEGORIES)[number];

const RULES: [Category, RegExp][] = [
  [
    "Crypto",
    /\b(bitcoin|btc|ethereum|eth|solana|crypto|token|defi|stablecoin|xrp|doge|coinbase|halving|altcoin|memecoin|satoshi)\b/i,
  ],
  [
    "Politics",
    // Institutions and process, then statecraft, then a short list of figures
    // whose names alone decide the category.
    /\b(election|president\w*|senate|senator|congress\w*|fed|rates?|tariffs?|vote|voter|governor|parliament|prime minister|policy|nomin\w*|supreme court|scotus|impeach\w*|cabinet|referendum|coup|resign\w*)\b|\b(war|invade|invasion|blockade|embargo|sanctions?|ceasefire|treaty|nato|airspace|strait|negotiations?|summit|diplomat\w*|withdrawal|nuclear deal)\b|\b(trump|biden|harris|putin|xi jinping|netanyahu|zelensky|khamenei|alito)\b/i,
  ],
  [
    "Sports",
    // Leagues and sports…
    // Bare `game`, `goal` and `season` are deliberately absent: they belong to
    // "Squid Game season 3" and "OpenAI's revenue goal" as readily as to sport,
    // and Sports is tested before Culture and Tech. The numeric forms are safe.
    /\b(nba|nfl|mlb|nhl|ncaa|super bowl|world cup|playoffs?|finals?|championship|league|cup|f1|formula 1|ufc|mma|boxing|tennis|golf|soccer|football|basketball|baseball|hockey|cricket|rugby|olympics?)\b|\b(wimbledon|atp|wta|grand slam|roland garros|us open|french open|australian open)\b|\b(match|tournament|coach|striker|goalkeeper)\b|\b(vs|exact score|team to advance|both teams to score|to advance|clean sheet|hat.?trick)\b|(\bspread\s*:|\bo\/u\b|\bover\/under\b|\bgame\s*\d|\d\s*\+\s*goals?\b|\bcorners?\b|\b1st half\b|\bend in a draw\b|\bwin on \d{4}-\d{2}-\d{2})/i,
  ],
  [
    "Culture",
    /\b(movie|film|box office|album|song|grammy|oscar|emmy|celebrity|tv|series|netflix|hbo|spotify|billboard|streaming|concert|tour|book|bestseller|met gala|person of the year|taylor swift|kanye|drake|kardashian)\b/i,
  ],
  [
    "Tech",
    /\b(apple|iphone|google|openai|anthropic|claude|ai|agi|gpt|llm|tesla|spacex|starship|rocket|satellite|meta|microsoft|nvidia|semiconductor|chip|quantum|startup|ipo|musk)\b/i,
  ],
];

/** Same rules, applied to raw text — lets the hook categorize a tweet, not just a market. */
export function categorizeText(text: string): Category {
  for (const [cat, re] of RULES) if (re.test(text)) return cat;
  return "Other";
}

/**
 * Polymarket now tells us. We fetch one request per tag, so a market arrives
 * already stamped with the bucket it came out of — no keyword has to guess that
 * "Exact Score: France 1 - 2 Morocco?" is sport.
 */
const TAG_TO_CATEGORY: Record<string, Category> = {
  crypto: "Crypto",
  sports: "Sports",
  politics: "Politics",
  "pop-culture": "Culture",
  tech: "Tech",
};

/**
 * The venue's own tag wins. The keyword rules above stay for everything with no
 * tag to trust: a tweet arriving at /hook, and any venue that hands us bare
 * questions. Note what this means for the numbers — "Other" is now near-zero by
 * construction on Polymarket, not because the keywords got better.
 */
export function categorize(m: Market): Category {
  for (const t of m.tags) {
    const c = TAG_TO_CATEGORY[t];
    if (c) return c;
  }
  return categorizeText(m.question + " " + m.tags.join(" "));
}
