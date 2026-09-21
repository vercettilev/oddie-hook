/**
 * Convert every Market still written in the 162-byte layout.
 *
 *   npm run migrate-markets            list what needs it
 *   npm run migrate-markets -- --apply convert them
 *
 * A Market grew 32 bytes when criteria_hash was added, and Anchor cannot read
 * the old length. Every instruction that touches such a market fails, so an
 * un-migrated market is a pool nobody can stake in, resolve, claim from or
 * refund out of. That is why migrate_market is permissionless and why this runs
 * IMMEDIATELY after the upgrade rather than when somebody notices.
 *
 * MARKETS BEFORE POSITIONS, ALWAYS. MigratePosition's account context declares
 * the market as an Account<Market>, so it deserializes the market before it
 * touches the position: against a 162-byte market it fails before its body
 * runs. Run this, then migrate-positions.
 *
 * It finds them by scanning the program's own accounts for the Market
 * discriminator at the old length, so it needs no database and cannot miss one
 * we forgot to record.
 */
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2";
import bs58 from "bs58";

const APPLY = process.argv.includes("--apply");
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const SECRET = process.env.SOLANA_ADMIN_SECRET_KEY;
const OLD_LEN = 162;
const NEW_LEN = 194;

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
  const disc = Buffer.from(sha256(new TextEncoder().encode("account:Market")).slice(0, 8));
  const found = await conn.getProgramAccounts(programId, {
    filters: [{ dataSize: OLD_LEN }, { memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
  });

  console.log(`\n  ${found.length} market(s) still in the old ${OLD_LEN}-byte layout${APPLY ? ", APPLYING" : ", dry run"}.\n`);
  if (!found.length) {
    console.log("  Nothing to migrate.\n");
    return;
  }

  let done = 0;
  for (const { pubkey, account } of found) {
    const d = account.data;
    // Read straight out of the bytes: Anchor cannot decode this account, which
    // is the entire reason we are here.
    const marketId = d.readBigUInt64LE(8 + 32 + 32);
    const totalYes = Number(d.readBigUInt64LE(8 + 32 + 32 + 8 + 32 + 8 + 1 + 1)) / 1e9;
    const totalNo = Number(d.readBigUInt64LE(8 + 32 + 32 + 8 + 32 + 8 + 1 + 1 + 8)) / 1e9;
    console.log(`  ${pubkey.toBase58()}`);
    console.log(`    market_id ${marketId}, pool ${totalYes} yes / ${totalNo} no`);
    if (!APPLY) { console.log(""); continue; }

    const sig = await program.methods.migrateMarket()
      .accounts({ payer: payer.publicKey, market: pubkey,
        systemProgram: anchor.web3.SystemProgram.programId })
      .rpc();

    // Read it back through Anchor, which could not read it a second ago.
    const after = await conn.getAccountInfo(pubkey);
    const mk: any = await (program.account as any).market.fetch(pubkey);
    const zero = (mk.criteriaHash as number[]).every((b) => b === 0);
    const poolHeld = Number(mk.totalYes) / 1e9 === totalYes && Number(mk.totalNo) / 1e9 === totalNo;
    console.log(`    -> ${after?.data.length} bytes, pool ${Number(mk.totalYes) / 1e9} yes / ${Number(mk.totalNo) / 1e9} no`);
    console.log(`    criteria_hash ${zero ? "zero — opened before the rule was pinned" : "SET, which it should not be"}`);
    if (after?.data.length !== NEW_LEN || !poolHeld || !zero) {
      console.error(`\n  STOPPING: ${pubkey.toBase58()} did not come back the way it went in.\n`);
      process.exit(1);
    }
    console.log(`    ${sig}\n`);
    done++;
  }
  if (APPLY) console.log(`  ${done} migrated. Now run migrate-positions.\n`);
  else console.log("  Nothing was changed. Re-run with --apply.\n");
}
main().catch((e) => { console.error("\nFAILED: " + e.message + "\n"); process.exit(1); });
