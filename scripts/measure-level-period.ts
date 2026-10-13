// What the extractor reads for a level over a period, against the live model.
// It opens no market and touches no database: it prints the reading only.
//
//   railway run -p 508d41c0-e0ab-4dfd-94e8-a00881cd9e2e -e production -s oddie-hook -- sh -c 'unset DATABASE_URL; npx tsx scripts/measure-level-period.ts'
//
// Six model calls. The four level-over-period claims should come back as
// "within" with criteria that name both cases; the two with a move or a moment
// named should keep "touch" and "at-close".
import { extractClaim } from "../src/matching/extractClaim.js";

const CASES: Array<[string, string]> = [
  ["Solana above $100 in october?", "within"],
  ["$HYPE below $100 this month?", "within"],
  ["Gold below $4,200 this week?", "within"],
  ["$CL above $90 this week?", "within"],
  ["$SOL hits $150 this month", "touch"],
  ["SOL closes October above $100", "at-close"],
];

let off = 0;
for (const [text, want] of CASES) {
  const ex = await extractClaim(text);
  const mode = ex.price_claim?.mode ?? "(no price claim)";
  const fine = mode === want || (want === "within" && !ex.price_claim && /stays? (above|below)/i.test(ex.resolution_criteria ?? "") && /at any point/i.test(ex.resolution_criteria ?? ""));
  if (!fine) off++;
  console.log(`\n${fine ? "ok " : "OFF"}  "${text}"  ->  ${mode} (want ${want})`);
  console.log(`     question: ${ex.question}`);
  console.log(`     criteria: ${(ex.resolution_criteria ?? "").slice(0, 400)}`);
}
console.log(off ? `\n${off} of ${CASES.length} read another way.\n` : `\nall ${CASES.length} read as intended.\n`);
