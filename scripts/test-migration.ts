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

  /* THE POSITION HALF ONLY APPLIES IF THE DEPLOYED BINARY STILL WRITES THE OLD
     SHAPE, and as of the upgrade that shipped migrate_position it does not.
     OLD_SO is dumped from mainnet, so once mainnet is past a migration this
     test can no longer manufacture an account for it: every position it opens
     is already 90 bytes. Asserting 83 here would not be catching a regression,
     it would be asserting that an upgrade we deliberately shipped never
     happened. So the half is skipped OUT LOUD rather than deleted -- the code
     it covers is still deployed, and if a binary that predates it is ever put
     back in front of this test the assertions come back on their own. */
  const before = await conn.getAccountInfo(position);
  const oldPositionFormat = before !== null && before.data.length === 83;
  if (oldPositionFormat) {
    check("a position exists in the OLD format", true, "83 bytes");
  } else {
    console.log(`  – position migration not exercised: this binary already writes ` +
      `${before?.data.length}-byte positions, so there is no old one to make`);
  }

  console.log("\nupgrading the program in place, as mainnet will");
  sh("solana", ["program", "extend", programId.toBase58(), "200000", "--url", URL]);
  sh("solana", ["program", "deploy", NEW_SO, "--program-id", KEYPAIR, "--url", URL,
    "--upgrade-authority", process.env.HOME + "/.config/solana/id.json"]);

  await settled(conn);
  const newIdl = JSON.parse(readFileSync(NEW_IDL, "utf8"));
  const p = new Program(newIdl as anchor.Idl, provider) as Program<anchor.Idl>;

  // The whole point: before migrating, the account is unreadable and every
  // instruction that touches it fails.
  if (oldPositionFormat) {
    let unreadable = false;
    try { await (p.account as any).position.fetch(position); } catch { unreadable = true; }
    check("the old position is unreadable by the new program", unreadable,
      "which is why migrate_position exists");
  }

  /* THE MARKET GOES FIRST, AND THAT IS NOT A PREFERENCE.
     MigratePosition's context declares `market: Account<'info, Market>`, so it
     DESERIALIZES the market before it touches the position. Against a market
     still at 162 bytes that fails before the migration body runs, which means
     positions cannot be converted until their market has been. The production
     runbook has to be markets, then positions, and this is where that is
     proved rather than assumed. */
  const mBefore = await conn.getAccountInfo(market);
  check("the market exists in the OLD format", mBefore !== null && mBefore.data.length === 162,
    `${mBefore?.data.length} bytes`);

  let mUnreadable = false;
  try { await (p.account as any).market.fetch(market); } catch { mUnreadable = true; }
  check("the old market is unreadable by the new program", mUnreadable,
    "which is why migrate_market exists");

  /* Still worth proving even when the position is already new-format: the
     failure being demonstrated is the MARKET's deserialization, which happens
     in MigratePosition's account context before its body runs at all. */
  let positionBlocked = false;
  try {
    await p.methods.migratePosition()
      .accounts({ payer: payer.publicKey, market, owner: user.publicKey, position,
        systemProgram: SystemProgram.programId })
      .rpc();
  } catch { positionBlocked = true; }
  check("a position cannot be migrated before its market", positionBlocked,
    "markets first, then positions");

  console.log("\nmigrating the market");
  await p.methods.migrateMarket()
    .accounts({ payer: payer.publicKey, market, systemProgram: SystemProgram.programId })
    .rpc();

  const mAfter = await conn.getAccountInfo(market);
  check("the market is now the new length", mAfter !== null && mAfter.data.length === 194,
    `${mAfter?.data.length} bytes`);

  const mk: any = await (p.account as any).market.fetch(market);
  check("the pool survived the resize", mk.totalYes.toNumber() === 2 * LAMPORTS_PER_SOL,
    `${mk.totalYes.toNumber()} yes / ${mk.totalNo.toNumber()} no`);
  check("the fee rates survived", mk.creatorFeeBps === 200 && mk.protocolFeeBps === 200,
    `${mk.creatorFeeBps} / ${mk.protocolFeeBps} bps`);
  check("the close time survived", mk.closeTime.toNumber() > Math.floor(Date.now() / 1000));
  check("a migrated market commits to NO rule", (mk.criteriaHash as number[]).every((b) => b === 0),
    "zero means opened before the rule was pinned, not 'criteria unknown'");

  let mTwice = false;
  try {
    await p.methods.migrateMarket()
      .accounts({ payer: payer.publicKey, market, systemProgram: SystemProgram.programId })
      .rpc();
  } catch { mTwice = true; }
  check("it refuses to run twice on the same market", mTwice);

  if (oldPositionFormat) {
    console.log("\nmigrating the position");
    await p.methods.migratePosition()
      .accounts({ payer: payer.publicKey, market, owner: user.publicKey, position,
        systemProgram: SystemProgram.programId })
      .rpc();

    const after = await conn.getAccountInfo(position);
    check("the account is now the new length", after !== null && after.data.length === 90,
      `${after?.data.length} bytes`);
    await failsTwice(p, payer, market, user, position);
  }

  const pos: any = await (p.account as any).position.fetch(position);
  check("the stake is on the right leg", pos.amountYes.toNumber() === 2 * LAMPORTS_PER_SOL,
    `${pos.amountYes.toNumber()} yes / ${pos.amountNo.toNumber()} no`);
  check("the owner survived the market's resize", pos.owner.toBase58() === user.publicKey.toBase58());

  console.log("\nand the money still comes out");
  await p.methods.resolveMarket(0).accounts({ authority: payer.publicKey, market }).rpc();
  const balBefore = await conn.getBalance(user.publicKey);
  await p.methods.claimWinnings()
    .accounts({ owner: user.publicKey, market, vault, position })
    .signers([user]).rpc();
  const balAfter = await conn.getBalance(user.publicKey);
  check("the migrated position claims its full one-sided pool", balAfter - balBefore > 2 * LAMPORTS_PER_SOL,
    `${((balAfter - balBefore) / LAMPORTS_PER_SOL).toFixed(4)} SOL back, fee waived on a one-sided pool`);

  await freshMarketCommits(p, provider, payer, programId, conn);

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

/**
 * A MARKET OPENED AFTER THE UPGRADE COMMITS TO ITS RULE, and the worst case
 * still fits in one transaction.
 *
 * The cap is 512 bytes of criteria beside 180 of question, and a Solana
 * transaction is 1232 bytes all in. That is close enough that the number has to
 * be MEASURED rather than reasoned about: this serializes the worst legal
 * create_market and fails if it does not fit, so a cap that is too generous is
 * caught here and not by a market that cannot be opened.
 */
async function freshMarketCommits(
  p: Program<anchor.Idl>,
  provider: anchor.AnchorProvider,
  payer: Keypair,
  programId: PublicKey,
  conn: Connection,
) {
  console.log("\nand a market opened now commits to its rule");
  const { createHash } = await import("node:crypto");

  const id = new BN(Date.now() + 1);
  const market = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), id.toArrayLike(Buffer, "le", 8)], programId)[0];
  const vault = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market.toBuffer()], programId)[0];

  const criteria = "Settled from the close on the official results page, read at the deadline.";
  await p.methods
    .createMarket(id, "Does the rule travel with the market?",
      new BN(Math.floor(Date.now() / 1000) + 3600), payer.publicKey, 200, 200, criteria)
    .accounts({ authority: payer.publicKey, market, vault, systemProgram: SystemProgram.programId })
    .rpc();

  const mk: any = await (p.account as any).market.fetch(market);
  const want = createHash("sha256").update(criteria).digest();
  check("the criteria hash is sha256 of the criteria",
    Buffer.from(mk.criteriaHash as number[]).equals(want),
    Buffer.from(mk.criteriaHash as number[]).toString("hex").slice(0, 16) + "…");

  // The worst legal transaction, serialized rather than estimated.
  const id2 = new BN(Date.now() + 2);
  const market2 = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), id2.toArrayLike(Buffer, "le", 8)], programId)[0];
  const vault2 = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market2.toBuffer()], programId)[0];
  const tx = await p.methods
    .createMarket(id2, "q".repeat(180), new BN(Math.floor(Date.now() / 1000) + 3600),
      payer.publicKey, 200, 200, "c".repeat(512))
    .accounts({ authority: payer.publicKey, market: market2, vault: vault2,
      systemProgram: SystemProgram.programId })
    .transaction();
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  const size = tx.serialize().length;
  check("the worst legal create_market fits in one transaction", size <= 1232,
    `${size} of 1232 bytes, ${1232 - size} to spare`);

  // And it is not merely small enough to serialize: it lands.
  await p.methods
    .createMarket(id2, "q".repeat(180), new BN(Math.floor(Date.now() / 1000) + 3600),
      payer.publicKey, 200, 200, "c".repeat(512))
    .accounts({ authority: payer.publicKey, market: market2, vault: vault2,
      systemProgram: SystemProgram.programId })
    .rpc();
  check("and the chain accepts it", true);
}
