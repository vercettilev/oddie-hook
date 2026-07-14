import { Market } from "../venues/types.js";

// Phase-1 matcher: lexical overlap scoring, PLUS three hard filters that catch
// the failure class pure lexical scoring can't: a threshold/asset mismatch
// ("$150k" vs "$60k"), a horizon mismatch ("this year" vs "closes today"), and
// an event-direction mismatch ("cutting" vs "no change").
// None of those show up as low word-overlap — "bitcoin", "above", "price"
// all still match — so they have to be checked as structured fields, not
// folded into the similarity score. This is still a heuristic patch, not
// full date/quantity NLP: it catches the common phrasings below and excludes
// on conflict rather than trying to score them.
//
// Stance is deliberately NOT filtered — the tweet is a take, the market is
// where either side can bet, so a market at 73% next to a "no way" tweet is
// the whole point, not a bug. That holds only when both sides describe the
// SAME event. When they describe different events, the market's yesPct is
// not an answer to the tweet's claim at all. See parseDirection below.

const STOPWORDS = new Set(
  ("a an and are as at be but by for from has have he her his i if in is it its of on or " +
    "that the their they this to was were will with you your what when who whom how do does " +
    "did not no yes vs than then so we they them our us about over under into out up down")
    .split(" "),
);

/**
 * "70k" and "$70,000" are the same number, and the tokenizer has to say so
 * before the punctuation strip does. It used to run the other way round: `$`
 * and `,` became spaces, so "$70,000" split into "70" (dropped, two chars) and
 * "000" — a token every `$X,000` market shares. Three Bitcoin markets at three
 * different strikes all scored identically against a "$70,000" tweet, and the
 * winner was decided by volume. It looked correct on live data only because the
 * right strike happened to be the busiest one that day.
 *
 * Only numbers that are unambiguously scaled get rewritten — a suffix, or the
 * thousands commas. Bare digits are left exactly as they were, so "2026",
 * "25 bps" and "O/U 9.5" tokenize the way they always did.
 */
const SCALE: Record<string, number> = {
  k: 1_000, thousand: 1_000,
  m: 1_000_000, million: 1_000_000,
  b: 1_000_000_000, billion: 1_000_000_000,
};
const SCALED_NUMBER = /\$?\b(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(k|m|b|\s?(?:thousand|million|billion))?\b/gi;

function canonicalizeNumbers(text: string): string {
  return text.replace(SCALED_NUMBER, (whole, digits: string, rawSuffix?: string) => {
    const suffix = (rawSuffix ?? "").trim().toLowerCase();
    if (!suffix && !digits.includes(",")) return whole; // bare number, leave it alone
    const n = parseFloat(digits.replace(/,/g, ""));
    if (!Number.isFinite(n)) return whole;
    const value = n * (SCALE[suffix] ?? 1);
    return Number.isInteger(value) ? ` ${value} ` : whole;
  });
}

/** Exported for tests and offline measurement only — nothing in the app calls it. */
export function tokenize(text: string): string[] {
  return canonicalizeNumbers(
    text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[@#]\w+/g, " "),
  )
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * A two-word tweet would otherwise score 0.500 on a single shared word. The
 * floor stops the denominator from collapsing; it does not stop one word from
 * clearing the bar on its own — see SHORT_TWEET_MAX.
 */
const OVERLAP_FLOOR = 3;

/**
 * At or below this many meaningful words, one shared word is not evidence.
 * "bitcoin is dead" hits "bitcoin" and scores 0.333 against every Bitcoin
 * market on the board; "sports are rigged" hits "sports" and lands on a SCOTUS
 * case. Eleven of eighteen generic off-topic takes published a card this way.
 *
 * Above it, the tweet is long enough that a single hit is already a low score:
 * the weakest true match we have, "no way the fed cuts, they're hiking again",
 * is five words and one hit — 0.200, just over the bar. That is why the rule is
 * scoped by length rather than applied to every tweet. Raising the denominator
 * floor instead does not work: at 5 the junk survives (1/5 = 0.200), and at 6
 * the Fed match dies with it (1/6 = 0.167).
 *
 * A short take can still rest on one word if the STRUCTURE agrees — see
 * corroborates(). Direction or threshold agreement is the second anchor.
 *
 * Only the lower side of this bound is pinned by evidence. "nobody watches
 * sports anymore" is four words and lands on a SCOTUS case, so 3 is too low.
 * The upper side is open: 5 and 6 kill exactly the same eleven junk takes and
 * keep exactly the same nine real ones, because corroborates() rescues the
 * direction-carrying Fed takes at any bound. Raising it would be defensible and
 * no test would notice. 4 is kept because it is the least invasive of the
 * options the evidence permits, not because the evidence chose it.
 */
const SHORT_TWEET_MAX = 4;
const isShort = (tokenCount: number): boolean => tokenCount <= SHORT_TWEET_MAX;

/**
 * Lexical overlap ONLY — the fraction of the tweet's meaningful words the
 * market question covers. No liquidity term: this number decides whether a
 * market is a safe match at all, and how much money sits on a market says
 * nothing about whether it is about the same thing as the tweet. Liquidity
 * enters later, as a tie-break among markets that already cleared the bar.
 */
function scoreMarket(tweetTokens: Set<string>, m: Market): number {
  // The question only. `m.tags` now carries the venue's own category slug, and
  // folding it in made "crypto is going to zero" share a word with every crypto
  // market on the board — an instant 0.333 against a question it has nothing to
  // do with, settled by volume. A category is not something the tweet said.
  const marketTokens = tokenize(m.question);
  if (marketTokens.length === 0) return 0;
  let hits = 0;
  const seen = new Set<string>();
  for (const t of marketTokens) {
    if (tweetTokens.has(t) && !seen.has(t)) {
      hits++;
      seen.add(t);
    }
  }
  return hits / Math.max(OVERLAP_FLOOR, tweetTokens.size);
}

// --- Hard filters: structured fields, checked before scoring is trusted ---

const ASSET_ALIASES: [string, RegExp][] = [
  ["bitcoin", /\b(bitcoin|btc)\b/i],
  ["ethereum", /\b(ethereum|eth)\b/i],
  ["solana", /\b(solana|sol)\b/i],
  ["xrp", /\bxrp\b/i],
  ["dogecoin", /\b(dogecoin|doge)\b/i],
];

function assetsIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const [name, re] of ASSET_ALIASES) if (re.test(text)) found.add(name);
  return found;
}

/**
 * Parses "above/over/below/under/close(s) above/reach/hit/cross $150,000 | 150k".
 *
 * The -ing forms are here because that is how people tweet. "bitcoin is hitting
 * 70k" parsed as no threshold at all, which meant the filter below never fired
 * and a 70k take could not be excluded from a $150,000 market on the numbers.
 */
function parseThreshold(text: string): number | null {
  const re =
    /\b(?:above|over|below|under|exceed(?:s|ing)?|hit(?:s|ting)?|reach(?:es|ing)?|cross(?:es|ing)?|clos(?:e|es|ed|ing)\s+(?:above|below))\s*\$?\s?([\d,]+(?:\.\d+)?)\s?(k|m|b|thousand|million|billion)?\b/i;
  const m = text.match(re);
  if (!m) return null;
  const val = parseFloat(m[1].replace(/,/g, ""));
  const scale = SCALE[(m[2] || "").toLowerCase()] ?? 1;
  return Number.isFinite(val) ? val * scale : null;
}

/**
 * A question that names a dollar figure is asking about a price, not a topic.
 * Tested on the raw strings, not the tokens: the tokenizer canonicalizes "70k"
 * to 70000 and drops the "$", which is exactly the information needed here.
 */
const PRICED_QUESTION = /\$\s?\d/;
const HAS_NUMBER = /\d/;

/** Very rough horizon parser: "today" -> 0, "this week" -> 7, "this year" -> days to Dec 31, etc. */
function parseHorizonDays(text: string): number | null {
  const t = text.toLowerCase();
  const now = new Date();
  if (/\btoday\b/.test(t)) return 0;
  if (/\bthis week\b/.test(t)) return 7;
  if (/\bthis month\b/.test(t)) return 30;
  if (/\bnext year\b/.test(t)) {
    const endNext = new Date(now.getFullYear() + 1, 11, 31);
    return Math.ceil((endNext.getTime() - now.getTime()) / 86_400_000);
  }
  if (/\bthis year\b|\bby (the )?end of (the )?year\b|\beoy\b/.test(t)) {
    const endYear = new Date(now.getFullYear(), 11, 31);
    return Math.ceil((endYear.getTime() - now.getTime()) / 86_400_000);
  }
  return null;
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Number.isNaN(ms) ? null : ms / 86_400_000;
}

type Direction = "up" | "down" | "flat";

/** Only rate/Fed language is disambiguated this way; crypto is covered by parseThreshold. */
const RATE_SUBJECT = /\b(fed|fomc|interest rates?|rates?)\b/i;

// FLAT is tested first: "no rate cuts" contains "cuts" but means the opposite.
const FLAT_RE =
  /\bno\s+(?:fed\s+)?(?:rate\s+)?(?:change|cuts?|hikes?|increases?|decreases?)\b|\bunchanged\b|\bhold(?:s|ing)?\s+(?:rates?|steady)\b|\brates?\s+steady\b|\bpause\b/i;
const UP_RE = /\b(hikes?|hiking|raises?|raising|increases?|increasing|higher)\b/i;
const DOWN_RE = /\b(cuts?|cutting|decreases?|decreasing|lowers?|lowering|slash(?:es|ing)?|reduces?|eas(?:e|es|ing))\b/i;

/**
 * The direction of the EVENT the text refers to — never the speaker's belief
 * about it. "the fed is not cutting" is still "down", because the event under
 * discussion is a cut; the disbelief is stance, and stance is what the market's
 * yesPct is there to price. That keeps a "no way" take pointed at its own
 * market, where it correctly shows a low yesPct.
 */
function parseDirection(text: string): Direction | null {
  if (!RATE_SUBJECT.test(text)) return null;
  if (FLAT_RE.test(text)) return "flat";
  if (UP_RE.test(text)) return "up";
  if (DOWN_RE.test(text)) return "down";
  return null;
}

/**
 * Direction says WHICH WAY, never WHICH MEETING. "the fed is hiking again"
 * agrees with the July hike market and the September one equally, and the
 * volume tie-break picks whichever is busier. Known gap, accepted for Week 1 —
 * both cards are honest about the event, just possibly the wrong date. Closing
 * it means parsing the meeting out of the tweet, which the tweet usually
 * doesn't state.
 */

/**
 * The positive form of the hard filters below. They already extract direction
 * and threshold in order to REJECT disagreement; agreement is evidence too, and
 * the gate in matchTweet uses it as a second anchor when a short take has only
 * one word to offer. Nothing here can lift a market over MIN_OVERLAP — it only
 * decides whether a single shared word is allowed to count.
 */
function corroborates(tweetText: string, m: Market): boolean {
  const tweetDir = parseDirection(tweetText);
  const marketDir = parseDirection(m.question);
  if (tweetDir && marketDir && tweetDir === marketDir) return true;

  const shared = [...assetsIn(tweetText)].some((a) => assetsIn(m.question).has(a));
  if (shared) {
    const tThresh = parseThreshold(tweetText);
    const mThresh = parseThreshold(m.question);
    if (tThresh !== null && mThresh !== null) {
      const ratio = tThresh / mThresh;
      if (ratio >= 0.7 && ratio <= 1.3) return true;
    }
  }
  return false;
}

/**
 * Hard-filter check: true if this market should be EXCLUDED as a candidate
 * for this tweet, independent of how well the words overlap.
 */
function isDisqualified(tweetText: string, m: Market): boolean {
  // 1) Same asset named on both sides + both give a numeric threshold that
  //    disagrees materially -> different claim entirely, exclude.
  const tweetAssets = assetsIn(tweetText);
  const marketAssets = assetsIn(m.question);
  const sharedAsset = [...tweetAssets].some((a) => marketAssets.has(a));
  if (sharedAsset) {
    const tThresh = parseThreshold(tweetText);
    const mThresh = parseThreshold(m.question);
    if (tThresh !== null && mThresh !== null) {
      const ratio = tThresh / mThresh;
      if (ratio < 0.7 || ratio > 1.3) return true; // e.g. $150k vs $60k
    }
  }

  // 2) Tweet implies a long horizon ("this year") but the market resolves
  //    within days -> by the time the tweet's claim could play out, this
  //    market has already settled on unrelated timing. Exclude.
  const tweetHorizon = parseHorizonDays(tweetText);
  const marketHorizon = daysUntil(m.closesAt);
  if (tweetHorizon !== null && tweetHorizon >= 60 && marketHorizon !== null && marketHorizon <= 3) {
    return true;
  }

  // 3) Both sides state a rate direction and they disagree -> the market asks
  //    about a different event, so its yesPct is not an answer to the tweet.
  //    e.g. tweet "cutting" (down) vs market "no change" (flat): the 79% on
  //    that market means NO cut, and would render as agreement on the card.
  const tweetDir = parseDirection(tweetText);
  const marketDir = parseDirection(m.question);
  if (tweetDir && marketDir && tweetDir !== marketDir) return true;

  // 4) The market asks about a PRICE and the tweet names none.
  //
  //    "Will Natural Gas (NG) hit (LOW) $2.60 in July?" is a claim about a
  //    number. "i am running low on gas" is a claim about a car. They share
  //    `gas` and `low` — two of the tweet's three words, a 0.667 overlap, the
  //    highest-confidence wrong card the matcher has ever produced. No family
  //    rule catches it: the market has no siblings, and every hit is real. The
  //    words simply mean something else.
  //
  //    A priced market cannot be answered by a take that gives no price and no
  //    direction. Corroboration still opens the door — "the fed is hiking"
  //    names no number and should still find the hike market — but a numberless,
  //    directionless take is not making the claim the market prices, however
  //    many of its words it happens to borrow.
  //
  //    Cost, measured on a frozen 2,293-market board: zero. All 2,293 questions
  //    still match themselves — a priced question carries its own figure. The
  //    numberless takes this could plausibly have cost ("bitcoin is going to the
  //    moon", "oil is about to spike") were already silent without it: a take
  //    with no number rarely clears MIN_OVERLAP against a question padded with
  //    strike, month and venue words. The rule bites exactly where the overlap
  //    is high and the meaning is absent.
  if (PRICED_QUESTION.test(m.question) && !HAS_NUMBER.test(tweetText) && !corroborates(tweetText, m)) {
    return true;
  }

  return false;
}

// --- Template families: the failure the overlap score cannot see -------------
//
// Venues list one market per outcome, so a single question arrives as a family
// of near-identical siblings: "Will France win the 2026 FIFA World Cup?", "Will
// Spain win…", "Will Argentina win…". They differ by one word. Everything else —
// win, 2026, fifa, world, cup — is shared, and that shared core alone clears the
// bar. So a take that names no team, or names a team whose market is missing,
// does not go silent: it lands on whichever sibling has the most volume.
//
// "morocco are going to win the 2026 world cup" published a France card at
// 0.500. Morocco's own market sits at 3%, below the bettable floor, so the right
// answer had been filtered out while a hundred wrong ones stood.
//
// This is worse than a normal false match because it is INVISIBLE to the
// matched:false rate — it reports as a confident match. Any Week-1 miss number
// collected without this filter is measuring the wrong thing.
//
// The rule: among candidates, a market may only win against a sibling if the
// tweet names something that tells the two apart.
//
// Note the pairwise framing. The obvious rule — "the token unique to this
// question within the family must appear in the tweet" — is broken by the board
// as it actually is: "Will Argentina win…" and "Will Argentina reach the final?"
// are both live, so `argentina` is unique to neither, and a correct Argentina
// take would be silenced. What distinguishes a market is relative to the sibling
// it is being compared against, not to the family as a whole.

/**
 * Crude suffix stripping, used ONLY to compare a market against its siblings —
 * never in scoreMarket, where the bar is calibrated against unstemmed tokens.
 *
 * It exists for one job: "france are winning the world cup" must be allowed to
 * prefer "Will France WIN…" over "Will France REACH THE FINAL?". Unstemmed,
 * `winning` and `win` are different words, the tweet appears to say nothing that
 * distinguishes the two markets, and a correct take goes silent.
 */
function stem(t: string): string {
  const s = t.replace(/(?:ing|es|s)$/, "");
  if (s.length < 3) return t;
  return s.replace(/(\w)\1$/, "$1"); // winning -> winn -> win
}
const stems = (tokens: Iterable<string>): Set<string> => new Set([...tokens].map(stem));

/**
 * Sibling if they overlap heavily.
 *
 * Only FAMILY_CONTAINMENT is pinned by evidence: raise it to 0.95 and three of
 * the World Cup cases start publishing a France card again. FAMILY_MIN_SHARED is
 * belt-and-braces — dropping it to 1 changes nothing on the live board or in the
 * suite, because containment already rejects small sets that share one word
 * (1/3 < 0.6). It is kept as a floor for the degenerate two-token question, and
 * a mutation test will not notice if it is removed. Said plainly so nobody
 * mistakes it for a calibrated number.
 */
const FAMILY_MIN_SHARED = 3;
const FAMILY_CONTAINMENT = 0.6;

function areSiblings(a: Set<string>, b: Set<string>): boolean {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  if (shared < FAMILY_MIN_SHARED) return false;
  return shared / Math.min(a.size, b.size) >= FAMILY_CONTAINMENT;
}

/**
 * Does the tweet pick `me` over `sibling`? Both halves are needed, and the
 * second half was learned from a wrong card:
 *
 *  - the tweet must name something only `me` has. A shared word cannot prefer
 *    one sibling to the other however well it scores.
 *  - the tweet must name nothing that only `sibling` has. Without this,
 *    "morocco are going to win the world cup" kept "Will Morocco REACH THE
 *    FINAL?" — the tweet said `morocco`, which the winner market also says, so
 *    the first half passed. But the tweet also said `win`, which belongs to the
 *    sibling alone. Evidence pointing at the other question is evidence against
 *    this one.
 *
 * The first half is waived when `me` has no word of its own at all — when it is
 * a strict subset of the sibling. That market is not the vaguer one, it is the
 * BASE question, and the sibling is a narrower variant of it: "France vs.
 * Morocco: Both Teams to Score" against "…to Score in First Half". A take that
 * says neither `first` nor `half` is asking the base question, and demanding it
 * name something the narrower market lacks — there is nothing — silenced ten
 * live markets whose only fault was being the plain version.
 */
function outranks(tweetTokens: Set<string>, me: Set<string>, sibling: Set<string>): boolean {
  // Evidence pointing at the sibling alone is evidence against me.
  for (const t of sibling) if (!me.has(t) && tweetTokens.has(t)) return false;

  let mineUnique = false;
  let namesMine = false;
  for (const t of me) {
    if (sibling.has(t)) continue;
    mineUnique = true;
    if (tweetTokens.has(t)) { namesMine = true; break; }
  }
  return mineUnique ? namesMine : true;
}

/**
 * Drop every candidate the tweet cannot distinguish from one of its siblings,
 * then decide whether what's left can be trusted.
 *
 * Two things had to be learned the hard way here, both measured:
 *
 * 1. STRUCTURALLY ANCHORED CANDIDATES ARE EXEMPT. A first cut applied the rule
 *    to every family and cost 74 of 400 live self-matches, all of them threshold
 *    families: "Bitcoin above $62,000 on July 10" against "above $64,000 on July
 *    10". Those look like a template family and are not one — what tells them
 *    apart is a NUMBER, and parseThreshold already compares numbers. Where a
 *    structural anchor exists (rate direction, or a matching asset threshold),
 *    lexical distinctness is not the evidence we are relying on, so demanding it
 *    is pure loss. corroborates() is exactly that test, reused.
 *
 * 2. ELIMINATION IS NOT SILENCE. Removing candidates promotes whatever ranked
 *    below them. Dropping the Fed hike family handed "no way the fed cuts,
 *    they're hiking again" to an unrelated Anthropic market sitting at the same
 *    0.200 — a wrong card where the baseline had a right one. So an elimination
 *    that leaves nothing better behind it voids the whole match.
 *
 *    But only an UNRESOLVED elimination. A sibling that lost cleanly — because
 *    the tweet named the winner and not it — is not confusion, it is the rule
 *    working; "Will France reach the final?" losing to "Will France win?" on a
 *    tweet that says `winning` must not veto France. What votes for silence is a
 *    dropped candidate that scored as well as our answer and that nothing kept
 *    ever beat: nobody was named, so nobody should be posted.
 */
function resolveFamilies(
  tweetText: string,
  tweetTokens: Set<string>,
  candidates: MatchResult[],
): MatchResult[] {
  if (candidates.length < 2) return candidates;

  const tw = stems(tweetTokens);
  const toks = candidates.map((c) => stems(tokenize(c.market.question)));
  const anchored = candidates.map((c) => corroborates(tweetText, c.market));

  const keep = candidates.map(
    (_, i) =>
      anchored[i] ||
      toks.every((other, j) => i === j || !areSiblings(toks[i], other) || outranks(tw, toks[i], other)),
  );

  const kept = candidates.filter((_, i) => keep[i]);
  if (kept.length === 0) return [];
  const bestKept = Math.max(...kept.map((c) => c.score));

  // STRICTLY better, not "as good as".
  //
  // This was `>=` and no test could tell the difference — until the matcher's
  // universe widened and brought in a two-market family:
  //
  //   "Will the Fed decide differently in the next three decisions (Apr–Jun–Jul)?"
  //   "Will the Fed decide differently in the next three decisions (Jul–Sep–Oct)?"
  //
  // "no way the fed cuts, they're hiking again" names neither window, so both
  // are correctly eliminated. Both score 0.200 — one shared word, `fed`, out of
  // five — which is also what the correct hike market scores, because that is
  // simply what one shared word out of five is worth. Under `>=` their mutual
  // ambiguity vetoed a match they have nothing to do with, and the calibration
  // case that MIN_OVERLAP is pinned to fell silent.
  //
  // What the veto is for is "we threw away something BETTER than the answer we
  // are about to give, and nobody named it". A discarded tie says only that two
  // markets scored the floor. It is not evidence that our answer is wrong.
  for (let i = 0; i < candidates.length; i++) {
    if (keep[i] || candidates[i].score <= bestKept + TIE_EPSILON) continue;
    const beaten = candidates.some(
      (_, j) => keep[j] && areSiblings(toks[j], toks[i]) && outranks(tw, toks[j], toks[i]),
    );
    if (!beaten) return []; // an unnamed sibling matched our best answer
  }
  return kept;
}

/**
 * Minimum lexical overlap for a market to be considered about the same thing
 * as the tweet. Calibrated on live Kalshi+Polymarket data: the weakest true
 * match observed is 0.200 ("no way the fed cuts, they're hiking again" shares
 * only "fed" with the hike market) and the strongest false one is 0.167
 * ("...best sandwich of my entire life" vs "Hanwha Life Esports"). 0.19 sits
 * strictly inside that gap, so no match hinges on float equality at the bar.
 *
 * NOT comparable to the old 0.34: that bar was applied to overlap plus a
 * liquidity term worth up to 0.15, so it silently demanded ~0.19 overlap from
 * a heavily-traded market and ~0.34 from an untraded one. The gate is now
 * scale-free — it means the same thing regardless of volume.
 */
const MIN_OVERLAP = 0.19;

export interface MatchResult {
  market: Market;
  score: number;
}

/**
 * Live markets whose token set is IDENTICAL to this one's — the matcher cannot
 * tell them apart, and the volume tie-break decides. tokenize() drops tokens
 * shorter than three characters, which is exactly where dates and scores live:
 * "…on July 7, 2026?" and "…on July 10, 2026?" are the same string to us, as are
 * "Exact Score: Spain 0 - 1 Belgium?" and "…Spain 3 - 2 Belgium?".
 *
 * resolveFamilies() cannot help here: it works by finding a word that tells two
 * siblings apart, and there is none. So the danger is surfaced instead of fixed
 * — /tool warns the operator before a card is posted by hand. See
 * NOTES/known-gaps.md; this must be closed before the bot posts unattended.
 */
export function nearTwins(market: Market, markets: Market[]): Market[] {
  const key = (m: Market) => [...new Set(tokenize(m.question).map(stem))].sort().join("|");
  const mine = key(market);
  return markets.filter((m) => m.venueId !== market.venueId && key(m) === mine);
}

/** Overlaps are k/n rationals, so genuine ties are exact; this only absorbs float noise. */
const TIE_EPSILON = 1e-9;

/**
 * Gate on overlap, then rank. The gate ("is this market about the same thing
 * as the tweet?") is answered by lexical overlap alone. Liquidity only orders
 * markets that already passed, so a heavily-traded market can never buy its
 * way over the bar, and a thin one can never be dropped for being thin.
 */
export function matchTweet(
  tweetText: string,
  markets: Market[],
  minScore = MIN_OVERLAP,
): MatchResult | null {
  const tokens = new Set(tokenize(tweetText));
  if (tokens.size === 0) return null;

  const candidates: MatchResult[] = [];
  for (const market of markets) {
    if (isDisqualified(tweetText, market)) continue; // structured check wins over lexical score
    const score = scoreMarket(tokens, market);
    if (score < minScore) continue;
    // Overlap is hits/max(3, size), so this recovers hits exactly.
    const hits = Math.round(score * Math.max(OVERLAP_FLOOR, tokens.size));
    if (isShort(tokens.size) && hits < 2 && !corroborates(tweetText, market)) continue;
    candidates.push({ market, score });
  }

  // Structural, like the hard filters above, but it needs the whole candidate
  // set to see a family at all — so it runs here rather than inside the loop.
  const survivors = resolveFamilies(tweetText, tokens, candidates);
  if (survivors.length === 0) return null;

  survivors.sort((a, b) => {
    const byOverlap = b.score - a.score;
    if (Math.abs(byOverlap) > TIE_EPSILON) return byOverlap;
    return b.market.volumeUsd - a.market.volumeUsd; // tie-break: the market people actually trade
  });
  return survivors[0];
}

/**
 * Candidate generator for the semantic stage: the same machine as matchTweet
 * with the CONFIDENCE gates removed and the CORRECTNESS gates kept.
 *
 * The distinction is the whole design. MIN_OVERLAP and the short-tweet guard
 * exist to stop a weak lexical signal from being ASSERTED as an answer — but
 * here nothing is asserted; a referee with world knowledge sees the list and
 * may say "none". The hard disqualifiers and the family/discriminator pruning
 * are different in kind: they encode facts (wrong threshold, wrong month
 * window, a priced question against a numberless take) that no amount of world
 * knowledge should override, so a market they reject never even reaches the
 * referee — cheap pruning, and one less way to be talked into a wrong card.
 */
export function candidateMarkets(tweetText: string, markets: Market[], limit = 12): MatchResult[] {
  const tokens = new Set(tokenize(tweetText));
  if (tokens.size === 0) return [];

  const candidates: MatchResult[] = [];
  for (const market of markets) {
    if (isDisqualified(tweetText, market)) continue;
    const score = scoreMarket(tokens, market);
    if (score <= 0) continue; // zero-overlap markets enter via the volume fill, not here
    candidates.push({ market, score });
  }

  const survivors = resolveFamilies(tweetText, tokens, candidates);
  survivors.sort((a, b) => {
    const byOverlap = b.score - a.score;
    if (Math.abs(byOverlap) > TIE_EPSILON) return byOverlap;
    return b.market.volumeUsd - a.market.volumeUsd;
  });
  return survivors.slice(0, limit);
}

/** The disqualifier, exported for the semantic stage's volume fill: a market
 *  structurally wrong for the tweet must not enter the candidate list through
 *  ANY door. Correctness gates apply everywhere; confidence gates do not. */
export function disqualified(tweetText: string, m: Market): boolean {
  return isDisqualified(tweetText, m);
}
