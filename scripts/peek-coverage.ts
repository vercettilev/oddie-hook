// How much of Solana can a price market actually be opened on?
//
// Not "does the source know this coin" (it does; see the commit that paced the
// queue) but the question that decides the feature: take real, actively traded
// Solana tokens, feed their TICKER to the same resolver a tag would, and see
// whether it comes back with THAT token. A ticker that resolves to a different
// coin is worse than one that resolves to nothing.
import { priceFeed } from "../src/price/feed.js";
import { resolvePriceClaim } from "../src/price/index.js";

const PAGES = Number(process.env.PAGES || 3);
const LIMIT = Number(process.env.LIMIT || 30);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function topPools(page: number): Promise<any[]> {
  const r = await fetch(
    `https://api.geckoterminal.com/api/v2/networks/solana/pools?sort=h24_volume_usd_desc&page=${page}`,
    { headers: { accept: "application/json" } },
  );
  if (!r.ok) return [];
  return ((await r.json()) as any)?.data ?? [];
}

/* ONE ROW PER TICKER, NOT PER POOL, and the first version of this got that
   wrong: the same symbol appeared five times and each of its pools was scored
   separately, so one ticker resolving to one mint counted as four failures and
   one success. The question is per TICKER -- that is what a tagger types. */
/* TRUTH IS SUMMED PER MINT, and getting that wrong twice is why this file says
   so loudly. A token's volume is the sum over ITS POOLS; scoring a ticker by
   its single busiest pool called a three-pool token smaller than a one-pool
   rival and then counted the resolver "wrong" for preferring the bigger one.
   The measurement was the thing that was broken, not the resolver. */
const perMint = new Map<string, { symbol: string; vol: number; mc: number }>();
for (let p = 1; p <= PAGES; p++) {
  for (const pool of await topPools(p)) {
    const a = pool.attributes ?? {};
    const mint = String(pool.relationships?.base_token?.data?.id ?? "").replace(/^solana_/, "");
    const symbol = String(a.name ?? "").split("/")[0].trim().toUpperCase();
    const vol = Number(a.volume_usd?.h24 ?? 0);
    const mc = Number(a.market_cap_usd ?? a.fdv_usd ?? 0);
    if (!mint || !/^[A-Z0-9]{2,16}$/.test(symbol)) continue;
    const e = perMint.get(mint) ?? { symbol, vol: 0, mc };
    e.vol += vol;
    if (mc > 0) e.mc = mc;
    perMint.set(mint, e);
  }
  await sleep(2500);
}

const byTicker = new Map<string, { mint: string; vol: number; mc: number }>();
for (const [mint, t] of perMint) {
  const prev = byTicker.get(t.symbol);
  if (!prev || t.vol > prev.vol) byTicker.set(t.symbol, { mint, vol: t.vol, mc: t.mc });
}

const sample = [...byTicker.entries()]
  .map(([symbol, t]) => [t.mint, { symbol, vol: t.vol, mc: t.mc }] as const)
  .sort((a, b) => b[1].vol - a[1].vol)
  .slice(0, LIMIT);
console.log(`${sample.length} distinct Solana tokens sampled from the busiest pools\n`);
console.log("ticker      mc(usd)     vol24h  result");

const bucket = { right: 0, wrong: 0, refused: 0 };
const reasons = new Map<string, number>();
for (const [mint, t] of sample) {
  const r = await resolvePriceClaim(
    { symbol: t.symbol, metric: "price", op: ">=", target: 1, mode: "touch" },
    { from: "2026-09-01T00:00:00Z", to: "2026-09-30T00:00:00Z" },
  );
  let out: string;
  if (!r.ok) {
    bucket.refused++;
    const key = r.why.replace(/\$[A-Z0-9]+/g, "$X").replace(/^\d+ different/, "N different");
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
    out = `refused: ${r.why.slice(0, 62)}`;
  } else if (r.check.mint === mint) {
    bucket.right++;
    out = "opens, correct token";
  } else {
    bucket.wrong++;
    out = `WRONG TOKEN -> ${r.check.mint.slice(0, 10)}.. (${r.check.name.slice(0, 18)})`;
  }
  console.log(`${t.symbol.slice(0, 10).padEnd(10)} ${Math.round(t.mc).toString().padStart(11)} ${Math.round(t.vol).toString().padStart(10)}  ${out}`);
}

const n = sample.length || 1;
console.log(`\n  opens on the right token : ${bucket.right}/${n}  (${Math.round(100 * bucket.right / n)}%)`);
console.log(`  refused                  : ${bucket.refused}/${n}`);
console.log(`  OPENED ON THE WRONG ONE  : ${bucket.wrong}/${n}`);
if (reasons.size) {
  console.log("\nwhy refusals happened:");
  for (const [w, c] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(3)}  ${w}`);
}
