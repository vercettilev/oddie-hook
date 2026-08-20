// The tweet-copy generator's trust rules, enforced mechanically — because "the
// copy never invents anything" is a claim a regex can hold better than a vibe.
//
// Run with: npm run test-copy

import { tweetCopy } from "../src/card/tweetCopy.js";
import {
  buildVerdict, buildTweetReply, buildTweetQuote,
  pick, QUOTE_LEAD_POOL, CTA_POOL,
} from "../src/matching/tweetReply.js";
import type { Market } from "../src/venues/types.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

const mk = (yesPct: number, volumeUsd: number, daysOut: number | null): Market => ({
  venue: "polymarket", venueId: "x", question: "Will the copy generator behave?", yesPct,
  closesAt: daysOut === null ? null : new Date(Date.now() + daysOut * 86_400_000).toISOString(),
  volumeUsd, venueUrl: "x", tags: [],
});

// One emoji max: count extended pictographs.
const emojiCount = (s: string): number => [...s.matchAll(/\p{Extended_Pictographic}/gu)].length;
const BANNED = /insane|don'?t miss|🚀|🔥|free token|sign ?up|our app|download|moon|guarantee|can'?t lose|easy money|trust me/i;
const ADVICE = /\b(take yes|take no|bet yes|bet no|i'?d go|you should|smart money says)\b/i;

const SHAPES: [string, Market][] = [
  ["balanced 48%", mk(48, 400_000, 30)],
  ["balanced + big money", mk(52, 4_600_000, 30)],
  ["heavy favorite 78%", mk(78, 200_000, 30)],
  ["favorite + big money", mk(82, 2_500_000, 30)],
  ["extreme favorite 93%", mk(93, 100_000, 30)],
  ["longshot 18%", mk(18, 300_000, 30)],
  ["extreme longshot 6%", mk(6, 150_000, 30)],
  ["lean 65%", mk(65, 500_000, 30)],
  ["closing soon (2d)", mk(44, 900_000, 2)],
  ["closing in hours", mk(61, 1_200_000, 0.3)],
  ["no close date", mk(37, 50_000, null)],
];

for (const [name, m] of SHAPES) {
  console.log(`\n${name}`);
  const lines = tweetCopy(m);
  check("3 to 5 variants", lines.length >= 3 && lines.length <= 5, `${lines.length}`);
  check("all distinct", new Set(lines).size === lines.length);
  for (const l of lines) {
    const problems: string[] = [];
    if (l.includes("\n")) problems.push("multiline");
    if (emojiCount(l) > 1) problems.push(`${emojiCount(l)} emojis`);
    if (BANNED.test(l)) problems.push("banned word/hype");
    if (ADVICE.test(l)) problems.push("side advice");
    if (l.length > 180) problems.push(`${l.length} chars`);
    // Every number in the line must be derivable from the market: yes%, no%,
    // payout mults, volume, days/hours left. Extract digits and verify.
    const yes = Math.round(m.yesPct), no = 100 - yes;
    const allowed = new Set<string>([String(yes), String(no)]);
    for (const p of [yes, no]) { const r = 100 / p; allowed.add(String(r >= 10 ? Math.round(r) : Math.round(r * 10) / 10)); }
    if (m.volumeUsd >= 1e6) allowed.add((m.volumeUsd / 1e6).toFixed(1)); else allowed.add(String(Math.round(m.volumeUsd / 1e3)));
    if (m.closesAt) { const ms = new Date(m.closesAt).getTime() - Date.now();
      if (ms > 0) { allowed.add(String(Math.floor(ms / 86_400_000))); allowed.add(String(Math.max(1, Math.floor(ms / 3_600_000)))); allowed.add(String(Math.max(1, Math.floor(ms / 3_600_000)) + 1)); } }
    for (const num of l.match(/\d+(?:\.\d+)?/g) ?? []) {
      if (!allowed.has(num)) problems.push(`invented number ${num}`);
    }
    check(`"${l}"`, problems.length === 0, problems.join(", "));
  }
}

console.log("\nvalidReplyLine: the gate every LLM reply line must pass");
{
  const { validReplyLine } = await import("../src/card/tweetCopy.js");
  const m = mk(38, 4_600_000, 9);
  const tweet = "Mbappé: until I see a trophy in my hands, we are not the strongest";
  const ok = (l: string) => validReplyLine(l, m, tweet);
  check("a good reply passes", ok("he's not wrong to be careful — the market only gives it 38%"));
  check("dry odds pass", ok("38% yes, 62% no. $4.6M says it's genuinely open"));
  check("a tweet-quoted word passes", ok("\"not the strongest\" — the market half agrees at 38%"));
  check("an invented number dies", !ok("38% now but it was 55% last week"));
  check("an invented stat dies", !ok("he has 12 goals this tournament and it's still 38%"));
  check("hype dies", !ok("38% — insane value, don't miss this"));
  check("CTA dies", !ok("38% yes — check it out below"));
  check("side advice dies", !ok("at 38% you should take yes"));
  check("two emojis die", !ok("38% 👀 wild 👇"));
  check("a rocket dies", !ok("38% and climbing 🚀"));
  check("multiline dies", !ok("38%\nyes"));
  check("payout mult passes", ok("right on yes pays 2.6× at these odds"));

  // Editorializing on the price is implicit advice, and it dies.
  check("'undervalued' dies", !ok("38% but maybe undervalued for a team like this"));
  check("'overvalued' dies", !ok("62% no feels overvalued here"));
  check("'good value' dies", !ok("38% is good value if you believe him"));
  check("'value bet' dies", !ok("38% — a value bet either way"));
  check("'market is wrong' dies", !ok("the market is wrong about france at 38%"));
  check("'market's sleeping' dies", !ok("market's sleeping on them at 38%"));
  check("'better bet' dies", !ok("no at 62% is the better bet"));
  check("'worth a punt' dies", !ok("38% — worth a punt honestly"));
  check("'a steal' dies", !ok("at 38% it's a steal"));
  check("bare 'talk is cheap' still passes", ok("talk is cheap until you lift it — market says 38%"));
}

console.log("\ndeterminism: same market, same lines");
{
  const a = tweetCopy(mk(48, 4_600_000, 10)).join("|");
  const b = tweetCopy(mk(48, 4_600_000, 10)).join("|");
  check("byte-identical across calls", a === b);
}

// ---------------------------------------------------------------------------
// Verdicts: the voice rule, enforced. Wins are loud; losses are flat and never
// mock the caller. This is a safety property before a style one — X's weights
// put a reply at +5 and a mute at −58.8, so the tone that gets an account muted
// costs more than eleven answers earn.
// ---------------------------------------------------------------------------
console.log("\nverdicts: loud on a win, never a jab on a loss");
{
  const V = (side: "yes" | "no", entryPct: number, outcome: "yes" | "no") =>
    buildVerdict({ handle: "someone", side, entryPct, outcome,
      question: "Will the copy generator behave?", permalink: "https://oddie.fun/m/x-abc123" });

  const wonLong = V("yes", 12, "yes");   // 8.3x — a longshot
  const wonEven = V("yes", 55, "yes");
  const lost = V("yes", 38, "no");

  check("a win is flagged, a loss is not", wonEven.won && !lost.won);
  check("a long-odds win is flagged as one", wonLong.longshot, String(wonLong.longshot));
  check("...and an even-odds win is not", !wonEven.longshot);
  check("a loss is never a longshot, however long the odds", !V("yes", 5, "no").longshot);

  // The jab test. A losing verdict may state what happened and nothing more:
  // no adjective about the caller, no gloating, no "told you".
  const MOCKING = /\b(lol|oops|nice one|told you|obviously|of course|genius|clown|cope|rekt|wrong again|embarrassing|😂|🤡|💀)/i;
  for (const v of [lost, V("no", 91, "yes"), V("yes", 3, "no")]) {
    check(`a losing verdict carries no jab: "${v.primary.split("\n")[0]}"`, !MOCKING.test(v.primary));
  }
  check("a loss names the outcome plainly", lost.primary.includes("resolved NO"));
  check("...and still gives the caller their due", lost.primary.includes("in public"));

  check("a win names the caller", wonEven.primary.includes("@someone"));
  check("a longshot win puts the market's number in the lead, not the person",
    wonLong.primary.startsWith("the market gave it 12%"), wonLong.primary.split("\n")[0]);

  // Every verdict is postable and carries the link.
  for (const [name, v] of [["won long", wonLong], ["won even", wonEven], ["lost", lost]] as const) {
    check(`${name} fits 280 (${v.primary.length})`, v.primary.length <= 280);
    check(`${name} carries the permalink`, v.primary.includes("https://oddie.fun/m/x-abc123"));
    check(`${name} fallback is ASCII-safe`, !/[^\x00-\x7F]/.test(v.fallback), v.fallback);
  }

  // Odds are clamped, not trusted: a bad entry price must not produce "0%" or
  // a division by zero in the multiplier.
  check("an out-of-range entry clamps rather than printing 0%",
    V("yes", 0, "yes").primary.includes("1%"));
  check("...at the top end too", V("yes", 140, "yes").primary.includes("99%"));
}

console.log("\nthe reply carries its own number");
{
  // A reply cannot reach anyone who does not follow us, so it has to make its
  // point where it stands rather than behind the link.
  const r = buildTweetReply({ question: "Will it behave?", permalink: "https://oddie.fun/m/x-abc123", yesPct: 38 });
  check("the odds are in the reply text", r.primary.includes("38% yes"), r.primary);
  check("...and the reply still fits", r.primary.length <= 280);
  const noOdds = buildTweetReply({ question: "Will it behave?", permalink: "https://oddie.fun/m/x-abc123" });
  check("no price means no invented price", !/\d+% yes/.test(noOdds.primary), noOdds.primary);

  // The reply must not promise a grant. It used to be checked the other way
  // round, pinning that the CTA named the exact number of free points the
  // economy handed out, which was the right test while there were any.
  check("the reply promises no free grant",
    !/\bfree (points?|predictions?)\b/.test(r.primary), r.primary);
}

console.log("\npick(): deterministic variety, not randomness wearing a disguise");
{
  // The whole point of hashing instead of Math.random(): call it 50 times on
  // the SAME seed and every single call has to agree. If this is flaky, the
  // module's own "pure functions with no I/O" claim is false.
  const pool = ["a", "b", "c", "d", "e"] as const;
  const first = pick(pool, "a-fixed-seed");
  let stable = true;
  for (let i = 0; i < 50; i++) if (pick(pool, "a-fixed-seed") !== first) stable = false;
  check("the same seed always picks the same entry, every time", stable);

  // And the reverse failure mode: a hash that silently collapses to one index
  // regardless of input would make "variety" a lie too.
  const seen = new Set(Array.from({ length: 30 }, (_, i) => pick(pool, `seed-${i}`)));
  check("different seeds actually reach different entries", seen.size > 1, [...seen].join(","));
}

console.log("\nCTA_POOL: every entry keeps the one promise that can't be wordplay");
{
  // The voice can vary; the number the economy actually pays cannot. Checked
  // against EVERY pool entry, not just whichever one a sample call happens to
  // hash to. A future addition that drops the number would pass every other
  // test here and still be a lie the day it gets picked.
  for (const [i, cta] of CTA_POOL.entries()) {
    check(`CTA_POOL[${i}] promises no free grant`, !/\bfree (points?|predictions?)\b|\d/.test(cta()), cta());
  }
}

console.log("\nthe quote's lead and CTA come from the pools, and travel with the market");
{
  const q1 = buildTweetQuote({ question: "Will Amazon have a #1 AI model by December 31, 2026?", permalink: "https://oddie.fun/m/amazon-ai-1" });
  const leadText = QUOTE_LEAD_POOL.find((l) => q1.primary.startsWith(l) || q1.primary.includes(`\n${l}\n`));
  check("the primary opens with a real QUOTE_LEAD_POOL entry", !!leadText, q1.primary);
  check("the CTA promises no free grant", !/\bfree points?\b/.test(q1.primary), q1.primary);
  check("still fits the limit", q1.primary.length <= 280, `${q1.primary.length}`);

  // Same market, called again: must read exactly the same both times. This is
  // the property a retry (or an operator re-extracting the same tweet) leans on:
  // two different tweets pointing at the SAME market should not post two
  // different-sounding announcements of it.
  const q2 = buildTweetQuote({ question: "Will Amazon have a #1 AI model by December 31, 2026?", permalink: "https://oddie.fun/m/amazon-ai-1" });
  check("the same market reads identically on a second call", q1.primary === q2.primary);

  // A different market should not be guaranteed the same lead/CTA pairing,
  // sampled across enough permalinks that a coincidental match is implausible
  // (1/5 lead * 1/5 cta = 1/25 per pair) but the check only fails if EVERY
  // sample happens to collide, not on one unlucky draw.
  const leadsSeen = new Set<string>(), ctasSeen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const r = buildTweetQuote({ question: "Will X happen?", permalink: `https://oddie.fun/m/sample-${i}` });
    for (const l of QUOTE_LEAD_POOL) if (r.primary.includes(l)) leadsSeen.add(l);
    for (const c of CTA_POOL) if (r.primary.includes(c())) ctasSeen.add(c());
  }
  check("20 different markets are not all reading the identical lead", leadsSeen.size > 1, [...leadsSeen].join(" | "));
  check("...nor the identical CTA", ctasSeen.size > 1, [...ctasSeen].join(" | "));
}

console.log(failures === 0 ? "\nall copy checks passed.\n" : `\n${failures} copy check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
