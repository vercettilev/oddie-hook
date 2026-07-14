// Offline, hermetic checks for the matcher. No network, no server.
// Run with: npm run test-matcher
//
// Two rules this file tries to obey:
//
// 1. Every decoy market is given MORE volume than the correct one. Volume is
//    the tie-break, so if a hard filter is deleted (or `isDisqualified` is made
//    to return false unconditionally) the decoy wins the tie and the test goes
//    red. A fixture where the right market is also the most-traded one passes
//    whether or not the filter exists, which is what the previous version of
//    this file did.
//
// 2. Each filter gets a decoy that trips ONLY that filter. The old $60k/today
//    market was excluded by the threshold check AND the horizon check, so
//    either one could rot undetected behind the other.
//
// The overlap numbers asserted at the bottom are the ones MIN_OVERLAP is
// calibrated against. They live here, executed, rather than only in a comment.

import { matchTweet } from "../src/matching/matcher.js";
import { categorizeText } from "../src/matching/categorize.js";
import type { Market } from "../src/venues/types.js";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
    if (detail) console.error(`      ${detail}`);
  }
}

/** What matchTweet picked, in a form that reads well in a failure message. */
function got(m: ReturnType<typeof matchTweet>): string {
  return m ? `"${m.market.question}" (${m.market.venueId}, score ${m.score.toFixed(3)})` : "null";
}

const IN_3H = new Date(Date.now() + 3 * 3_600_000).toISOString();
const YEAR_END = "2026-12-31T23:59:00Z";

/** Decoys outrank the correct market on the tie-break, so a dead filter shows up. */
const DECOY_VOLUME = 10_000_000;
const RIGHT_VOLUME = 100_000;

function mk(venueId: string, question: string, over: Partial<Market> = {}): Market {
  return {
    venue: "kalshi",
    venueId,
    question,
    yesPct: 50,
    closesAt: YEAR_END,
    volumeUsd: RIGHT_VOLUME,
    venueUrl: "x",
    tags: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Bitcoin: one correct market, one decoy per filter.
// ---------------------------------------------------------------------------

const BTC_TWEET = "no way bitcoin closes above 150k this year";

/** Correct: same asset, same threshold, horizon that matches "this year". */
const btcRight = mk("BTC-RIGHT", "Will Bitcoin close above $150,000 in 2026?");

/** Wrong threshold ($60k vs $150k), same far horizon -> ONLY the threshold filter can exclude it. */
const btcWrongThreshold = mk("BTC-THRESH", "Will Bitcoin close above $60,000 in 2026?", {
  volumeUsd: DECOY_VOLUME,
});

/** Right threshold, resolves in 3h -> ONLY the horizon filter can exclude it. */
const btcWrongHorizon = mk("BTC-HORIZON", "Will Bitcoin close above $150,000 on July 9?", {
  closesAt: IN_3H,
  volumeUsd: DECOY_VOLUME,
});

console.log("threshold filter");
{
  const r = matchTweet(BTC_TWEET, [btcWrongThreshold, btcRight]);
  check(
    "$150k tweet does not match the $60k market, even though it is 100x more traded",
    r?.market.venueId === "BTC-RIGHT",
    `got ${got(r)}`,
  );
}

console.log("horizon filter");
{
  const r = matchTweet(BTC_TWEET, [btcWrongHorizon, btcRight]);
  check(
    '"this year" tweet does not match a market resolving in 3 hours',
    r?.market.venueId === "BTC-RIGHT",
    `got ${got(r)}`,
  );
}

console.log("both decoys present");
{
  const r = matchTweet(BTC_TWEET, [btcWrongThreshold, btcWrongHorizon, btcRight]);
  check("correct market survives both decoys", r?.market.venueId === "BTC-RIGHT", `got ${got(r)}`);
}

console.log("nothing suitable");
{
  // The correct market removed: the honest answer is null, not the best leftover.
  const r = matchTweet(BTC_TWEET, [btcWrongThreshold, btcWrongHorizon]);
  check("no correct market -> null rather than the runner-up", r === null, `got ${got(r)}`);
}

// ---------------------------------------------------------------------------
// Fed direction. Regression test for the bug where "the fed is cutting" matched
// "no change in Fed rates" at 78% yes — the card would have rendered the market
// as agreeing with a take it actually contradicts.
// ---------------------------------------------------------------------------

const FED_CUT_TWEET = "the fed is 100% cutting rates next meeting, book it";

const fedCut = mk("FED-CUT", "Will the Fed decrease interest rates by 25 bps after the July 2026 meeting?");
const fedFlat = mk("FED-FLAT", "Will there be no change in Fed interest rates after the July 2026 meeting?", {
  volumeUsd: DECOY_VOLUME,
});
const fedHike = mk("FED-HIKE", "Will the Fed increase interest rates by 25 bps after the July 2026 meeting?", {
  volumeUsd: DECOY_VOLUME,
});

console.log("direction filter");
{
  const r = matchTweet(FED_CUT_TWEET, [fedFlat, fedHike, fedCut]);
  check(
    '"cutting" tweet matches the cut market, not the no-change or hike market',
    r?.market.venueId === "FED-CUT",
    `got ${got(r)}`,
  );
}
{
  const r = matchTweet(FED_CUT_TWEET, [fedFlat, fedHike]);
  check("no cut market live -> null, not the no-change market", r === null, `got ${got(r)}`);
}
{
  // Stance is deliberately NOT filtered: a disbelieving take still points at
  // the market for the event it disbelieves. Only the EVENT has to agree.
  const r = matchTweet("no way the fed cuts, this is copium", [fedCut]);
  check('disbelief ("no way the fed cuts") still matches the cut market', r?.market.venueId === "FED-CUT", `got ${got(r)}`);
}

// ---------------------------------------------------------------------------
// The MIN_OVERLAP margin. The threshold (0.19) is only meaningful if the
// weakest true match stays above it and the strongest false one stays below.
// Both numbers are asserted here, so a tokenizer edit that moves either one
// fails instead of silently invalidating the comment in matcher.ts.
// ---------------------------------------------------------------------------

const HIKE_TWEET = "no way the fed cuts, they're hiking again"; // 5 tokens, 1 hit -> 0.200
const SANDWICH_TWEET = "just had the best sandwich of my entire life"; // 6 tokens, 1 hit -> 0.167
const esports = mk("ESPORTS", "Will Hanwha Life Esports win?");

/** matchTweet with the bar dropped to 0 reports the score of the best candidate. */
function rawScore(tweet: string, m: Market): number {
  const r = matchTweet(tweet, [m], 0);
  return r ? r.score : NaN;
}

const near = (a: number, b: number) => Math.abs(a - b) < 5e-4;

console.log("calibration margin");
{
  const s = rawScore(HIKE_TWEET, fedHike);
  check(`weakest true match scores 0.200 (got ${s.toFixed(3)})`, near(s, 0.2));

  const r = matchTweet(HIKE_TWEET, [fedHike]);
  check("...and clears the bar", r?.market.venueId === "FED-HIKE", `got ${got(r)}`);
}
{
  const s = rawScore(SANDWICH_TWEET, esports);
  check(`strongest false match scores 0.167 (got ${s.toFixed(3)})`, near(s, 1 / 6));

  const r = matchTweet(SANDWICH_TWEET, [esports]);
  check('...and is rejected ("life" is the only shared word)', r === null, `got ${got(r)}`);
}
{
  // Together the two above pin MIN_OVERLAP into (0.167, 0.200]. This asserts the
  // ordering itself, so the margin cannot silently invert.
  const trueScore = rawScore(HIKE_TWEET, fedHike);
  const falseScore = rawScore(SANDWICH_TWEET, esports);
  check(
    `margin holds: ${falseScore.toFixed(3)} (false) < ${trueScore.toFixed(3)} (true)`,
    falseScore < trueScore,
  );
}

// ---------------------------------------------------------------------------
// Number normalization. Crypto takes are written "70k", never "$70,000", and
// crypto markets are written "$70,000", never "70k". Before the tokenizer knew
// they were the same number, "$70,000" tokenized to "70" (dropped, two chars)
// and "000" — a token EVERY $X,000 market shares. The decoy below carries more
// volume than the right market, so a matcher that scores them alike picks the
// decoy on the tie-break and this fails.
// ---------------------------------------------------------------------------
console.log("\nnumber normalization");
{
  const btc70 = mk("BTC-70K", "Will Bitcoin reach $70,000 in July?", { volumeUsd: RIGHT_VOLUME });
  const btc65 = mk("BTC-65K", "Will Bitcoin reach $65,000 in July?", { volumeUsd: DECOY_VOLUME });
  const btc150 = mk("BTC-150K", "Will Bitcoin reach $150,000 in 2026?", { volumeUsd: DECOY_VOLUME });
  const board = [btc70, btc65, btc150];

  // Every spelling of the same take must land on the same market.
  for (const tweet of [
    "bitcoin is definitely hitting 70k this month, no doubt",
    "bitcoin is definitely hitting $70,000 this month, no doubt",
    "bitcoin is definitely hitting 70000 this month, no doubt",
  ]) {
    const r = matchTweet(tweet, board);
    check(`"${tweet.slice(0, 40)}…" -> the $70,000 market`, r?.market.venueId === "BTC-70K", `got ${got(r)}`);
  }

  // …and must be excluded from the wrong strike by the threshold filter, not by
  // a low score. Bar dropped to 0: only a hard filter can still return null.
  check(
    "70k take is disqualified from the $150,000 market on the numbers",
    matchTweet("bitcoin is definitely hitting 70k this month", [btc150], 0) === null,
  );
  // The near strike is not disqualified (0.93 ratio), it simply scores too low.
  const near65 = matchTweet("bitcoin is definitely hitting 70k this month, no doubt", [btc65], 0);
  check(
    `the $65,000 market survives the filter but scores ${near65 ? near65.score.toFixed(3) : "n/a"} < 0.19`,
    near65 !== null && near65.score < 0.19,
  );

  // Millions, and a decimal.
  const btc15m = mk("BTC-1.5M", "Will Bitcoin reach $1,500,000 in 2030?");
  check(
    '"1.5m" -> $1,500,000',
    matchTweet("bitcoin crossing 1.5m by 2030", [btc15m])?.market.venueId === "BTC-1.5M",
  );

  // Bare numbers must be left alone: "2026" and "9.5" are not scaled quantities.
  const score = mk("SCORE", "France vs. Morocco: O/U 9.5 Total Corners");
  check("bare decimals are not rewritten", matchTweet("france morocco corners", [score], 0) !== null);
}

// ---------------------------------------------------------------------------
// The venue's category tag is not something the tweet said. It lives on the
// market so the feed can bucket it; folding it into the lexical score gave
// "crypto is going to zero" a free word against every crypto market on the
// board, and the volume tie-break then picked one.
// ---------------------------------------------------------------------------
console.log("\nvenue tags stay out of the score");
{
  const tagged = mk("ETH-FLIP", "Will Ethereum flip Bitcoin?", { tags: ["crypto"], volumeUsd: DECOY_VOLUME });
  check("a category word alone never matches", matchTweet("crypto is going to zero", [tagged]) === null);

  // Read the raw score with a tweet LONG enough that the short-take gate isn't
  // what makes it null. That gate is threshold-independent, so matchTweet(…, 0)
  // cannot report a score for a short tweet — asking it to was the flaw in the
  // old version of this check. A leaked tag would surface here as 1/6 = 0.167.
  const long = "crypto as an asset class is going straight to zero";
  const s = rawScore(long, tagged);
  check("...and contributes nothing to the score", s === 0, `got ${s}`);

  const sport = mk("SCORE-2", "Exact Score: France 1 - 2 Morocco?", { tags: ["sports"], volumeUsd: DECOY_VOLUME });
  check('"sports are rigged" matches nothing', matchTweet("sports are rigged", [sport]) === null);
}

// ---------------------------------------------------------------------------
// Short takes need two anchors.
//
// A tweet of four words or fewer scores 0.333 on a single shared word, which is
// twice the bar. Eleven of eighteen generic off-topic takes published a card
// that way once the per-category fetch put the whole board in reach: "bitcoin is
// dead" landed on a $70,000 market, "sports are rigged" on a SCOTUS case.
//
// The second anchor does not have to be a second WORD. The hard filters already
// parse direction and threshold in order to reject disagreement; agreement is
// evidence too. That is what keeps the direction-carrying Fed takes below, which
// share exactly one word ("fed") with their market and would otherwise die here.
// ---------------------------------------------------------------------------
console.log("\nshort takes need two anchors");
{
  const pepsi = mk("PEPSI", 'Will PepsiCo say "Zero Sugar" during the earnings call?', { volumeUsd: DECOY_VOLUME });
  const scotus = mk("SCOTUS", "SCOTUS accepts sports event contract case by December 31, 2026?", { volumeUsd: DECOY_VOLUME });
  const btc70 = mk("BTC-70K", "Will Bitcoin reach $70,000 in July?", { volumeUsd: DECOY_VOLUME });
  // No direction: "resign" is neither a hike, a cut, nor a hold.
  const fedChair = mk("FED-CHAIR", "Will the Fed chair resign before 2027?", { volumeUsd: DECOY_VOLUME });
  const board = [pepsi, scotus, btc70, fedFlat, fedHike, fedCut];

  // Each of these shares exactly one word with exactly one market on the board.
  // "nobody watches sports anymore" is four words: it pins SHORT_TWEET_MAX. Drop
  // the bound to three and it publishes a SCOTUS card.
  const junk: [string, string][] = [
    ["crypto is going to zero", '"zero" is also in a PepsiCo market'],
    ["sports are rigged", '"sports" is also in a SCOTUS market'],
    ["nobody watches sports anymore", "four words — the boundary case"],
    ["bitcoin is dead", '"bitcoin" is in every Bitcoin market'],
    ["the fed is useless", '"fed" is in every Fed market, and the take states no direction'],
  ];
  for (const [tweet, why] of junk) {
    const r = matchTweet(tweet, board);
    check(`"${tweet}" stays silent  (${why})`, r === null, `got ${got(r)}`);
  }

  // …and the rescues. One lexical hit each; the direction is the second anchor.
  {
    const r = matchTweet("the fed is hiking again", board);
    check('"the fed is hiking again" -> the hike market (up agrees with up)', r?.market.venueId === "FED-HIKE", `got ${got(r)}`);
    check("...on a single shared word", near(r?.score ?? -1, 1 / 3), `score ${r?.score.toFixed(3)}`);
  }
  {
    const r = matchTweet("no way the fed cuts, this is copium", board);
    check('"no way the fed cuts" -> the cut market (down agrees with down)', r?.market.venueId === "FED-CUT", `got ${got(r)}`);
    check("...on a single shared word", near(r?.score ?? -1, 0.25), `score ${r?.score.toFixed(3)}`);
  }

  // Agreement needs BOTH sides to state a direction. A market that states none
  // corroborates nothing — otherwise any direction-carrying take would be free
  // to land on any market sharing one word with it. isDisqualified can't catch
  // this: it only rejects directions that CONFLICT, and null never conflicts.
  {
    const r = matchTweet("the fed is hiking again", [fedChair]);
    check('"the fed is hiking again" does not reach a market with no direction', r === null, `got ${got(r)}`);
  }

  // The threshold is the other second anchor: "btc" never matches "bitcoin"
  // lexically, so the only shared word is the number.
  {
    const r = matchTweet("btc crossing 70k soon", board);
    check('"btc crossing 70k soon" -> the $70,000 market (threshold agrees)', r?.market.venueId === "BTC-70K", `got ${got(r)}`);
  }
  {
    // Same shape, wrong strike: the disqualifier runs before any of this.
    const r = matchTweet("btc crossing 150k soon", board);
    check('"btc crossing 150k soon" is disqualified from the $70,000 market', r === null, `got ${got(r)}`);
  }

  // A long take is not subject to the rule at all — one hit is already a low score.
  {
    const r = matchTweet(HIKE_TWEET, board);
    check("a five-word take still matches on one word", r?.market.venueId === "FED-HIKE", `got ${got(r)}`);
  }
}

// ---------------------------------------------------------------------------
// Template families.
//
// Venues list one market per outcome, so the board carries a hundred questions
// that differ by one word. Their shared core ("win the 2026 fifa world cup")
// clears the bar on its own, which means a take that names no team does not go
// silent — it lands on whichever sibling has the most volume.
//
// This class is INVISIBLE to the matched:false rate: it reports as a confident
// match. It cannot be caught by watching the miss number, so it has to be
// caught here. The decoy volumes below are what a real board looks like: the
// wrong answer is the busiest market.
// ---------------------------------------------------------------------------
console.log("\ntemplate families need the tweet to name a side");
{
  // France is the volume favourite, exactly as on the live board. Every check
  // below fails to a France card if the rule is removed.
  const france = mk("WC-FRA", "Will France win the 2026 FIFA World Cup?", { volumeUsd: 3_410_000 });
  const argentina = mk("WC-ARG", "Will Argentina win the 2026 FIFA World Cup?", { volumeUsd: 2_090_000 });
  const spain = mk("WC-ESP", "Will Spain win the 2026 FIFA World Cup?", { volumeUsd: 2_550_000 });
  // The narrower variant of a base question, and a base question of its own.
  const argFinal = mk("WC-ARG-F", "Will Argentina reach the 2026 FIFA World Cup final?", { volumeUsd: 50_000 });
  // France's OWN reach-the-final market. Without it the stemming below is
  // untested: "france are winning" would keep the win market simply because no
  // sibling of France's exists to be told apart from. With it, `winning` has to
  // reach `win`, or both France markets die and the take goes silent.
  const fraFinal = mk("WC-FRA-F", "Will France reach the 2026 FIFA World Cup final?", { volumeUsd: 60_000 });
  const btsFirst = mk("BTS-1H", "France vs. Morocco: Both Teams to Score in First Half", { volumeUsd: 90_000 });
  const bts = mk("BTS", "France vs. Morocco: Both Teams to Score", { volumeUsd: 12_000 });
  // Morocco has no "win the cup" market — but it does have a reach-the-final
  // one. A rule that only asks "does the tweet name a word unique to me?" keeps
  // this on a `morocco … win` take, because the take does say `morocco`. It must
  // also notice the take says `win`, which belongs to the sibling alone.
  const marFinal = mk("WC-MAR-F", "Will Morocco reach the 2026 FIFA World Cup final?", { volumeUsd: 40_000 });
  // Three tokens, so it is nobody's sibling: it never enters the family and
  // survives every elimination. It is what a card lands on when the family is
  // cleared out and nothing vetoes the promotion.
  const marDate = mk("MAR-DATE", "Will Morocco win on 2026-07-09?", { volumeUsd: 8_000 });
  const wc = [france, argentina, spain, argFinal, fraFinal, btsFirst, bts, marFinal, marDate];

  // Morocco's own market is missing — below the 4% bettable floor — which is
  // precisely when the family is most dangerous: the right answer is gone and a
  // hundred wrong ones are still standing.
  const silent: [string, string][] = [
    ["morocco are going to win the 2026 world cup, mark my words", "names a team with no market; must not land on France"],
    ["who is going to win the 2026 world cup", "names no team at all"],
    ["someone is finally going to win the 2026 world cup", "names no team, high overlap"],
  ];
  for (const [tweet, why] of silent) {
    const r = matchTweet(tweet, wc);
    check(`"${tweet.slice(0, 42)}…" stays silent  (${why})`, r === null, `got ${got(r)}`);
  }

  // …and the takes that DO name a side still match, including the one whose
  // market is not the volume favourite.
  {
    const r = matchTweet("BREAKING: Netanyahu reveals he's rooting for Argentina to win the 2026 World Cup.", wc);
    check('"…Argentina to win…" -> Argentina, not the busier France', r?.market.venueId === "WC-ARG", `got ${got(r)}`);
  }
  {
    // "winning" and "win" are different tokens; the family comparison stems, so
    // this take can still prefer "win the cup" over "reach the final".
    const r = matchTweet("france are winning the 2026 world cup and everyone knows it", wc);
    check('"france are winning…" -> France win, not France reach-final', r?.market.venueId === "WC-FRA", `got ${got(r)}`);
  }
  {
    const r = matchTweet("argentina reach the 2026 world cup final, calling it now", wc);
    check('"argentina reach the … final" -> the final market, not the win market', r?.market.venueId === "WC-ARG-F", `got ${got(r)}`);
  }
  {
    // The base question must beat its own narrower variant. Nothing in the take
    // says "first half", so the plain market is the one being asked about —
    // even though the variant is seven times busier.
    const r = matchTweet("both teams to score in france vs morocco, easy money", wc);
    check('"both teams to score" -> the full-match market, not the first-half one', r?.market.venueId === "BTS", `got ${got(r)}`);
  }
  {
    const r = matchTweet("both teams to score in the first half of france vs morocco", wc);
    check('"…in the first half" -> the first-half market', r?.market.venueId === "BTS-1H", `got ${got(r)}`);
  }

  // Non-template markets must be untouched by all of this. A structural anchor
  // (direction, threshold) is evidence the family rule has no business second-
  // guessing: "above $62,000" vs "above $64,000" is told apart by parseThreshold,
  // not by a distinguishing word.
  {
    // Two hike markets, one per meeting. They ARE a template family — the only
    // thing telling them apart is `july` / `september`, and the take names
    // neither. What saves the match is the structural anchor: both markets agree
    // with the take's direction, so the family rule stands down and volume picks
    // the meeting. (That last part is the known meeting-disambiguation gap.)
    const fedHikeSep = mk("FED-HIKE-SEP", "Will the Fed increase interest rates by 25 bps after the September 2026 meeting?", {
      volumeUsd: 1_000,
    });
    const r = matchTweet("no way the fed cuts, they're hiking again", [fedHike, fedHikeSep, fedCut, fedFlat]);
    check("the 0.200 Fed calibration case survives the family rule", r?.market.venueId === "FED-HIKE", `got ${got(r)}`);
    check("...still at exactly 0.200", near(r?.score ?? -1, 0.2), `score ${r?.score.toFixed(3)}`);
  }
  {
    const btc70 = mk("BTC-70K", "Will the price of Bitcoin be above $70,000 on July 10?", { volumeUsd: 10_000 });
    const btc72 = mk("BTC-72K", "Will the price of Bitcoin be above $72,000 on July 10?", { volumeUsd: 9_000_000 });
    const r = matchTweet("bitcoin closing above 70k on july 10, screenshot this", [btc70, btc72]);
    check("a threshold family is resolved by the number, not silenced", r?.market.venueId === "BTC-70K", `got ${got(r)}`);
  }
}

// ---------------------------------------------------------------------------
// A priced market needs a priced take.
//
// Widening the matcher's universe to every Polymarket tag brought in commodity
// markets, and with them the highest-confidence wrong card the matcher has
// produced: "i am running low on gas" scored 0.667 against "Will Natural Gas
// (NG) hit (LOW) $2.60 in July?" — two of the tweet's three words, both real
// hits, no template family to blame. The words just mean something else.
//
// The family rule cannot see this and never will: there is one market, not a
// family. Only the absence of a number tells you the take isn't about a price.
// ---------------------------------------------------------------------------
console.log("\na priced market needs a priced take");
{
  const gas = mk("NG-260", "Will Natural Gas (NG) hit (LOW) $2.60 in July?", { volumeUsd: DECOY_VOLUME });

  check(
    "'running low on gas' does not buy a natural gas contract",
    matchTweet("i am running low on gas", [gas]) === null,
    `got ${got(matchTweet("i am running low on gas", [gas]))}`,
  );

  // The rule must cost nothing when the take IS about the price. Same market,
  // same words, one number added.
  const withNumber = matchTweet("natural gas hitting $2.60 in july, easy", [gas]);
  check("...but a take that names the price still matches it", withNumber?.market.venueId === "NG-260", `got ${got(withNumber)}`);

  // And corroboration still opens the door for the one case that legitimately
  // names no number: a rate direction. If the guard is widened to "no number,
  // no match" this goes red.
  const fedPriced = mk("FED-PRICED", "Will the Fed increase interest rates above $0 by 25 bps in July?");
  const hike = matchTweet("the fed is hiking again", [fedPriced]);
  check("...and corroboration still lets a numberless Fed take through", hike?.market.venueId === "FED-PRICED", `got ${got(hike)}`);
}

// ---------------------------------------------------------------------------
// The family veto is STRICTLY better, not "at least as good".
//
// A candidate eliminated by the discriminator rule vetoes the whole match only
// when it scored strictly HIGHER than the best survivor. With `>=` the suite
// stayed green for weeks — mutation testing flagged the mutant as inert and it
// was documented as a conservative choice. Then the universe widened, an
// unrelated Fed family landed on exactly the survivor's 0.200, and the 0.200
// calibration case fell silent. The mutant was never inert; nothing had ever
// put a tie in front of it. This fixture does.
// ---------------------------------------------------------------------------
console.log("\nan eliminated tie does not veto the match");
{
  // The survivor: a real answer at 0.200, one hit out of five tokens.
  const hike = mk("TIE-HIKE", "Will the Fed increase interest rates by 25 bps after the July 2026 meeting?");
  // A family the tweet names no member of. Both are correctly eliminated, and
  // both score 0.200 on the single word "fed" — the survivor's exact score.
  // Their mutual ambiguity is not evidence against a market they never mention.
  const winA = mk("TIE-WIN-A", "Will the Fed decide differently in the next three decisions (Apr–Jun–Jul)?", { volumeUsd: DECOY_VOLUME });
  const winB = mk("TIE-WIN-B", "Will the Fed decide differently in the next three decisions (Jul–Sep–Oct)?", { volumeUsd: DECOY_VOLUME });

  const r = matchTweet("no way the fed cuts, they're hiking again", [hike, winA, winB]);
  check("an eliminated family tied with the answer does not veto it", r?.market.venueId === "TIE-HIKE", `got ${got(r)}`);
  check("...and the answer keeps its 0.200", near(r?.score ?? -1, 0.2), `score ${r?.score.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// Categorizer. The feed's chips are only useful if the buckets are, and the
// rules are ordered, so the order is what's asserted here. Every case below is
// one that a plausible reordering or a broader keyword would get wrong — the
// live market set happens not to contain any of them today, which is exactly
// why they need a test rather than an eyeball.
// ---------------------------------------------------------------------------
console.log("\ncategorizer");
{
  const cases: [string, string, string][] = [
    // the bug that started this: a tennis match naming neither "tennis" nor a sport
    ["Wimbledon WTA: Marta Kostyuk vs Linda Noskova", "Sports", "tournament + matchup shape"],
    ["Exact Score: France 2 - 1 Morocco?", "Sports", "sportsbook shape, no sport named"],
    ["Spread: Qarabağ Ağdam FK (-2.5)", "Sports", "sportsbook shape, no sport named"],
    ["Will France win on 2026-07-09?", "Sports", "date-scoped win"],
    ["Kylian Mbappé: 1+ goals", "Sports", "numeric goals form"],

    // Politics is tested before Sports precisely so this doesn't become Sports
    ["Trump vs. Newsom in 2028?", "Politics", "matchup shape, political name decides"],
    ["Will the U.S. invade Iran before 2027?", "Politics", "statecraft, no institution named"],
    ["Will the Fed increase interest rates?", "Politics", "and not Sports via 'rates'"],

    // Sports is tested before Culture and Tech, so bare game/goal/season must not
    // live in the Sports rule
    ["Will Netflix renew Squid Game for season 3?", "Culture", "'game'/'season' must not mean sport"],
    ["Will OpenAI hit its 2026 revenue goal?", "Tech", "'goal' must not mean sport"],

    // Crypto runs first, so a crypto market never falls to another bucket
    ["Will Bitcoin close above $150k in 2026?", "Crypto", "crypto wins over everything"],
    ["Will the SEC approve a Solana ETF?", "Crypto", "and not Politics via 'approve'"],
  ];
  for (const [text, want, why] of cases) {
    const got = categorizeText(text);
    check(`${want.padEnd(8)} ← "${text.slice(0, 44)}"  (${why})`, got === want, `got ${got}`);
  }
}

console.log();
if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log("all offline checks passed.");
