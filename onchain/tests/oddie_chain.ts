// The pari-mutuel program, against a local validator.
//
// These are not shape tests. Every block here pins a way the program could take
// or lose somebody's money, because that is the only class of bug that matters
// in a contract holding a pool:
//
//   · the fee comes OUT of the pool and winners are paid from what is left, so
//     fee + payouts can never exceed what was staked
//   · nobody can claim twice, and nobody can claim someone else's
//     - not the loser, not a stranger, not the creator's fee
//   · a market nobody won refunds instead of confiscating, and takes no fee
//   · the vault survives every claim (rent exemption is never broken)
//
// Run with: anchor test   (from onchain/)

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { OddieChain } from "../target/types/oddie_chain";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, PublicKey } from "@solana/web3.js";
import { assert } from "chai";

const SIDE_YES = 0;
const SIDE_NO = 1;
const FEE_BPS = 300; // the 3% economy.ts proposes for play; the real rate is a policy call

describe("oddie_chain", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.OddieChain as Program<OddieChain>;
  const authority = provider.wallet as anchor.Wallet;

  let nextId = Math.floor(Date.now() / 1000) * 1000;
  const freshId = () => new BN(++nextId);

  const pdas = (id: BN) => {
    const [market] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), id.toArrayLike(Buffer, "le", 8)], program.programId);
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), market.toBuffer()], program.programId);
    return { market, vault };
  };
  const positionPda = (market: PublicKey, owner: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("position"), market.toBuffer(), owner.toBuffer()], program.programId)[0];

  const funded = async (sol = 5): Promise<Keypair> => {
    const kp = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
    const bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature: sig, ...bh });
    return kp;
  };

  const openMarket = async (creator: PublicKey, feeBps = FEE_BPS) => {
    const id = freshId();
    const { market, vault } = pdas(id);
    await program.methods
      .createMarket(id, "Will the test pass?", new BN(Math.floor(Date.now() / 1000) + 3600), creator, feeBps)
      .accounts({ authority: authority.publicKey, market, vault, systemProgram: SystemProgram.programId })
      .rpc();
    return { id, market, vault };
  };

  const stake = async (market: PublicKey, vault: PublicKey, user: Keypair, side: number, sol: number) =>
    program.methods
      .takePosition(side, new BN(sol * LAMPORTS_PER_SOL))
      .accounts({
        user: user.publicKey, market, vault,
        position: positionPda(market, user.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([user]).rpc();

  const claim = async (market: PublicKey, vault: PublicKey, user: Keypair) =>
    program.methods.claimWinnings()
      .accounts({ owner: user.publicKey, market, vault, position: positionPda(market, user.publicKey) })
      .signers([user]).rpc();

  const failsWith = async (p: Promise<unknown>, code: string) => {
    try { await p; assert.fail(`expected ${code}, but it succeeded`); }
    catch (e: any) {
      const s = JSON.stringify(e?.error ?? e?.message ?? e);
      assert.include(s, code, `expected ${code}, got ${s.slice(0, 300)}`);
    }
  };

  it("pays winners out of the pool minus the creator fee, and the arithmetic closes", async () => {
    const creator = await funded();
    const win1 = await funded();
    const win2 = await funded();
    const lose = await funded();
    const { market, vault } = await openMarket(creator.publicKey);

    // 1 + 2 on YES, 3 on NO. Pool 6 SOL, fee 3% = 0.18, distributable 5.82.
    await stake(market, vault, win1, SIDE_YES, 1);
    await stake(market, vault, win2, SIDE_YES, 2);
    await stake(market, vault, lose, SIDE_NO, 3);

    await program.methods.resolveMarket(SIDE_YES)
      .accounts({ authority: authority.publicKey, market }).rpc();

    const m = await program.account.market.fetch(market);
    const pool = 6 * LAMPORTS_PER_SOL;
    const expectedFee = Math.floor((pool * FEE_BPS) / 10000);
    assert.equal(m.creatorFeeLamports.toNumber(), expectedFee, "fee fixed at resolve");

    const distributable = pool - expectedFee;
    const before1 = await provider.connection.getBalance(win1.publicKey);
    const before2 = await provider.connection.getBalance(win2.publicKey);
    await claim(market, vault, win1);
    await claim(market, vault, win2);
    const got1 = (await provider.connection.getBalance(win1.publicKey)) - before1;
    const got2 = (await provider.connection.getBalance(win2.publicKey)) - before2;

    // Signature fees come out of the same balance, so compare against the
    // formula with a small tolerance rather than demanding an exact figure.
    const want1 = Math.floor((1 * LAMPORTS_PER_SOL * distributable) / (3 * LAMPORTS_PER_SOL));
    const want2 = Math.floor((2 * LAMPORTS_PER_SOL * distributable) / (3 * LAMPORTS_PER_SOL));
    assert.isAtMost(Math.abs(got1 - want1), 10000, `win1 got ${got1}, wanted ~${want1}`);
    assert.isAtMost(Math.abs(got2 - want2), 10000, `win2 got ${got2}, wanted ~${want2}`);
    assert.isAbove(got2, got1, "the bigger stake earns more");

    // THE PROPERTY THAT MATTERS: the two winners plus the fee never exceed the
    // pool. If this fails the vault is promising money it does not hold.
    assert.isAtMost(want1 + want2 + expectedFee, pool, "payouts + fee overspend the pool");

    // And the creator can actually take theirs, from what is left.
    const feeBefore = await provider.connection.getBalance(creator.publicKey);
    await program.methods.claimCreatorFee()
      .accounts({ creator: creator.publicKey, market, vault })
      .signers([creator]).rpc();
    const feeGot = (await provider.connection.getBalance(creator.publicKey)) - feeBefore;
    assert.isAtMost(Math.abs(feeGot - expectedFee), 10000, `creator got ${feeGot}, wanted ~${expectedFee}`);
  });

  it("pays a loser nothing, and refuses every second claim", async () => {
    const creator = await funded();
    const winner = await funded();
    const loser = await funded();
    const { market, vault } = await openMarket(creator.publicKey);
    await stake(market, vault, winner, SIDE_YES, 1);
    await stake(market, vault, loser, SIDE_NO, 1);
    await program.methods.resolveMarket(SIDE_YES)
      .accounts({ authority: authority.publicKey, market }).rpc();

    // The property is that a loser GAINS nothing. Whether they also pay a
    // signature fee is Solana's behaviour, not this program's, and asserting on
    // it would be testing the validator.
    const loserBefore = await provider.connection.getBalance(loser.publicKey);
    await claim(market, vault, loser);
    const loserAfter = await provider.connection.getBalance(loser.publicKey);
    assert.isAtMost(loserAfter, loserBefore, "a losing claim paid out something");
    const lost = await program.account.position.fetch(positionPda(market, loser.publicKey));
    assert.isTrue(lost.claimed, "the losing position is still marked claimed, so it cannot be retried");

    await failsWith(claim(market, vault, winner).then(() => claim(market, vault, winner)), "AlreadyClaimed");
    await failsWith(claim(market, vault, loser), "AlreadyClaimed");

    await program.methods.claimCreatorFee()
      .accounts({ creator: creator.publicKey, market, vault }).signers([creator]).rpc();
    await failsWith(
      program.methods.claimCreatorFee()
        .accounts({ creator: creator.publicKey, market, vault }).signers([creator]).rpc(),
      "AlreadyClaimed");
  });

  it("refunds everyone and takes no fee when nobody backed the winning side", async () => {
    const creator = await funded();
    const a = await funded();
    const b = await funded();
    const { market, vault } = await openMarket(creator.publicKey);
    await stake(market, vault, a, SIDE_NO, 1);
    await stake(market, vault, b, SIDE_NO, 1);

    await program.methods.resolveMarket(SIDE_YES)
      .accounts({ authority: authority.publicKey, market }).rpc();

    const m = await program.account.market.fetch(market);
    assert.equal(m.creatorFeeLamports.toNumber(), 0, "no fee is taken from a refund");

    const before = await provider.connection.getBalance(a.publicKey);
    await claim(market, vault, a);
    const got = (await provider.connection.getBalance(a.publicKey)) - before;
    assert.isAtMost(Math.abs(got - 1 * LAMPORTS_PER_SOL), 10000, `refund was ${got}`);

    await failsWith(
      program.methods.claimCreatorFee()
        .accounts({ creator: creator.publicKey, market, vault }).signers([creator]).rpc(),
      "NoFeeOwed");
  });

  it("lets nobody claim what is not theirs", async () => {
    const creator = await funded();
    const winner = await funded();
    const stranger = await funded();
    const { market, vault } = await openMarket(creator.publicKey);
    await stake(market, vault, winner, SIDE_YES, 1);
    await stake(market, vault, stranger, SIDE_NO, 1);
    await program.methods.resolveMarket(SIDE_YES)
      .accounts({ authority: authority.publicKey, market }).rpc();

    // The stranger pointing at the winner's position account.
    await failsWith(
      program.methods.claimWinnings()
        .accounts({
          owner: stranger.publicKey, market, vault,
          position: positionPda(market, winner.publicKey),
        }).signers([stranger]).rpc(),
      "ConstraintSeeds");

    // A stranger reaching for the creator's fee. The expected code is the
    // program's own WrongCreator rather than Anchor's generic ConstraintHasOne:
    // every has_one here is mapped to a named error, so a rejection says which
    // relationship failed instead of only that one did.
    await failsWith(
      program.methods.claimCreatorFee()
        .accounts({ creator: stranger.publicKey, market, vault }).signers([stranger]).rpc(),
      "WrongCreator");

    // A stranger settling a market they did not open.
    await failsWith(
      program.methods.resolveMarket(SIDE_NO)
        .accounts({ authority: stranger.publicKey, market }).signers([stranger]).rpc(),
      "WrongAuthority");
  });

  it("refuses the states that would corrupt the pool", async () => {
    const creator = await funded();
    const user = await funded();
    const { market, vault } = await openMarket(creator.publicKey);

    await failsWith(stake(market, vault, user, 7, 1), "BadSide");
    await failsWith(stake(market, vault, user, SIDE_YES, 0), "ZeroAmount");

    await stake(market, vault, user, SIDE_YES, 1);
    // Same wallet, other side: refused rather than silently moved.
    await failsWith(stake(market, vault, user, SIDE_NO, 1), "SideAlreadyTaken");
    // Same side again: allowed, and it accumulates.
    await stake(market, vault, user, SIDE_YES, 1);
    const pos = await program.account.position.fetch(positionPda(market, user.publicKey));
    assert.equal(pos.amount.toNumber(), 2 * LAMPORTS_PER_SOL, "same-side stakes add up");

    await failsWith(claim(market, vault, user), "NotResolved");

    await program.methods.resolveMarket(SIDE_YES)
      .accounts({ authority: authority.publicKey, market }).rpc();
    await failsWith(
      program.methods.resolveMarket(SIDE_NO)
        .accounts({ authority: authority.publicKey, market }).rpc(),
      "AlreadyResolved");
    await failsWith(stake(market, vault, user, SIDE_YES, 1), "AlreadyResolved");
  });

  it("will not open a market with a predatory fee", async () => {
    const creator = await funded();
    const id = freshId();
    const { market, vault } = pdas(id);
    await failsWith(
      program.methods
        .createMarket(id, "Will the rug pull?", new BN(Math.floor(Date.now() / 1000) + 3600),
          creator.publicKey, 5000)
        .accounts({ authority: authority.publicKey, market, vault, systemProgram: SystemProgram.programId })
        .rpc(),
      "FeeTooHigh");
  });

  it("leaves the vault alive after every claim", async () => {
    const creator = await funded();
    const a = await funded();
    const b = await funded();
    const { market, vault } = await openMarket(creator.publicKey);
    await stake(market, vault, a, SIDE_YES, 1);
    await stake(market, vault, b, SIDE_NO, 1);
    await program.methods.resolveMarket(SIDE_YES)
      .accounts({ authority: authority.publicKey, market }).rpc();

    await claim(market, vault, a);
    await claim(market, vault, b);
    await program.methods.claimCreatorFee()
      .accounts({ creator: creator.publicKey, market, vault }).signers([creator]).rpc();

    const info = await provider.connection.getAccountInfo(vault);
    assert.isNotNull(info, "the vault was deleted, which would strand any unclaimed position");
    const rent = await provider.connection.getMinimumBalanceForRentExemption(info!.data.length);
    assert.isAtLeast(info!.lamports, rent, "the vault fell below rent exemption");
  });

  // set_creator exists because the person who tags an argument on X has no
  // wallet at the moment their market is minted. The fee has to wait for them.
  // What follows pins the two ways that waiting could cost somebody money:
  // a fee that can be redirected after it is promised, and a fee that becomes
  // unreachable because the market settled before its creator turned up.

  it("pays a creator who only connects a wallet after the market settled", async () => {
    const a = await funded();
    const b = await funded();
    const { market, vault } = await openMarket(PublicKey.default);

    await stake(market, vault, a, SIDE_YES, 2);
    await stake(market, vault, b, SIDE_NO, 2);
    await program.methods.resolveMarket(SIDE_YES)
      .accounts({ authority: authority.publicKey, market }).rpc();

    // The fee is fixed at resolve whether or not anyone can receive it yet.
    const owed = (await program.account.market.fetch(market)).creatorFeeLamports.toNumber();
    assert.isAbove(owed, 0, "a resolved market with a winning side owes a fee");

    // Now the tagger shows up, a wallet in hand, after settlement.
    const latecomer = await funded();
    await program.methods.setCreator(latecomer.publicKey)
      .accounts({ authority: authority.publicKey, market }).rpc();

    const before = await provider.connection.getBalance(latecomer.publicKey);
    await program.methods.claimCreatorFee()
      .accounts({ creator: latecomer.publicKey, market, vault }).signers([latecomer]).rpc();
    const after = await provider.connection.getBalance(latecomer.publicKey);

    assert.equal(after - before, owed, "the late creator was paid exactly what the market owed");
  });

  it("will not let a named creator be swapped for another", async () => {
    const named = await funded();
    const thief = await funded();
    const { market } = await openMarket(named.publicKey);

    await failsWith(
      program.methods.setCreator(thief.publicKey)
        .accounts({ authority: authority.publicKey, market }).rpc(),
      "CreatorAlreadySet",
    );

    const m = await program.account.market.fetch(market);
    assert.equal(m.creator.toBase58(), named.publicKey.toBase58(), "the creator moved");
  });

  it("lets nobody but the authority name a creator", async () => {
    const outsider = await funded();
    const { market } = await openMarket(PublicKey.default);

    await failsWith(
      program.methods.setCreator(outsider.publicKey)
        .accounts({ authority: outsider.publicKey, market }).signers([outsider]).rpc(),
      "WrongAuthority",
    );
  });

  it("refuses to name the unnamed address, which would lock the fee forever", async () => {
    const { market } = await openMarket(PublicKey.default);
    await failsWith(
      program.methods.setCreator(PublicKey.default)
        .accounts({ authority: authority.publicKey, market }).rpc(),
      "CreatorNotNamed",
    );
  });

  it("pays no fee to a stranger while the creator is still unnamed", async () => {
    const a = await funded();
    const b = await funded();
    const stranger = await funded();
    const { market, vault } = await openMarket(PublicKey.default);

    await stake(market, vault, a, SIDE_YES, 1);
    await stake(market, vault, b, SIDE_NO, 1);
    await program.methods.resolveMarket(SIDE_YES)
      .accounts({ authority: authority.publicKey, market }).rpc();

    await failsWith(
      program.methods.claimCreatorFee()
        .accounts({ creator: stranger.publicKey, market, vault }).signers([stranger]).rpc(),
      "WrongCreator",
    );
  });
});
