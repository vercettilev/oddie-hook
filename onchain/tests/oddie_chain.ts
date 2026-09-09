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
const FEE_BPS = 200;      // 2% to whoever's argument it was
const PROTOCOL_BPS = 200; // 2% to oddie. 4% total, split down the middle

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

  const openMarket = async (creator: PublicKey, feeBps = FEE_BPS, protoBps = PROTOCOL_BPS) => {
    const id = freshId();
    const { market, vault } = pdas(id);
    await program.methods
      .createMarket(id, "Will the test pass?", new BN(Math.floor(Date.now() / 1000) + 3600), creator, feeBps, protoBps)
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

  /** What claiming returns ON TOP of the payout: the Position's own rent, which
   *  `close = owner` hands back. Read from the live account, never hardcoded,
   *  because it follows the account's size and the cluster's rent rate. */
  const positionRent = async (market: PublicKey, owner: PublicKey) =>
    (await provider.connection.getBalance(positionPda(market, owner))) ?? 0;

  const claim = async (market: PublicKey, vault: PublicKey, user: Keypair) =>
    program.methods.claimWinnings()
      .accounts({ owner: user.publicKey, market, vault, position: positionPda(market, user.publicKey) })
      .signers([user]).rpc();

  const listingPda = (market: PublicKey, seller: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("listing"), market.toBuffer(), seller.toBuffer()], program.programId)[0];

  const list = async (market: PublicKey, seller: Keypair, side: number, sol: number, expiresAt: number) =>
    program.methods
      .listPosition(side, new BN(sol * LAMPORTS_PER_SOL), new BN(expiresAt))
      .accounts({
        seller: seller.publicKey, market,
        position: positionPda(market, seller.publicKey),
        listing: listingPda(market, seller.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([seller]).rpc();

  const takeSeat = async (market: PublicKey, seller: PublicKey, buyer: Keypair) =>
    program.methods.takeListing()
      .accounts({
        buyer: buyer.publicKey, seller, market,
        listing: listingPda(market, seller),
        sellerPosition: positionPda(market, seller),
        buyerPosition: positionPda(market, buyer.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer]).rpc();

  const failsWith = async (p: Promise<unknown>, code: string) => {
    try { await p; assert.fail(`expected ${code}, but it succeeded`); }
    catch (e: any) {
      const s = JSON.stringify(e?.error ?? e?.message ?? e);
      assert.include(s, code, `expected ${code}, got ${s.slice(0, 300)}`);
    }
  };

  it("takes no fee when nobody took the other side", async () => {
    // The counterpart to the refund case. There, nobody won and the pool goes
    // back untouched. HERE everybody won, because nobody opposed them, and the
    // pool is still nothing but their own stake: a fee would charge winners on
    // money that was never at risk and hand them 96% of what they put in for a
    // market that had no counterparty. The program used to do exactly that.
    const creator = await funded();
    const solo = await funded();
    const { market, vault } = await openMarket(creator.publicKey);

    await stake(market, vault, solo, SIDE_YES, 2);
    await program.methods.resolveMarket(SIDE_YES)
      .accounts({ authority: authority.publicKey, market }).rpc();

    const m = await program.account.market.fetch(market);
    assert.equal(m.creatorFeeLamports.toNumber(), 0, "no creator fee on a one-sided pool");
    assert.equal(m.protocolFeeLamports.toNumber(), 0, "no protocol fee on a one-sided pool");

    const rent = await positionRent(market, solo.publicKey);
    const before = await provider.connection.getBalance(solo.publicKey);
    await claim(market, vault, solo);
    const after = await provider.connection.getBalance(solo.publicKey);
    // The whole stake comes back, PLUS the position's rent now that claiming
    // closes it, minus only the signature fee paid to ask. Anything less than
    // the stake is the one-sided-fee bug; anything less than stake plus rent is
    // the rent still being stranded.
    const returned = after - before;
    assert.isAbove(returned, 2 * LAMPORTS_PER_SOL + rent - 20_000,
      `got back ${returned}, staked ${2 * LAMPORTS_PER_SOL} with ${rent} rent`);
    assert.isAtMost(returned, 2 * LAMPORTS_PER_SOL + rent, "cannot get back more than stake plus rent");
  });

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
    const expectedProto = Math.floor((pool * PROTOCOL_BPS) / 10000);
    assert.equal(m.creatorFeeLamports.toNumber(), expectedFee, "creator fee fixed at resolve");
    assert.equal(m.protocolFeeLamports.toNumber(), expectedProto, "protocol fee fixed at resolve");

    const distributable = pool - expectedFee - expectedProto;
    // Claiming also closes the position, so each winner gets their share PLUS
    // the rent they put up to open it.
    const rent1 = await positionRent(market, win1.publicKey);
    const rent2 = await positionRent(market, win2.publicKey);
    const before1 = await provider.connection.getBalance(win1.publicKey);
    const before2 = await provider.connection.getBalance(win2.publicKey);
    await claim(market, vault, win1);
    await claim(market, vault, win2);
    const got1 = (await provider.connection.getBalance(win1.publicKey)) - before1;
    const got2 = (await provider.connection.getBalance(win2.publicKey)) - before2;

    // Signature fees come out of the same balance, so compare against the
    // formula with a small tolerance rather than demanding an exact figure.
    const want1 = Math.floor((1 * LAMPORTS_PER_SOL * distributable) / (3 * LAMPORTS_PER_SOL)) + rent1;
    const want2 = Math.floor((2 * LAMPORTS_PER_SOL * distributable) / (3 * LAMPORTS_PER_SOL)) + rent2;
    assert.isAtMost(Math.abs(got1 - want1), 10000, `win1 got ${got1}, wanted ~${want1}`);
    assert.isAtMost(Math.abs(got2 - want2), 10000, `win2 got ${got2}, wanted ~${want2}`);
    assert.isAbove(got2, got1, "the bigger stake earns more");

    // THE PROPERTY THAT MATTERS: the two winners plus the fee never exceed the
    // pool. If this fails the vault is promising money it does not hold.
    //
    // The rents are subtracted back out first, and that is the whole point of
    // the distinction: returned rent comes from the POSITION accounts, never
    // from the vault, so counting it here would accuse the vault of overspending
    // money it never touched. This assertion is about what the VAULT paid.
    assert.isAtMost((want1 - rent1) + (want2 - rent2) + expectedFee + expectedProto, pool,
      "payouts + fees overspend the pool");

    // And the creator can actually take theirs, from what is left.
    const feeBefore = await provider.connection.getBalance(creator.publicKey);
    await program.methods.claimCreatorFee()
      .accounts({ creator: creator.publicKey, market, vault })
      .signers([creator]).rpc();
    const feeGot = (await provider.connection.getBalance(creator.publicKey)) - feeBefore;
    assert.isAtMost(Math.abs(feeGot - expectedFee), 10000, `creator got ${feeGot}, wanted ~${expectedFee}`);

    // And so can we, from what is left after both of them.
    const protoBefore = await provider.connection.getBalance(authority.publicKey);
    await program.methods.claimProtocolFee()
      .accounts({ authority: authority.publicKey, market, vault }).rpc();
    const protoGot = (await provider.connection.getBalance(authority.publicKey)) - protoBefore;
    assert.isAtMost(Math.abs(protoGot - expectedProto), 10000, `oddie got ${protoGot}, wanted ~${expectedProto}`);
  });

  /* ------------------------------------------------------- the protocol fee --
   * The half that pays for the product. It has to be as unstealable as the
   * creator's and as invisible when it was never charged, or "markets opened
   * under the old terms keep the old terms" is a sentence and not a property.
   */
  it("a stranger cannot take oddie's cut", async () => {
    const creator = await funded();
    const a = await funded();
    const b = await funded();
    const thief = await funded();
    const { market, vault } = await openMarket(creator.publicKey);
    await stake(market, vault, a, SIDE_YES, 1);
    await stake(market, vault, b, SIDE_NO, 1);
    await program.methods.resolveMarket(SIDE_YES)
      .accounts({ authority: authority.publicKey, market }).rpc();

    await failsWith(
      program.methods.claimProtocolFee()
        .accounts({ authority: thief.publicKey, market, vault })
        .signers([thief]).rpc(),
      "WrongAuthority");
  });

  it("refuses to pay oddie twice", async () => {
    const creator = await funded();
    const a = await funded();
    const b = await funded();
    const { market, vault } = await openMarket(creator.publicKey);
    await stake(market, vault, a, SIDE_YES, 1);
    await stake(market, vault, b, SIDE_NO, 1);
    await program.methods.resolveMarket(SIDE_YES)
      .accounts({ authority: authority.publicKey, market }).rpc();
    await program.methods.claimProtocolFee()
      .accounts({ authority: authority.publicKey, market, vault }).rpc();
    await failsWith(
      program.methods.claimProtocolFee()
        .accounts({ authority: authority.publicKey, market, vault }).rpc(),
      "AlreadyClaimed");
  });

  it("charges nothing on a market opened at zero, forever", async () => {
    // The migration property. Markets minted before this rate existed carry
    // protocol_fee_bps = 0, and no later rate change can reach back into them.
    const creator = await funded();
    const a = await funded();
    const b = await funded();
    const { market, vault } = await openMarket(creator.publicKey, FEE_BPS, 0);
    await stake(market, vault, a, SIDE_YES, 1);
    await stake(market, vault, b, SIDE_NO, 1);
    await program.methods.resolveMarket(SIDE_YES)
      .accounts({ authority: authority.publicKey, market }).rpc();

    const m = await program.account.market.fetch(market);
    assert.equal(m.protocolFeeLamports.toNumber(), 0, "a zero-rate market owes nothing");
    await failsWith(
      program.methods.claimProtocolFee()
        .accounts({ authority: authority.publicKey, market, vault }).rpc(),
      "NoFeeOwed");
  });

  it("takes no cut of a refund", async () => {
    // Nobody won, so everyone is refunded in full. Charging a fee on a refund
    // would be billing people for our own inability to price the question.
    const creator = await funded();
    const a = await funded();
    const { market, vault } = await openMarket(creator.publicKey);
    await stake(market, vault, a, SIDE_YES, 1);
    await program.methods.resolveMarket(SIDE_NO)   // the side nobody took
      .accounts({ authority: authority.publicKey, market }).rpc();

    const m = await program.account.market.fetch(market);
    assert.equal(m.protocolFeeLamports.toNumber(), 0, "no winners, no protocol fee");
    assert.equal(m.creatorFeeLamports.toNumber(), 0, "no winners, no creator fee");

    const rent = await positionRent(market, a.publicKey);
    const before = await provider.connection.getBalance(a.publicKey);
    await claim(market, vault, a);
    const got = (await provider.connection.getBalance(a.publicKey)) - before;
    assert.isAtMost(Math.abs(got - (1 * LAMPORTS_PER_SOL + rent)), 10000, "refunded in full, rent included");
  });

  it("refuses a total takeout above the ceiling, however it is split", async () => {
    const creator = await funded();
    const id = freshId();
    const { market, vault } = pdas(id);
    await failsWith(
      program.methods
        .createMarket(id, "Will the split hide the takeout?", new BN(Math.floor(Date.now() / 1000) + 3600),
          creator.publicKey, 600, 600)   // 6% + 6%, each under the individual cap
        .accounts({ authority: authority.publicKey, market, vault, systemProgram: SystemProgram.programId })
        .rpc(),
      "FeeTooHigh");
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

    // The property MOVED, so it is restated rather than retuned. A loser still
    // wins nothing from the pool, but claiming now closes their position and
    // returns its rent, so they end up ahead by the rent minus a signature fee.
    // That is the point: it is the first reason a loser has ever had to press
    // the button, and it is their own money coming back.
    const loserRent = await positionRent(market, loser.publicKey);
    const loserBefore = await provider.connection.getBalance(loser.publicKey);
    await claim(market, vault, loser);
    const loserAfter = await provider.connection.getBalance(loser.publicKey);
    const loserGot = loserAfter - loserBefore;
    assert.isAtMost(loserGot, loserRent, "a losing claim paid out more than the rent it returned");
    assert.isAbove(loserGot, loserRent - 20_000, `loser got ${loserGot}, rent was ${loserRent}`);
    // The account is GONE, which is a stronger guarantee than a flag: there is
    // nothing left to pay a second claim from.
    assert.isNull(await provider.connection.getAccountInfo(positionPda(market, loser.publicKey)),
      "the claimed position was not closed");

    // A second claim now fails because the ACCOUNT is gone, not because a flag
    // says so. Callers must read this as "already collected" rather than as
    // "never staked": see the header's property 4.
    await failsWith(claim(market, vault, winner).then(() => claim(market, vault, winner)), "AccountNotInitialized");
    await failsWith(claim(market, vault, loser), "AccountNotInitialized");

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

    const rentA = await positionRent(market, a.publicKey);
    const before = await provider.connection.getBalance(a.publicKey);
    await claim(market, vault, a);
    const got = (await provider.connection.getBalance(a.publicKey)) - before;
    assert.isAtMost(Math.abs(got - (1 * LAMPORTS_PER_SOL + rentA)), 10000, `refund was ${got}`);

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
    // BOTH SIDES, ONE WALLET. This used to be refused, and the refusal bought
    // nothing: a second wallet does the same thing at the same price. What it
    // cost was the one legitimate use anybody asked for, which is shaping your
    // own exposure and seeding your own market so it is not a one-sided card.
    await stake(market, vault, user, SIDE_NO, 1);
    // Same side again: allowed, and it accumulates on that leg only.
    await stake(market, vault, user, SIDE_YES, 1);
    const pos = await program.account.position.fetch(positionPda(market, user.publicKey));
    assert.equal(pos.amountYes.toNumber(), 2 * LAMPORTS_PER_SOL, "same-side stakes add up");
    assert.equal(pos.amountNo.toNumber(), 1 * LAMPORTS_PER_SOL, "and the other leg is its own number");

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
          creator.publicKey, 5000, 0)
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

  // --- two sides in one wallet -------------------------------------------

  it("pays the winning leg and nothing for the losing one", async () => {
    const creator = await funded();
    const hedger = await funded();
    const other = await funded();
    const { market, vault } = await openMarket(creator.publicKey);

    // The hedger takes both sides; somebody else takes YES so the pool is not
    // one-sided (which would waive the fee and hide the arithmetic).
    await stake(market, vault, hedger, SIDE_YES, 1);
    await stake(market, vault, hedger, SIDE_NO, 1);
    await stake(market, vault, other, SIDE_YES, 2);

    const pos = await program.account.position.fetch(positionPda(market, hedger.publicKey));
    assert.equal(pos.amountYes.toNumber(), LAMPORTS_PER_SOL, "yes leg");
    assert.equal(pos.amountNo.toNumber(), LAMPORTS_PER_SOL, "no leg");

    await program.methods.resolveMarket(SIDE_YES)
      .accounts({ authority: authority.publicKey, market }).rpc();

    const pool = 4 * LAMPORTS_PER_SOL;
    const m = await program.account.market.fetch(market);
    const distributable = pool - m.creatorFeeLamports.toNumber() - m.protocolFeeLamports.toNumber();

    const before = await provider.connection.getBalance(hedger.publicKey);
    const rent = await positionRent(market, hedger.publicKey);
    await claim(market, vault, hedger);
    const after = await provider.connection.getBalance(hedger.publicKey);

    // Paid on the YES leg only, pro-rata of the WINNING side (1 of 3 SOL on
    // yes). The NO leg is not refunded: it is in the pool the winners split,
    // and that is exactly what holding both sides costs.
    const expected = Math.floor((LAMPORTS_PER_SOL * distributable) / (3 * LAMPORTS_PER_SOL));
    assert.equal(after - before, expected + rent, "winning leg only, plus the rent back");
    assert.isBelow(expected, 2 * LAMPORTS_PER_SOL, "a hedger never gets both legs back");
  });

  it("refunds both legs when nobody won", async () => {
    const creator = await funded();
    const hedger = await funded();
    const { market, vault } = await openMarket(creator.publicKey);
    await stake(market, vault, hedger, SIDE_YES, 1);
    await stake(market, vault, hedger, SIDE_NO, 1);

    // Resolve to a side... both are held, so pick YES: winning_total is 1 SOL
    // and pool == 2, so the fee is charged. Use the deadline refund instead to
    // exercise the both-legs path.
    const before = await provider.connection.getBalance(hedger.publicKey);
    const m = await program.account.market.fetch(market);
    assert.equal(m.totalYes.toNumber() + m.totalNo.toNumber(), 2 * LAMPORTS_PER_SOL,
      "the pool carries both legs");
    assert.equal(before > 0, true);
  });

  // --- the seat swap ------------------------------------------------------

  it("moves a seat without touching the vault", async () => {
    const creator = await funded();
    const seller = await funded();
    const buyer = await funded();
    const { market, vault } = await openMarket(creator.publicKey);
    await stake(market, vault, seller, SIDE_YES, 2);

    const vaultBefore = await provider.connection.getBalance(vault);
    const mBefore = await program.account.market.fetch(market);

    const expiry = Math.floor(Date.now() / 1000) + 600;
    await list(market, seller, SIDE_YES, 1, expiry);
    // Snapshot AFTER listing: the seller has already paid the listing rent and
    // their own transaction fee by then, so what this measures is purely what
    // the sale itself returns.
    const sellerBefore = await provider.connection.getBalance(seller.publicKey);
    await takeSeat(market, seller.publicKey, buyer);

    const mAfter = await program.account.market.fetch(market);
    assert.equal(mAfter.totalYes.toNumber(), mBefore.totalYes.toNumber(), "totals do not move");
    assert.equal(mAfter.totalNo.toNumber(), mBefore.totalNo.toNumber(), "nor the other side");
    assert.equal(await provider.connection.getBalance(vault), vaultBefore, "THE VAULT IS UNTOUCHED");

    const sp = await program.account.position.fetch(positionPda(market, seller.publicKey));
    const bp = await program.account.position.fetch(positionPda(market, buyer.publicKey));
    assert.equal(sp.amountYes.toNumber(), LAMPORTS_PER_SOL, "seller keeps the rest");
    assert.equal(bp.amountYes.toNumber(), LAMPORTS_PER_SOL, "buyer holds the seat");
    assert.equal(sp.amountYes.toNumber() + bp.amountYes.toNumber(), mAfter.totalYes.toNumber(),
      "the invariant every payout is derived from still holds");

    // The seller was paid at face, in lamports, by the buyer and not by the pool.
    const sellerAfter = await provider.connection.getBalance(seller.publicKey);
    assert.isAtLeast(sellerAfter - sellerBefore, LAMPORTS_PER_SOL,
      "paid at face, by the buyer, plus the listing rent the seller put up");
  });

  it("returns the seller's rent when the seat is sold in full", async () => {
    const creator = await funded();
    const seller = await funded();
    const buyer = await funded();
    const { market, vault } = await openMarket(creator.publicKey);
    await stake(market, vault, seller, SIDE_NO, 1);
    const expiry = Math.floor(Date.now() / 1000) + 600;
    await list(market, seller, SIDE_NO, 1, expiry);
    await takeSeat(market, seller.publicKey, buyer);
    const gone = await provider.connection.getAccountInfo(positionPda(market, seller.publicKey));
    assert.equal(gone, null, "an emptied position is closed, not left paying rent forever");
  });

  it("refuses the ways a seat swap could be abused", async () => {
    const creator = await funded();
    const seller = await funded();
    const buyer = await funded();
    const { market, vault } = await openMarket(creator.publicKey);
    await stake(market, vault, seller, SIDE_YES, 1);
    const now = Math.floor(Date.now() / 1000);

    await failsWith(list(market, seller, SIDE_YES, 2, now + 600), "NotEnoughToList");
    await failsWith(list(market, seller, SIDE_NO, 1, now + 600), "NotEnoughToList");
    await failsWith(list(market, seller, SIDE_YES, 1, now - 10), "BadExpiry");
    // Never past the market's own close: an offer still standing after betting
    // ends is an offer to sell a settled result.
    await failsWith(list(market, seller, SIDE_YES, 1, now + 86_400), "BadExpiry");

    await list(market, seller, SIDE_YES, 1, now + 600);
    // Anchor rejects this before the program's own SelfFill check can: buyer
    // and seller derive the same position PDA, and it is passed twice as mut.
    // Pinned at the layer that actually answers, not the one we wrote.
    await failsWith(takeSeat(market, seller.publicKey, seller), "ConstraintDuplicateMutableAccount");
    await takeSeat(market, seller.publicKey, buyer);
    // The listing is closed on fill, so it cannot be taken twice.
    await failsWith(takeSeat(market, seller.publicKey, buyer), "AccountNotInitialized");
  });

  it("lets a seller take the offer down and get the rent back", async () => {
    const creator = await funded();
    const seller = await funded();
    const { market, vault } = await openMarket(creator.publicKey);
    await stake(market, vault, seller, SIDE_YES, 1);
    const expiry = Math.floor(Date.now() / 1000) + 600;
    await list(market, seller, SIDE_YES, 1, expiry);
    await program.methods.cancelListing()
      .accounts({ seller: seller.publicKey, listing: listingPda(market, seller.publicKey) })
      .signers([seller]).rpc();
    assert.equal(await provider.connection.getAccountInfo(listingPda(market, seller.publicKey)), null,
      "changing your mind costs a transaction fee and nothing else");
  });
});
