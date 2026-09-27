// A wallet may hold both sides of a market, and farmers doing so are welcome.
// The ledger has to record both legs and still count one person.
if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database: unset DATABASE_URL");
  process.exit(1);
}
import { readFileSync } from "node:fs";
import { recordChainEntry, walletsInMarket, stakerCounts, chainEntryFor } from "../src/store/markets.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

const W = "TwoSidedWa11etTwoSidedWa11etTwoSidedWa11111";
await recordChainEntry({ slug: "hedge", wallet: W, side: "yes", entryPct: 50, lamports: 1e8 });
await recordChainEntry({ slug: "hedge", wallet: W, side: "no", entryPct: 0, lamports: 1e8 });
await recordChainEntry({ slug: "hedge", wallet: W, side: "yes", entryPct: 50, lamports: 5e7 }); // a top-up
const rows = await walletsInMarket("hedge");
check("both legs of a two-sided wallet are recorded", rows.length === 2 && rows.some((r) => r.side === "yes") && rows.some((r) => r.side === "no"));
check("a top-up on a side it already holds adds no row", rows.filter((r) => r.side === "yes").length === 1);
check("it counts as one person", (await stakerCounts(["hedge"]))["hedge"] === 1);
check("its receipt starts from its first stake", (await chainEntryFor("hedge", W))?.side === "yes");

const store = readFileSync("src/store/markets.ts", "utf8");
check("the key is (slug, wallet, side) for new tables", /PRIMARY KEY \(slug, wallet, side\)\n\);/.test(store));
check("...and existing tables are moved to it, once", /ADD PRIMARY KEY \(slug, wallet, side\);/.test(store)
  && /constraint_name = 'chain_entry_pkey'\) = 2 THEN/.test(store));
check("a new stake on the other side is written, not dropped", /ON CONFLICT \(slug, wallet, side\) DO NOTHING/.test(store));
check("people are counted as distinct wallets", /count\(DISTINCT wallet\)::int AS n FROM chain_entry/.test(store));
check("open positions list a market once", /SELECT DISTINCT ON \(ce\.slug\)/.test(store));
const server = readFileSync("src/server.ts", "utf8");
check("the settlement crowd counts people, not rows", /stakers: new Set\(entries\.map\(\(e\) => e\.wallet\)\)\.size/.test(server));

console.log(failures ? `\n${failures} failure(s)\n` : "\nall two-sided checks passed.\n");
process.exit(failures ? 1 : 0);
