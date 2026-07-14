// The tweet-copy generator's trust rules, enforced mechanically — because "the
// copy never invents anything" is a claim a regex can hold better than a vibe.
//
// Run with: npm run test-copy

import { tweetCopy } from "../src/card/tweetCopy.js";
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

console.log(failures === 0 ? "\nall copy checks passed.\n" : `\n${failures} copy check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
