// What one SOL is worth in dollars, for display beside a pool.
//
// Lev's rule since the landing rebuild: money READS in USD and SETTLES in SOL.
// A Kick viewer or a Telegram group has no idea what 0.5 SOL is, and the pool
// is the number that decides whether they care. Display only: nothing here is
// ever an input to a stake, a fee or a payout, all of which stay in lamports.
//
// One read per five minutes for the whole server, through the same keyless
// feed the oracle already uses. A failed read keeps the last good price for an
// hour and then gives up and returns null, so a page shows SOL alone rather
// than a dollar figure nobody measured today.

import { priceFeed } from "./feed.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const FRESH_MS = 5 * 60_000;
const STALE_MS = 60 * 60_000;

let last: { usd: number; at: number } | null = null;
let inflight: Promise<number | null> | null = null;

export async function solUsd(now = Date.now()): Promise<number | null> {
  if (last && now - last.at < FRESH_MS) return last.usd;
  inflight ??= priceFeed().tokenInfo("solana", SOL_MINT)
    .then((t) => {
      const usd = t?.priceUsd;
      if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) last = { usd, at: Date.now() };
      return last && Date.now() - last.at < STALE_MS ? last.usd : null;
    })
    .catch(() => (last && Date.now() - last.at < STALE_MS ? last.usd : null))
    .finally(() => { inflight = null; });
  return inflight;
}

/** Test seam. */
export function _setSolUsd(v: { usd: number; at: number } | null): void { last = v; }
