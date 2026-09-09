/**
 * Convert every Position still written in the pre-two-sided layout.
 *
 *   npm run migrate-positions            list what needs it
 *   npm run migrate-positions -- --apply convert them
 *
 * An old Position is 83 bytes and the current struct is 90, so Anchor cannot
 * read one and EVERY instruction that touches it fails, refund included. A
 * position left un-migrated is somebody's money behind a format change, which
 * is why migrate_position is permissionless and why this runs right after the
 * upgrade rather than whenever somebody notices.
 *
 * It finds them by scanning the program's own accounts for the Position
 * discriminator at the old length, so it needs no database and cannot miss one
 * we forgot to record. The owner is read out of the account itself.
 */
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2";
import bs58 from "bs58";

const APPLY = process.argv.includes("--apply");
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const SECRET = process.env.SOLANA_ADMIN_SECRET_KEY;
const OLD_LEN = 83;

async function main() {
  if (!SECRET) { console.error("SOLANA_ADMIN_SECRET_KEY is required (it pays the rent on the extra bytes)"); process.exit(1); }
  const idl = JSON.parse(readFileSync("src/chain/oddie_chain_idl.json", "utf8"));
  const programId = new PublicKey(process.env.ODDIE_CHAIN_PROGRAM_ID ?? idl.address);
  const conn = new Connection(RPC, "confirmed");
  const s = SECRET.trim();
  const payer = Keypair.fromSecretKey(s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: "confirmed" });
  const program = new anchor.Program(idl as anchor.Idl, provider) as anchor.Program<anchor.Idl>;

  // Anchor's account discriminator: the first 8 bytes of sha256("account:<Name>").
  const disc = Buffer.from(sha256(new TextEncoder().encode("account:Position")).slice(0, 8));
  const found = await conn.getProgramAccounts(programId, {
    filters: [{ dataSize: OLD_LEN }, { memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
  });

  console.log(`\n  ${found.length} position(s) still in the old ${OLD_LEN}-byte layout${APPLY ? ", APPLYING" : ", dry run"}.\n`);
  if (!found.length) {
    console.log("  Nothing to migrate.\n");
    return;
  }

  for (const { pubkey, account } of found) {
    const d = account.data;
    const market = new PublicKey(d.subarray(8, 40));
    const owner = new PublicKey(d.subarray(40, 72));
    const side = d[72] === 0 ? "yes" : "no";
    const amount = Number(d.readBigUInt64LE(73)) / 1e9;
    console.log(`  ${pubkey.toBase58()}`);
    console.log(`    ${amount} SOL on ${side.toUpperCase()}, owner ${owner.toBase58()}`);
    if (!APPLY) { console.log(""); continue; }

    const sig = await program.methods.migratePosition()
      .accounts({ payer: payer.publicKey, market, owner, position: pubkey,
        systemProgram: anchor.web3.SystemProgram.programId })
      .rpc();
    const after = await conn.getAccountInfo(pubkey);
    const pos: any = await (program.account as any).position.fetch(pubkey);
    console.log(`    -> ${after?.data.length} bytes, ${Number(pos.amountYes) / 1e9} yes / ${Number(pos.amountNo) / 1e9} no`);
    console.log(`    ${sig}\n`);
  }
  if (!APPLY) console.log("  Nothing was changed. Re-run with --apply.\n");
}
main().catch((e) => { console.error("\nFAILED: " + e.message + "\n"); process.exit(1); });
