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

console.log("\ncallerTier: the ladder is short, and every rung is above the market");
{
  check("top 5% earns Oracle",
    callerTier({ hasEnough: true, oddieScore: 700, topPct: ORACLE_TOP_PCT })?.id === "oracle");
  check("top 25% earns Sharp Caller",
    callerTier({ hasEnough: true, oddieScore: 600, topPct: SHARP_TOP_PCT })?.id === "sharp");
  check("beating the market outside the top 25% earns Proven Caller",
    callerTier({ hasEnough: true, oddieScore: 600, meanEdge: 0.04, topPct: 60 })?.id === "proven");
  check("the best qualifying tier wins, not the last one checked",
    callerTier({ hasEnough: true, oddieScore: 999, topPct: 2 })?.id === "oracle");

  // The point of a status label is that it can be WITHHELD.
  check("a below-market record earns NO tier, not a consolation one",
    callerTier({ hasEnough: true, oddieScore: 9000, meanEdge: -0.02, topPct: 60 }) === null,
    "a huge score off pure activity must not buy a tier that claims edge");
  check("a provisional record earns no tier however good it looks",
    callerTier({ hasEnough: false, oddieScore: 950, topPct: 1 }) === null);
  check("no score at all earns no tier",
    callerTier({ hasEnough: true, oddieScore: null, topPct: 1 }) === null);
  check("unranked but market-beating still earns Proven (rank is optional)",
    callerTier({ hasEnough: true, oddieScore: 700, meanEdge: 0.1, topPct: null })?.id === "proven");
  check("unranked and below market earns nothing",
    callerTier({ hasEnough: true, oddieScore: 300, meanEdge: -0.1, topPct: null }) === null);
}

console.log("\noddieScoreFrom: activity sets the size, accuracy scales it");
{
  const busyAverage = oddieScoreFrom({ resolvedCalls: 40, marketsCreated: 2, contributionPoints: 100, meanEdge: 0 });
  const sharpRare   = oddieScoreFrom({ resolvedCalls: 5,  marketsCreated: 0, contributionPoints: 0,   meanEdge: 0.2 });
  check("a busy average caller outranks a sharp rare one — the whole point of the reweighting",
    busyAverage > sharpRare, `busy ${busyAverage} vs sharp ${sharpRare}`);

  const base = { resolvedCalls: 20, marketsCreated: 0, contributionPoints: 0 };
  const neutral = oddieScoreFrom({ ...base, meanEdge: 0 });
  const good    = oddieScoreFrom({ ...base, meanEdge: 0.2 });
  const bad     = oddieScoreFrom({ ...base, meanEdge: -0.2 });
  check("being right raises the same activity", good > neutral, `${good} > ${neutral}`);
  check("being wrong LOWERS it — a big base must be shrinkable, or accuracy is decorative",
    bad < neutral, `${bad} < ${neutral}`);
  check("...but accuracy never swings it more than half either way",
    good <= neutral * 1.5 + 1 && bad >= neutral * 0.5 - 1, `${bad}..${good} around ${neutral}`);

  check("no activity is no score, however good the edge",
    oddieScoreFrom({ resolvedCalls: 0, marketsCreated: 0, contributionPoints: 0, meanEdge: 0.9 }) === 0);
  check("creating markets counts even with nothing resolved",
    oddieScoreFrom({ resolvedCalls: 0, marketsCreated: 4, contributionPoints: 0, meanEdge: null }) > 0);
  check("a null edge is treated as market-neutral, not as a penalty",
    oddieScoreFrom({ resolvedCalls: 10, marketsCreated: 0, contributionPoints: 0, meanEdge: null }) ===
    oddieScoreFrom({ resolvedCalls: 10, marketsCreated: 0, contributionPoints: 0, meanEdge: 0 }));
}

console.log("\nthe farm is pointed at volume and at X, on purpose");
{
  // The growth bet, pinned. Loudness is meant to be the cheapest way up, so
  // these orderings are load-bearing product decisions and not incidental
  // arithmetic — if a re-weighting ever inverts one, that should fail here
  // rather than be discovered from a leaderboard nobody recognises.
  const farmer = oddieScoreFrom({ callsMade: 60, resolvedCalls: 0, marketsCreated: 5, contributionPoints: 490, meanEdge: null });
  const sharp  = oddieScoreFrom({ callsMade: 8,  resolvedCalls: 8, marketsCreated: 0, contributionPoints: 0,   meanEdge: 0.25 });
  check("a loud farmer outranks a sharp lurker by a wide margin", farmer > sharp * 5, `${farmer} vs ${sharp}`);

  const oneMarket = oddieScoreFrom({ callsMade: 0, resolvedCalls: 0, marketsCreated: 1, contributionPoints: 0, meanEdge: null });
  const calls     = oddieScoreFrom({ callsMade: 15, resolvedCalls: 0, marketsCreated: 0, contributionPoints: 0, meanEdge: null });
  check("tagging ONE market on X beats fifteen calls — X is the loud axis",
    oneMarket > calls, `${oneMarket} vs ${calls}`);

  const before = oddieScoreFrom({ callsMade: 10, resolvedCalls: 0, marketsCreated: 0, contributionPoints: 0, meanEdge: null });
  const after  = oddieScoreFrom({ callsMade: 11, resolvedCalls: 0, marketsCreated: 0, contributionPoints: 0, meanEdge: null });
  check("a call pays THE MOMENT it is made, before anything resolves",
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
  // four would hand first place a Sharp Caller tier for beating three people.
  check("a percentile is withheld until the field is big enough — the tier falls back to score",
    callerTier({ hasEnough: true, oddieScore: 918, meanEdge: 0.08, topPct: null })?.id === "proven");
  check("...and never reads as 'top 100%' by leaking a degenerate percentile through",
    callerTier({ hasEnough: true, oddieScore: 918, meanEdge: 0.08, topPct: 100 })?.id === "proven");
  check("a real top-5% field still earns Oracle",
    callerTier({ hasEnough: true, oddieScore: 918, meanEdge: 0.08, topPct: 4 })?.id === "oracle");
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
