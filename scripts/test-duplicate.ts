// The duplicate check, on the pair that caused it and on the pairs that must
// NOT be merged.
//
// The asymmetry is the whole design and it is pinned here: opening a twin is
// untidy, merging two different bets sends somebody's stake to a question they
// never took a side on. So every ambiguous case must fall out as "not a
// duplicate", including the case where the judge cannot be reached at all.
//
// Run with: npm run test-duplicate
if (process.env.DATABASE_URL) { console.error("refusing to run against a database"); process.exit(1); }

import { contenders, findDuplicate, samePriceBet, _setSameBetJudge, type OpenMarketRow } from "../src/matching/duplicate.js";
import type { PriceCheck } from "../src/price/index.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.error(`  ✗ ${n}`); if (d) console.error(`      ${d}`); }
};

const END = "2026-12-31T23:59:00.000Z";

// The two that were live beside each other, word for word.
const SAYLOR = "Will Bitcoin (BTC/USD) trade at or above $100,000 at any point before the end of 2026?";
const BITCOIN = "Will Bitcoin (BTC/USD) reach $100,000 at any point before the end of 2026?";

const row = (question: string, closesAt: string | null = END, priceCheck: PriceCheck | null = null): OpenMarketRow =>
  ({ slug: "existing", question, closesAt, priceCheck });

let judged = 0;
const judgeSays = (verdict: boolean) => _setSameBetJudge(async () => { judged++; return verdict; });

console.log("\nThe cheap gates");

let c = contenders({ question: SAYLOR, closesAt: END }, [row(BITCOIN)]);
check("the live pair survives the lexical gates", c.length === 1, `overlap ${c[0]?.overlap?.toFixed(2)}`);
check("and scores well above the floor", (c[0]?.overlap ?? 0) > 0.6, String(c[0]?.overlap));

c = contenders({ question: SAYLOR, closesAt: END }, [row(BITCOIN.replace("$100,000", "$150,000"))]);
check("a different strike never reaches the judge", c.length === 0);

c = contenders({ question: SAYLOR, closesAt: END }, [row(BITCOIN, "2026-06-30T23:59:00.000Z")]);
check("a different deadline never reaches the judge", c.length === 0);

c = contenders({ question: SAYLOR, closesAt: END }, [row("Will the Fed cut rates before the end of 2026?")]);
check("an unrelated market never reaches the judge", c.length === 0);

console.log("\nWhat only the judge can tell apart");

judged = 0; judgeSays(true);
let d = await findDuplicate({ question: SAYLOR, closesAt: END }, [row(BITCOIN)]);
check("the live pair is caught", d?.slug === "existing");
check("and it cost exactly one judgement", judged === 1, String(judged));

// One word apart, same numbers, same deadline. No threshold separates these.
const ETH = "Will Ethereum (ETH/USD) reach $100,000 at any point before the end of 2026?";
judged = 0; judgeSays(false);
d = await findDuplicate({ question: SAYLOR.replace("Bitcoin (BTC/USD)", "Ethereum (ETH/USD)"), closesAt: END }, [row(ETH.replace("Ethereum", "Bitcoin").replace("ETH/USD", "BTC/USD"))]);
check("a different asset is asked about, and the judge's no is final", d === null && judged === 1);

_setSameBetJudge(async () => { throw new Error("inference down"); });
d = await findDuplicate({ question: SAYLOR, closesAt: END }, [row(BITCOIN)]);
check("an unreachable judge opens a second market rather than merging", d === null);

console.log("\nPrice markets need no judge at all");

const pc = (over: Partial<PriceCheck> = {}): PriceCheck => ({
  chain: "solana", mint: "AAA", symbol: "TOK", name: "Token", pool: "p", supply: 1e6,
  metric: "mc", op: ">=", target: 4_000_000, mode: "touch", from: "2026-09-14T00:00:00Z", to: END, ...over,
});

check("the same bet is the same bet", samePriceBet(pc(), pc()));
check("a different target is a different bet", !samePriceBet(pc(), pc({ target: 5_000_000 })));
check("a different mint is a different bet", !samePriceBet(pc(), pc({ mint: "BBB" })));
check("touching is not closing above", !samePriceBet(pc(), pc({ mode: "at-close" })));
check("a different deadline is a different bet", !samePriceBet(pc(), pc({ to: "2026-11-30T00:00:00Z" })));

judged = 0; judgeSays(false);
d = await findDuplicate(
  { question: "Will $TOK reach a $4M market cap before the end of 2026?", closesAt: END, priceCheck: pc() },
  [row("Does $TOK hit four million this year?", END, pc())],
);
check("two price markets on the same bet merge on structure, wording ignored", d?.slug === "existing");
check("and no judgement was bought", judged === 0, String(judged));

judged = 0;
d = await findDuplicate(
  { question: "Will $TOK reach a $4M market cap before the end of 2026?", closesAt: END, priceCheck: pc() },
  [row("Will $TOK reach a $4M market cap before the end of 2026?", END, pc({ target: 9_000_000 }))],
);
check("identical wording does not merge two different price bets", d === null);
check("and the judge is never consulted about a price pair", judged === 0, String(judged));

_setSameBetJudge(null);
console.log(failures ? `\n${failures} failure(s)\n` : "\nall green\n");
process.exit(failures ? 1 : 0);
