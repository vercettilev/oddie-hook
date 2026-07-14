// The semantic pipeline's plumbing, with the referee mocked — every branch
// AROUND the LLM call, none of the LLM itself (scripts/eval-semantic.ts runs
// the real model against the frozen suite).
//
// What must be true whatever the model says:
//   - a confident lexical match never reaches the referee
//   - "none" from the referee is silence; so is any failure whatsoever
//   - the referee can only choose from candidates the correctness gates passed
//   - without an API key the stage is simply off (pre-semantic behaviour)
//
// Run with: npm run test-semantic

import { matchSemantic, buildCandidates, _setReferee } from "../src/matching/semantic.js";
import type { Market } from "../src/venues/types.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

const mk = (id: string, q: string, yesPct: number, volumeUsd: number, tags: string[] = []): Market =>
  ({ venue: "polymarket", venueId: id, question: q, yesPct, closesAt: "2026-12-31T00:00:00Z", volumeUsd, venueUrl: "x", tags });

const BOARD: Market[] = [
  mk("WC-FR", "Will France win the 2026 FIFA World Cup?", 39, 4_600_000, ["sports"]),
  mk("WC-AR", "Will Argentina win the 2026 FIFA World Cup?", 22, 3_100_000, ["sports"]),
  mk("BTC", "Will Bitcoin close above $70,000 in July?", 55, 2_000_000, ["crypto"]),
  mk("NG", "Will Natural Gas (NG) hit (LOW) $2.60 in July?", 41, 900_000, []),
  mk("FED", "Will the Fed cut interest rates in September?", 62, 1_500_000, ["economy"]),
];

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key-never-used";

console.log("\na confident lexical match never consults the referee");
{
  let called = 0;
  _setReferee(async () => { called++; return { pick: null, reason: "" }; });
  const r = await matchSemantic("will france win the 2026 fifa world cup? i say yes", BOARD);
  check("the match lands", r?.market.venueId === "WC-FR", JSON.stringify(r?.market.venueId));
  check("...via lexical", r?.via === "lexical");
  check("...with no reason attached", r?.reason === null);
  check("...and zero referee calls", called === 0, `${called}`);
}

console.log("\nzero-overlap tweet: the referee sees headline markets and may pick");
{
  const tweet = "Mbappé: until I see a trophy we are not the strongest";
  const cands = buildCandidates(tweet, BOARD);
  check("candidates exist despite zero overlap", cands.length > 0, `${cands.length}`);
  check("the France market is on the list (volume fill)", cands.some((c) => c.market.venueId === "WC-FR"));
  check("the priced NG market is NOT (price guard prunes candidates)",
    !cands.some((c) => c.market.venueId === "NG"), JSON.stringify(cands.map((c) => c.market.venueId)));

  _setReferee(async (_t, cs) => ({ pick: cs.findIndex((c) => c.market.venueId === "WC-FR") + 1, reason: "Mbappé is France's captain" }));
  const r = await matchSemantic(tweet, BOARD);
  check("the referee's pick comes back", r?.market.venueId === "WC-FR");
  check("...via semantic, reason logged", r?.via === "semantic" && r?.reason === "Mbappé is France's captain", JSON.stringify(r));
}

console.log("\n'none' is silence; so is every failure");
{
  _setReferee(async () => ({ pick: null, reason: "nostalgia post, no forward-looking claim" }));
  check("referee says none -> null", (await matchSemantic("remember when solana was $8", BOARD)) === null);

  _setReferee(async () => { throw new Error("timeout"); });
  check("referee throws -> null, not an exception", (await matchSemantic("mbappe carried again", BOARD)) === null);

  _setReferee(async () => ({ pick: 999, reason: "hallucinated index" }));
  check("an out-of-range pick is parsed to none upstream or dropped here",
    (await matchSemantic("mbappe carried again", BOARD))?.market === undefined);

  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  _setReferee(async () => ({ pick: 1, reason: "should never run" }));
  check("no API key -> stage off, silence", (await matchSemantic("mbappe carried again", BOARD)) === null);
  process.env.ANTHROPIC_API_KEY = saved;
}

console.log("\nthe lexical stage's own answers are untouched");
{
  _setReferee(async () => ({ pick: 1, reason: "must not be consulted" }));
  const silent = await matchSemantic("gm", BOARD);
  // "gm" produces no candidates at all (no overlap, and it categorises to
  // nothing that fills) — or if fill produces candidates, the mock would match.
  // Either way the lexical result for real matches is byte-identical:
  const lex = await matchSemantic("bitcoin closing above $70,000 in july easily", BOARD);
  check("a real lexical match still answers lexically", lex?.via === "lexical" && lex?.market.venueId === "BTC", JSON.stringify(lex));
  void silent;
}

_setReferee(null);
console.log(failures === 0 ? "\nall semantic checks passed.\n" : `\n${failures} semantic check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
