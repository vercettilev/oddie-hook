// How often can the oracle actually settle, and how often is it RIGHT?
//
// Neither number can be read off the live board. Every market there closes in
// the future, so the free "not closed" gate answers first, and moving the clock
// does not help: the proposer keeps the real clock and searches the real
// internet, so it correctly reports that nothing has happened yet. The only way
// to measure is to ask about events that have ALREADY happened and to know the
// answer in advance.
//
// That is what this is. A fixture of questions with settled, checkable answers,
// run through the same decide() the runner uses, scored three ways:
//
//   SETTLED RIGHT   it committed and agreed with the known answer
//   SETTLED WRONG   it committed and was wrong. The only unacceptable outcome.
//   ABSTAINED       it refused. Costs a human a look; costs nobody money.
//
// The abstention rate is the size of the job a human (or a staked resolver
// network) has to do. The wrong rate is the one that must be zero.
//
//   npm run oracle-backtest              the whole fixture
//   npm run oracle-backtest -- --only 3  the first 3, for a cheap smoke test
//
// It spends real money: roughly $0.22 a question. It touches no database and
// settles nothing.

import { decide } from "../src/oracle/oracle.js";
import { oracleAvailable } from "../src/oracle/verdict.js";

interface Case {
  question: string;
  criteria: string;
  closeTime: string;
  /** What actually happened. The fixture's whole value is that this is known. */
  answer: "yes" | "no";
  note: string;
}

/**
 * Deliberately mixed. Easy YES cases prove nothing on their own: an oracle that
 * always says yes scores perfectly on them. The NO cases are the hard half and
 * the ones the asymmetry in audit.ts makes structurally harder, which is the
 * point of including them.
 */
const CASES: Case[] = [
  {
    question: "Did Anthropic announce a model called Claude Opus 5 before 27 August 2026?",
    criteria: "Resolves YES if Anthropic's official website, newsroom, or documentation shows an announcement of a model named Claude Opus 5 dated before 27 August 2026; otherwise NO.",
    closeTime: "2026-08-27T00:00:00Z", answer: "yes",
    note: "well-sourced, official page, recent",
  },
  {
    question: "Did Bitcoin trade above $1,000,000 at any point during July 2026?",
    criteria: "Resolves YES if a recognised price tracker (CoinGecko, CoinMarketCap) shows a BTC/USD price above $1,000,000 at any point in July 2026; otherwise NO.",
    closeTime: "2026-08-01T00:00:00Z", answer: "no",
    note: "a NO that requires refusing an absurd claim, not finding a source",
  },
  {
    question: "Was Donald Trump the sitting president of the United States on 1 August 2026?",
    criteria: "Resolves YES if official US government sources show Donald Trump holding the office of President on 1 August 2026; otherwise NO.",
    closeTime: "2026-08-02T00:00:00Z", answer: "yes",
    note: "widely documented, many citable sources",
  },
  {
    question: "Did the 2026 FIFA World Cup final take place before 1 August 2026?",
    criteria: "Resolves YES if FIFA's official site or major sports outlets show the 2026 World Cup final was played before 1 August 2026; otherwise NO.",
    closeTime: "2026-08-01T00:00:00Z", answer: "yes",
    note: "sports, a fixed calendar event",
  },
  {
    question: "Did Ethereum's price fall below $10 at any point in July 2026?",
    criteria: "Resolves YES if a recognised price tracker shows an ETH/USD price below $10 at any point during July 2026; otherwise NO.",
    closeTime: "2026-08-01T00:00:00Z", answer: "no",
    note: "the NO case again, on a market a price page can actually address",
  },
  {
    question: "Did Apple release a product named 'Apple Car' before August 2026?",
    criteria: "Resolves YES if Apple's official newsroom shows the release of a product named Apple Car before 1 August 2026; otherwise NO.",
    closeTime: "2026-08-01T00:00:00Z", answer: "no",
    note: "a NO where the honest proof is an absence, which is the hardest shape",
  },
];

const onlyIdx = process.argv.indexOf("--only");
const only = onlyIdx >= 0 ? Number(process.argv[onlyIdx + 1]) : CASES.length;
const caseIdx = process.argv.indexOf("--case");
const one = caseIdx >= 0 ? Number(process.argv[caseIdx + 1]) : null;
// --case runs exactly one, which is how you diagnose a single result without
// paying for the whole fixture again.
const cases = one !== null && Number.isFinite(one)
  ? CASES.slice(one - 1, one)
  : CASES.slice(0, Number.isFinite(only) ? only : CASES.length);

const avail = oracleAvailable();
if (!avail.ok) { console.error(`\n  ${avail.why}\n`); process.exit(1); }
console.log(`\n  ${avail.why}`);
console.log(`  ${cases.length} question(s) with known answers, about $${(cases.length * 0.22).toFixed(2)}.\n`);

let right = 0, wrong = 0, abstained = 0;
const gates = new Map<string, number>();

for (const c of cases) {
  const d = await decide({ slug: "backtest", question: c.question, criteria: c.criteria, closeTime: c.closeTime });
  gates.set(d.gate, (gates.get(d.gate) ?? 0) + 1);

  let verdict: string;
  if (d.settle === null) { abstained++; verdict = "ABSTAINED"; }
  else if (d.settle === c.answer) { right++; verdict = "RIGHT"; }
  else { wrong++; verdict = "WRONG"; }

  console.log(`  ${verdict.padEnd(10)} expected ${c.answer.toUpperCase().padEnd(3)} got ${(d.settle ?? "-").toUpperCase().padEnd(3)} ${c.question.slice(0, 58)}`);
  console.log(`             ${d.gate}: ${d.reason.slice(0, 150)}`);
  const a = d.audit;
  if (a) {
    console.log(`             citations: ${a.verified} verified, ${a.undated} undated, ${a.stale} stale, ${a.absent} absent, ${a.unreachable} unreachable`);
    // The URL and the quote, always. "absent" means the words were not on the
    // page WE fetched, and that is either a model inventing a source or a page
    // we cannot read properly. Those need completely different fixes, and the
    // tally alone cannot tell them apart.
    for (const c2 of a.citations) {
      console.log(`               [${c2.status}] ${c2.url.slice(0, 88)}`);
      console.log(`                 "${c2.quote.slice(0, 90)}"`);
    }
  }
  console.log("");
}

console.log(`  RIGHT ${right}   WRONG ${wrong}   ABSTAINED ${abstained}   of ${cases.length}`);
console.log(`  gates: ${[...gates.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g} ${n}`).join(", ")}`);
console.log(`  settle rate ${((right + wrong) / cases.length * 100).toFixed(0)}%, and of what it settled, ${right + wrong > 0 ? ((right / (right + wrong)) * 100).toFixed(0) : "n/a"}% right.\n`);

// A wrong settlement is the only unacceptable outcome. Abstaining is expensive
// in human time and costs nobody their stake, so it never fails this run.
if (wrong > 0) { console.error(`  ${wrong} WRONG. That is the number that must be zero.\n`); process.exit(1); }
