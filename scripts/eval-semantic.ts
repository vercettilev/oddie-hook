// The frozen-suite before/after: every tweet through BOTH paths on ONE board.
//
//   before = the lexical matcher alone (threshold and all) — what shipped
//   after  = the full pipeline with the real referee
//
// The suite is the safety contract in rows: previously-correct silences must
// stay silent, previously-correct matches must survive (and stay "lexical" —
// they never reach the referee), and the three real-world zero-overlap misses
// must now match their obvious markets.
//
// The board is frozen to a file on first run so re-runs measure the model, not
// venue drift. Needs ANTHROPIC_API_KEY (run under `railway run` if it only
// lives there).
//
//   ANTHROPIC_API_KEY=... npx tsx scripts/eval-semantic.ts

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { matchTweet } from "../src/matching/matcher.js";
import { matchSemantic, semanticEnabled, semanticUsage } from "../src/matching/semantic.js";
import type { Market } from "../src/venues/types.js";

if (!semanticEnabled()) {
  console.error("ANTHROPIC_API_KEY is not set — nothing to evaluate.");
  process.exit(1);
}

const BOARD_FILE = "cards/frozen-eval-board.json";
let markets: Market[];
if (existsSync(BOARD_FILE)) {
  markets = JSON.parse(readFileSync(BOARD_FILE, "utf8"));
  console.log(`board: ${markets.length} markets (frozen, ${BOARD_FILE})`);
} else {
  const { getMarketData } = await import("../src/venues/index.js");
  const data = await getMarketData(true);
  markets = data.markets;
  writeFileSync(BOARD_FILE, JSON.stringify(markets));
  console.log(`board: ${markets.length} markets (fetched live, frozen to ${BOARD_FILE})`);
}

interface Case { tweet: string; expect: "match" | "silence"; note: string }

const SUITE: Case[] = [
  // -- the three real-world misses: obvious to a human, zero word overlap.
  //    Exact original texts, supplied by the operator. ------------------------
  {
    tweet: "Mbappé: \"Until I see a trophy in my hands, we are not the strongest. Because the strongest are the winners.\"",
    expect: "match", note: "REAL MISS #1 (exact)",
  },
  {
    tweet: "Mbappe: \"I have been both a world champion and a world runner-up. Right now, this team is neither a world champion nor a world runner-up yet. Yes, we have potential. We are dreaming and letting others dream. However, until I see a trophy in my hands, we are not the strongest. Because the strongest are the winners.\"",
    expect: "match", note: "REAL MISS #2 (exact)",
  },
  {
    tweet: "Argentina pull it back late to secure their spot in the last eight!  #FIFAWorldCup",
    expect: "match", note: "REAL MISS #3 (exact)",
  },

  // -- the three real no-market tweets: news/nostalgia/announcement.
  //    Exact original texts; none must hold on every one. ---------------------
  {
    tweet: "HAPPY EPOCH 1000 SOLANA!!  I found an nft wallet from May 1st 2021, but I have older wallets that I can't find lol. I am around epoch +870 based on emails from CEXs that I found, so I want to try and find my old seedphrases to update you guys lmao. If you are above 700, let me follow you!! Solana OGs always stick together.",
    expect: "silence", note: "REAL NONE (Solana nostalgia, exact)",
  },
  {
    tweet: "After 6 years I'm leaving @Coinbase. I'll be transitioning to an advisory role at the end of the month and continue my service on the Board of Coinbase National Trust Company. I will be a Coinbase ally for life and am grateful to @brian_armstrong, @emilemc and the Coinbase board for the opportunity of a lifetime.",
    expect: "silence", note: "REAL NONE (Coinbase departure, exact)",
  },
  {
    tweet: "JUST IN: $600 billion added to US stock market in the last 3 hours",
    expect: "silence", note: "REAL NONE ($600B news, exact)",
  },

  // -- previously-correct matches: must survive byte-identical, via lexical ---
  { tweet: "no shot france actually win the world cup", expect: "match", note: "was lexical-correct (WC)" },
  { tweet: "argentina winning the world cup? i don't see it", expect: "match", note: "was lexical-correct (WC)" },
  { tweet: "will spain win the 2026 fifa world cup? yes", expect: "match", note: "was lexical-correct (WC discriminator: must pick Spain, not France)" },
  { tweet: "the fed is definitely cutting rates in september", expect: "match", note: "was lexical-correct (Fed cut)" },
  { tweet: "no way the fed hikes rates this year", expect: "match", note: "was lexical-correct (Fed hike + direction rule)" },
  { tweet: "btc holding above $64,000 through july 11, easy money", expect: "match", note: "was lexical-correct (crypto threshold)" },

  // -- previously-correct silences: garbage and off-topic, must stay silent ---
  { tweet: "gm", expect: "silence", note: "garbage" },
  { tweet: "lmaooo did you see that, i cannot breathe", expect: "silence", note: "garbage" },
  { tweet: "i am running low on gas, stopping at the next station", expect: "silence", note: "off-topic (price-guard case)" },
  { tweet: "my cat knocked the router off the shelf again, day ruined", expect: "silence", note: "off-topic" },
  { tweet: "just finished a 10k run, legs are gone", expect: "silence", note: "off-topic" },
];

const money = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`);
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

let failures = 0;
const rows: string[] = [];
let calls = 0, latencySum = 0;

for (const c of SUITE) {
  const before = matchTweet(c.tweet, markets);
  const t0 = Date.now();
  const after = await matchSemantic(c.tweet, markets);
  const ms = Date.now() - t0;
  if (!before && after?.via === "semantic") { calls++; latencySum += ms; }
  else if (!before && !after) { calls++; latencySum += ms; } // a real "none" round trip

  const beforeS = before ? `MATCH ${short(before.market.question, 34)}` : "silence";
  const afterS = after ? `${after.via.toUpperCase()} ${short(after.market.question, 34)}` : "silence";
  const ok =
    c.expect === "match"
      ? Boolean(after)
      : after === null;
  const regression = before !== null && (!after || after.market.venueId !== before.market.venueId);
  if (!ok || regression) failures++;

  rows.push(
    `${ok && !regression ? "✓" : "✗"} ${short(c.tweet, 44).padEnd(45)} | ${beforeS.padEnd(41)} | ${afterS.padEnd(43)} | ${after?.reason ? short(after.reason, 46) : ""}`,
  );
  if (after?.via === "semantic")
    rows.push(`    ${"".padEnd(45)} |   ${money(after.market.volumeUsd)}, yes ${after.market.yesPct}% — ${c.note}`);
}

console.log(`\n${"tweet".padEnd(47)} | ${"BEFORE (lexical only)".padEnd(41)} | ${"AFTER (semantic pipeline)".padEnd(43)} | referee reason`);
console.log("-".repeat(160));
for (const r of rows) console.log(r);
console.log("-".repeat(160));
const u = semanticUsage();
// Haiku 4.5 list price: $1 / MTok in, $5 / MTok out.
const cost = (u.inputTokens * 1 + u.outputTokens * 5) / 1e6;
console.log(`referee round trips: ${u.calls}, avg latency ${calls ? Math.round(latencySum / calls) : 0}ms`);
console.log(`tokens: ${u.inputTokens} in / ${u.outputTokens} out — total $${cost.toFixed(4)}, ~$${u.calls ? (cost / u.calls).toFixed(4) : "0"}/call`);
console.log(failures === 0 ? "\nfrozen suite: ALL GREEN.\n" : `\n${failures} suite case(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
