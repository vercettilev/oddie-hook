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

import { closeAtStart, unsettleablePhrase, addressInQuestion, withinQuestion, extractClaim, holdAsWithin } from "../src/matching/extractClaim.js";

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

console.log("\na level over a period keeps the claimant's words (rule 8)");
{
  // Measured on the live model, 13 Oct: "within", criteria naming both cases,
  // and a question that said the one thing rule 8 rules out.
  check("the question that came back loses its \"at any point\"",
    withinQuestion("Will $CL be above $90 at any point this week?") === "Will $CL be above $90 this week?");
  check("...in any of its forms",
    withinQuestion("Will HYPE trade below $100 at any time during October 2026?") === "Will HYPE trade below $100 during October 2026?"
    && withinQuestion("Will SOL be above $100 At Any Moment in October?") === "Will SOL be above $100 in October?");
  check("...and a question without it is left alone",
    withinQuestion("Will Solana (SOL) be above $100 in October 2026?") === "Will Solana (SOL) be above $100 in October 2026?");

  // Through the extractor itself, with the model's answer from that run.
  const answer = {
    question: "Will $CL be above $90 at any point this week?",
    resolution_criteria: "Resolves YES if the token $CL is above $90 when this market opens and stays above $90 until the end of this week, or, if it is not above $90 when this market opens, if it trades above $90 at any point before the end of this week. Resolves NO otherwise.",
    price_claim: { symbol: "CL", metric: "price", op: ">", target: 90, mode: "within" },
    close_time: "2099-01-01T00:00:00Z", close_time_inferred: false, category: "Crypto", resolvability: "clean",
    appropriate: true, appropriate_reason: "", reason: "clean", hook: "$CL above $90?",
  };
  const realFetch = globalThis.fetch;
  const hadKey = process.env.INFERENCE_API_KEY;
  process.env.INFERENCE_API_KEY = "test";
  const reply = (a: unknown) => (async () => new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(a) }] }), { status: 200 })) as typeof fetch;
  try {
    globalThis.fetch = reply(answer);
    const ex = await extractClaim("$CL above $90 this week?");
    check("the extractor hands on the claimant's words, the mode and the both-case rule",
      ex.question === "Will $CL be above $90 this week?" && ex.price_claim?.mode === "within" && ex.resolution_criteria === answer.resolution_criteria, ex.question);
    globalThis.fetch = reply({ ...answer, price_claim: { ...answer.price_claim, mode: "touch" }, question: "Will $CL trade above $90 at any point this week?" });
    const touch = await extractClaim("$CL hits $90 this week");
    check("...while a move named keeps its \"at any point\"", touch.question === "Will $CL trade above $90 at any point this week?", touch.question);
  } finally {
    globalThis.fetch = realFetch;
    if (hadKey === undefined) delete process.env.INFERENCE_API_KEY; else process.env.INFERENCE_API_KEY = hadKey;
  }
}

console.log("\na hold verb is a level over a period (15 Oct, Bee's nine claims)");
{
  const claim = (mode: "touch" | "at-close" | "always" | "within", op: ">" | ">=" | "<" | "<=" = ">") =>
    ({ symbol: "ETH", metric: "price" as const, op, target: 2350, mode });
  check("\"stay above … by the end of this week\" read at the close becomes rule 8",
    holdAsWithin("will ETH stay above 2350 by the end of this week?", claim("at-close"))?.mode === "within");
  check("...and so does one read as a hold", holdAsWithin("Will BTC stay above 80k by the end of this week?", claim("always"))?.mode === "within");
  check("holds, remains, keeps and under all count", ["HYPE holds under 100 all week", "SOL remains below 100 this month", "keeps under 100 till friday"]
    .every((t) => holdAsWithin(t, claim("at-close", "<"))?.mode === "within"));
  check("a hold the other way round from the op is left alone", holdAsWithin("will ETH stay above 2350?", claim("at-close", "<"))?.mode === "at-close");
  check("no hold verb, nothing changes", holdAsWithin("will ETH be above 2350 at the end of this week?", claim("at-close"))?.mode === "at-close"
    && holdAsWithin("ETH hits 2350 this week", claim("touch"))?.mode === "touch");

  // Through the extractor, with the answer the model gave for ETH that night.
  const answer = {
    question: "Will Ethereum (ETH) be above $2,350 at the end of this week?",
    resolution_criteria: "Resolves YES if the ETH/USD price is above $2,350 at 23:59 UTC on 2026-10-18 per CoinMarketCap. Resolves NO otherwise.",
    price_claim: { symbol: "ETH", metric: "price", op: ">", target: 2350, mode: "at-close" },
    close_time: "2099-01-01T00:00:00Z", close_time_inferred: false, category: "Crypto", resolvability: "clean",
    appropriate: true, appropriate_reason: "", reason: "clean", hook: "ETH above 2350?",
  };
  const realFetch = globalThis.fetch;
  const hadKey = process.env.INFERENCE_API_KEY;
  process.env.INFERENCE_API_KEY = "test";
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(answer) }] }), { status: 200 })) as typeof fetch;
    const ex = await extractClaim("will ETH stay above 2350 by the end of this week?");
    check("the extractor hands on a hold as rule 8, whatever the model said", ex.price_claim?.mode === "within", JSON.stringify(ex.price_claim));
  } finally {
    globalThis.fetch = realFetch;
    if (hadKey === undefined) delete process.env.INFERENCE_API_KEY; else process.env.INFERENCE_API_KEY = hadKey;
  }
}

console.log("\na game's market closes when the game starts (23 Oct, Showdown's Beat Stan)");
{
  // The model's answer for "Can GPPoker beat Stan? Game starts tonight at 8pm
  // CET...", with the close it gave before the rule: the end of the day.
  const start = new Date(Date.now() + 6 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const late = new Date(Date.now() + 11 * 3600_000).toISOString();
  const answer = {
    question: "Will GPPoker beat Stan in their match tonight?",
    resolution_criteria: "Resolves YES if @Showdown_TCG announces GPPoker as the winner of tonight's game, and NO if Stan is announced as the winner.",
    price_claim: null, close_time: late, close_time_inferred: true, starts_at: start,
    category: "Culture", resolvability: "clean", appropriate: true, appropriate_reason: "", reason: "clean", hook: "GPPoker vs Stan?",
  };
  const realFetch = globalThis.fetch;
  const hadKey = process.env.INFERENCE_API_KEY;
  process.env.INFERENCE_API_KEY = "test";
  const reply = (a: unknown) => (async () => new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(a) }] }), { status: 200 })) as typeof fetch;
  try {
    globalThis.fetch = reply(answer);
    const ex = await extractClaim("Can GPPoker beat Stan? Game starts tonight at 8pm CET. Winner posted by @Showdown_TCG after the game.");
    check("bets close when the game starts, not hours after the winner is on screen",
      Date.parse(ex.close_time ?? "") === Date.parse(start) && ex.close_time_inferred === false, `${ex.close_time} vs ${start}`);
    globalThis.fetch = reply({ ...answer, close_time: new Date(Date.now() + 3 * 3600_000).toISOString() });
    const early = await extractClaim("same, with a deadline before the game");
    check("...a close already before the start is left alone", Date.parse(early.close_time ?? "") < Date.parse(start), String(early.close_time));
    globalThis.fetch = reply({ ...answer, starts_at: new Date(Date.now() - 600_000).toISOString() });
    const live = await extractClaim("will I win this match? (opened from a stream, game under way)");
    check("...a game already under way keeps its own close: a live market is the product", ex.close_time !== live.close_time && Date.parse(live.close_time ?? "") === Date.parse(late), String(live.close_time));
    globalThis.fetch = reply({ ...answer, price_claim: { symbol: "BTC", metric: "price", op: ">", target: 100000, mode: "touch" } });
    const price = await extractClaim("BTC above 100k by tonight");
    check("...and a price claim has its own window, start or no start", Date.parse(price.close_time ?? "") === Date.parse(late), String(price.close_time));
    check("closeAtStart on its own: no start, nothing changes",
      closeAtStart({ ...ex, starts_at: null, close_time: late }).close_time === late);
  } finally {
    globalThis.fetch = realFetch;
    if (hadKey === undefined) delete process.env.INFERENCE_API_KEY; else process.env.INFERENCE_API_KEY = hadKey;
  }
}

console.log(`\n${fail === 0 ? "all unsettleable checks passed." : `${fail} FAILED`} (${pass} passed)`);
if (fail) process.exit(1);
