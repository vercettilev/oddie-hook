/**
 * THE MIGRATION, AGAINST A GENUINE OLD ACCOUNT.
 *
 * migrate_position rewrites bytes an Anchor struct can no longer read, which
 * means every ordinary test in this repo is blind to it: they all create
 * positions with the NEW program and there is no way to fake an old one from
 * TypeScript, because only the owning program may write to the account.
 *
 * So this does the real thing. It deploys the binary that is live on mainnet
 * (hash-identical, saved before the rebuild), opens a market and a position
 * through it, upgrades the program in place exactly as the mainnet upgrade
 * will, and then migrates and claims. If this passes, the one live position on
 * mainnet survives the upgrade; if it does not, we find out here instead of
 * there.
 *
 *   npm run test-migration
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, PublicKey, Connection } from "@solana/web3.js";

const URL = "http://127.0.0.1:8899";
const OLD_SO = "/tmp/oddie_old.so";
const NEW_SO = "onchain/target/deploy/oddie_chain.so";
const KEYPAIR = "onchain/target/deploy/oddie_chain-keypair.json";
const OLD_IDL = "src/chain/oddie_chain_idl.json";
const NEW_IDL = "onchain/target/idl/oddie_chain.json";

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failed++;
};
const sh = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

async function main() {
  const conn = new Connection(URL, "confirmed");
  const payer = Keypair.generate();
  const user = Keypair.generate();
  for (const kp of [payer, user]) {
    const sig = await conn.requestAirdrop(kp.publicKey, 20 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) });
  }
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  console.log("\ndeploying the binary that is live on mainnet");
  sh("solana", ["program", "deploy", OLD_SO, "--program-id", KEYPAIR, "--url", URL,
    "--upgrade-authority", process.env.HOME + "/.config/solana/id.json"]);
  const programId = new PublicKey(sh("solana", ["address", "-k", KEYPAIR]).trim());
  await settled(conn);
  check("old program deployed", true, programId.toBase58());

  const oldIdl = JSON.parse(readFileSync(OLD_IDL, "utf8"));
  const oldProgram = new Program(oldIdl as anchor.Idl, provider) as Program<anchor.Idl>;

  const id = new BN(Date.now());
  const market = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), id.toArrayLike(Buffer, "le", 8)], programId)[0];
  const vault = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market.toBuffer()], programId)[0];
  const position = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), user.publicKey.toBuffer()], programId)[0];

  await oldProgram.methods
    .createMarket(id, "Will the migration hold?", new BN(Math.floor(Date.now() / 1000) + 3600),
      payer.publicKey, 200, 200)
    .accounts({ authority: payer.publicKey, market, vault, systemProgram: SystemProgram.programId })
    .rpc();
  await oldProgram.methods.takePosition(0, new BN(2 * LAMPORTS_PER_SOL))
    .accounts({ user: user.publicKey, market, vault, position, systemProgram: SystemProgram.programId })
    .signers([user]).rpc();

  const before = await conn.getAccountInfo(position);
  check("a position exists in the OLD format", before !== null && before.data.length === 83,
    `${before?.data.length} bytes`);

  console.log("\nupgrading the program in place, as mainnet will");
  sh("solana", ["program", "extend", programId.toBase58(), "200000", "--url", URL]);
  sh("solana", ["program", "deploy", NEW_SO, "--program-id", KEYPAIR, "--url", URL,
    "--upgrade-authority", process.env.HOME + "/.config/solana/id.json"]);

  await settled(conn);
  const newIdl = JSON.parse(readFileSync(NEW_IDL, "utf8"));
  const p = new Program(newIdl as anchor.Idl, provider) as Program<anchor.Idl>;

  // The whole point: before migrating, the account is unreadable and every
  // instruction that touches it fails.
  let unreadable = false;
  try { await (p.account as any).position.fetch(position); } catch { unreadable = true; }
  check("the old account is unreadable by the new program", unreadable,
    "which is why migrate_position exists");

  console.log("\nmigrating");
  await p.methods.migratePosition()
    .accounts({ payer: payer.publicKey, market, owner: user.publicKey, position,
      systemProgram: SystemProgram.programId })
    .rpc();

  const after = await conn.getAccountInfo(position);
  check("the account is now the new length", after !== null && after.data.length === 90,
    `${after?.data.length} bytes`);
  const pos: any = await (p.account as any).position.fetch(position);
  check("the stake landed on the right leg", pos.amountYes.toNumber() === 2 * LAMPORTS_PER_SOL,
    `${pos.amountYes.toNumber()} yes / ${pos.amountNo.toNumber()} no`);
  check("the owner survived", pos.owner.toBase58() === user.publicKey.toBase58());

  await failsTwice(p, payer, market, user, position);

  console.log("\nand the money still comes out");
  await p.methods.resolveMarket(0).accounts({ authority: payer.publicKey, market }).rpc();
  const balBefore = await conn.getBalance(user.publicKey);
  await p.methods.claimWinnings()
    .accounts({ owner: user.publicKey, market, vault, position })
    .signers([user]).rpc();
  const balAfter = await conn.getBalance(user.publicKey);
  check("the migrated position claims its full one-sided pool", balAfter - balBefore > 2 * LAMPORTS_PER_SOL,
    `${((balAfter - balBefore) / LAMPORTS_PER_SOL).toFixed(4)} SOL back, fee waived on a one-sided pool`);

  console.log(failed === 0 ? "\nthe migration holds.\n" : `\n${failed} FAILED\n`);
  process.exit(failed === 0 ? 0 : 1);
}

/** A program deployed in the current slot is not callable until the next one,
 *  and the runtime says "Program is not deployed" rather than anything about
 *  timing. Wait for slots to pass rather than for a sleep to be long enough. */
async function settled(conn: Connection) {
  const at = await conn.getSlot("confirmed");
  while ((await conn.getSlot("confirmed")) <= at + 2) await new Promise((r) => setTimeout(r, 400));
}

async function failsTwice(p: any, payer: Keypair, market: PublicKey, user: Keypair, position: PublicKey) {
  let refused = false;
  try {
    await p.methods.migratePosition()
      .accounts({ payer: payer.publicKey, market, owner: user.publicKey, position,
        systemProgram: SystemProgram.programId }).rpc();
  } catch (e: any) {
    refused = JSON.stringify(e?.error ?? e?.message ?? e).includes("NotOldPosition");
  }
  check("running it twice is refused", refused, "it can only ever convert the old length");
}

main().catch((e) => { console.error("\nFAILED: " + e.message + "\n"); process.exit(1); });
