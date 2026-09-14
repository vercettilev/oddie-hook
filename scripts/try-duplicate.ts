// Ask the real judge about the pairs that matter.
import { findDuplicate, type OpenMarketRow } from "../src/matching/duplicate.js";
const END = "2026-12-31T23:59:00.000Z";
const row = (q: string): OpenMarketRow => ({ slug: "existing", question: q, closesAt: END, priceCheck: null });
const pairs: [string, string][] = [
  ["Will Bitcoin (BTC/USD) trade at or above $100,000 at any point before the end of 2026?",
   "Will Bitcoin (BTC/USD) reach $100,000 at any point before the end of 2026?"],
  ["Will Bitcoin (BTC/USD) reach $100,000 at any point before the end of 2026?",
   "Will Ethereum (ETH/USD) reach $100,000 at any point before the end of 2026?"],
  ["Will Bitcoin (BTC/USD) reach $100,000 at any point before the end of 2026?",
   "Will Bitcoin (BTC/USD) close below $100,000 at any point before the end of 2026?"],
  ["Will Bitcoin (BTC/USD) reach $100,000 at any point before the end of 2026?",
   "Will Bitcoin (BTC/USD) reach $100,000 on a Coinbase spot market before the end of 2026?"],
];
for (const [a, b] of pairs) {
  const d = await findDuplicate({ question: a, closesAt: END }, [row(b)]);
  console.log(`${d ? "SAME     " : "different"}  ${a.slice(0, 52)}…\n            ${b.slice(0, 52)}…`);
}
