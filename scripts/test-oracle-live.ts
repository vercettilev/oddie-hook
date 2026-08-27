// One real market, one real search, one real audit. Costs money and needs the
// network, so it is NOT in `npm run test`.
//
// It exists because the offline suite builds every page it checks. That suite
// proves the RULES; it cannot prove the API accepts the request shape those
// rules run on, and a shape the API rejects fails identically to a market
// nobody could settle. This is the only thing that tells the two apart.
//
//   railway run -s <service> -- npx tsx scripts/test-oracle-live.ts

import { proposeVerdict, oracleAvailable } from "../src/oracle/verdict.js";
import { auditCitations, auditSupports } from "../src/oracle/audit.js";
import { inferenceProvider } from "../src/inference.js";

const avail = oracleAvailable();
console.log(`\n  ${JSON.stringify(inferenceProvider())}`);
if (!avail.ok) { console.error(`\n  ${avail.why}\n`); process.exit(1); }

const market = {
  question: "Did Anthropic announce a model named Claude Opus 5 before 27 August 2026?",
  criteria:
    "Resolves YES if Anthropic's official website, newsroom, or documentation shows an announcement of a model named Claude Opus 5 dated before 27 August 2026; otherwise NO.",
  closeTime: "2026-08-27T00:00:00Z",
};

console.log(`\n  asking...\n`);
const t0 = Date.now();
const p = await proposeVerdict(market);
console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  outcome     ${p.outcome}`);
console.log(`  confidence  ${p.confidence}`);
console.log(`  checkable   ${p.checkable}`);
console.log(`  reasoning   ${p.reasoning}`);
console.log(`  citations   ${p.citations.length}`);

const audit = await auditCitations(p.citations, new Date(market.closeTime));
for (const c of audit.citations) {
  console.log(`\n  [${c.status}] ${c.url}`);
  console.log(`     dated ${c.datedAt ?? "not declared"} — ${c.note}`);
  console.log(`     "${c.quote.slice(0, 110)}"`);
}
const s = p.outcome === "undetermined" ? { ok: false, why: "proposer abstained" } : auditSupports(p.outcome, audit);
console.log(`\n  verified ${audit.verified}, stale ${audit.stale}, absent ${audit.fabricated}, unreachable ${audit.unreachable}`);
console.log(`  support: ${s.ok ? "PASSES" : "refused"} — ${s.why}\n`);
