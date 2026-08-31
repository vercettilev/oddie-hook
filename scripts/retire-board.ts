// Take markets off the board without destroying them.
//
//   npm run retire-board                     dry run: what would be retired
//   npm run retire-board -- --slugs a,b,c    dry run on exactly those
//   npm run retire-board -- --slugs a,b --go actually retire them
//
// This is the replacement for `retire --delete`, which is still there and is
// still the wrong tool for a market you merely want off the feed: that one
// deletes market_slug and cascades through community_market, market_surfacer
// and market_call, taking the record of who tagged the market with it, and it
// puts the on-chain account beyond reclaim-rent's reach because that script
// enumerates by database row.
//
// RETIRED MEANS UNDISCOVERABLE, NOT UNREACHABLE. The permalink still resolves,
// the detail still loads, and anyone's positions still list it. Only the feed,
// pricing, the agent API and the one-post-one-market check stop seeing it, so a
// fresh tag on the same post opens a fresh market.
//
// A market holding SOL is refused whatever is passed, and so is one whose vault
// cannot be read: "we could not check" must never resolve to "go ahead".

import pg from "pg";
import { isChainEnabled, stakedInVault } from "../src/chain/oddieChain.js";
import { adminListCommunity, retireMarket } from "../src/store/markets.js";

const args = process.argv.slice(2);
const GO = args.includes("--go");
const i = args.indexOf("--slugs");
if (i >= 0 && (!args[i + 1] || args[i + 1].startsWith("--"))) {
  console.error(`\n  --slugs needs a comma-separated list after it.\n`);
  process.exit(1);
}
const SLUGS = i >= 0 ? args[i + 1].split(",").map((s) => s.trim()).filter(Boolean) : [];

if (!process.env.DATABASE_URL) {
  console.error(`\n  DATABASE_URL is required. This changes production rows.\n`);
  process.exit(1);
}

const board = (await adminListCommunity()).filter((m) => !m.resolvedOutcome);
const picked = SLUGS.length ? board.filter((m) => SLUGS.includes(m.slug)) : board;

const missing = SLUGS.filter((s) => !board.some((m) => m.slug === s));
if (missing.length) { console.error(`\n  Not on the open board: ${missing.join(", ")}\n`); process.exit(1); }
if (!picked.length) { console.log(`\n  Nothing selected.\n`); process.exit(0); }

console.log(`\n  ${picked.length} selected of ${board.length} open${GO ? ", RETIRING" : ", dry run"}.\n`);

let done = 0, refused = 0;
for (const m of picked) {
  // Read the VAULT BALANCE, not the market's totals.
  //
  // The totals live in the Market account, and a Market written by an older
  // program layout cannot be deserialised at all, so asking it whether anybody
  // has money in there answers "unreadable" precisely when the answer matters.
  // The vault's balance is the runtime's own number and needs no decoding; it
  // is also the money itself rather than a claim about it. An unminted market
  // has no vault and nothing at risk.
  let vault: number | null = 0;
  if (m.onchainPubkey) vault = isChainEnabled() ? await stakedInVault(m.onchainPubkey) : null;

  if (!GO) {
    const verdict = vault === null ? "REFUSED (vault unreadable)" : vault > 0 ? `REFUSED (${(vault / 1e9).toFixed(4)} SOL)` : "would retire";
    console.log(`  ${verdict.padEnd(30)} ${m.slug.slice(0, 46)}`);
    continue;
  }
  const out = await retireMarket(m.slug, vault);
  if (out.ok) { done++; console.log(`  retired   ${m.slug.slice(0, 46)}`); }
  else { refused++; console.error(`  ! refused ${m.slug.slice(0, 46)}  ${out.reason}`); }
}

if (!GO) { console.log(`\n  DRY RUN. Nothing changed. Pass --go when this is the list you want.\n`); process.exit(0); }
console.log(`\n  ${done} retired, ${refused} refused.\n`);
if (refused) process.exit(1);
