// A market taken off the board takes no new money (15 Oct: a bet reached the
// retired gold market through a shared link, minted it, and the oracle, which
// sweeps the board only, would never have settled it). The detail carries
// retiredAt; position/prepare and ensureMinted refuse a retired market; the
// page shows betting closed; the gold market goes back on the board once.
//
// Run with: npm run test-retired-market
import { readFileSync } from "node:fs";
import { communityMarketDetail, createCommunityMarket, retireMarket, RETURN_GOLD_2026_10_15_SQL } from "../src/store/markets.js";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

console.log("the store says when a market came off the board");
{
  const { slug } = await createCommunityMarket({ question: "Will the retired-market test pass?", closeTime: Math.floor(Date.now() / 1000) + 86_400 });
  const before = await communityMarketDetail(slug);
  check("a market on the board has no retiredAt", before !== null && !before.retiredAt, JSON.stringify(before?.retiredAt));
  const r = await retireMarket(slug, 0);
  const after = await communityMarketDetail(slug);
  check("retired, its detail says when", r.ok && typeof after?.retiredAt === "string" && !Number.isNaN(Date.parse(after.retiredAt)), JSON.stringify(after?.retiredAt));
}

const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../public/app/market.html", import.meta.url), "utf8");
const store = readFileSync(new URL("../src/store/markets.ts", import.meta.url), "utf8");
const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  return a < 0 || b < 0 ? "" : src.slice(a, b);
};

console.log("\nno new money into a retired market");
{
  const prepare = between(server, 'app.post("/api/chain/position/prepare"', "ensureMinted(slug)");
  check("position/prepare refuses it as closed, before anything is minted",
    /if \(detail\.retiredAt\) return res\.status\(409\)\.json\(\{ ok: false, reason: "closed" \}\);/.test(prepare));
  const mint = between(server, "async function ensureMinted(", "mintMarket(");
  check("ensureMinted spends no rent on it", /if \(detail\.retiredAt\) return null;/.test(mint));
  check("the market API says it is retired", /retired: Boolean\(detail\.retiredAt\),/.test(server));
}

console.log("\nthe page");
{
  check("a retired market reads as closed", /var closed = retired \|\| \(/.test(page) && /var retired = Boolean\(m\.retired\);/.test(page));
  check("...and points to what is open", page.includes("Betting is closed.") && page.includes('href="/markets"'));
}

console.log("\nthe gold market goes back on the board, once");
{
  const sql = RETURN_GOLD_2026_10_15_SQL;
  check("only the gold market", sql.includes("c.slug = 'will-the-price-of-gold-xauusd-176a74'"));
  check("only while it is off the board, minted, and unsettled",
    sql.includes("c.retired_at IS NOT NULL") && sql.includes("c.onchain_pubkey IS NOT NULL") && sql.includes("c.resolved_outcome IS NULL"));
  check("it clears retired_at and nothing else", /SET retired_at = NULL\s/.test(sql) && !/SET[^]*question|resolution_criteria|price_check/.test(sql.split("WHERE")[0]));
  check("it runs at boot with the other one-way steps", /RETIRE_GOLD_2026_10_13, RETURN_GOLD_2026_10_15\]/.test(store));
}

console.log(failed ? `\n${failed} failed` : "\nretired market: all passed");
process.exit(failed ? 1 : 0);
