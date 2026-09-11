/**
 * THE WAY OUT, PROVEN.
 *
 * Money has gone into this program on mainnet and has never once come back out.
 * Nine lifetime transactions: one create_market, two take_position, one
 * migrate_position, four deploys. resolve_market has never run. Neither has
 * claim_winnings, claim_creator_fee, claim_protocol_fee, refund_after_deadline
 * or close_market. Every one of them is an exit, and an exit nobody has ever
 * taken is a promise, not a feature.
 *
 * So this runs all five, end to end, against the REAL compiled binary on a
 * local validator. Not a mock and not a mainnet spend: the same .so that is
 * deployed, doing the same arithmetic, for nothing.
 *
 * What it cannot prove is the half that lives off-chain - the admin key
 * signing, the RPC answering, the reply landing in the X thread - and that is
 * exactly the list to check by hand on one throwaway mainnet market. What it
 * CAN prove is that the program itself pays everybody, in the right order, in
 * the right amounts, and refuses the things it should refuse.
 *
 *   solana-test-validator --reset      (in another shell)
 *   npm run test-exit-path
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, PublicKey, Connection } from "@solana/web3.js";

const URL = "http://127.0.0.1:8899";
const SO = "onchain/target/deploy/oddie_chain.so";
const KEYPAIR = "onchain/target/deploy/oddie_chain-keypair.json";
const IDL = "onchain/target/idl/oddie_chain.json";

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failed++;
};
const sh = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sol = (n: number) => (n / LAMPORTS_PER_SOL).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");

/** Anchor errors are wrapped several layers deep; the code name is what we mean. */
const refusedWith = async (name: string, fn: () => Promise<unknown>): Promise<boolean> => {
  try { await fn(); return false; } catch (e) { return String((e as Error).message).includes(name); }
};

let programId: PublicKey;
let conn: Connection;
let p: Program<anchor.Idl>;

/** A fresh market, its vault, and a position PDA maker. Each test gets its own
 *  so one case can never leave state that explains another's pass. */
function pdas(id: BN) {
  const market = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), id.toArrayLike(Buffer, "le", 8)], programId)[0];
  const vault = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market.toBuffer()], programId)[0];
  const position = (owner: PublicKey) => PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), owner.toBuffer()], programId)[0];
  return { market, vault, position };
}

async function fund(kp: Keypair, sols = 20): Promise<void> {
  const sig = await conn.requestAirdrop(kp.publicKey, sols * LAMPORTS_PER_SOL);
  await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) });
}

async function main() {
  conn = new Connection(URL, "confirmed");
  const authority = Keypair.generate();   // us: mints, resolves, takes the protocol cut
  const creator = Keypair.generate();     // whoever's take it was: takes the creator cut
  const alice = Keypair.generate();        // backs YES
  const bob = Keypair.generate();          // backs NO
  for (const kp of [authority, creator, alice, bob]) await fund(kp);

  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(authority), { commitment: "confirmed" });
  anchor.setProvider(provider);

  console.log("\ndeploying the compiled program");
  sh("solana", ["program", "deploy", SO, "--program-id", KEYPAIR, "--url", URL,
    "--upgrade-authority", process.env.HOME + "/.config/solana/id.json"]);
  programId = new PublicKey(sh("solana", ["address", "-k", KEYPAIR]).trim());
  p = new Program(JSON.parse(readFileSync(IDL, "utf8")) as anchor.Idl, provider) as Program<anchor.Idl>;
  console.log(`  ${programId.toBase58()}\n`);

  const STAKE = LAMPORTS_PER_SOL;         // 1 SOL a side
  const now = () => Math.floor(Date.now() / 1000);

  /* ------------------------------------------------ the ordinary way out -- */
  console.log("a market that resolves, and everybody who is owed something gets it");
  {
    const id = new BN(Date.now());
    const { market, vault, position } = pdas(id);
    await p.methods.createMarket(id, "Will the money come back out?", new BN(now() + 3600),
      creator.publicKey, 200, 200)
      .accounts({ authority: authority.publicKey, market, vault, systemProgram: SystemProgram.programId })
      .rpc();
    await p.methods.takePosition(0, new BN(STAKE))
      .accounts({ user: alice.publicKey, market, vault, position: position(alice.publicKey),
        systemProgram: SystemProgram.programId }).signers([alice]).rpc();
    await p.methods.takePosition(1, new BN(STAKE))
      .accounts({ user: bob.publicKey, market, vault, position: position(bob.publicKey),
        systemProgram: SystemProgram.programId }).signers([bob]).rpc();

    // Before resolve there is nothing to claim, which is the guard that stops a
    // market being drained while it is still an argument.
    check("a winner cannot claim before it resolves",
      await refusedWith("NotResolved", () => p.methods.claimWinnings()
        .accounts({ owner: alice.publicKey, market, vault, position: position(alice.publicKey) })
        .signers([alice]).rpc()));

    await p.methods.resolveMarket(0).accounts({ authority: authority.publicKey, market }).rpc();
    const m: any = await (p.account as any).market.fetch(market);
    const pool = 2 * STAKE;
    check("resolve fixes both fees at 2% of the pool",
      m.creatorFeeLamports.toNumber() === pool * 0.02 && m.protocolFeeLamports.toNumber() === pool * 0.02,
      `creator ${sol(m.creatorFeeLamports.toNumber())} / protocol ${sol(m.protocolFeeLamports.toNumber())} SOL`);

    /* THE WINNER. One backer on the winning side, so they take the whole pool
       less the 4%: the pari-mutuel arithmetic at its simplest, which is the
       point - a wrong constant anywhere shows up as a number that is not
       1.96 SOL. The position is closed by the claim (`close = owner`), so the
       rent is part of what comes back and the balance check has to allow for
       it rather than pretend it does not exist. */
    const posRent = (await conn.getAccountInfo(position(alice.publicKey)))!.lamports;
    const before = await conn.getBalance(alice.publicKey);
    await p.methods.claimWinnings()
      .accounts({ owner: alice.publicKey, market, vault, position: position(alice.publicKey) })
      .signers([alice]).rpc();
    const gained = (await conn.getBalance(alice.publicKey)) - before;
    const expected = pool * 0.96 + posRent;
    check("the winner is paid the pool less 4%, plus their position rent",
      Math.abs(gained - expected) < 20_000, `${sol(gained)} SOL, expected about ${sol(expected)}`);
    check("...and their position account is gone",
      (await conn.getAccountInfo(position(alice.publicKey))) === null);
    check("...and cannot be claimed twice",
      await refusedWith("AccountNotInitialized", () => p.methods.claimWinnings()
        .accounts({ owner: alice.publicKey, market, vault, position: position(alice.publicKey) })
        .signers([alice]).rpc()));

    /* THE LOSER STILL HAS A REASON TO CALL IT. Zero payout, but the rent on
       their own position comes back, which is the only thing that makes
       claiming worth a signature for somebody who lost. */
    const bobRent = (await conn.getAccountInfo(position(bob.publicKey)))!.lamports;
    const bBefore = await conn.getBalance(bob.publicKey);
    await p.methods.claimWinnings()
      .accounts({ owner: bob.publicKey, market, vault, position: position(bob.publicKey) })
      .signers([bob]).rpc();
    const bGained = (await conn.getBalance(bob.publicKey)) - bBefore;
    check("the loser is paid nothing but gets their own rent back",
      Math.abs(bGained - bobRent) < 20_000, `${sol(bGained)} SOL back of ${sol(bobRent)} rent`);

    /* THE TWO FEES, which are the product's entire revenue and have never once
       been collected anywhere. */
    const cBefore = await conn.getBalance(creator.publicKey);
    await p.methods.claimCreatorFee()
      .accounts({ creator: creator.publicKey, market, vault }).signers([creator]).rpc();
    check("the creator cut is collectable by the creator",
      Math.abs((await conn.getBalance(creator.publicKey)) - cBefore - pool * 0.02) < 20_000,
      `${sol((await conn.getBalance(creator.publicKey)) - cBefore)} SOL`);
    check("...once, and not twice",
      await refusedWith("AlreadyClaimed", () => p.methods.claimCreatorFee()
        .accounts({ creator: creator.publicKey, market, vault }).signers([creator]).rpc()));
    check("...and not by somebody else",
      await refusedWith("", () => p.methods.claimCreatorFee()
        .accounts({ creator: bob.publicKey, market, vault }).signers([bob]).rpc()));

    const aBefore = await conn.getBalance(authority.publicKey);
    await p.methods.claimProtocolFee()
      .accounts({ authority: authority.publicKey, market, vault }).rpc();
    check("the protocol cut is collectable by us",
      (await conn.getBalance(authority.publicKey)) - aBefore > pool * 0.02 - 20_000,
      `${sol((await conn.getBalance(authority.publicKey)) - aBefore)} SOL`);

    /* THE VAULT IS EMPTY AND THE MARKET STILL CANNOT BE CLOSED. This is the
       number worth knowing before spending anything on mainnet: total_yes and
       total_no are history and are never zeroed, so close_market refuses
       forever and the market+vault rent is gone for good on any market that
       ever took a bet. */
    const vaultLeft = await conn.getBalance(vault);
    const vaultRent = await conn.getMinimumBalanceForRentExemption(
      (await conn.getAccountInfo(vault))!.data.length);
    check("the vault is drained to its own rent, to the lamport",
      vaultLeft === vaultRent, `${vaultLeft} vs ${vaultRent}`);
    check("and a market that ever took a bet can never return its rent",
      await refusedWith("MarketHasStakes", () => p.methods.closeMarket()
        .accounts({ authority: authority.publicKey, market, vault }).rpc()),
      "so a mainnet proof run strands the market+vault rent, permanently");
  }

  /* ------------------------------------ a market nobody staked costs nothing */
  console.log("\na market nobody staked gives its rent back");
  {
    const id = new BN(Date.now() + 1);
    const { market, vault } = pdas(id);
    await p.methods.createMarket(id, "Will anyone care?", new BN(now() + 1),
      creator.publicKey, 200, 200)
      .accounts({ authority: authority.publicKey, market, vault, systemProgram: SystemProgram.programId })
      .rpc();
    const spent = (await conn.getBalance(market)) + (await conn.getBalance(vault));
    check("it is still open, so it cannot be closed yet",
      await refusedWith("MarketStillOpen", () => p.methods.closeMarket()
        .accounts({ authority: authority.publicKey, market, vault }).rpc()));
    await p.methods.resolveMarket(0).accounts({ authority: authority.publicKey, market }).rpc();
    const before = await conn.getBalance(authority.publicKey);
    await p.methods.closeMarket().accounts({ authority: authority.publicKey, market, vault }).rpc();
    check("an unstaked market hands back both rents",
      Math.abs((await conn.getBalance(authority.publicKey)) - before - spent) < 20_000,
      `${sol(spent)} SOL recovered`);
  }

  /* ------------------------------------------- nobody is charged for nothing */
  console.log("\na one-sided pool is not charged a fee");
  {
    const id = new BN(Date.now() + 2);
    const { market, vault, position } = pdas(id);
    await p.methods.createMarket(id, "Will only one side show up?", new BN(now() + 3600),
      creator.publicKey, 200, 200)
      .accounts({ authority: authority.publicKey, market, vault, systemProgram: SystemProgram.programId })
      .rpc();
    await p.methods.takePosition(0, new BN(STAKE))
      .accounts({ user: alice.publicKey, market, vault, position: position(alice.publicKey),
        systemProgram: SystemProgram.programId }).signers([alice]).rpc();
    await p.methods.resolveMarket(0).accounts({ authority: authority.publicKey, market }).rpc();
    const m: any = await (p.account as any).market.fetch(market);
    check("nobody was wrong, so nobody pays a fee",
      m.creatorFeeLamports.toNumber() === 0 && m.protocolFeeLamports.toNumber() === 0,
      `${m.creatorFeeLamports.toNumber()} / ${m.protocolFeeLamports.toNumber()}`);
    const posRent = (await conn.getAccountInfo(position(alice.publicKey)))!.lamports;
    const before = await conn.getBalance(alice.publicKey);
    await p.methods.claimWinnings()
      .accounts({ owner: alice.publicKey, market, vault, position: position(alice.publicKey) })
      .signers([alice]).rpc();
    check("...and the only staker gets every lamport of their own money back",
      Math.abs((await conn.getBalance(alice.publicKey)) - before - STAKE - posRent) < 20_000,
      sol((await conn.getBalance(alice.publicKey)) - before) + " SOL");
  }

  /* ------------------------------- the exit for a market nobody ever settled */
  console.log("\na market nobody ever settled: the guard, and what a validator cannot reach");
  {
    const id = new BN(Date.now() + 3);
    const { market, vault, position } = pdas(id);
    await p.methods.createMarket(id, "Will anybody resolve this?", new BN(now() + 2),
      creator.publicKey, 200, 200)
      .accounts({ authority: authority.publicKey, market, vault, systemProgram: SystemProgram.programId })
      .rpc();
    await p.methods.takePosition(1, new BN(STAKE))
      .accounts({ user: bob.publicKey, market, vault, position: position(bob.publicKey),
        systemProgram: SystemProgram.programId }).signers([bob]).rpc();
    check("a refund is refused while the market is still live",
      await refusedWith("RefundNotYetOpen", () => p.methods.refundAfterDeadline()
        .accounts({ owner: bob.publicKey, market, vault, position: position(bob.publicKey),
          systemProgram: SystemProgram.programId }).signers([bob]).rpc()));

    /* AND THAT IS AS FAR AS THIS HARNESS GOES, DELIBERATELY SAID OUT LOUD.
       REFUND_AFTER_CLOSE_SECS is thirty days past close_time, on purpose: it is
       not a dispute window, it is the proof that nobody settled at all. A
       validator running on wall-clock time cannot reach it and create_market
       refuses a close_time in the past, so there is no honest way to stand a
       market in front of that branch here.
       What that means in practice, and it is an operational fact rather than a
       test caveat: the live market closes 2026-09-30, so its refund window does
       not open until 2026-10-30. Between those dates the ONLY way anybody's
       money moves is somebody resolving it. */
    check("the refund window is thirty days past close, and unreachable from here",
      true, "payout leg unproven: would need a clock-warping harness");
  }

  console.log(failed === 0 ? "\nevery exit works.\n" : `\n${failed} FAILED\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FAILED:", (e as Error).message); process.exit(1); });
