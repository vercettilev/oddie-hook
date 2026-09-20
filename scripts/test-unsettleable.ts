// The two backstops that stand between a model's answer and a real-money market.
//
// Both exist because SYSTEM in extractClaim.ts already forbids these in words,
// and on 2026-09-20 a real tweet proved that words are a request.
//
// @troxqt posted "Don't think $ORE will hit 90 by the end of this week". The
// model graded it publishable and wrote, as the market's ONLY rule: "...either
// $90 unit price or 90M market cap... Ambiguity over whether '90' means unit
// price or market cap must be clarified before this can settle." It opened on
// mainnet with a seven-day clock, under a stranger's tweet, inviting SOL into a
// pool the oracle could never pay out. The same answer put a 44-character mint
// address in the QUESTION, which SYSTEM forbids outright.
//
// These are the checks, not the request. A regex is a poor judge of language
// and a perfect judge of a sentence shape, which is all either one claims to be.
//
//   npm run test-unsettleable

import { unsettleablePhrase, addressInQuestion } from "../src/matching/extractClaim.js";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`); }
}

console.log("\na rule that postpones its own decision is not a rule");
{
  // The live one, verbatim from will-the-solana-token-at-mint-8454d5.
  const real =
    "Resolves YES if the token at the referenced Solana mint reaches a value of 90 " +
    "(in the units the poster intended, i.e. either $90 unit price or 90M market cap) " +
    "at any point before the deadline, per on-chain price data. Ambiguity over whether " +
    "'90' means unit price or market cap must be clarified before this can settle.";
  check("the market that shipped is caught", unsettleablePhrase(real) !== null, real.slice(-60));

  for (const s of [
    "The winner must be confirmed by the organiser before this can settle.",
    "This cannot be resolved without knowing which exchange the poster meant.",
    "Requires manual review of the final standings.",
    "Threshold TBD.",
    "Settles at whatever the poster intended by 'soon'.",
    "YES if it reaches either 90 in unit price or 90M in market cap.",
  ]) check(`caught: "${s.slice(0, 44)}…"`, unsettleablePhrase(s) !== null);
}

console.log("\nand a real rule is left alone");
{
  // Including criteriaSentence()'s own template and prose that merely contains
  // the word "ambiguous", which is legitimate: a rule may name ambiguity as an
  // OUTCOME without being ambiguous itself.
  for (const s of [
    "Settles from the on-chain price of $BULLSHIT (solana mint zj1jpp7QMveWHLs61vL9KMZf254KvW7j4AAmBF8ry2k). " +
      "YES if its market cap is at or above $1M at any point between this market opening on 2026-09-15 and " +
      "2026-09-18 UTC, read from the hourly candles of its deepest pool on GeckoTerminal. NO otherwise.",
    "Resolves NO if the announcement is ambiguous or never made.",
    "YES if the final score on the Premier League site shows Arsenal ahead.",
    "Resolves YES if the official @company account posts the release before 1 October.",
    "YES if BTC/USD closes above $100,000 on CoinMarketCap on 31 December.",
  ]) check(`left alone: "${s.slice(0, 44)}…"`, unsettleablePhrase(s) === null, String(unsettleablePhrase(s)));
}

console.log("\nan address is an identifier, never a name");
{
  check("the question that shipped is caught",
    addressInQuestion(
      "Will the Solana token at mint address oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp reach 90 by the end of this week?",
    ) === "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp");

  for (const q of [
    "Will $ORE trade at or above $90 before 27 September?",
    "Will Bitcoin (BTC/USD) trade at or above $100,000 before the end of 2026?",
    "Will Arsenal beat Chelsea on Saturday?",
    // 31 base58 chars: one short of an address, and nothing in prose is longer.
    "Will aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa happen?",
  ]) check(`left alone: "${q.slice(0, 44)}…"`, addressInQuestion(q) === null, String(addressInQuestion(q)));

  // The criteria are exactly where an address belongs, so nothing checks them.
  check("criteria may carry an address, and this check never looks at them",
    typeof addressInQuestion === "function");
}

console.log(`\n${fail === 0 ? "all unsettleable checks passed." : `${fail} FAILED`} (${pass} passed)`);
if (fail) process.exit(1);
