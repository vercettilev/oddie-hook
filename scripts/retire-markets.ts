// Take markets off the board.
//
//   npm run retire -- --list                    what is on the board and its chain status
//   npm run retire -- --unminted                dry run: every market with no on-chain account
//   npm run retire -- --unminted --delete       actually remove them
//   npm run retire -- --slugs a,b,c             dry run: an explicit list
//   npm run retire -- --slugs a,b,c --delete    remove exactly those
//
// Dry run is the default and the selection is never a guess. --unminted is a
// FACT about a row (onchain_pubkey IS NULL), not a pattern match on a name;
// anything else has to be named slug by slug. Same discipline as
// scripts/cleanup-test-rows.ts and for the same reason: a rule that guesses is
// a rule that eventually guesses wrong, and this one destroys data.
//
// THE GUARD THAT OVERRIDES EVERY FLAG: a market holding SOL is never removed,
// whatever is passed. Deleting it would take the board down while the vault
// still holds somebody's stake and claim_winnings still points at it, and no
// amount of --delete makes that right.
//
// WHAT REMOVAL MEANS. It deletes the market_slug row; community_market,
// market_surfacer and market_call follow through ON DELETE CASCADE. For an
// unminted market that is the whole story.
//
// FOR A MINTED ONE, RECLAIM THE RENT FIRST. This used to say "the program has
// no close instruction, so its rent is gone for good", and that stopped being
// true when close_market shipped. It is still true that deleting the row
// strands the rent, but now for a different and more annoying reason: the rent
// IS recoverable, and scripts/reclaim-rent.ts finds what to close by reading
// these rows. Delete the row and you have thrown away the only pointer to
// 0.0029 SOL that was still yours to take back.
//   npm run reclaim-rent -- --close     then     npm run retire -- --slugs X --delete
// close_market refuses a market whose totals are non-zero, so a market anybody
// ever bet in cannot be reclaimed at all and this ordering costs nothing there.
// /m/{slug} answers 404 after removal either way.
//
// Needs DATABASE_URL on production; --unminted works without the chain layer,
// and a minted market needs it so the pool can be read before anything is
// deleted.

import pg from "pg";
import { isChainEnabled, fetchMarketOnChain } from "../src/chain/oddieChain.js";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const valueOf = (f: string): string | null => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};
const DELETE = has("--delete");
const SLUGS = (valueOf("--slugs") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

if (!process.env.DATABASE_URL) {
  console.error("\n  DATABASE_URL is required. This reads and can delete production rows.\n");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

interface Row { slug: string; question: string; onchain_pubkey: string | null; resolved_outcome: string | null }

const { rows } = await pool.query<Row>(
  `SELECT cm.slug, s.question, cm.onchain_pubkey, cm.resolved_outcome
     FROM community_market cm JOIN market_slug s ON s.slug = cm.slug
    ORDER BY cm.market_id`,
);

/** Lamports in a market's vault, or null when it cannot be read. Unminted
 *  markets have no vault and therefore nothing at risk. */
async function poolOf(r: Row): Promise<number | null> {
  if (!r.onchain_pubkey) return 0;
  if (!isChainEnabled()) return null;
  const st = await fetchMarketOnChain(r.onchain_pubkey).catch(() => null);
  return st ? st.totalYesLamports + st.totalNoLamports : null;
}

if (has("--list") || (!has("--unminted") && SLUGS.length === 0)) {
  console.log(`\n  ${rows.length} markets on the board.\n`);
  for (const r of rows) {
    const p = await poolOf(r);
    const chain = r.onchain_pubkey ? (p === null ? "on chain, unreadable" : `on chain, ${(p / 1e9).toFixed(3)} SOL`) : "NOT MINTED";
    console.log(`  ${r.resolved_outcome ? "settled " : "open    "} ${chain.padEnd(24)} ${r.slug.slice(0, 46)}`);
  }
  console.log(`\n  --unminted selects the not-minted ones. --slugs names any others.\n`);
  await pool.end();
  process.exit(0);
}

const picked = has("--unminted")
  ? rows.filter((r) => !r.onchain_pubkey)
  : rows.filter((r) => SLUGS.includes(r.slug));

const missing = SLUGS.filter((s) => !rows.some((r) => r.slug === s));
if (missing.length) {
  console.error(`\n  Not on the board: ${missing.join(", ")}\n`);
  await pool.end();
  process.exit(1);
}
if (picked.length === 0) {
  console.log(`\n  Nothing selected.\n`);
  await pool.end();
  process.exit(0);
}

console.log(`\n  ${picked.length} selected, ${rows.length - picked.length} staying.\n`);
const safe: Row[] = [];
for (const r of picked) {
  const p = await poolOf(r);
  if (p === null) {
    console.error(`  ! ${r.slug} is minted and its pool could not be read. Not removing it.`);
    continue;
  }
  if (p > 0) {
    // The guard no flag can override.
    console.error(`  ! ${r.slug} holds ${(p / 1e9).toFixed(4)} SOL. Not removing it, whatever was passed.`);
    continue;
  }
  safe.push(r);
  console.log(`  ${DELETE ? "-" : "would remove"} ${r.slug.slice(0, 50)}${r.onchain_pubkey ? "  (orphans its on-chain account)" : ""}`);
}

console.log(`\n  Staying on the board:`);
for (const r of rows.filter((x) => !safe.some((s) => s.slug === x.slug))) {
  console.log(`    ${r.slug.slice(0, 54)}`);
}

if (!DELETE) {
  console.log(`\n  DRY RUN. Nothing was deleted. Pass --delete when this is the list you want.\n`);
  await pool.end();
  process.exit(0);
}

// One statement, one transaction: a half-removed board is worse than either
// board. The cascade takes community_market, market_surfacer and market_call.
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const res = await client.query(`DELETE FROM market_slug WHERE slug = ANY($1::text[])`, [safe.map((r) => r.slug)]);
  await client.query("COMMIT");
  console.log(`\n  Removed ${res.rowCount}.\n`);
} catch (e) {
  await client.query("ROLLBACK");
  console.error(`\n  Rolled back, nothing removed: ${(e as Error).message}\n`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
