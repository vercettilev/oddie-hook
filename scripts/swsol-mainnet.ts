// Park a market's SOL in Sanctum's swSOL and bring it back, on mainnet, by hand.
//
// The first live run of park_swsol and unpark_swsol, the way it was agreed with
// Sanctum: one market, 1 SOL, every step printed. NOTHING IS SENT WITHOUT
// --send. Without it each command builds the exact transaction and has the RPC
// simulate it, which runs the real programs against the real accounts and
// changes nothing, so a dry run needs no key at all.
//
//   npx tsx scripts/swsol-mainnet.ts status   <market>
//   npx tsx scripts/swsol-mainnet.ts rehearse <market> <sol>
//   npx tsx scripts/swsol-mainnet.ts park     <market> <sol>      [--send]
//   npx tsx scripts/swsol-mainnet.ts unpark   <market> <sol|all>  [--send]
//
// rehearse is the round trip, park and unpark, as ONE simulated transaction:
// both calls into Sanctum's real program, against the real pool, before any
// SOL moves. It never sends; there would be nothing to show for it on chain.
//
// <market> is a slug or the market's address. --send signs with the admin key,
// the authority on every market and the address Sanctum credits our mints to,
// so it runs under the deployment's own environment:
//
//   railway run -p 508d41c0-e0ab-4dfd-94e8-a00881cd9e2e -e production -s oddie-hook -- sh -c 'unset DATABASE_URL; npx tsx scripts/swsol-mainnet.ts park <slug> 1 --send'
//
// It never prints key material, nor the RPC url, which carries a key.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BorshAccountsCoder, web3 } from "@coral-xyz/anchor";
import bs58 from "bs58";

const { PublicKey, Connection, Keypair, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = web3;
type Pk = InstanceType<typeof PublicKey>;

const SWSOL_PROGRAM = new PublicKey("so1f7APRw5pJ5iNJrM9g5X9tQgXzk8kMUnXxDNdt99b");
const SWSOL_MINT = new PublicKey("swso1x7A8Dy36znxtcstSVLNseeCQzNV3wVAfa5GGLu");
const SWSOL_POOL = new PublicKey("CugxVX9C5N1gmGTB4DGLjTcod1jTJtJFXgnkm9ExjyDP");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** The address Sanctum has on file for us (Telegram, 12 Oct 2026). A mint is
 *  credited to it by this memo in the same transaction; no signature is checked. */
const ATTRIBUTION = "J3bEmhdy7CeZeJRXHSJe2JEDyC39kmEWfBKUrYCQuPVY";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/** Sanctum's terms for the first live test: start at 1 SOL, never above 10. */
const MAX_PARKED = 10n * 1_000_000_000n;
/** Parking pays over weeks, and the server does not yet bring a vault home
 *  before it settles, so a market this close to its end is left alone. */
const MIN_DAYS_LEFT = 7;

function die(msg: string): never {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

const SEND = process.argv.includes("--send");
const [cmd, marketArg, amountArg] = process.argv.slice(2).filter((a) => a !== "--send");
if (!["status", "rehearse", "park", "unpark"].includes(cmd ?? "") || !marketArg || (cmd !== "status" && !amountArg)) {
  die("usage: npx tsx scripts/swsol-mainnet.ts status <market> | rehearse <market> <sol> | park <market> <sol> [--send] | unpark <market> <sol|all> [--send]");
}
if (SEND && cmd === "rehearse") die("rehearse only simulates. To move SOL, park.");

const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
if ((await conn.getGenesisHash()) !== MAINNET_GENESIS) die("This RPC is not mainnet, and swSOL only exists on mainnet.");

const idl = JSON.parse(readFileSync(new URL("../src/chain/oddie_chain_idl.json", import.meta.url), "utf8"));
const PROGRAM = new PublicKey(process.env.ODDIE_CHAIN_PROGRAM_ID ?? idl.address);
const coder = new BorshAccountsCoder(idl);

const sol = (l: bigint) => (Number(l) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 });
const ataOf = (owner: Pk) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), SWSOL_MINT.toBuffer()], ATA_PROGRAM)[0];

function parseSol(s: string): bigint {
  if (!/^\d+(\.\d{1,9})?$/.test(s)) die(`"${s}" is not an amount of SOL.`);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, "0"));
}

/** A slug goes through the public API, which is where the board keeps the address. */
async function findMarket(arg: string): Promise<{ address: Pk; label: string }> {
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(arg)) return { address: new PublicKey(arg), label: arg };
  const r = await fetch(`https://oddie.fun/api/v1/markets/${encodeURIComponent(arg)}`);
  const j = r.ok ? ((await r.json()) as { onchain?: { pubkey?: string }; questionDisplay?: string; question?: string }) : null;
  if (!j?.onchain?.pubkey) die(`No on-chain market for "${arg}" (HTTP ${r.status}).`);
  return { address: new PublicKey(j.onchain.pubkey), label: `${arg}\n           "${j.questionDisplay ?? j.question}"` };
}

interface State {
  market: Pk; authority: Pk; closeTime: number; resolved: boolean; open: boolean;
  staked: bigint; totalYes: bigint; totalNo: bigint;
  vault: Pk; vaultLamports: bigint; vaultRent: bigint;
  held: Pk; heldExists: boolean; swsol: bigint; poolLamports: bigint;
}

async function readState(market: Pk): Promise<State> {
  const info = await conn.getAccountInfo(market);
  if (!info) die("That market has no account on chain yet: it is minted on its first stake.");
  if (!info.owner.equals(PROGRAM)) die("That account is not an oddie market.");
  // Field names come back as the IDL spells them, snake_case.
  const m = coder.decode("Market", info.data);
  const [vault, bump] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM);
  if (bump !== m.vault_bump) die("The market's vault bump does not match its address.");
  const held = ataOf(vault);
  const [v, h, p] = await conn.getMultipleAccountsInfo([vault, held, SWSOL_POOL]);
  if (!v || !p) die("The vault or Sanctum's pool could not be read.");
  let swsol = 0n;
  if (h) {
    // The same three checks the program makes before it trusts this account.
    const ok = h.owner.equals(TOKEN) && new PublicKey(h.data.subarray(0, 32)).equals(SWSOL_MINT) && new PublicKey(h.data.subarray(32, 64)).equals(vault);
    if (!ok) die(`${held.toBase58()} is not the vault's swSOL account.`);
    swsol = h.data.readBigUInt64LE(64);
  }
  const closeTime = Number(m.close_time.toString());
  const resolved = Boolean(m.resolved);
  const totalYes = BigInt(m.total_yes.toString()), totalNo = BigInt(m.total_no.toString());
  return {
    market, authority: m.authority, closeTime, resolved, open: !resolved && Date.now() / 1000 < closeTime,
    staked: totalYes + totalNo, totalYes, totalNo,
    vault, vaultLamports: BigInt(v.lamports), vaultRent: BigInt(await conn.getMinimumBalanceForRentExemption(v.data.length)),
    held, heldExists: Boolean(h), swsol, poolLamports: BigInt(p.lamports),
  };
}

function printState(label: string, s: State): void {
  const days = (s.closeTime - Date.now() / 1000) / 86400;
  const when = new Date(s.closeTime * 1000).toISOString().slice(0, 16).replace("T", " ");
  const inVault = s.vaultLamports - s.vaultRent;
  // A vault opened before mainnet's rent was cut still holds the old, higher
  // rent, so a few thousand lamports over the stakes is history, not an error.
  const books = inVault + s.swsol;
  const mark = books === s.staked ? "✓" : books > s.staked ? `✓ (${sol(books - s.staked)} over, old rent)` : `✗ SHORT ${sol(s.staked - books)}`;
  console.log(`
  market   ${label}
           ${s.market.toBase58()}, closes ${when} UTC (${days.toFixed(1)} days), ${s.resolved ? "settled" : s.open ? "open" : "closed"}
  staked   ${sol(s.staked)} SOL  (yes ${sol(s.totalYes)}, no ${sol(s.totalNo)})
  vault    ${s.vault.toBase58()}  ${sol(inVault)} SOL of stakes + ${sol(s.vaultRent)} rent
  swSOL    ${s.held.toBase58()}  ${s.heldExists ? `${sol(s.swsol)} swSOL` : "not created yet"}
  books    vault ${sol(inVault)} + swSOL ${sol(s.swsol)} = ${sol(books)} against ${sol(s.staked)} staked ${mark}
  Sanctum  pool holds ${sol(s.poolLamports)} SOL
  signer   ${s.authority.toBase58()} is this market's authority`);
}

function adminKey(): InstanceType<typeof Keypair> {
  const s = process.env.SOLANA_ADMIN_SECRET_KEY?.trim();
  if (!s) die("--send signs with SOLANA_ADMIN_SECRET_KEY. Run it under railway run, as the top of this file shows.");
  return Keypair.fromSecretKey(s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s));
}

const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
function u64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

/** park_swsol and unpark_swsol take the same eight accounts; only the signer's name differs. */
function swsolIx(name: "park_swsol" | "unpark_swsol", signer: Pk, s: State, lamports: bigint) {
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: signer, isSigner: true, isWritable: false },
      { pubkey: s.market, isSigner: false, isWritable: false },
      { pubkey: s.vault, isSigner: false, isWritable: true },
      { pubkey: s.held, isSigner: false, isWritable: true },
      { pubkey: SWSOL_MINT, isSigner: false, isWritable: true },
      { pubkey: SWSOL_POOL, isSigner: false, isWritable: true },
      { pubkey: TOKEN, isSigner: false, isWritable: false },
      { pubkey: SWSOL_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc(name), u64(lamports)]),
  });
}

/** The vault's swSOL account, created on the first park and a no-op after. */
const createHeld = (payer: Pk, s: State) =>
  new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: s.held, isSigner: false, isWritable: true },
      { pubkey: s.vault, isSigner: false, isWritable: false },
      { pubkey: SWSOL_MINT, isSigner: false, isWritable: false },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });

const memo = () => new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(`sols:${ATTRIBUTION}`, "utf8") });

/** Simulate always; send only with --send. Returns the signature when it sent. */
async function run(instructions: InstanceType<typeof TransactionInstruction>[], signer: Pk): Promise<string | null> {
  const key = SEND ? adminKey() : null;
  if (key && !key.publicKey.equals(signer)) die(`The admin key is ${key.publicKey.toBase58()}, but this needs ${signer.toBase58()}.`);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: signer,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 25_000 }),
      ...instructions,
    ],
  }).compileToV0Message());

  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  console.log("\n  simulation");
  for (const line of sim.value.logs ?? []) console.log(`    ${line}`);
  if (sim.value.err) die(`The simulation failed: ${JSON.stringify(sim.value.err)}. Nothing was sent.`);
  console.log(`\n  simulation passed, ${sim.value.unitsConsumed} compute units`);
  if (!key) {
    console.log("  dry run: nothing was sent. Add --send to do it for real.\n");
    return null;
  }

  tx.sign([key]);
  const sig = await conn.sendTransaction(tx, { maxRetries: 5 });
  console.log(`  sent ${sig}`);
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) die(`It landed and failed: ${JSON.stringify(res.value.err)}. https://solscan.io/tx/${sig}`);
  console.log(`  confirmed  https://solscan.io/tx/${sig}`);
  return sig;
}

const { address, label } = await findMarket(marketArg);
const st = await readState(address);
printState(label, st);

/** What park refuses on top of what the program refuses. */
function parkable(s: State, amount: string): bigint {
  const lamports = parseSol(amount);
  const days = (s.closeTime - Date.now() / 1000) / 86400;
  if (lamports === 0n) die("Park something: the amount is zero.");
  if (!s.open) die("The market is not open, and only an open market parks.");
  if (days < MIN_DAYS_LEFT) die(`The market closes in ${days.toFixed(1)} days. Parking is for markets with ${MIN_DAYS_LEFT}+ days left.`);
  if (s.swsol + lamports > MAX_PARKED) die(`That would put ${sol(s.swsol + lamports)} SOL in swSOL; the agreed test cap is ${sol(MAX_PARKED)}.`);
  if (lamports > s.vaultLamports - s.vaultRent) die(`The vault holds ${sol(s.vaultLamports - s.vaultRent)} SOL of stakes; it cannot park ${sol(lamports)}.`);
  return lamports;
}
const parkIxs = (s: State, lamports: bigint) => [createHeld(s.authority, s), memo(), swsolIx("park_swsol", s.authority, s, lamports)];

if (cmd === "rehearse") {
  const lamports = parkable(st, amountArg);
  console.log(`\n  rehearse: park ${sol(lamports)} SOL and unpark it, in one simulated transaction`);
  await run([...parkIxs(st, lamports), swsolIx("unpark_swsol", st.authority, st, lamports)], st.authority);
} else if (cmd === "park") {
  const lamports = parkable(st, amountArg);
  console.log(`\n  park ${sol(lamports)} SOL as swSOL, memo sols:${ATTRIBUTION}`);
  const sig = await run(parkIxs(st, lamports), st.authority);
  if (sig) printState(label, await readState(address));
} else if (cmd === "unpark") {
  const lamports = amountArg === "all" ? st.swsol : parseSol(amountArg);
  if (lamports === 0n) die("Nothing to unpark: the vault holds no swSOL.");
  if (lamports > st.swsol) die(`The vault holds ${sol(st.swsol)} swSOL; it cannot unpark ${sol(lamports)}.`);
  console.log(`\n  unpark ${sol(lamports)} swSOL back into the vault as SOL`);
  const sig = await run([swsolIx("unpark_swsol", st.authority, st, lamports)], st.authority);
  if (sig) printState(label, await readState(address));
} else {
  console.log("");
}
