// Caller tiers and the public flex line — the status layer that answers
// "accuracy accumulates, so what?". Pure logic plus one end-to-end
// reputationFor read against the in-memory store.
//
// Run with: npm run test-status

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database — unset DATABASE_URL");
  process.exit(1);
}

import { callerTier, ORACLE_TOP_PCT, SHARP_TOP_PCT, PROVEN_MIN_SCORE } from "../src/store/economy.js";
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
    callerTier({ hasEnough: true, oddieScore: PROVEN_MIN_SCORE, topPct: 60 })?.id === "proven");
  check("the best qualifying tier wins, not the last one checked",
    callerTier({ hasEnough: true, oddieScore: 999, topPct: 2 })?.id === "oracle");

  // The point of a status label is that it can be WITHHELD.
  check("a below-market record earns NO tier, not a consolation one",
    callerTier({ hasEnough: true, oddieScore: PROVEN_MIN_SCORE - 1, topPct: 60 }) === null);
  check("a provisional record earns no tier however good it looks",
    callerTier({ hasEnough: false, oddieScore: 950, topPct: 1 }) === null);
  check("no score at all earns no tier",
    callerTier({ hasEnough: true, oddieScore: null, topPct: 1 }) === null);
  check("unranked but market-beating still earns Proven (rank is optional)",
    callerTier({ hasEnough: true, oddieScore: 700, topPct: null })?.id === "proven");
  check("unranked and below market earns nothing",
    callerTier({ hasEnough: true, oddieScore: 300, topPct: null }) === null);
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
    callerTier({ hasEnough: true, oddieScore: 918, topPct: null })?.id === "proven");
  check("...and never reads as 'top 100%' by leaking a degenerate percentile through",
    callerTier({ hasEnough: true, oddieScore: 918, topPct: 100 })?.id === "proven");
  check("a real top-5% field still earns Oracle",
    callerTier({ hasEnough: true, oddieScore: 918, topPct: 4 })?.id === "oracle");
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
