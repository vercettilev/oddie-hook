// Re-mint every existing market on the cluster oddie is moving to.
//
// WHY THIS EXISTS. "Deploy the program, flip SOLANA_RPC_URL" is not the mainnet
// move, and believing it is would take the product down. A market lives at a
// PDA derived from ["market", market_id], and that account exists only on the
// cluster it was minted on. Flip the RPC and every card in the feed points at
// an address that is not there: /api/chain/market answers "unreachable", every
// stake sheet dead-ends, and the whole board goes cold while looking fine.
//
// The PDA is derived from the market_id we already store, so re-minting with
// the SAME id reproduces the SAME address, and onchain_pubkey stays correct
// with no database write at all. That is the whole trick, and it is why this is
// a replay rather than a migration.
//
// TWO PHASES, AND THE ORDER IS NOT OPTIONAL.
//
//   snapshot   run while SOLANA_RPC_URL still points at the OLD cluster
//   replay     run after the deploy, with SOLANA_RPC_URL on the NEW one
//
// Snapshot first because close_time, the authority, the creator and BOTH fee
// rates live on the market account, not in our database, and they are not
// derivable from today's constants: markets minted before the protocol fee
// existed carry 300/0 and must keep carrying it. Once the RPC is flipped those
// values are unreadable.
//
//   npm run mainnet-backfill -- snapshot            # read old cluster, write the file
//   npm run mainnet-backfill -- replay              # DRY RUN against the new cluster
//   npm run mainnet-backfill -- replay --apply      # mint for real
//   npm run mainnet-backfill -- verify              # prove every PDA is now live
//
// EVERY phase needs DATABASE_URL on production AND the chain layer configured
// (ONCHAIN_ENABLED plus SOLANA_ADMIN_SECRET_KEY): snapshot reads accounts
// through the same client replay mints with, so without the key it reads
// nothing and would write a file that says every market is unreadable. It never
// prints key material.
//
// SAFE TO RUN TWICE. Replay skips any market whose account already exists on
// the target cluster, so an interrupted run is resumed by running it again.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  cluster, isChainEnabled, mintMarket, fetchMarketOnChain, adminAddress, adminBalanceSol,
  programIdString,
} from "../src/chain/oddieChain.js";
import { mintedMarketsForBackfill } from "../src/store/markets.js";

const FILE = "mainnet-backfill.json";
const args = process.argv.slice(2);
const mode = args[0];
const APPLY = args.includes("--apply");

/** Rent for one market account plus its vault, measured on devnet 2026-08-25. */
const RENT_PER_MARKET_SOL = 0.0043;

interface SnapMarket {
  slug: string;
  marketId: string;      // bigint from pg, kept a STRING all the way through
  question: string;
  expectedPubkey: string;
  closeTime: number;
  authority: string | null;
  creator: string | null;
  creatorFeeBps: number;
  protocolFeeBps: number;
  /** The rule, carried so a re-mint commits to it rather than to nothing. */
  resolutionCriteria: string | null;
  resolved: boolean;         // the chain's flag
  resolvedOutcome: string | null; // ours, which moves first
}
interface Snap {
  takenAt: string;
  cluster: string;
  programId: string | null;
  neverMinted: number;
  markets: SnapMarket[];
  unreadable: { slug: string; expectedPubkey: string; owner: string | null; reason: string }[];
}

function die(msg: string): never {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

/** Settled by EITHER authority. The chain flag only turns true once a resolve
 *  transaction lands, and our database moves first, so filtering on the chain
 *  alone would re-mint decided questions as open. */
const isSettled = (m: SnapMarket): boolean => m.resolved || m.resolvedOutcome != null;

function loadSnap(): Snap {
  if (!existsSync(FILE)) die(`No ${FILE}. Run snapshot on the OLD cluster first, before flipping SOLANA_RPC_URL.`);
  let snap: Snap;
  try { snap = JSON.parse(readFileSync(FILE, "utf8")) as Snap; }
  catch (e) { die(`${FILE} is not readable JSON: ${(e as Error).message}`); }
  if (!Array.isArray(snap.markets)) die(`${FILE} has no markets array. It is not a snapshot from this script.`);
  if (snap.markets.length === 0) die(`${FILE} contains no markets. Refusing to act on an empty snapshot.`);
  return snap;
}

/** Three tries. A single un-retried read means one RPC blink drops a healthy
 *  market out of the file forever: replay never mints it, verify never checks
 *  it, and after the flip its terms cannot be read again. */
async function readMarket(pubkey: string) {
  for (let i = 0; i < 3; i++) {
    const st = await fetchMarketOnChain(pubkey).catch(() => null);
    if (st) return st;
    if (i < 2) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  return null;
}

async function snapshot(): Promise<void> {
  // Without the admin key `load()` returns null and every read comes back
  // empty, so this would cheerfully write a file declaring the whole board
  // unreadable and look like it worked.
  if (!isChainEnabled()) {
    die("Snapshot reads market accounts through the same client replay mints with. Set ONCHAIN_ENABLED and SOLANA_ADMIN_SECRET_KEY, or every market lands in `unreadable`.");
  }
  const from = cluster();
  const pid = await programIdString();
  console.log(`\n  Reading every minted market from ${from}, program ${pid}.\n`);

  const { rows, neverMinted } = await mintedMarketsForBackfill();
  if (rows.length === 0) {
    die("No minted markets in the database. DATABASE_URL is probably not pointed at production.");
  }
  const markets: SnapMarket[] = [];
  const unreadable: Snap["unreadable"] = [];

  for (const r of rows) {
    const st = await readMarket(r.onchainPubkey);
    if (!st) {
      // Name the OWNER. An account owned by a retired program is a legacy
      // orphan that is already dead on the board and stays dead; one that is
      // simply absent, or owned by us and still unreadable, is a different
      // problem and the operator has to be able to tell them apart.
      const owner = await ownerOf(r.onchainPubkey);
      unreadable.push({
        slug: r.slug, expectedPubkey: r.onchainPubkey, owner,
        reason: owner === null ? "no account at that address"
          : owner === pid ? "owned by THIS program but would not decode"
          : `owned by ${owner}, a different program`,
      });
      continue;
    }
    // Nothing here is recomputed from a constant. Every value is what the
    // account actually carries, because that is what has to be reproduced.
    markets.push({
      slug: r.slug,
      marketId: r.marketId,
      question: r.question,
      /* From the ROW, not the account: the chain carries only the hash and a
         hash cannot be re-minted into a commitment. If the row has no criteria
         the re-mint commits to nothing, which is the truth about that market. */
      resolutionCriteria: r.resolutionCriteria,
      expectedPubkey: r.onchainPubkey,
      closeTime: st.closeTime,
      authority: st.authority,
      creator: st.creator,
      creatorFeeBps: st.creatorFeeBps,
      protocolFeeBps: st.protocolFeeBps,
      resolved: st.resolved,
      resolvedOutcome: r.resolvedOutcome,
    });
  }

  if (markets.length === 0) {
    die(`Every one of the ${rows.length} accounts was unreadable. SOLANA_RPC_URL is probably on the wrong cluster; refusing to overwrite a good snapshot with an empty one.`);
  }

  const snap: Snap = { takenAt: new Date().toISOString(), cluster: from, programId: pid, neverMinted, markets, unreadable };
  writeFileSync(FILE, JSON.stringify(snap, null, 2));

  const settled = markets.filter(isSettled).length;
  console.log(`  ${rows.length} minted rows in the database.`);
  console.log(`  ${markets.length} read, ${markets.length - settled} still open, ${settled} settled.`);
  console.log(`  ${neverMinted} community markets were never minted at all: they answer not-minted today and will after the move, which is not a regression.`);
  if (unreadable.length) {
    console.log(`\n  ${unreadable.length} could not be read. They ARE recorded in the file, and replay will NOT re-mint them:`);
    for (const u of unreadable) console.log(`    ${u.slug}: ${u.reason}`);
  }
  const odd = markets.filter((m) => m.creatorFeeBps !== 200 || m.protocolFeeBps !== 200);
  if (odd.length) {
    console.log(`\n  ${odd.length} carry rates that are NOT today's 200/200, and they keep them:`);
    for (const m of odd.slice(0, 8)) console.log(`    ${m.slug}: creator ${m.creatorFeeBps} protocol ${m.protocolFeeBps}`);
  }
  console.log(`\n  Wrote ${FILE}. Keep it: after the RPC flips, these values cannot be read again.\n`);
  // Non-zero AFTER the write, never instead of it: the file is the
  // irreplaceable artifact and a bad exit code must not cost it.
  const shouldHaveRead = unreadable.filter((u) => u.owner === null || u.owner === pid);
  if (shouldHaveRead.length) {
    console.error(`  ${shouldHaveRead.length} should have been readable and were not. The file is written; look at those before replaying.\n`);
    process.exit(1);
  }
}

async function ownerOf(pubkey: string): Promise<string | null> {
  try {
    const r = await fetch(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [pubkey, { encoding: "base64" }] }),
    });
    const j = await r.json() as { result?: { value?: { owner?: string } | null } };
    return j.result?.value?.owner ?? null;
  } catch { return null; }
}

async function replay(): Promise<void> {
  const snap = loadSnap();
  const to = cluster();

  // The one mistake that would waste the whole run: replaying onto the cluster
  // the snapshot came from. Every mint would fail as already-in-use and the
  // output would look like a disaster while nothing was wrong.
  if (snap.cluster === to) {
    die(`This snapshot was taken on ${snap.cluster} and this script's SOLANA_RPC_URL still points there. Flip it to the new cluster first.`);
  }
  if (APPLY && !isChainEnabled()) {
    die("The chain layer is off. Replay needs ONCHAIN_ENABLED and the admin key the server mints with.");
  }
  // The PDA derives from the program id, so a snapshot taken against a
  // different program describes addresses this build cannot reproduce.
  const pid = await programIdString();
  if (snap.programId && pid && snap.programId !== pid) {
    die(`Snapshot was taken against program ${snap.programId} and this build mints into ${pid}. The PDAs would not match.`);
  }
  // Minting under a key the existing markets do not answer to would rebuild the
  // board under a signer that cannot resolve any of it.
  const admin = await adminAddress();
  const authorities = [...new Set(snap.markets.map((m) => m.authority).filter(Boolean))];
  if (APPLY && admin && authorities.length === 1 && authorities[0] !== admin) {
    die(`Every snapshotted market answers to authority ${authorities[0]} and this build would mint with ${admin}. Use the same admin key.`);
  }

  // Settled markets are deliberately NOT re-minted. Re-minting one as open
  // would put a decided question back on the board and invite bets on a known
  // answer. Their pools were paid out on the old cluster and their cards read
  // as unreachable here, which is honest.
  const now = Math.floor(Date.now() / 1000);
  const open = snap.markets.filter((m) => !isSettled(m));
  const settledChain = snap.markets.filter((m) => m.resolved).length;
  const settledDb = snap.markets.filter((m) => !m.resolved && m.resolvedOutcome != null).length;
  // create_market rejects a close_time in the past, so these cannot be minted
  // at all. Say so instead of promising a mint that will fail.
  const stale = open.filter((m) => m.closeTime <= now);
  const mintable = open.filter((m) => m.closeTime > now);

  console.log(`\n  ${snap.markets.length} in the snapshot from ${snap.cluster}, taken ${snap.takenAt}.`);
  console.log(`  ${settledChain} settled on chain, ${settledDb} settled in our database only. Both skipped on purpose.`);
  console.log(`  ${mintable.length} to re-mint on ${to}. ${stale.length} are past their close time and cannot be minted.`);
  console.log(`  Rent, roughly ${(mintable.length * RENT_PER_MARKET_SOL).toFixed(3)} SOL at ${RENT_PER_MARKET_SOL} each.`);
  const bal = await adminBalanceSol();
  if (admin) console.log(`  Minting from ${admin}${bal != null ? `, holding ${bal.toFixed(4)} SOL` : ""}.`);
  const need = mintable.length * RENT_PER_MARKET_SOL;
  if (APPLY && bal != null && bal < need) {
    die(`Admin holds ${bal.toFixed(4)} SOL and this run needs about ${need.toFixed(3)}. Fund it and run again; anything already minted is skipped.`);
  }
  if (!APPLY) console.log(`\n  DRY RUN. Nothing will be minted. Pass --apply when this looks right.`);
  console.log("");

  for (const m of stale) {
    console.log(`  x ${m.slug} past close ${new Date(m.closeTime * 1000).toISOString().slice(0, 10)}, create_market would reject it`);
  }

  let done = 0, already = 0, failed = 0, attempted = 0;
  for (const m of mintable) {
    attempted++;
    // Idempotent: if the PDA is already there this run is a resume, not a
    // retry, so it costs nothing and says so.
    const existing = await fetchMarketOnChain(m.expectedPubkey).catch(() => null);
    if (existing) { already++; console.log(`  = ${m.slug} already on ${to}`); continue; }
    if (!APPLY) { console.log(`  + would mint ${m.slug} at ${m.expectedPubkey}`); continue; }

    // market_id is a u64 on chain and a bigint in pg, carried as a string to
    // here. mintMarket takes a number, and Date.now() ids sit around 1.79e12 so
    // the conversion is safe today, but a lossy one would derive a DIFFERENT
    // PDA and mint a market at an address the database does not know. Stop
    // rather than find that out afterwards.
    const idNum = Number(m.marketId);
    if (!Number.isSafeInteger(idNum) || String(idNum) !== m.marketId) {
      failed++;
      console.error(`  ! ${m.slug} market_id ${m.marketId} does not survive a number conversion; refusing to mint it`);
      continue;
    }
    const out = await mintMarket({
      marketId: idNum,
      question: m.question,
      closeTime: m.closeTime,
      creator: m.creator,
      creatorFeeBps: m.creatorFeeBps,
      protocolFeeBps: m.protocolFeeBps,
      criteria: m.resolutionCriteria ?? "",
    });
    if (!out) { failed++; console.error(`  ! ${m.slug} FAILED to mint`); continue; }
    // The address is the whole point. If it does not match, the market_id did
    // not survive the round trip and onchain_pubkey in the database is now
    // wrong, which is worse than not minting at all.
    if (out.pubkey !== m.expectedPubkey) {
      failed++;
      console.error(`  ! ${m.slug} MINTED AT THE WRONG ADDRESS`);
      console.error(`      expected ${m.expectedPubkey}`);
      console.error(`      got      ${out.pubkey}`);
      console.error(`      Stop and work out why before continuing: the database still points at the expected one.`);
      break;
    }
    done++;
    console.log(`  + ${m.slug} -> ${out.pubkey}`);
  }

  const untouched = mintable.length - attempted;
  console.log(`\n  ${APPLY ? `Minted ${done}` : `Would mint ${mintable.length - already}`}, ${already} already there, ${failed} failed, ${untouched} not attempted, out of ${mintable.length}.`);
  if (failed) console.log(`  Run verify before you trust the board.`);
  console.log("");
  if (APPLY && failed) process.exit(1);
}

async function verify(): Promise<void> {
  const snap = loadSnap();
  const to = cluster();
  // Inverted from replay's guard: verifying against the cluster the snapshot
  // came from would pass trivially and prove nothing about the move.
  if (snap.cluster === to) {
    die(`This snapshot came from ${snap.cluster} and that is the cluster this script is pointed at. Verifying there proves nothing.`);
  }
  console.log(`\n  Checking ${snap.markets.length} snapshotted markets (taken ${snap.takenAt}) against ${to}.\n`);

  let live = 0, missing = 0, drift = 0;
  for (const m of snap.markets) {
    const st = await readMarket(m.expectedPubkey);
    if (!st) {
      if (isSettled(m)) { console.log(`  . ${m.slug} absent, settled, expected`); continue; }
      if (m.closeTime <= Math.floor(Date.now() / 1000)) { console.log(`  . ${m.slug} absent, past close, could not be minted`); continue; }
      missing++; console.error(`  ! ${m.slug} MISSING at ${m.expectedPubkey}`); continue;
    }
    // A market that came back with different terms is worse than a missing
    // one, because it looks fine and pays differently.
    if (st.creatorFeeBps !== m.creatorFeeBps || st.protocolFeeBps !== m.protocolFeeBps
        || st.closeTime !== m.closeTime || (m.authority && st.authority !== m.authority)) {
      drift++;
      console.error(`  ! ${m.slug} TERMS DIFFER`);
      console.error(`      was creator ${m.creatorFeeBps} protocol ${m.protocolFeeBps} close ${m.closeTime} authority ${m.authority}`);
      console.error(`      now creator ${st.creatorFeeBps} protocol ${st.protocolFeeBps} close ${st.closeTime} authority ${st.authority}`);
      continue;
    }
    live++;
  }

  // Anything minted AFTER the snapshot is invisible to the file, and that is
  // exactly the market a cutover is most likely to lose.
  let orphaned = 0;
  const { rows } = await mintedMarketsForBackfill().catch(() => ({ rows: [], neverMinted: 0 }));
  const known = new Set(snap.markets.map((m) => m.expectedPubkey).concat(snap.unreadable.map((u) => u.expectedPubkey)));
  for (const r of rows) {
    if (known.has(r.onchainPubkey)) continue;
    orphaned++;
    console.error(`  ! ${r.slug} is minted in the database but absent from the snapshot: created after it was taken`);
  }

  if (snap.unreadable.length) {
    console.log(`\n  ${snap.unreadable.length} were unreadable at snapshot time and were deliberately not re-minted:`);
    for (const u of snap.unreadable) console.log(`    ${u.slug}: ${u.reason}`);
  }
  console.log(`\n  ${live} live and identical, ${missing} missing, ${drift} with different terms, ${orphaned} newer than the snapshot.\n`);
  if (missing || drift || orphaned) process.exit(1);
}

if (mode === "snapshot") await snapshot();
else if (mode === "replay") await replay();
else if (mode === "verify") await verify();
else {
  console.log(`
  Re-mint existing markets on a new cluster, reproducing each PDA exactly.

    npm run mainnet-backfill -- snapshot          read the OLD cluster into ${FILE}
    npm run mainnet-backfill -- replay            dry run against the NEW cluster
    npm run mainnet-backfill -- replay --apply    mint for real
    npm run mainnet-backfill -- verify            prove every PDA is live and unchanged

  Snapshot BEFORE flipping SOLANA_RPC_URL. close_time, the authority, the
  creator and both fee rates live on the account, not in the database, and
  cannot be read afterwards. Every phase needs the chain layer configured.
`);
}
