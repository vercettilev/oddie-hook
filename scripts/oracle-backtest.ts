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
  /** The page a human fetched to establish the answer, and the line they read
   *  it from. Carried so a future reader can re-check the fixture itself rather
   *  than trusting it: a fixture with a wrong answer scores a correct oracle as
   *  wrong, which is the one number this exists to protect. */
  evidence: string;
  note: string;
}

/**
 * Deliberately mixed. Easy YES cases prove nothing on their own: an oracle that
 * always says yes scores perfectly on them. The NO cases are the hard half and
 * the ones the asymmetry in audit.ts makes structurally harder, which is the
 * point of including them.
 */
/**
 * Real markets, in oddie's actual shape, whose answers are already settled.
 *
 * The first version of this fixture was six questions I wrote from intuition,
 * and it measured the wrong thing: half of them were absurdities ("did Bitcoin
 * trade above $1,000,000") that no one would ever open a market on, where the
 * honest answer is that no record specifically denies a silly claim. Tuning
 * against those was overfitting to bad questions.
 *
 * These came from a search of events that actually resolved between May and
 * August 2026, in the shape a tagged X argument produces: a specific subject, a
 * threshold, a hard date, and a nameable public source. Every answer was
 * established by fetching a page and reading it, then independently re-fetched
 * and re-checked by a second pass, which dropped 11 of 24 candidates and
 * corrected 7 of the survivors (two close times that sat too near the event, a
 * results-table quote that only existed de-spaced, and two price questions
 * missing a lower bound that made them trivially YES).
 *
 * Seven NO and six YES on purpose. A fixture of YES cases proves nothing: an
 * oracle that always answers yes scores perfectly on it.
 */
const CASES: Case[] = [
  {
    question: "Will Argentina win the 2026 FIFA World Cup final on 19 July 2026?",
    criteria: "YES if Argentina are the winners of the 2026 FIFA World Cup final at MetLife Stadium (including extra time or penalties); NO if any other nation lifts the trophy. Settled by the official FIFA World Cup 2026 final result and major wire reports of the match.",
    closeTime: "2026-07-19T23:00:00Z",
    answer: "no",
    // Defending champions chasing back-to-back titles is a genuine X argument with a hard date and an official settling source.
    evidence: "https://www.cbsnews.com/news/2026-fifa-world-cup-final-spain-argentina-sunday/",
    note: "It took 106 minutes for Ferran Torres to score the first and only goal in the 2026 FIFA World Cup final at MetLife Stadium in New Jersey, giving Spain the 1-0 win over Argentina in",
  },
  {
    question: "Will Arsenal win the 2026 UEFA Champions League final against Paris Saint-Germain on 30 May 2026?",
    criteria: "YES if Arsenal are declared winners of the 2026 UEFA Champions League final at the Puskas Arena, by any margin including a penalty shootout; NO if Paris Saint-Germain win. Settled by the official UEFA final result and the ESPN match report for the game.",
    closeTime: "2026-05-30T20:00:00Z",
    answer: "no",
    // A single-match final with a nameable official result is the ideal oddie shape, and Arsenal's first European Cup vs a PSG repeat was a real argument.
    evidence: "https://www.espn.com/soccer/report/_/gameId/401862897",
    note: "PSG beat Arsenal on penalties to defend Champions League title",
  },
  {
    question: "Will Arsenal be crowned champions of the 2025-26 Premier League season?",
    criteria: "YES if Arsenal finish top of the 2025-26 Premier League table and are awarded the title; NO if any other club wins it. Settled by the final Premier League table on premierleague.com and match reports of the title-clinching result.",
    closeTime: "2026-05-24T18:00:00Z",
    answer: "yes",
    // A season-long title race resolving on a specific matchday, settled by an unambiguous public league table.
    evidence: "https://www.espn.com/soccer/story/_/id/48813813/arsenal-win-premier-league-title-2026-manchester-city-bournemouth",
    note: "Arsenal were crowned Premier League champions for the first time in 22 years after Manchester City failed to beat Bournemouth on Tuesday.",
  },
  {
    question: "Will Jannik Sinner successfully defend his Wimbledon men's singles title in the final on 12 July 2026?",
    criteria: "YES if Sinner wins the 2026 Wimbledon gentlemen's singles final; NO if his opponent wins or if Sinner does not reach the final. Settled by the official Wimbledon championship results and major outlets' final match reports.",
    closeTime: "2026-07-12T21:00:00Z",
    answer: "yes",
    // Grand Slam finals are a staple of X sports arguments, with a fixed date and an official results page.
    evidence: "https://www.espn.com/tennis/story/_/id/49342484/wimbledon-2026-men-final-live-tennis-latest-updates-jannik-sinner-alexander-zverev-news-results-schedule-weather",
    note: "Jannik Sinner has defended his title, coming from a set down to beat Alexander Zverev, 6-7, 7-6, 6-3, 6-4 in three hours, 46 minutes in London.",
  },
  {
    question: "Will the New York Knicks win the 2026 NBA Finals?",
    criteria: "YES if the Knicks win the 2026 NBA Finals series against the San Antonio Spurs; NO if the Spurs win the series. Settled by the official NBA.com playoff series result for the 2026 Finals.",
    closeTime: "2026-06-14T05:00:00Z",
    answer: "yes",
    // A best-of-seven final with a public official result and a huge fanbase argument (a 53-year Knicks drought vs a rising Spurs team) is a natural bot-tag
    evidence: "https://www.espn.com/nba/story/_/id/49053284/new-york-knicks-win-2026-nba-finals-path-championship-outlast-east-brunson-towns-hart",
    note: "It culminated in a five-game NBA Finals win over the rising San Antonio Spurs, as the Knicks won their first title in 53 years.",
  },
  {
    question: "Will Lando Norris win the 2026 British Grand Prix at Silverstone on 5 July 2026?",
    criteria: "YES if Norris is classified first in the official race classification for the 2026 British Grand Prix; NO if any other driver wins. Settled by the official race result on formula1.com for the 2026 British Grand Prix, corroborated by the Wikipedia race report.",
    closeTime: "2026-07-05T17:00:00Z",
    answer: "no",
    // A home-race win for a British driver is a textbook X argument, and F1 publishes an official classification the same day.
    evidence: "https://en.wikipedia.org/wiki/2026_British_Grand_Prix",
    note: "Leclerc took his ninth Formula One victory, his first at the British Grand Prix, ahead of George Russell (Mercedes), who took his first podium at Silverstone, and Hamilton.",
  },
  {
    question: "Will Bitcoin trade below $60,000 at any point in 2026 before July 1, 2026?",
    criteria: "YES if a major price source records a BTC spot price under $60,000 on any date between 2026-01-01 and 2026-07-01; NO if BTC never prints below that level in that window. Settled by Forbes/CoinGecko BTC spot price coverage.",
    closeTime: "2026-07-01T00:00:00Z",
    answer: "yes",
    // A round-number BTC threshold with a hard deadline, genuinely arguable in late May 2026 when BTC was still near $80,000.
    evidence: "https://www.forbes.com/sites/tylerroush/2026/06/05/bitcoin-falls-below-60000-erasing-trump-fueled-rally/",
    note: "The price of bitcoin fell to a low of $59,840 just after noon on Friday",
  },
  {
    question: "Will Bitcoin set a new all-time high above its October 2025 record of $126,198 at any point before August 21, 2026?",
    criteria: "YES if BTC prints above $126,198.07 (the Oct 6, 2025 record) before 2026-08-21; NO if the all-time high is still dated October 2025 at close. Settled by Fortune's daily Bitcoin price page / CoinGecko's ATH field.",
    closeTime: "2026-08-21T12:00:00Z",
    answer: "no",
    // A perennially argued claim ('new ATH this cycle') with a nameable settling source, and well-posed without a start bound because an all-time high is de
    evidence: "https://fortune.com/article/price-of-bitcoin-08-21-2026/",
    note: "Bitcoin reached its highest price ever on Oct. 6, 2025, pricing at a whopping $126,198.07.",
  },
  {
    question: "Will Ethereum trade below $2,000 at any point in 2026 before August 18, 2026?",
    criteria: "YES if ETH spot prints under $2,000 on any date between 2026-01-01 and 2026-08-18; NO otherwise. Settled by Fortune's daily Ethereum price page or CoinGecko's ETH daily close data.",
    closeTime: "2026-08-18T00:00:00Z",
    answer: "yes",
    // A round-number threshold on the second-largest asset, exactly the kind of line people fight over in ETH replies.
    evidence: "https://fortune.com/article/price-of-ethereum-08-17-2026/",
    note: "At 6:15 a.m. Eastern Time on August 17, 2026, the price of Ethereum (1 ETH) is $1,891.33.",
  },
  {
    question: "Will Ethereum's Glamsterdam upgrade activate on mainnet before August 1, 2026?",
    criteria: "YES if the Glamsterdam hard fork activates on Ethereum mainnet before 2026-08-01; NO if it is still unshipped at that date. Settled by ethereum.org's Glamsterdam roadmap page.",
    closeTime: "2026-08-01T00:00:00Z",
    answer: "no",
    // Ship-date arguments about Ethereum forks are a staple of crypto X, and Glamsterdam was originally targeted at H1 2026, so a July deadline was genuinel
    evidence: "https://ethereum.org/roadmap/glamsterdam/",
    note: "Glamsterdam is an upcoming Ethereum upgrade planned for Q4 2026",
  },
  {
    question: "Will Solana's Alpenglow consensus upgrade be live on Solana mainnet before August 15, 2026?",
    criteria: "YES if Alpenglow consensus (Votor) is activated on Solana mainnet before 2026-08-15; NO if only prerequisite SIMDs have shipped and Alpenglow itself is still pending. Settled by solana.com/upgrades/alpenglow or Solana core-dev release coverage.",
    closeTime: "2026-08-15T00:00:00Z",
    answer: "no",
    // Alpenglow's 150ms-finality claim was heavily hyped and community validator testing went live in May 2026, so 'is it actually live yet' was a real disp
    evidence: "https://crypto.news/solana-alpenglow-targets-150ms-finality-in-october/",
    note: "Alpenglow is expected to activate with Agave 4.3, which is targeted for October 2026.",
  },
  {
    question: "Will Strategy (MSTR) publicly disclose a sale of at least $100 million of its bitcoin holdings in 2026 before August 1, 2026?",
    criteria: "YES if Strategy announces or files disclosure of a bitcoin disposal worth $100M or more between 2026-01-01 and 2026-08-01; NO if all disclosed sales in that window stay under that size. Settled by Strategy's SEC filings or major-outlet coverage of them (Fortune/CNBC/CoinDesk).",
    closeTime: "2026-08-01T00:00:00Z",
    answer: "yes",
    // 'Saylor will never sell' was one of the loudest arguments on crypto X, and the first 2026 sale was only 32 BTC, so a $100M threshold was a real dividi
    evidence: "https://fortune.com/2026/07/06/michael-saylor-strategy-216-million-bitcoin-sale-largest-ever/",
    note: "Strategy announced on Monday morning that it sold $216 million worth of Bitcoin over the past week.",
  },
  {
    question: "Will NVIDIA report total revenue of at least $100 billion for its fiscal Q2 2027 (quarter ended July 26, 2026)?",
    criteria: "YES if NVIDIA's official quarterly results press release on nvidianews.nvidia.com states Q2 FY2027 revenue of $100.0 billion or more; NO if it states less. Source: the NVIDIA Newsroom release \"NVIDIA Announces Financial Results for Second Quarter Fiscal 2027\".",
    closeTime: "2026-08-26T23:59:59Z",
    answer: "no",
    // A round-number earnings threshold on the most-argued stock on X, settled by a single official press release on a scheduled date, which is close to the
    evidence: "https://nvidianews.nvidia.com/news/nvidia-announces-financial-results-for-second-quarter-fiscal-2027",
    note: "Revenue of $96.2 billion, up 106% from a year ago",
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
