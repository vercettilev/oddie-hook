// End-to-end check against LIVE Kalshi + Polymarket data. Needs network, no keys.
// Run with: npm run smoke
//
// This asserts and exits non-zero on mismatch. It used to only print.
//
// The hard part of testing a matcher against live data is that you cannot
// hardcode "this tweet matches that market" — the market set turns over. So
// every expectation below is DERIVED from the markets actually fetched:
//
//   "if a live BTC $150k market exists, the tweet must match it;
//    if none exists, the tweet must match nothing — because matching the
//    $60k market instead is exactly the bug the threshold filter prevents."
//
// Both branches are real assertions. Neither is satisfied by the matcher
// going silent, and neither is satisfied by it matching whatever is nearby.
//
// The predicates that decide which branch applies are deliberately dumb regexes
// written here, NOT the matcher's own parseThreshold/parseDirection. Reusing
// the matcher's parsers to check the matcher would make a broken parser agree
// with itself.

import { getMarketData } from "../src/venues/index.js";
import { matchTweet, tokenize } from "../src/matching/matcher.js";
import { renderCard } from "../src/card/renderCard.js";
import type { Market } from "../src/venues/types.js";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

/* ------------------------------------------------------ two jobs, split -----
 * This script did two different things under one exit code: it checked the
 * MATCHER against real questions, and it checked that the venues were up. The
 * second is monitoring, not a test, and folding it in made the whole suite
 * non-deterministic — Polymarket returned zero markets on several runs across
 * two days, each time failing `npm test` for a reason that had nothing to do
 * with the code being tested. A suite that cries wolf is a suite that stops
 * being read, which is exactly what happened: three separate false alarms in
 * one session, each needing a manual re-run to dismiss.
 *
 *   npm test  -> --fixture, a committed snapshot. Deterministic. Tests the
 *                matcher, which is the part that can actually regress.
 *   npm run smoke -> live. Still checks venue health, still fails on an
 *                outage, but it is not gating every other suite any more.
 *
 * Refresh the snapshot with `npm run smoke -- --write-fixture` when the
 * question mix has drifted enough that the cases stop being representative.
 */
const FIXTURE = new URL("./fixtures/markets.json", import.meta.url);
const USE_FIXTURE = process.argv.includes("--fixture");
const WRITE_FIXTURE = process.argv.includes("--write-fixture");

let failures = 0;
let envFailures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
    if (detail) console.error(`      ${detail}`);
  }
}

/**
 * An environment precondition, not an assertion about our code. A venue being
 * down still fails the run — a suite that goes green on half a market set is
 * lying — but it is reported separately so a Kalshi outage is never read as a
 * matcher regression. Set SMOKE_ALLOW_DEGRADED=1 to downgrade these to warnings
 * when you knowingly want to exercise the matcher against whatever is up.
 */
const ALLOW_DEGRADED = process.env.SMOKE_ALLOW_DEGRADED === "1";

function precondition(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else if (ALLOW_DEGRADED) {
    console.warn(`  ! ${name} (degraded, allowed)`);
    if (detail) console.warn(`      ${detail}`);
  } else {
    envFailures++;
    console.error(`  ✗ ${name}`);
    if (detail) console.error(`      ${detail}`);
  }
}

const key = (m: Market) => `${m.venue}:${m.venueId}`;
const daysUntil = (iso: string | null) => (iso ? (new Date(iso).getTime() - Date.now()) / 86_400_000 : null);
const farOff = (m: Market) => {
  const d = daysUntil(m.closesAt);
  return d === null || d > 4;
};

function describe(m: ReturnType<typeof matchTweet>): string {
  return m ? `[${m.market.venue}] "${m.market.question}" (score ${m.score.toFixed(3)})` : "no match";
}

// --- Independent topic predicates (not the matcher's parsers) ---------------
const RE_BTC = /\b(bitcoin|btc)\b/i;
const RE_150K = /150[,.]?000|\b150\s?k\b/i;
const RE_RATE = /\b(fed|fomc|interest rates?)\b/i;
const RE_DOWN = /\b(cut|cuts|decrease|decreases|lower|lowers)\b/i;
const RE_UP = /\b(increase|increases|hike|hikes|raise|raises)\b/i;
const RE_FLAT = /\bno change\b|\bunchanged\b/i;
/**
 * A "how many cuts" market split into per-count outcomes is NOT a rate-cut
 * market for every one of its outcomes. Polymarket lists them as
 *
 *   How many Fed rate cuts in 2026? — 0 (0 bps)
 *   How many Fed rate cuts in 2026? — 1 (25 bps)
 *
 * and the first is a market about the Fed cutting NOTHING. RE_DOWN matches it
 * on the word "cuts" in the stem, so the expectation counted it as a suitable
 * answer to "the fed is 100% cutting rates" — a tweet it asserts the opposite
 * of. That is what made this case fail: not the matcher declining to match,
 * which was right, but the test insisting it should.
 *
 * The "— 1 (25 bps)" sibling is a different question again: a count for the
 * whole of 2026 against a tweet about the next meeting.
 */
const RE_ZERO_CUTS = /—\s*0\b|\b0\s*\(0\s*bps\)/i;
/**
 * And the whole "how many cuts" family is the wrong QUESTION, not just the
 * wrong outcome. "How many Fed rate cuts in 2026? — 1 (25 bps)" prices a count
 * for a calendar year; the tweet is about the next meeting. Answering one with
 * the other is the mistake this case exists to catch, so the market that would
 * have been offered as the right answer is excluded too, and the expectation
 * becomes "no match" — which is what the matcher has been saying all along.
 *
 * Net: the matcher was never wrong here. The test was, in two ways, and it had
 * been failing on and off for long enough to be treated as background noise.
 */
const RE_COUNT_SPLIT = /\bhow many\b/i;
const RE_POPVOTE = /\bpopular vote\b/i;

type Expectation =
  | { kind: "one-of"; set: Market[]; why: string }
  | { kind: "null"; why: string };

interface Case {
  tweet: string;
  expect(markets: Market[]): Expectation;
}

const CASES: Case[] = [
  {
    // The threshold filter's live counterpart. A $60k market must never answer
    // a $150k take, so when no $150k market is live the only correct move is silence.
    tweet: "there's no way bitcoin closes above 150k this year, cope harder",
    expect(markets) {
      const set = markets.filter((m) => RE_BTC.test(m.question) && RE_150K.test(m.question) && farOff(m));
      return set.length
        ? { kind: "one-of", set, why: `${set.length} live BTC $150k market(s) with a far horizon` }
        : {
            kind: "null",
            why: "no live BTC $150k long-horizon market; matching a different strike would be the bug",
          };
    },
  },
  {
    // The direction filter's live counterpart.
    tweet: "the fed is 100% cutting rates next meeting, book it",
    expect(markets) {
      const set = markets.filter((m) =>
        RE_RATE.test(m.question) && RE_DOWN.test(m.question) &&
        !RE_FLAT.test(m.question) && !RE_ZERO_CUTS.test(m.question) &&
        !RE_COUNT_SPLIT.test(m.question));
      return set.length
        ? { kind: "one-of", set, why: `${set.length} live Fed rate-cut market(s)` }
        : { kind: "null", why: "no live Fed cut market; a no-change or hike market would misread the take" };
    },
  },
  {
    // The 0.200 calibration case from matcher.ts, exercised against live data.
    // Only "fed" overlaps, so this is the weakest match the bar still admits.
    tweet: "no way the fed cuts, they're hiking again",
    expect(markets) {
      const set = markets.filter((m) => RE_RATE.test(m.question) && RE_UP.test(m.question) && !RE_FLAT.test(m.question));
      return set.length
        ? { kind: "one-of", set, why: `${set.length} live Fed rate-hike market(s)` }
        : { kind: "null", why: "no live Fed hike market" };
    },
  },
  {
    tweet: "trump is winning the popular vote easily, not even close",
    expect(markets) {
      const set = markets.filter((m) => RE_POPVOTE.test(m.question));
      return set.length
        ? { kind: "one-of", set, why: `${set.length} live popular-vote market(s)` }
        : { kind: "null", why: "no live popular-vote market" };
    },
  },
  {
    // Off-topic under every market set. If this ever matches, the bar is broken.
    tweet: "my cat is cuter than yours and that's just facts",
    expect: () => ({ kind: "null", why: "off-topic; no market set should ever answer this" }),
  },
];

// --- Live template-family assertion ------------------------------------------
//
// The one false-match class that the matched:false rate cannot see. A venue
// lists one market per outcome, so the board carries families of near-identical
// questions: "Will France win the 2026 FIFA World Cup?", "Will Spain win…". The
// shared core clears the bar by itself, so a take naming no team does not go
// silent — it reports a confident match on whichever sibling is busiest.
//
// Because that is indistinguishable from a real match in the Week-1 numbers, it
// gets its own live assertion here rather than being inferred from the miss
// rate. Both halves are derived from whatever family is actually live today:
//
//   core alone            -> must be silent   (no team named)
//   core + one member's own word -> must match THAT member
//
// Nothing is hardcoded: if the World Cup rolls off the board, the check finds
// whatever family replaced it, and says so if there is none.

const stem = (t: string) => { const s = t.replace(/(?:ing|es|s)$/, ""); return s.length < 3 ? t : s.replace(/(\w)\1$/, "$1"); };
const stemSet = (q: string) => new Set(tokenize(q).map(stem));

/** Markets whose structure the matcher resolves on numbers or direction are not
 *  template families — parseThreshold and parseDirection already tell them apart. */
const structural = (q: string) => /\$|\bfed\b|\brates?\b|bitcoin|ethereum|solana|xrp/i.test(q);

/**
 * The largest set of markets sharing a core of >= 4 words, where every member
 * also has a word no other member has.
 *
 * The bounds are what make the constructed takes MEAN anything. A looser family
 * ("29 markets sharing the word `match`") yields a one-word core, and a one-word
 * take is rejected by the short-take gate rather than by the family rule — the
 * check would go red without ever exercising what it claims to test. The core
 * must be long enough to clear that gate on its own.
 */
function largestFamily(markets: Market[]): Market[] {
  const pool = markets.filter((m) => !structural(m.question) && stemSet(m.question).size >= 5);
  let best: Market[] = [];
  for (const seed of pool) {
    const a = stemSet(seed.question);
    const fam = pool.filter((m) => {
      const b = stemSet(m.question);
      let shared = 0;
      for (const t of a) if (b.has(t)) shared++;
      return shared >= 4 && shared / Math.min(a.size, b.size) >= 0.8;
    });
    if (fam.length <= best.length) continue;

    const sets = fam.map((m) => stemSet(m.question));
    const core = [...sets[0]].filter((t) => sets.every((s) => s.has(t)));
    if (core.length < 4) continue; // a take built from this core would be too short to test anything
    // Every member needs a word of its own. Token-identical twins have none, and
    // are a separate (still open) problem.
    const everyoneDistinct = sets.every((s, i) => [...s].some((t) => sets.every((o, j) => j === i || !o.has(t))));
    if (everyoneDistinct) best = fam;
  }
  return best;
}

// --- Live positive-match assertion ------------------------------------------
//
// Take a real live market, paraphrase its own question into a take, and require
// the matcher to hand that market back. This is the check that fails if the bar
// eats everything, or if a hard filter starts excluding unconditionally — both
// of which look like healthy silence from the miss cases above.

const STOP = new Set("a an and are as at be but by for from has have in is it of on or that the this to was were will with what when who how do does did not no yes than then so we our us about over under into out up down".split(" "));

/** Selection-only tokenizer. Assertions never depend on it — it just picks a market. */
function roughTokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t));
}

/**
 * Kalshi returns some multi-leg parlays whose "question" is a comma-joined list
 * of legs ("yes 8+ corners,yes Lionel Messi: 1+,…") rather than a question. Those
 * are the most lexically distinctive strings in the set by a mile, so the picker
 * below would always choose one, and the strongest assertion in this suite would
 * end up exercising the least realistic market we have. Skip them.
 */
const looksLikeQuestion = (q: string) => q.length <= 140 && (q.match(/,/g)?.length ?? 0) <= 1;

/** The market whose question shares the fewest words with any other market. */
function mostDistinctive(markets: Market[]): Market | null {
  const df = new Map<string, number>();
  for (const m of markets) for (const t of new Set(roughTokens(m.question))) df.set(t, (df.get(t) ?? 0) + 1);

  const scored = markets
    .filter((m) => farOff(m) && looksLikeQuestion(m.question) && roughTokens(m.question).length >= 4)
    .map((m) => ({ m, unique: [...new Set(roughTokens(m.question))].filter((t) => df.get(t) === 1).length }))
    .filter((x) => x.unique >= 3)
    .sort((a, b) => b.unique - a.unique || b.m.volumeUsd - a.m.volumeUsd || key(a.m).localeCompare(key(b.m)));

  return scored.length ? scored[0].m : null;
}

/** "Will X happen in 2026?" -> "hot take: X happen in 2026 — calling it now" */
function paraphrase(question: string): string {
  const core = question.replace(/^\s*will\s+/i, "").replace(/\s*\?+\s*$/, "");
  return `hot take: ${core} — calling it now`;
}

async function main() {
  let data: Awaited<ReturnType<typeof getMarketData>>;
  if (USE_FIXTURE) {
    if (!existsSync(FIXTURE)) {
      console.error("no fixture at scripts/fixtures/markets.json — run: npm run smoke -- --write-fixture");
      process.exit(1);
    }
    const snap = JSON.parse(readFileSync(FIXTURE, "utf8")) as { capturedAt: string; markets: Market[] };
    console.log(`Using the committed market snapshot (${snap.markets.length} markets, captured ${snap.capturedAt}).`);
    // The venue block is skipped wholesale below: a snapshot cannot tell you
    // whether Polymarket is up, and pretending otherwise is the exact confusion
    // this split exists to remove.
    data = { markets: snap.markets, feed: snap.markets, all: snap.markets,
             venues: {} as typeof data.venues, stale: false, ageMs: 0 };
  } else {
    console.log("Fetching live markets from Kalshi + Polymarket…");
    data = await getMarketData(true);
  }
  const markets = data.markets;
  console.log(`Got ${markets.length} markets.\n`);

  if (WRITE_FIXTURE) {
    writeFileSync(new URL("./fixtures/", import.meta.url).pathname + "markets.json",
      JSON.stringify({ capturedAt: new Date().toISOString(), markets }, null, 0));
    console.log(`Wrote scripts/fixtures/markets.json (${markets.length} markets).`);
  }

  // Without these, an empty (or half-empty) market list makes every "expect
  // null" case below pass and the suite reports green while a venue is down.
  // A total-count check is not enough: Polymarket alone clears any total
  // threshold, so a Kalshi outage would sail straight through it.
  // Green must mean "every venue I turned on is healthy". A venue we chose not
  // to run is not a failure, and a venue we did turn on returning nothing is —
  // even if the other one carries the total past any threshold.
  console.log("preconditions");
  if (USE_FIXTURE) console.log("  - venue health not checked: this run is against a snapshot (see npm run smoke)");
  for (const [name, st] of Object.entries(USE_FIXTURE ? {} : data.venues)) {
    if (!st.enabled) {
      console.log(`  - ${name} disabled by configuration (not expected to contribute)`);
      continue;
    }
    precondition(`${name} returned markets (${st.count})`, st.count > 0, st.error ?? "fetch succeeded but returned 0 markets");
    // A venue that answers with a handful of markets is up but not healthy, and
    // `count > 0` will happily call that green. Not a failure — venues legitimately
    // thin out — but it must be visible, because it skews the matched:false rate.
    if (st.ok && st.count > 0 && st.count < 5) {
      console.warn(`  ! ${name} looks degraded: only ${st.count} market(s); matched:false rates will lean on the other venue`);
    }
  }
  // This used to require BOTH venues, with a note saying that if Kalshi were
  // ever deliberately turned off, this line was the decision that had to be
  // edited in the open. Editing it, in the open:
  //
  // KALSHI IS OFF BY PRODUCT DECISION, not by outage. It has defaulted off
  // (ENABLE_KALSHI) throughout, and the real-money work made the exclusion
  // explicit — Polymarket is the venue we source, Kalshi is deliberately not.
  // So the assertion now names the venue we actually ship and reports Kalshi's
  // state without failing on it.
  //
  // What the old line cost: it failed on EVERY run, which is precisely how a
  // suite stops being read. The trade-off it was protecting against is real
  // and unchanged — Kalshi was the only source of Fed, CPI and U-3 prices, so
  // economics takes now go unanswered — but that is a known consequence of the
  // decision, not a regression this run should be re-discovering each time.
  if (!USE_FIXTURE) {
    const off = Object.entries(data.venues).filter(([, st]) => !st.enabled).map(([n]) => n);
    precondition("the venue we ship (polymarket) is enabled", data.venues.polymarket.enabled === true,
      `switched off: ${off.join(", ") || "none"}`);
    if (off.length) console.log(`  - not shipping: ${off.join(", ")} (by configuration, not an outage)`);
    precondition("serving fresh data, not a stale cache", !data.stale, `last good set is ${Math.round(data.ageMs / 1000)}s old`);
  }
  check(
    `market set is large enough to assert on (${markets.length})`,
    markets.length >= 20,
    "the miss assertions below would pass vacuously",
  );

  if (markets.length === 0) {
    console.error("\nno markets; refusing to report on an empty set.");
    process.exit(1);
  }

  console.log("\nlive positive match (paraphrase of a real market's own question)");
  const pick = mostDistinctive(markets);
  if (!pick) {
    check("found a lexically distinctive live market to paraphrase", false, "no market had >=3 words unique to it");
  } else {
    const tweet = paraphrase(pick.question);
    const r = matchTweet(tweet, markets);
    console.log(`  market: [${pick.venue}] "${pick.question}"`);
    console.log(`  tweet:  "${tweet}"`);
    check("a paraphrase of a live market matches something", r !== null, "matcher returned null — the bar or a filter is eating everything");
    if (r) {
      const self = matchTweet(tweet, [pick], 0);
      check(
        "…and matches that exact market",
        key(r.market) === key(pick),
        `matched ${describe(r)} instead; the source market scores ${self ? self.score.toFixed(3) : "n/a"} on its own`,
      );
    }
  }

  // --- template families ----------------------------------------------------
  console.log("\ntemplate families (invisible to the matched:false rate)");
  {
    const fam = largestFamily(markets);
    if (fam.length < 3) {
      precondition("a template family is live to test against", false, `largest family has ${fam.length} members`);
    } else {
      const sets = fam.map((m) => stemSet(m.question));
      const core = [...sets[0]].filter((t) => sets.every((s) => s.has(t)));
      const own = (i: number) => [...sets[i]].filter((t) => sets.every((s, j) => j === i || !s.has(t)));

      console.log(`  family of ${fam.length}: "${fam[0].question}"`);
      console.log(`  shared core: ${core.join(" ")}`);

      // The core alone names no member. Anything but silence is a wrong card.
      const coreTweet = core.join(" ");
      const r = matchTweet(coreTweet, markets);
      check(
        `"${coreTweet}" (core only, names no member) -> silence`,
        r === null,
        `matched ${describe(r)} — the family's shared words alone cleared the bar`,
      );

      // …and naming one member must still reach that member, not a busier sibling.
      const busiest = [...fam].sort((a, b) => b.volumeUsd - a.volumeUsd)[0];
      const target = fam.find((m, i) => m !== busiest && own(i).length > 0);
      const idx = target ? fam.indexOf(target) : -1;
      if (!target || idx < 0) {
        precondition("a non-busiest family member has a word of its own", false, "every member is token-identical");
      } else {
        const named = `${own(idx)[0]} ${coreTweet}`;
        const r2 = matchTweet(named, markets);
        check(
          `"${named}" -> that member, not the busier "${busiest.question.slice(0, 34)}…"`,
          r2?.market.venueId === target.venueId,
          `expected "${target.question}" ($${Math.round(target.volumeUsd)}), got ${describe(r2)}`,
        );
      }
    }
  }

  console.log("\nsample tweets");
  let firstMatch: Market | null = null;

  for (const c of CASES) {
    const r = matchTweet(c.tweet, markets);
    const exp = c.expect(markets);
    console.log(`\n  "${c.tweet}"`);
    console.log(`    -> ${describe(r)}`);
    console.log(`    expected: ${exp.kind === "null" ? "no match" : "one of " + exp.set.length} (${exp.why})`);

    if (exp.kind === "null") {
      check("no match", r === null, `matched ${describe(r)}`);
    } else {
      const allowed = new Set(exp.set.map(key));
      check("matched", r !== null, "got null while a suitable live market exists");
      if (r) {
        check(
          "matched a market from the expected set",
          allowed.has(key(r.market)),
          `matched ${describe(r)}; expected one of:\n        ` + exp.set.map((m) => `"${m.question}"`).join("\n        "),
        );
      }
    }
    if (r && !firstMatch) firstMatch = r.market;
  }

  if (firstMatch) {
    writeFileSync("card-sample.svg", renderCard(firstMatch));
    console.log("\nWrote card-sample.svg — open it to see the slip on real odds.");
  }

  console.log();
  if (failures > 0) console.error(`${failures} assertion(s) failed — this is a code problem.`);
  if (envFailures > 0)
    console.error(
      `${envFailures} precondition(s) failed — a venue is down, not a matcher regression. ` +
        `Re-run with SMOKE_ALLOW_DEGRADED=1 to test against whatever is up.`,
    );
  if (failures > 0 || envFailures > 0) process.exit(1);
  console.log("all live checks passed.");
}

main().catch((e) => {
  console.error("smoke failed:", e);
  process.exit(1);
});
