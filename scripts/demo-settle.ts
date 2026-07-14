// The full settlement cycle against a GENUINELY resolved market, end to end:
// the outcome is read from the venue's live records by fetchResolution — the
// exact code path the production sweep runs — and everything downstream
// (proceeds, balance, edge, reputation, notification) is the real store.
//
// In-memory store (refuses to run with DATABASE_URL), so the demo leaves no
// residue anywhere.
//
//   npx tsx scripts/demo-settle.ts <conditionId> <question...>

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database — unset DATABASE_URL");
  process.exit(1);
}

import { createSlug, placeCall, settleMarket, positionsFor, getWallet, noticesFor, slugFor } from "../src/store/markets.js";
import { fetchResolution } from "../src/venues/resolution.js";
import type { Market } from "../src/venues/types.js";

const conditionId = process.argv[2];
const question = process.argv.slice(3).join(" ");
if (!conditionId || !question) {
  console.error("usage: npx tsx scripts/demo-settle.ts <conditionId> <question...>");
  process.exit(1);
}

// The market as it would have been snapshotted while still trading. The entry
// price is the snapshot's job in production; here we pin a plausible one so the
// arithmetic is legible (entry 38 -> a winning NO pays round(100*100/62) etc).
const m: Market = {
  venue: "polymarket", venueId: conditionId, question,
  yesPct: 38, closesAt: null, volumeUsd: 250_000, venueUrl: "x", tags: [],
};
await createSlug(m);
const slug = slugFor(m);

const HOLDER = "demo-holder-0001";  // calls NO at 62 (no terms)
const DOUBTER = "demo-doubter-001"; // calls YES at 38

console.log(`\nmarket: “${question}”`);
console.log(`slug: ${slug}\n`);

await placeCall(slug, "no", 100, HOLDER, [m]);
await placeCall(slug, "yes", 100, DOUBTER, [m]);
console.log(`holder  calls NO  — 100 tokens at 62% (balance ${(await getWallet(HOLDER)).tokens})`);
console.log(`doubter calls YES — 100 tokens at 38% (balance ${(await getWallet(DOUBTER)).tokens})`);

console.log(`\nasking the venue for its verdict (fetchResolution, live)…`);
const outcome = await fetchResolution("polymarket", conditionId);
if (!outcome) {
  console.error("the venue reports no terminal outcome for this market — pick a resolved one");
  process.exit(1);
}
console.log(`venue says: ${outcome.toUpperCase()}`);

const settled = await settleMarket(slug, outcome);
console.log(`\nsettled ${settled.length} position(s):`);
for (const s of settled) {
  console.log(`  ${s.deviceId}  ${s.side.toUpperCase().padEnd(3)} entry ${s.entryPct}% -> exit ${s.exitPct}%  proceeds ${s.proceeds}  edge ${s.edge > 0 ? "+" : ""}${s.edge}`);
}

for (const dev of [HOLDER, DOUBTER]) {
  const w = await getWallet(dev);
  const p = await positionsFor(dev, []);
  const n = await noticesFor(dev);
  console.log(`\n${dev}: balance ${w.tokens}, reputation ${p.overall.avgEdge}% over ${p.overall.closed} closed (provisional: ${p.overall.provisional})`);
  console.log(`  notification: ${n[0]?.body ?? "none"}`);
}

console.log(`\nidempotency: settling the same market again…`);
const again = await settleMarket(slug, outcome);
console.log(`  settled ${again.length} position(s); holder balance still ${(await getWallet(HOLDER)).tokens}`);
