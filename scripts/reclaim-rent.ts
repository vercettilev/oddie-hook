// Take back the rent on markets nobody ever used.
//
//   npm run reclaim-rent            dry run: what could be closed and for how much
//   npm run reclaim-rent -- --close actually close them
//
// Opening a market costs oddie a rent deposit for its Market and Vault accounts
// and nothing ever gave it back, so every market that was opened and then
// ignored was a permanent loss. Lazy minting stops most of those from being
// opened at all; this recovers the ones already out there.
//
// THE PROGRAM REFUSES ANYTHING ELSE, and the reason is worth repeating here
// because the rule looks needlessly strict from the outside. claim_winnings
// carries `close = owner`, so a LOSER still calls it to get their own position
// rent back, and that call needs the market account to exist. Closing a market
// anybody staked into would recover our deposit by stranding theirs. So: empty
// pool only, and only once the market is over.
//
// Needs DATABASE_URL and the chain layer configured with the admin key that
// opened the markets. It never prints key material.

import { cluster, isChainEnabled, fetchMarketOnChain, closeMarketOnChain } from "../src/chain/oddieChain.js";
import { mintedMarketsForBackfill } from "../src/store/markets.js";

const CLOSE = process.argv.includes("--close");

if (!isChainEnabled()) {
  console.error(`\n  This closes accounts our admin key owns, so it needs ONCHAIN_ENABLED and SOLANA_ADMIN_SECRET_KEY.\n`);
  process.exit(1);
}

const { rows } = await mintedMarketsForBackfill();
if (rows.length === 0) {
  console.error(`\n  No minted markets. DATABASE_URL is probably not pointed at production.\n`);
  process.exit(1);
}

console.log(`\n  ${rows.length} minted markets, against ${cluster()}.\n`);

let closable = 0, lamports = 0, held = 0, unreadable = 0, closed = 0, failed = 0;

for (const r of rows) {
  const state = await fetchMarketOnChain(r.onchainPubkey).catch(() => null);
  if (!state) { unreadable++; console.log(`  ?  ${r.slug} account unreadable`); continue; }

  const pool = state.totalYesLamports + state.totalNoLamports;
  if (pool > 0) {
    held++;
    console.log(`  .  ${r.slug.slice(0, 46).padEnd(46)} ${(pool / 1e9).toFixed(4)} SOL staked, stays open`);
    continue;
  }
  const over = state.resolved || state.closeTime * 1000 <= Date.now();
  if (!over) {
    held++;
    console.log(`  .  ${r.slug.slice(0, 46).padEnd(46)} empty but still open`);
    continue;
  }

  closable++;
  if (!CLOSE) {
    console.log(`  +  ${r.slug.slice(0, 46).padEnd(46)} empty and over, would close`);
    continue;
  }
  const out = await closeMarketOnChain(r.onchainPubkey);
  if (out.ok) {
    closed++;
    lamports += out.lamports;
    console.log(`  +  ${r.slug.slice(0, 46).padEnd(46)} ${(out.lamports / 1e9).toFixed(6)} SOL back`);
  } else {
    failed++;
    console.error(`  !  ${r.slug.slice(0, 46).padEnd(46)} ${out.reason}: ${out.error}`);
  }
}

// The estimate uses the CURRENT struct's rent. A market opened under the older,
// larger Market account holds more than this, so a dry run understates what
// closing it actually returns.
const RENT_PER_MARKET = (128 + 162) * 6960 + (128 + 41) * 6960;
if (!CLOSE) {
  console.log(`\n  ${closable} closable, ${held} staying open, ${unreadable} unreadable.`);
  console.log(`  About ${((closable * RENT_PER_MARKET) / 1e9).toFixed(5)} SOL, at least. Pass --close to take it back.\n`);
  process.exit(0);
}
console.log(`\n  ${closed} closed, ${(lamports / 1e9).toFixed(6)} SOL recovered, ${failed} failed, ${held} left open.\n`);
if (failed) process.exit(1);
