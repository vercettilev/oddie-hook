// Does every market our database calls settled actually say so on chain?
//
// WHY THIS EXISTS. /api/community/resolve writes the row first and fires the
// chain call afterwards, best-effort. The row LATCHES (`WHERE resolved_outcome
// IS NULL`), so a chain call that failed can never be retried through the API:
// the route answers 409 and stops. The market is then permanently settled in
// our database and open on chain, `claim_winnings` has no outcome to pay
// against, and a winner's claim fails with an error about an account rather
// than about a verdict. Nothing anywhere records that this happened.
//
// The chain is the record, so this holds no state of its own: it reads both
// sides and compares them. There is nothing here that can drift.
//
//   npm run resolve-reconcile              report only, changes nothing
//   npm run resolve-reconcile -- --apply   push our verdict to the chain
//
// Needs DATABASE_URL on production and the chain layer configured with the same
// admin key the server resolves with. It never prints key material.
//
// SAFE TO RUN REPEATEDLY. A market already carrying the right verdict on chain
// is reported as agreed and never touched.

import { cluster, isChainEnabled, fetchMarketOnChain, resolveMarketOnChain } from "../src/chain/oddieChain.js";
import { mintedMarketsForBackfill } from "../src/store/markets.js";

const APPLY = process.argv.includes("--apply");

function die(msg: string): never {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

if (!isChainEnabled()) {
  die("This compares our database against the chain, so it needs ONCHAIN_ENABLED and the admin key the server resolves with.");
}

const { rows } = await mintedMarketsForBackfill();
if (rows.length === 0) die("No minted markets in the database. DATABASE_URL is probably not pointed at production.");

console.log(`\n  ${rows.length} minted markets, against ${cluster()}.\n`);

let agreed = 0, open = 0, gap = 0, ahead = 0, diverged = 0, unreadable = 0, fixed = 0, failed = 0;

for (const r of rows) {
  const chain = await fetchMarketOnChain(r.onchainPubkey).catch(() => null);
  if (!chain) { unreadable++; console.log(`  ? ${r.slug} account unreadable on this cluster`); continue; }

  const dbOutcome = r.resolvedOutcome === "yes" || r.resolvedOutcome === "no" ? r.resolvedOutcome : null;

  if (!dbOutcome && !chain.resolved) { open++; continue; }

  if (dbOutcome && chain.resolved) {
    if (chain.winningSide === dbOutcome) { agreed++; continue; }
    // Both sides decided and they disagree. Money may already have moved on the
    // chain's answer, and resolve_market cannot be undone, so this is never
    // touched automatically no matter what --apply says.
    diverged++;
    console.error(`  ! ${r.slug} DISAGREES: database says ${dbOutcome}, chain says ${chain.winningSide}`);
    console.error(`      Nothing here will change that. Payouts may already have run on the chain's answer.`);
    continue;
  }

  if (!dbOutcome && chain.resolved) {
    // The chain is ahead of us. Rare, and it is a READ problem rather than a
    // write one, so it is reported and never written: our row is what the app
    // shows, and quietly adopting a verdict nobody at oddie recorded is worse
    // than showing a market that needs a look.
    ahead++;
    console.error(`  ! ${r.slug} settled ${chain.winningSide} ON CHAIN but open in the database`);
    continue;
  }

  // The gap this script exists for: we decided, the chain never heard.
  gap++;
  if (!APPLY) {
    console.log(`  + ${r.slug} database says ${dbOutcome}, chain is still open. Would push it.`);
    continue;
  }
  const out = await resolveMarketOnChain(r.onchainPubkey, dbOutcome!);
  if (out.ok) {
    fixed++;
    console.log(`  + ${r.slug} -> ${dbOutcome}${out.alreadyResolved ? " (already there)" : ` (${out.signature?.slice(0, 8)}…)`}`);
  } else {
    failed++;
    console.error(`  ! ${r.slug} could not be pushed: ${out.reason}, ${out.error}`);
  }
}

console.log(`\n  ${agreed} agree, ${open} still open, ${gap} database-only${APPLY ? ` (${fixed} pushed, ${failed} failed)` : ""}.`);
if (ahead) console.log(`  ${ahead} settled on chain but open here.`);
if (diverged) console.log(`  ${diverged} DISAGREE and were not touched.`);
if (unreadable) console.log(`  ${unreadable} unreadable.`);
if (!APPLY && gap) console.log(`\n  Pass --apply to push those ${gap} to the chain.`);
console.log("");

// A gap left unfixed means somebody cannot claim what they won, so a report-only
// run that FOUND one still fails: this belongs in a health check, not only in a
// terminal somebody is watching.
if (diverged || failed || ahead || (!APPLY && gap)) process.exit(1);
