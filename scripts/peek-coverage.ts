// Does the free candle source actually cover the tokens this feature is for?
// Uses the production feed, retries and all, and spaces calls so a rate limit
// is not mistaken for absence.
import { priceFeed } from "../src/price/feed.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const seen = new Map<string, { sym: string; mc: number; vol: number; dex: string }>();

for (const q of ["pepe", "cat", "dog", "ai", "moon"]) {
  for (const p of await priceFeed().searchPairs(q)) {
    if (p.chainId !== "solana") continue;
    const mc = p.marketCap ?? 0;
    if (mc <= 0 || mc > 3_000_000) continue;
    if (!seen.has(p.baseMint)) seen.set(p.baseMint, { sym: p.baseSymbol, mc, vol: p.volumeH24, dex: "" });
  }
  await sleep(1200);
}

const picks = [...seen.entries()].sort((a, b) => b[1].vol - a[1].vol).slice(0, 8);
console.log(`${seen.size} small Solana tokens seen; probing the ${picks.length} most traded\n`);
console.log("sym        mc(usd)   vol24h   candles");
let ok = 0;
for (const [mint, v] of picks) {
  let line = "";
  try {
    const info = await priceFeed().tokenInfo("solana", mint);
    await sleep(500);
    if (!info) line = "no token record";
    else if (!info.topPools.length) line = "no pool";
    else {
      const cs = await priceFeed().ohlcv("solana", info.topPools[0], "hour", 200);
      await sleep(500);
      line = String(cs.length);
      if (cs.length > 0) ok++;
    }
  } catch (e) {
    line = `ERR ${(e as Error).message.slice(-14)}`;
  }
  console.log(`${v.sym.slice(0, 9).padEnd(9)} ${Math.round(v.mc).toString().padStart(9)} ${Math.round(v.vol).toString().padStart(8)}   ${line}`);
}
console.log(`\n${ok}/${picks.length} had usable candles`);
