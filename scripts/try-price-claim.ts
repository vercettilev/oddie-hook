// One real extraction, to see whether the model reads a price claim as one.
//   npm run try-price-claim -- "$BULLSHIT hits 4m mc this month, screenshot this"
import { extractClaim } from "../src/matching/extractClaim.js";
import { resolvePriceClaim } from "../src/price/index.js";
const text = process.argv.slice(2).join(" ");
if (!text) { console.error('usage: try-price-claim "<tweet text>"'); process.exit(1); }
const ex = await extractClaim(text);
console.log("question   :", ex.question);
console.log("close_time :", ex.close_time, ex.close_time_inferred ? "(inferred)" : "");
console.log("grade      :", ex.resolvability, "| appropriate:", ex.appropriate);
console.log("price_claim:", JSON.stringify(ex.price_claim));
console.log("criteria   :", ex.resolution_criteria || "(left to the price path)");

if (ex.price_claim && ex.close_time) {
  const r = await resolvePriceClaim(ex.price_claim, { from: new Date().toISOString(), to: ex.close_time });
  console.log("token      :", r.ok ? `${r.check.symbol} ${r.check.chain}:${r.check.mint}` : `REFUSED (${r.why})`);
  if (r.ok) console.log("settles by :", r.sentence);
}
