// Live probe for the price oracle. Read-only, no database, no keys.
//   npm run peek-price -- BULLSHIT 4000000 2026-08-01 2026-08-31
import { resolvePriceClaim, checkPrice, criteriaSentence } from "../src/price/index.js";

const [symbol, targetRaw, fromDay, toDay, modeRaw] = process.argv.slice(2);
if (!symbol || !targetRaw) { console.error("usage: peek-price <SYMBOL> <TARGET_USD> [FROM] [TO] [touch|at-close|always]"); process.exit(1); }
const from = `${fromDay || "2026-08-01"}T00:00:00Z`;
const to = `${toDay || "2026-08-31"}T23:59:59Z`;
const mode = (modeRaw as any) || "touch";

const r = await resolvePriceClaim({ symbol, metric: "mc", op: ">=", target: Number(targetRaw), mode }, { from, to });
if (!r.ok) { console.log("REFUSED AT CREATION:", r.why); process.exit(0); }
console.log("token :", r.check.symbol, "|", r.check.name, "|", r.check.chain, r.check.mint);
console.log("pool  :", r.check.pool, "| supply", Math.round(r.check.supply).toLocaleString("en-US"));
console.log("criteria:", criteriaSentence(r.check));
const v = await checkPrice(r.check);
console.log("VERDICT:", v.outcome ?? "undetermined", "|", v.why, `| ${v.candles} candles`);
