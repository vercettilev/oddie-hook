// swSOL, against Sanctum's real program.
//
// Run with scripts/test-swsol.sh, which starts a local validator with Sanctum's
// mainnet swSOL program, its mint and its pool cloned in. Under a plain
// `anchor test` the program is absent and this whole suite skips itself.
//
// What is pinned here is the same thing the main suite pins, money:
//   · parked SOL leaves the vault only as swSOL the vault owns, 1:1
//   · it comes back whole, and only ever to the vault
//   · a market cannot be settled with stakes still parked
//   · a resolve without the vault is refused (required since the 22 Oct audit)
//   · once a market is settled or closed, anybody can bring its SOL home

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { OddieChain } from "../target/types/oddie_chain";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { assert } from "chai";

const SWSOL_PROGRAM = new PublicKey("so1f7APRw5pJ5iNJrM9g5X9tQgXzk8kMUnXxDNdt99b");
const SWSOL_MINT = new PublicKey("swso1x7A8Dy36znxtcstSVLNseeCQzNV3wVAfa5GGLu");
const SWSOL_POOL = new PublicKey("CugxVX9C5N1gmGTB4DGLjTcod1jTJtJFXgnkm9ExjyDP");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** Oddie's admin wallet, the address Sanctum attributes our mints to. */
const ATTRIBUTION = "J3bEmhdy7CeZeJRXHSJe2JEDyC39kmEWfBKUrYCQuPVY";
const CRITERIA = "Resolves YES if the test passes.";
const SOL = LAMPORTS_PER_SOL;

describe("swSOL", function () {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.OddieChain as Program<OddieChain>;
  const authority = provider.wallet as anchor.Wallet;
  const conn = provider.connection;

  before(async function () {
    if (!(await conn.getAccountInfo(SWSOL_PROGRAM))) this.skip();
  });

  let nextId = Math.floor(Date.now() / 1000) * 1000 + 500;
  const pdas = (id: BN) => {
    const [market] = PublicKey.findProgramAddressSync([Buffer.from("market"), id.toArrayLike(Buffer, "le", 8)], program.programId);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], program.programId);
    return { market, vault };
  };
  const positionPda = (market: PublicKey, owner: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("position"), market.toBuffer(), owner.toBuffer()], program.programId)[0];
  const ataOf = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), SWSOL_MINT.toBuffer()], ATA_PROGRAM)[0];

  const funded = async (sol = 10): Promise<Keypair> => {
    const kp = Keypair.generate();
    const sig = await conn.requestAirdrop(kp.publicKey, sol * SOL);
    await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) });
    return kp;
  };

  /** A market that runs for a month: the kind worth parking. */
  const openMarket = async (closeInSecs = 30 * 86400) => {
    const id = new BN(++nextId);
    const { market, vault } = pdas(id);
    await program.methods
      .createMarket(id, "Will the test pass?", new BN(Math.floor(Date.now() / 1000) + closeInSecs), authority.publicKey, 200, 200, CRITERIA)
      .accounts({ authority: authority.publicKey, market, vault, systemProgram: SystemProgram.programId })
      .rpc();
    return { market, vault };
  };
  const stake = (market: PublicKey, vault: PublicKey, user: Keypair, side: number, sol: number) =>
    program.methods.takePosition(side, new BN(sol * SOL))
      .accounts({ user: user.publicKey, market, vault, position: positionPda(market, user.publicKey), systemProgram: SystemProgram.programId })
      .signers([user]).rpc();

  /** The vault's swSOL account: the associated account of (vault, swSOL),
   *  created idempotently by whoever pays, owned by the vault PDA. */
  const createAta = (payer: PublicKey, owner: PublicKey) =>
    new TransactionInstruction({
      programId: ATA_PROGRAM,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: ataOf(owner), isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: SWSOL_MINT, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]), // CreateIdempotent
    });
  const memo = () => new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(`sols:${ATTRIBUTION}`) });
  const swsolOf = async (acc: PublicKey) => {
    const info = await conn.getAccountInfo(acc);
    return info ? Number(info.data.readBigUInt64LE(64)) : 0;
  };
  const bal = (k: PublicKey) => conn.getBalance(k);

  const swsolAccounts = (market: PublicKey, vault: PublicKey, vaultSwsol = ataOf(vault)) => ({
    market, vault, vaultSwsol, swsolMint: SWSOL_MINT, swsolPool: SWSOL_POOL, tokenProgram: TOKEN, swsolProgram: SWSOL_PROGRAM,
  });
  const parkIx = (market: PublicKey, vault: PublicKey, lamports: number, signer = authority.publicKey, held?: PublicKey) =>
    program.methods.parkSwsol(new BN(lamports)).accountsStrict({ authority: signer, ...swsolAccounts(market, vault, held) }).instruction();
  const unparkIx = (market: PublicKey, vault: PublicKey, lamports: number, caller = authority.publicKey) =>
    program.methods.unparkSwsol(new BN(lamports)).accountsStrict({ caller, ...swsolAccounts(market, vault) }).instruction();
  /** One transaction the way production would send it: the swSOL account if it
   *  is missing, the attribution memo, then the park. */
  const park = async (market: PublicKey, vault: PublicKey, lamports: number, opts: { signer?: Keypair; held?: PublicKey } = {}) => {
    const signer = opts.signer?.publicKey ?? authority.publicKey;
    const tx = new Transaction().add(createAta(authority.publicKey, vault), memo(), await parkIx(market, vault, lamports, signer, opts.held));
    return provider.sendAndConfirm(tx, opts.signer ? [opts.signer] : []);
  };
  const unpark = async (market: PublicKey, vault: PublicKey, lamports: number, caller?: Keypair) =>
    provider.sendAndConfirm(new Transaction().add(await unparkIx(market, vault, lamports, caller?.publicKey)), caller ? [caller] : []);
  const resolveWithVault = (market: PublicKey, vault: PublicKey, side: number) =>
    program.methods.resolveMarket(side).accountsStrict({ authority: authority.publicKey, market, vault }).rpc();
  /** Exactly what the server deployed before swSOL sends: two accounts. */
  const resolveOldServer = async (market: PublicKey, side: number) => {
    const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], program.programId)[0];
    const ix = await program.methods.resolveMarket(side).accountsStrict({ authority: authority.publicKey, market, vault }).instruction();
    ix.keys = ix.keys.slice(0, 2);
    return provider.sendAndConfirm(new Transaction().add(ix));
  };
  const claim = (market: PublicKey, vault: PublicKey, user: Keypair) =>
    program.methods.claimWinnings().accounts({ owner: user.publicKey, market, vault, position: positionPda(market, user.publicKey) }).signers([user]).rpc();

  const failsWith = async (p: Promise<unknown>, code: string) => {
    try { await p; assert.fail(`expected ${code}, but it succeeded`); }
    catch (e: any) {
      const s = JSON.stringify(e?.error ?? e?.logs ?? e?.message ?? e) + String(e?.message ?? "") + JSON.stringify(e?.transactionLogs ?? e?.logs ?? "");
      assert.include(s, code, `expected ${code}, got ${s.slice(0, 400)}`);
    }
  };

  it("parks idle SOL as swSOL the vault owns, and brings every lamport back", async () => {
    const { market, vault } = await openMarket();
    const alice = await funded(), bob = await funded();
    await stake(market, vault, alice, 0, 2);
    await stake(market, vault, bob, 1, 1);
    const vault0 = await bal(vault), pool0 = await bal(SWSOL_POOL);

    await park(market, vault, 1.5 * SOL);
    assert.equal(await swsolOf(ataOf(vault)), 1.5 * SOL, "1.5 swSOL, owned by the vault");
    assert.equal(await bal(vault), vault0 - 1.5 * SOL, "the SOL left the vault");
    assert.equal(await bal(SWSOL_POOL), pool0 + 1.5 * SOL, "and landed in Sanctum's pool");

    await failsWith(resolveWithVault(market, vault, 0), "StakesParked");

    const stranger = await funded();
    await failsWith(unpark(market, vault, 1.5 * SOL, stranger), "UnparkNotYours");

    await unpark(market, vault, 1.5 * SOL);
    assert.equal(await swsolOf(ataOf(vault)), 0);
    assert.equal(await bal(vault), vault0, "every lamport is back");

    await resolveWithVault(market, vault, 0);
    const a0 = await bal(alice.publicKey);
    await claim(market, vault, alice);
    // 3 SOL pool, 4% fee (2% + 2%, inside the losing 1 SOL): 2.88 SOL to the
    // only winner, plus her position's rent back, less her transaction fee.
    assert.approximately(await bal(alice.publicKey) - a0, 2.88 * SOL, 0.003 * SOL, "the winner is paid the whole pool after fees, from the vault");
  });

  it("parks twice and unparks in parts, and the arithmetic closes", async () => {
    const { market, vault } = await openMarket();
    const alice = await funded();
    await stake(market, vault, alice, 0, 3);
    const vault0 = await bal(vault);
    await park(market, vault, 1 * SOL);
    await park(market, vault, 0.5 * SOL);
    assert.equal(await swsolOf(ataOf(vault)), 1.5 * SOL);
    await unpark(market, vault, 0.7 * SOL);
    await unpark(market, vault, 0.8 * SOL);
    assert.equal(await swsolOf(ataOf(vault)), 0);
    assert.equal(await bal(vault), vault0);
  });

  it("refuses a resolve without the vault, and lets anybody bring the SOL home once the market is closed", async () => {
    const { market, vault } = await openMarket(12);
    const alice = await funded(), bob = await funded();
    await stake(market, vault, alice, 0, 1);
    await stake(market, vault, bob, 1, 1);
    const vault0 = await bal(vault);
    await park(market, vault, 1 * SOL);
    // The two-account resolve the pre-swSOL server sent: refused since 22 Oct,
    // so no resolve can skip the parked-stakes check.
    await failsWith(resolveOldServer(market, 0), "AccountNotEnoughKeys");
    await failsWith(resolveWithVault(market, vault, 0), "StakesParked");
    // Waited out on the CHAIN's clock, which is the one the program reads: a
    // local validator's runs behind the wall clock.
    const close = (await program.account.market.fetch(market)).closeTime.toNumber();
    const chainNow = async () => Number((await conn.getAccountInfo(anchor.web3.SYSVAR_CLOCK_PUBKEY))!.data.readBigInt64LE(32));
    while ((await chainNow()) <= close) await new Promise((r) => setTimeout(r, 1000));
    const stranger = await funded();
    await unpark(market, vault, 1 * SOL, stranger);
    assert.equal(await bal(vault), vault0);
    await resolveWithVault(market, vault, 0);
    await claim(market, vault, alice);
  });

  it("parks nothing it does not hold, and never the vault's rent", async () => {
    const { market, vault } = await openMarket();
    const alice = await funded();
    await stake(market, vault, alice, 0, 1);
    await failsWith(park(market, vault, 1 * SOL + 1), "VaultUnderfunded");
  });

  it("only the market's authority parks", async () => {
    const { market, vault } = await openMarket();
    const alice = await funded();
    await stake(market, vault, alice, 0, 1);
    const stranger = await funded();
    await failsWith(park(market, vault, 0.5 * SOL, { signer: stranger }), "WrongAuthority");
  });

  it("mints only into the vault's own swSOL account", async () => {
    const { market, vault } = await openMarket();
    const alice = await funded();
    await stake(market, vault, alice, 0, 1);
    // A real swSOL account, but somebody else's.
    await provider.sendAndConfirm(new Transaction().add(createAta(authority.publicKey, authority.publicKey)));
    await failsWith(park(market, vault, 0.5 * SOL, { held: ataOf(authority.publicKey) }), "SwsolBadAccount");
  });

  it("unparks no more than the vault holds", async () => {
    const { market, vault } = await openMarket();
    const alice = await funded();
    await stake(market, vault, alice, 0, 1);
    await park(market, vault, 0.5 * SOL);
    await failsWith(unpark(market, vault, 0.5 * SOL + 1), "NotEnoughSwsol");
    await unpark(market, vault, 0.5 * SOL);
  });
});
