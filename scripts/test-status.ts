// Caller tiers and the public flex line — the status layer that answers
// "accuracy accumulates, so what?". Pure logic plus one end-to-end
// reputationFor read against the in-memory store.
//
// Run with: npm run test-status

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database — unset DATABASE_URL");
  process.exit(1);
}

import { callerTier, oddieScoreFrom, ORACLE_TOP_PCT, SHARP_TOP_PCT } from "../src/store/economy.js";
import { flexLine, reputationFor } from "../src/store/markets.js";
import type { AccuracyRecord } from "../src/store/markets.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

// Typed, NOT cast. `as AccuracyRecord` on a partial literal is how the ladder
// fields stayed undefined here while the real record carried them, which is
// precisely how a NaN reached a share card with every test green.
const acc = (o: Partial<AccuracyRecord>): AccuracyRecord => ({
  resolved: 40, correct: 31, accuracyPct: 78, oddieScore: 640, meanEdge: 0.14,
  hasEnough: true, minResolved: 10, streak: 3, bestStreak: 7, bestTopic: null,
  byCategory: [], marketsCreated: 0, contributionPoints: 0, tradersReached: 0,
  ...o,
});

console.log("\ncallerTier: the ladder is short, and every rung is loudness");
{
  check("top 5% earns Loudest",
    callerTier({ hasEnough: true, oddieScore: 700, topPct: ORACLE_TOP_PCT })?.id === "oracle");
  check("top 25% earns Loud",
    callerTier({ hasEnough: true, oddieScore: 600, topPct: SHARP_TOP_PCT })?.id === "sharp");
  check("tagging a market outside the top 25% still earns the entry rung",
    callerTier({ hasEnough: true, oddieScore: 600, marketsCreated: 2, topPct: 60 })?.id === "proven");
  check("the best qualifying tier wins, not the last one checked",
    callerTier({ hasEnough: true, oddieScore: 999, marketsCreated: 9, topPct: 2 })?.id === "oracle");

  // The point of a status label is that it can be WITHHELD.
  check("points alone earn no tier: the entry rung is for putting markets up",
    callerTier({ hasEnough: true, oddieScore: 9000, marketsCreated: 0, topPct: 60 }) === null,
    "a big score off shares and posts must not read as having tagged anything");
  check("an empty record earns no tier however good it looks",
    callerTier({ hasEnough: false, oddieScore: 950, topPct: 1 }) === null);
  check("no score at all earns no tier",
    callerTier({ hasEnough: true, oddieScore: null, topPct: 1 }) === null);
  check("unranked but tagging still earns the entry rung (rank is optional)",
    callerTier({ hasEnough: true, oddieScore: 700, marketsCreated: 1, topPct: null })?.id === "proven");
  check("unranked with nothing tagged earns nothing",
    callerTier({ hasEnough: true, oddieScore: 300, marketsCreated: 0, topPct: null }) === null);
  check("edge is ignored entirely now, whatever it says",
    callerTier({ hasEnough: true, oddieScore: 600, meanEdge: 0.9, marketsCreated: 0, topPct: 60 }) === null);
}

console.log("\noddieScoreFrom: the score is a loudness ladder");
{
  // Score measures how much you brought oddie, not how right you were. Two
  // sources, and only two: markets you put on the board, and the growth ledger.
  const loud  = oddieScoreFrom({ marketsCreated: 4, contributionPoints: 0, resolvedCalls: 0, meanEdge: null });
  const quiet = oddieScoreFrom({ marketsCreated: 0, contributionPoints: 0, resolvedCalls: 40, meanEdge: 0.9 });
  check("surfacing four markets outranks forty perfectly-called positions",
    loud > quiet, `loud ${loud} vs quiet ${quiet}`);
  check("...because taking a position pays nothing at all", quiet === 0, String(quiet));

  const base = { marketsCreated: 5, contributionPoints: 0, resolvedCalls: 20 };
  check("being right no longer moves the score",
    oddieScoreFrom({ ...base, meanEdge: 0.9 }) === oddieScoreFrom({ ...base, meanEdge: -0.9 }));
  check("...and neither does a missing edge",
    oddieScoreFrom({ ...base, meanEdge: null }) === oddieScoreFrom({ ...base, meanEdge: 0 }));

  check("doing nothing is no score", oddieScoreFrom({ marketsCreated: 0, contributionPoints: 0, resolvedCalls: 0, meanEdge: null }) === 0);
  check("creating markets is the ladder's big rung",
    oddieScoreFrom({ marketsCreated: 1, contributionPoints: 0, resolvedCalls: 0, meanEdge: null }) === 100);

  /* THE MULTIPLIER BLOCK IS GONE WITH THE MULTIPLIER. It asserted that a
     posting streak doubled the markets half of the score, which is the mechanic
     X revoked API access over on 2026-01-15. There is nothing to rewrite these
     into: the score is now tagged markets plus the growth ledger, and nothing a
     person posts moves it. The two assertions below survive because they pin
     the ledger half, which did not change. */
  check("the promised delta is exact: +150 oddies for a 75-point ledger event",
    oddieScoreFrom({ marketsCreated: 0, contributionPoints: 75, resolvedCalls: 0, meanEdge: null }) === 150);
  /* AND THE CLAMP ASSERTION IS DELETED RATHER THAN ADAPTED, because it never
     tested the clamp. With contributionPoints at 0 the expected 300 is
     3 x 100 whether or not a clamp exists, so it would have stayed green if
     Math.max(1, ...) had been deleted years ago. A test that cannot fail is
     worse than no test: it reads as coverage. */
}

console.log("\nthe farm is pointed at X, on purpose");
{
  // The growth bet, pinned. Loudness is meant to be the cheapest way up, so
  // these orderings are load-bearing product decisions and not incidental
  // arithmetic: if a re-weighting ever inverts one, that should fail here
  // rather than be discovered from a leaderboard nobody recognises.
  const farmer = oddieScoreFrom({ resolvedCalls: 0, marketsCreated: 5, contributionPoints: 490, meanEdge: null });
  const sharp  = oddieScoreFrom({ resolvedCalls: 8, marketsCreated: 0, contributionPoints: 0,   meanEdge: 0.25 });
  check("a loud farmer outranks a sharp lurker by a wide margin", farmer > sharp * 5, `${farmer} vs ${sharp}`);

  const oneMarket = oddieScoreFrom({ resolvedCalls: 0, marketsCreated: 1, contributionPoints: 0, meanEdge: null });
  const oneLedgerEvent = oddieScoreFrom({ resolvedCalls: 0, marketsCreated: 0, contributionPoints: 40, meanEdge: null });
  check("tagging a market outranks any single growth-ledger event",
    oneMarket > oneLedgerEvent, `${oneMarket} vs ${oneLedgerEvent}`);

  const before = oddieScoreFrom({ resolvedCalls: 0, marketsCreated: 3, contributionPoints: 0, meanEdge: null });
  const after  = oddieScoreFrom({ resolvedCalls: 0, marketsCreated: 4, contributionPoints: 0, meanEdge: null });
  check("a market pays THE MOMENT it is minted, before anyone plays it",
    after > before, `${before} -> ${after}`);
}

/**
 * Two naming systems now sit on one screen: the worn TIER (callerTier) and the
 * collected STAMPS (achievementsFor). They are different mechanics, so both can
 * exist, but a word that means two different achievements in one product is a
 * bug. "Loudest" was briefly both the top 5% of the board and a weekly win.
 */
console.log("\nno tier name and stamp name mean two different things");
{
  const { achievementsFor, accuracyFor } = await import("../src/store/markets.js");
  const tierNames = [ORACLE_TOP_PCT, SHARP_TOP_PCT, 60]
    .map((topPct) => callerTier({ hasEnough: true, oddieScore: 900, marketsCreated: 3, topPct }))
    .filter(Boolean)
    .map((t) => t!.label);
  const stamps = await achievementsFor("dev-name-collision", await accuracyFor("dev-name-collision"), null, null);
  const clash = stamps.map((a) => a.name).filter((n) => tierNames.includes(n));
  check("every tier is named", tierNames.length === 3, tierNames.join(", "));
  /* EXACT, not >=. Three stamps went with the posting mechanic (Cleared,
     Triple Clear, Week Won) and the sheet is 11. A >= re-armed at the new
     number would silently permit the next deletion to shrink it again. */
  check("the sheet is full", stamps.length === 11, String(stamps.length));
  check("...and no stamp borrows a tier's name", clash.length === 0, clash.join(", "));
  check("...nor does any stamp name repeat another", 
    new Set(stamps.map((a) => a.name)).size === stamps.length,
    stamps.map((a) => a.name).join(", "));
}

console.log("\nflexLine: the postable brag, and only claims the data supports");
{
  const loud = (o: Partial<AccuracyRecord>) => flexLine(acc(o), { category: "Crypto", pctile: 3 });
  check("what you brought",
    loud({ marketsCreated: 4 }) === "4 markets tagged", loud({ marketsCreated: 4 }));
  check("singular at exactly one",
    loud({ marketsCreated: 1 }) === "1 market tagged", loud({ marketsCreated: 1 }));
  // tradersReached is permanently 0 (it counts rows in the dead play-token
  // table), so a brag that quoted it could never say what it looked like it said.
  check("the dead reach count can never leak into the brag",
    !loud({ marketsCreated: 4, tradersReached: 12 }).includes("player"),
    loud({ marketsCreated: 4, tradersReached: 12 }));
  check("points without a market still say something true",
    loud({ marketsCreated: 0, oddieScore: 300 }) === "300 oddies earned");
  check("a brand-new device is honest about it",
    loud({ marketsCreated: 0, oddieScore: null }) === "not on the board yet");

  // The brag goes into a TWEET. Anything that can render as NaN or null in it
  // is published under the user's name on the product's own channel.
  for (const o of [{}, { marketsCreated: 3 }, { marketsCreated: 0, oddieScore: 0 },
                   { resolved: 0, accuracyPct: null, hasEnough: true }] as Partial<AccuracyRecord>[]) {
    const line = flexLine(acc(o), null);
    check(`postable, never NaN or null: ${JSON.stringify(o)}`,
      !/NaN|null|undefined/.test(line), line);
  }
}

// The class of bug that hid the NaN: every check above builds an AccuracyRecord
// by hand, so it can only ever test what the author remembered to put in it.
// This one goes through the REAL computeAccuracy on the real store.
console.log("\nthe record a live device actually gets is postable");
{
  const { _memSeasonCredit, accuracyFor, reputationFor } = await import("../src/store/markets.js");
  const dev = "dev-postable-check";
  _memSeasonCredit(dev, 50);
  const real = await accuracyFor(dev);
  check("a real ladder record has a score", (real.oddieScore ?? 0) > 0, String(real.oddieScore));
  check("...and accuracyPct is null, not NaN, with nothing resolved",
    real.accuracyPct === null, String(real.accuracyPct));
  check("...and every number in it is finite or null",
    [real.oddieScore, real.accuracyPct, real.meanEdge].every((v) => v === null || Number.isFinite(v)),
    JSON.stringify({ s: real.oddieScore, a: real.accuracyPct, e: real.meanEdge }));
  const rep = await reputationFor(dev);
  check("...and the line it would post carries no NaN or null",
    !/NaN|null|undefined/.test(rep.flexLine), rep.flexLine);
}

console.log("\nsmall fields cannot mint status");
{
  // The formula that produced these is fine; the STATEMENT it makes about a
  // tiny field is not. #1 of 1 is "top 100%" arithmetically, and a field of
  // four would hand first place a Loud tier for beating three people.
  check("a percentile is withheld until the field is big enough: the tier falls back to the entry rung",
    callerTier({ hasEnough: true, oddieScore: 918, marketsCreated: 6, topPct: null })?.id === "proven");
  check("...and never reads as 'top 100%' by leaking a degenerate percentile through",
    callerTier({ hasEnough: true, oddieScore: 918, marketsCreated: 6, topPct: 100 })?.id === "proven");
  check("a real top-5% field still earns Loudest",
    callerTier({ hasEnough: true, oddieScore: 918, marketsCreated: 6, topPct: 4 })?.id === "oracle");
}

console.log("\nreputationFor: one read, consistent across every surface");
{
  const rep = await reputationFor("status-test-device-01");
  check("an unknown device resolves rather than throwing", !!rep, JSON.stringify(rep).slice(0, 80));
  check("...with no tier invented for it", rep.tier === null, JSON.stringify(rep.tier));
  check("...no rank", rep.rank === null);
  check("...and an honest flex line", rep.flexLine === "not on the board yet", rep.flexLine);
  check("...and a handle that was never minted as a side effect of looking",
    typeof rep.handle === "string" && rep.handle.length > 0, rep.handle);
}

console.log(failures === 0 ? "\nall status checks passed.\n" : `\n${failures} status check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
