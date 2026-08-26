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

const acc = (o: Partial<AccuracyRecord>): AccuracyRecord => ({
  resolved: 40, correct: 31, accuracyPct: 78, oddieScore: 640, meanEdge: 0.14,
  hasEnough: true, minResolved: 10, streak: 3, bestStreak: 7, bestTopic: null,
  ...o,
} as AccuracyRecord);

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

  // The multiplier is the reward for being loud CONSISTENTLY, so it lifts the
  // markets you surfaced. It must not touch ledger points, because those are
  // quoted to the user as exact oddies ("+150 when your post clears").
  const withMult = oddieScoreFrom({ marketsCreated: 3, contributionPoints: 75, resolvedCalls: 0, meanEdge: null, loudMultiplier: 2 });
  const noMult   = oddieScoreFrom({ marketsCreated: 3, contributionPoints: 75, resolvedCalls: 0, meanEdge: null });
  check("a loud streak doubles the markets half", withMult - 150 === (noMult - 150) * 2, `${withMult} vs ${noMult}`);
  check("...and leaves the ledger half at face value", withMult - noMult === 300, String(withMult - noMult));
  check("the promised delta is exact: +150 oddies for a 75-point ledger event",
    oddieScoreFrom({ marketsCreated: 0, contributionPoints: 75, resolvedCalls: 0, meanEdge: null }) === 150);
  check("a multiplier below 1 can never shrink a score", 
    oddieScoreFrom({ marketsCreated: 3, contributionPoints: 0, resolvedCalls: 0, meanEdge: null, loudMultiplier: 0 }) === 300);
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
  const oneShare  = oddieScoreFrom({ resolvedCalls: 0, marketsCreated: 0, contributionPoints: 40, meanEdge: null });
  check("tagging a market outranks sharing one: the tag is the loud axis",
    oneMarket > oneShare, `${oneMarket} vs ${oneShare}`);

  const before = oddieScoreFrom({ resolvedCalls: 0, marketsCreated: 3, contributionPoints: 0, meanEdge: null });
  const after  = oddieScoreFrom({ resolvedCalls: 0, marketsCreated: 4, contributionPoints: 0, meanEdge: null });
  check("a market pays THE MOMENT it is minted, before anyone plays it",
    after > before, `${before} -> ${after}`);
}

console.log("\nflexLine: the postable brag, and only claims the data supports");
{
  check("full line with a qualifying category",
    flexLine(acc({}), { category: "Crypto", pctile: 3 }) === "78% accuracy across 40 calls · top 3% in Crypto",
    flexLine(acc({}), { category: "Crypto", pctile: 3 }));
  check("no qualifying category drops the clause rather than faking one",
    flexLine(acc({}), null) === "78% accuracy across 40 calls",
    flexLine(acc({}), null));
  check("singular 'call' at exactly one resolved",
    flexLine(acc({ resolved: 1, hasEnough: false, accuracyPct: null }), null) === "1 call resolved · building a track record",
    flexLine(acc({ resolved: 1, hasEnough: false, accuracyPct: null }), null));
  check("a provisional record never quotes a percentage",
    !flexLine(acc({ resolved: 4, hasEnough: false, accuracyPct: null }), { category: "Crypto", pctile: 3 }).includes("%"),
    flexLine(acc({ resolved: 4, hasEnough: false, accuracyPct: null }), { category: "Crypto", pctile: 3 }));
  check("a brand-new device reads as building, not as 0%",
    flexLine(acc({ resolved: 0, hasEnough: false, accuracyPct: null }), null) === "building a track record");
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
  check("...and an honest flex line", rep.flexLine === "building a track record", rep.flexLine);
  check("...and a handle that was never minted as a side effect of looking",
    typeof rep.handle === "string" && rep.handle.length > 0, rep.handle);
}

console.log(failures === 0 ? "\nall status checks passed.\n" : `\n${failures} status check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
