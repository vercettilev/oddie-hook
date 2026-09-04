/**
 * The market itself. Not a badge on one.
 *
 * This module used to be Layer 2: markets were played in virtual tokens and
 * ALSO minted on Solana as a provable "this really exists" artifact, so a
 * failed mint cost nothing but a missing explorer link. That inverted when
 * oddie went real-money-only. The pari-mutuel vault on this program IS the
 * market now. There is no off-chain pool behind it to fall back to, and a
 * market that failed to mint is not a market with a missing badge, it is a
 * market nobody can stake into.
 *
 * So the failure policy splits, and the split is the thing to keep straight:
 *
 *   · MINTING must fail loudly. mintMarket returning null has to abort the
 *     create, because publishing a tradeable market with no vault invites
 *     people to a table that does not exist. Its caller is what enforces
 *     that, and the route contract says so.
 *   · BOOT must still never fail. The lazy-import guard below stays exactly
 *     as it was: a bad @coral-xyz/anchor import, an unparseable admin key or
 *     a dead RPC degrades to "cannot mint right now" and is reported as such,
 *     rather than taking the process down and with it every already-open
 *     market, every settled claim and the whole read path.
 *
 * Read that as: on-chain is no longer optional to the PRODUCT, but it is
 * still optional to the PROCESS STARTING. Those are different promises and
 * only the first one changed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
// Type-only import: erased at compile time, so it adds ZERO runtime dependency.
import type * as Anchor from "@coral-xyz/anchor";

/**
 * ONCHAIN_ENABLED: the master switch, now default ON.
 *
 * It defaulted OFF through the play-token era, when the Solana layer was a
 * parked grant demo and the honest default for a parked feature is off. Under
 * real money that default would ship a product with no markets in it, so the
 * polarity flips with the business model.
 *
 * Setting it to false is now a DEVELOPMENT switch, not a product state: it is
 * how the test suite and a laptop with no admin key run the rest of the server
 * without reaching for an RPC. Anything user-facing that reads it should treat
 * false as "this environment cannot trade", not as "trading is off today".
 */
const ONCHAIN = (process.env.ONCHAIN_ENABLED ?? "true").toLowerCase() === "true";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

/**
 * Which cluster the explorer links point at. Derived from the RPC URL rather
 * than set beside it, because these two drifting apart is the exact bug that
 * ships mainnet markets with devnet explorer links on them, and nobody notices
 * until someone clicks one and sees "account not found" under their own money.
 * SOLANA_CLUSTER overrides it for the RPC hosts whose names say nothing (a
 * Helius or QuickNode endpoint looks the same on either network).
 */
const CLUSTER: "devnet" | "testnet" | "mainnet-beta" =
  (process.env.SOLANA_CLUSTER as "devnet" | "testnet" | "mainnet-beta" | undefined) ??
  (/\bdevnet\b/.test(RPC_URL) ? "devnet" : /\btestnet\b/.test(RPC_URL) ? "testnet" : "mainnet-beta");

const SECRET = process.env.SOLANA_ADMIN_SECRET_KEY;
/**
 * THIS FILE MUST MATCH THE PROGRAM THAT IS DEPLOYED, NOT THE SOURCE IN THIS REPO.
 *
 * They are two halves of one contract and only one half is under our control at
 * any moment. Regenerating the IDL alongside a program change and committing it
 * points the live server at a layout the live program does not have: the
 * discriminator still matches (Anchor derives it from the struct NAME), so every
 * account passes the gate and then fails on a field, fetchMarketOnChain catches
 * the throw and returns null, and every market reads as "unreachable" while
 * nothing logs a cause. That is exactly what happened here, measured against
 * devnet: the old IDL decoded the live markets fine and the new one threw
 * "Invalid bool" on all of them, because the question String moved everything
 * after it by its own length.
 *
 * So the IDL swap is a DEPLOY step, not a code step. The next program's IDL
 * waits in onchain/idl-next.json and is copied over this one only once the
 * program that matches it is actually on chain.
 */
const IDL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "oddie_chain_idl.json");

// A create needs ~0.00426 SOL (Market + Vault rent + fee). Refuse below a small
// buffer so we fail fast+soft rather than eating a doomed tx fee.
const MIN_LAMPORTS = 10_000_000; // 0.01 SOL
const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * The program's "creator not named yet" sentinel, base58 of the all-zero
 * pubkey. Written as a literal rather than derived from web3, because every
 * pure helper in this file has to stay import-safe (see the isolation note at
 * the top) and PublicKey.default costs an anchor import to read.
 */
const UNNAMED_CREATOR = "11111111111111111111111111111111";

export type MintResult = { pubkey: string; signature: string };

/**
 * A base58 Solana address, shape-checked WITHOUT loading anchor — this must
 * stay a pure function so routes can reject garbage input before ever
 * attempting `load()`. Length bounds match a real ed25519 pubkey encoding;
 * the charset excludes 0/O/I/l, which base58 always excludes.
 */
export function isValidPubkeyString(s: unknown): s is string {
  return typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

// --- pure, import-safe helpers (no anchor, cannot throw at load) -------------

/** The flag alone — gates DISPLAY of on-chain artifacts (badges, explorer
 *  links), including ones minted before the flag was turned off. */
export function onchainEnabled(): boolean {
  return ONCHAIN;
}

/** Whether minting can actually happen: flag on AND admin key present. */
export function isChainEnabled(): boolean {
  return ONCHAIN && Boolean(SECRET);
}

/** Solana Explorer link for a market account. Mainnet is the explorer's own
 *  default and takes no query param, so it is left off there. */
export function explorerUrl(pubkey: string): string {
  const q = CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER}`;
  return `https://explorer.solana.com/address/${pubkey}${q}`;
}

/** Which network this process is actually trading on. The UI needs it to say
 *  so out loud: "you are about to send real SOL" and "this is devnet play"
 *  must never look identical to somebody about to sign. */
export function cluster(): "devnet" | "testnet" | "mainnet-beta" {
  return CLUSTER;
}

// --- lazy client (all runtime anchor usage lives behind this) ----------------

interface ChainClient {
  program: Anchor.Program;
  admin: Anchor.web3.Keypair;
  connection: Anchor.web3.Connection;
  programId: Anchor.web3.PublicKey;
  web3: typeof import("@coral-xyz/anchor")["web3"];
  // BN + PublicKey constructors captured from the runtime module.
  BN: new (v: number | string) => { toArrayLike(buf: BufferConstructor, endian: string, len: number): Buffer };
}

let cached: ChainClient | null = null;
let initFailed = false;

/** Build (once) the anchor program + admin keypair, importing anchor lazily.
 *  Returns null on ANY failure — unconfigured, unparseable key, broken import. */
async function load(): Promise<ChainClient | null> {
  if (!ONCHAIN) return null; // flag off: never touch anchor, never call devnet
  if (cached) return cached;
  if (initFailed || !SECRET) return null;
  try {
    const anchor = await import("@coral-xyz/anchor");
    const bs58 = (await import("bs58")).default;
    const { web3 } = anchor;

    const idl = JSON.parse(readFileSync(IDL_PATH, "utf8")) as Anchor.Idl & { address: string };
    const programId = new web3.PublicKey(process.env.ODDIE_CHAIN_PROGRAM_ID ?? idl.address);

    const s = SECRET.trim();
    const bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s);
    const admin = web3.Keypair.fromSecretKey(bytes);

    const connection = new web3.Connection(RPC_URL, "confirmed");
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
    const program = new anchor.Program(idl, provider);

    cached = { program, admin, connection, programId, web3, BN: anchor.BN as unknown as ChainClient["BN"] };
    console.log(`[chain] on-chain layer ready; admin ${admin.publicKey.toBase58()}`);
    return cached;
  } catch (e) {
    initFailed = true; // don't retry a broken init on every request
    console.error("[chain] init failed; on-chain layer disabled, product unaffected:", (e as Error).message);
    return null;
  }
}

/** The program this build mints into. The PDA derives from it, so a backfill
 *  must refuse to replay a snapshot taken against a different one. */
export async function programIdString(): Promise<string | null> {
  const c = await load();
  return c ? c.programId.toBase58() : null;
}

/** The admin (market authority) address, or null if unconfigured/broken. */
export async function adminAddress(): Promise<string | null> {
  const c = await load();
  return c ? c.admin.publicKey.toBase58() : null;
}

/** Balance of the admin wallet in SOL, or null if unconfigured/unreachable. */
export async function adminBalanceSol(): Promise<number | null> {
  const c = await load();
  if (!c) return null;
  try {
    return (await c.connection.getBalance(c.admin.publicKey)) / LAMPORTS_PER_SOL;
  } catch {
    return null;
  }
}

/**
 * Mint a market on devnet. Returns the market PDA + tx signature on success, or
 * null on ANY failure (unconfigured, underfunded, RPC error). Never throws.
 * `marketId` seeds the PDA; the caller passes the community market's own id so
 * the two layers share one identifier.
 */
export async function mintMarket(args: {
  marketId: number;
  question: string;
  closeTime: number;
  /**
   * The wallet the creator fee is owed to, or null when the tagger has no
   * wallet yet, which is the normal case: a market is minted the second
   * someone tags an argument on X and that person is usually not even present.
   * Null mints the market with the program's unnamed sentinel, and
   * `nameCreator` fills it in later. See set_creator in the program.
   */
  creator: string | null;
  creatorFeeBps: number;
  protocolFeeBps: number;
}): Promise<MintResult | null> {
  const c = await load();
  if (!c) return null;
  try {
    if (args.question.length > 180) {
      console.error("[chain] question exceeds 180 bytes; skipping on-chain mint");
      return null;
    }
    if (args.creator !== null && !isValidPubkeyString(args.creator)) {
      console.error("[chain] creator is not a valid pubkey; refusing to mint");
      return null;
    }
    // The program caps this at 1000. Catching it here turns a wasted tx fee and
    // an opaque FeeTooHigh into a log line that names the actual number.
    if (!Number.isInteger(args.creatorFeeBps) || args.creatorFeeBps < 0 || args.creatorFeeBps > 1000) {
      console.error(`[chain] creatorFeeBps ${args.creatorFeeBps} outside 0..1000; refusing to mint`);
      return null;
    }
    if (!Number.isInteger(args.protocolFeeBps) || args.protocolFeeBps < 0 || args.protocolFeeBps > 1000) {
      console.error(`[chain] protocolFeeBps ${args.protocolFeeBps} outside 0..1000; refusing to mint`);
      return null;
    }
    // The program caps the SUM, because the sum is what a staker actually
    // loses. Two individually legal rates can still be a takeout.
    if (args.creatorFeeBps + args.protocolFeeBps > 1000) {
      console.error(`[chain] total fee ${args.creatorFeeBps + args.protocolFeeBps} bps exceeds the program's 1000; refusing to mint`);
      return null;
    }
    const bal = await c.connection.getBalance(c.admin.publicKey);
    if (bal < MIN_LAMPORTS) {
      console.error(
        `[chain] admin wallet ${c.admin.publicKey.toBase58()} low: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL ` +
          `(< ${(MIN_LAMPORTS / LAMPORTS_PER_SOL).toFixed(2)}). Fund it. Skipping on-chain mint.`,
      );
      return null;
    }

    const marketIdBn = new c.BN(args.marketId);
    const market = marketPda(c, marketIdBn);
    const vault = vaultPda(c, market);
    const creatorPk = args.creator
      ? new c.web3.PublicKey(args.creator)
      : c.web3.PublicKey.default; // the program's "not named yet" sentinel

    const signature = await c.program.methods
      .createMarket(marketIdBn, args.question, new c.BN(args.closeTime), creatorPk, args.creatorFeeBps, args.protocolFeeBps)
      .accountsStrict({
        authority: c.admin.publicKey,
        market,
        vault,
        systemProgram: c.web3.SystemProgram.programId,
      })
      .rpc();

    console.log(
      `[chain] minted market ${market.toBase58()} (sig ${signature.slice(0, 8)}…)` +
        (args.creator ? ` creator ${args.creator}` : " creator unnamed"),
    );
    return { pubkey: market.toBase58(), signature };
  } catch (e) {
    console.error("[chain] mintMarket failed; the market has no vault and must not be published:", (e as Error).message);
    return null;
  }
}

/**
 * Name the creator of a market minted before they had a wallet. Admin-signed,
 * because set_creator is authority-only.
 *
 * One way in the program: this can name an unnamed market and can never rename
 * a named one, so calling it twice is not a corruption risk, only a wasted fee.
 * Returns the signature, or null on any failure including "already named",
 * which the caller should treat as "fine, somebody got there first" rather
 * than as an error worth surfacing.
 */
export async function nameCreator(marketPubkey: string, creator: string): Promise<string | null> {
  const c = await load();
  if (!c) return null;
  if (!isValidPubkeyString(creator)) return null;
  try {
    const signature = await c.program.methods
      .setCreator(new c.web3.PublicKey(creator))
      .accountsStrict({ authority: c.admin.publicKey, market: new c.web3.PublicKey(marketPubkey) })
      .rpc();
    console.log(`[chain] named creator ${creator} on ${marketPubkey} (sig ${signature.slice(0, 8)}…)`);
    return signature;
  } catch (e) {
    console.error("[chain] nameCreator failed:", (e as Error).message);
    return null;
  }
}

// --- real-stakes ("skin in the game", opt-in, ONCHAIN_ENABLED-gated) --------
// Everything below plays a real user's own wallet against take_position /
// claim_winnings on the SAME pari-mutuel program mintMarket already writes to.
// The admin keypair signs nothing here except resolveMarketOnChain (the
// authority-only instruction) — a user's stake and claim are transactions
// the SERVER ASSEMBLES and RELAYS; only the user's own wallet can sign them.
// Same isolation contract as the rest of this file: any failure degrades to
// null, never throws past this module.

/**
 * The market PDA. Seeded by market_id ALONE.
 *
 * This used to mix the admin pubkey into the seeds, matching the older
 * deployed program. Ours does not, and a derivation that disagrees with the
 * program does not fail loudly: it computes a perfectly valid address that
 * simply holds nothing, so a create lands somewhere nobody reads and a
 * position is taken against an account that does not exist. Deriving it in one
 * place is what keeps that from being re-introduced a fourth time.
 */
function marketPda(c: ChainClient, marketId: InstanceType<ChainClient["BN"]>) {
  return c.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("market"), marketId.toArrayLike(Buffer, "le", 8)],
    c.programId,
  )[0];
}

function vaultPda(c: ChainClient, market: InstanceType<typeof c.web3.PublicKey>) {
  return c.web3.PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], c.programId)[0];
}
function positionPda(c: ChainClient, market: InstanceType<typeof c.web3.PublicKey>, user: InstanceType<typeof c.web3.PublicKey>) {
  return c.web3.PublicKey.findProgramAddressSync([Buffer.from("position"), market.toBuffer(), user.toBuffer()], c.programId)[0];
}

/** Mark a market resolved on-chain — the authority-only counterpart to the
 *  off-chain settleMarket, so claim_winnings has a real outcome to pay against.
 *  Best-effort: the off-chain settlement (the product's real economy) never
 *  waits on or depends on this succeeding. */
/**
 * The three answers a resolve can give, because it used to give one.
 *
 * It returned `string | null` and swallowed every error, so "the chain already
 * has this verdict" and "the RPC is down" and "we are not the authority" were
 * the same value, and the only caller discarded it anyway. That is how a
 * resolution comes to exist ONLY in our database: the row latches, the chain
 * call fails into the void, claim_winnings has no outcome to pay against, and
 * nothing anywhere knows.
 */
export type ResolveResult =
  | { ok: true; signature: string | null; alreadyResolved: boolean }
  | { ok: false; reason: "unavailable" | "diverged" | "failed"; error: string; onChainOutcome?: "yes" | "no" };

/**
 * How much SOL is actually staked in a market's vault, in lamports.
 *
 * This exists because the obvious way to ask, reading total_yes and total_no
 * off the Market account, stops working exactly when it matters most. A Market
 * written by an older layout cannot be deserialised at all, so every question
 * about it answers "unreadable", including the only one that decides whether it
 * is safe to touch: is anybody's money in there.
 *
 * The vault's balance needs no decoding. It is the runtime's own number, the
 * Vault account's layout has not changed anyway, and it is the money itself
 * rather than a claim about the money. Anything above the rent-exempt minimum
 * is somebody's stake; exactly the minimum means the vault holds nothing but
 * itself; and a vault that does not exist at all holds nothing, which is the
 * shape of a market minted by a program we no longer run.
 *
 * Null means the chain could not be reached, which callers must treat as a
 * refusal rather than as zero.
 */
export async function stakedInVault(marketPubkey: string): Promise<number | null> {
  const c = await load();
  if (!c) return null;
  try {
    const marketPk = new c.web3.PublicKey(marketPubkey);
    const [vaultPk] = c.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPk.toBuffer()],
      c.program.programId,
    );
    const [balance, rentMin] = await Promise.all([
      c.connection.getBalance(vaultPk),
      c.connection.getMinimumBalanceForRentExemption(8 + 33),
    ]);
    if (balance === 0) return 0;
    return Math.max(0, balance - rentMin);
  } catch {
    return null;
  }
}

/**
 * Give back the rent on a market nobody ever staked into.
 *
 * The program refuses anything else, and deliberately: `claim_winnings` closes a
 * position with `close = owner`, so a LOSER still calls it to get their own rent
 * back, and that call needs this market account to exist. Closing a market with
 * any history would recover our deposit by stranding somebody else's.
 *
 * So this only ever touches empty, finished markets, which is exactly what a
 * board accumulates: opened, ignored, closed. The pool is checked here as well
 * as in the program, because a request that is going to revert should not cost a
 * transaction to find out.
 */
export async function closeMarketOnChain(
  marketPubkey: string,
): Promise<{ ok: true; signature: string | null; lamports: number } | { ok: false; reason: string; error: string }> {
  const c = await load();
  if (!c) return { ok: false, reason: "unavailable", error: "chain layer not configured" };

  const state = await fetchMarketOnChain(marketPubkey).catch(() => null);
  if (!state) return { ok: false, reason: "unreadable", error: "market account could not be read" };
  if (state.totalYesLamports > 0 || state.totalNoLamports > 0) {
    return { ok: false, reason: "has-stakes", error: "somebody staked in this market; closing it would strand their rent" };
  }
  // The decoded totals are a claim about the money; the vault balance IS the
  // money. An account written by an older layout can decode as an empty pool
  // while the vault holds real SOL, so the balance is checked here too and the
  // program checks it again on its own side. A market whose vault we cannot even
  // read is never closed.
  try {
    const [vaultPk] = c.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), new c.web3.PublicKey(marketPubkey).toBuffer()],
      c.program.programId,
    );
    const held = await c.connection.getBalance(vaultPk);
    const rentMin = await c.connection.getMinimumBalanceForRentExemption(8 + 33);
    if (held > rentMin) {
      return { ok: false, reason: "has-stakes", error: `vault holds ${(held / 1e9).toFixed(6)} SOL, above its own rent` };
    }
  } catch (e) {
    return { ok: false, reason: "unreadable", error: `vault balance could not be read: ${(e as Error).message}` };
  }
  if (!state.resolved && state.closeTime * 1000 > Date.now()) {
    return { ok: false, reason: "still-open", error: `still open until ${new Date(state.closeTime * 1000).toISOString()}` };
  }

  try {
    const marketPk = new c.web3.PublicKey(marketPubkey);
    const [vaultPk] = c.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPk.toBuffer()],
      c.program.programId,
    );
    // Read before writing, so what came back can be reported rather than guessed.
    const before = await c.connection.getBalance(marketPk).catch(() => 0);
    const vaultBefore = await c.connection.getBalance(vaultPk).catch(() => 0);
    const signature = await c.program.methods
      .closeMarket()
      .accountsStrict({ authority: c.admin.publicKey, market: marketPk, vault: vaultPk })
      .rpc();
    const lamports = before + vaultBefore;
    console.log(`[chain] closed ${marketPk.toBase58()}, ${(lamports / 1e9).toFixed(6)} SOL back (sig ${signature.slice(0, 8)}…)`);
    return { ok: true, signature, lamports };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    console.error("[chain] closeMarketOnChain failed:", msg);
    return { ok: false, reason: "failed", error: msg.slice(0, 300) };
  }
}

export async function resolveMarketOnChain(marketPubkey: string, outcome: "yes" | "no"): Promise<ResolveResult> {
  const c = await load();
  if (!c) return { ok: false, reason: "unavailable", error: "chain layer not configured" };

  // Read before writing. A retry of a resolve that already landed must be a
  // success rather than an AlreadyResolved error, or every reconciliation run
  // jams on the markets that are already correct.
  const before = await fetchMarketOnChain(marketPubkey).catch(() => null);
  if (before?.resolved) {
    if (before.winningSide === outcome) return { ok: true, signature: null, alreadyResolved: true };
    // The chain says one thing and we are asking for another. Money may already
    // have moved on the chain's answer. This is never resolved automatically.
    return {
      ok: false, reason: "diverged", onChainOutcome: before.winningSide ?? undefined,
      error: `chain says ${before.winningSide}, asked for ${outcome}`,
    };
  }

  try {
    const marketPk = new c.web3.PublicKey(marketPubkey);
    const signature = await c.program.methods
      .resolveMarket(outcome === "yes" ? 0 : 1)
      .accountsStrict({ authority: c.admin.publicKey, market: marketPk })
      .rpc();
    console.log(`[chain] resolved ${marketPk.toBase58()} -> ${outcome} (sig ${signature.slice(0, 8)}…)`);
    return { ok: true, signature, alreadyResolved: false };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    console.error("[chain] resolveMarketOnChain failed:", msg);
    // AlreadyResolved can still surface here if something landed between the
    // read above and this write. Same verdict, same answer: it is done.
    if (/AlreadyResolved/i.test(msg)) return { ok: true, signature: null, alreadyResolved: true };
    return { ok: false, reason: "failed", error: msg };
  }
}

export interface OnChainMarketState {
  resolved: boolean;
  /** The market's authority. A backfill has to prove the key it is minting
   *  with is the key the markets already answer to, or it recreates the board
   *  under a signer that cannot resolve any of it. */
  authority: string | null;
  /** Unix seconds. The program refuses a stake at or after this
   *  (`require!(clock < close_time, MarketClosed)`), and our own database's
   *  close time is a separate value that can disagree with it, so anything
   *  deciding whether a stake will succeed has to read THIS one. */
  closeTime: number;
  winningSide: "yes" | "no" | null;
  totalYesLamports: number;
  totalNoLamports: number;
  /** Null while the tagger has no wallet yet. The UI reads this to decide
   *  between "claim your cut" and "connect a wallet to claim it". */
  creator: string | null;
  creatorFeeBps: number;
  /** Zero until resolve, and zero forever if nobody backed the winning side. */
  creatorFeeLamports: number;
  creatorFeeClaimed: boolean;
  /** Oddie's own half, read from the market rather than from a constant: a
   *  market opened before this rate existed carries zero and always will. */
  protocolFeeBps: number;
  protocolFeeLamports: number;
  protocolFeeClaimed: boolean;
}

/** Read a market's live on-chain state — pool sizes and (once resolved) the
 *  outcome. Anchor's account decoder returns camelCased field names from the
 *  IDL's snake_case; read both to survive either. */
/**
 * A fee rate the program could actually have stored, or zero.
 *
 * Adding fields to the Market account changed its layout, and an account
 * written by an older build is simply too short: Anchor decodes past the end
 * of what was serialised and returns whatever bytes follow. It does not throw.
 * The first market read after the fee shipped reported a protocol rate of
 * 65020 bps, which is the account's `bump` and `vault_bump` read as a u16.
 *
 * The program caps every rate at 1000 bps, so anything above that is not a
 * rate this program has ever charged, whatever the decoder says. Reading it as
 * zero is both true (an old market carries no protocol fee) and safe: it can
 * only ever understate what comes out of a pool, never overstate it.
 */
const sane = (bps: number): number => (Number.isFinite(bps) && bps >= 0 && bps <= 1000 ? bps : 0);

export async function fetchMarketOnChain(marketPubkey: string): Promise<OnChainMarketState | null> {
  const c = await load();
  if (!c) return null;
  try {
    // The generic `Idl` type this module uses (see the isolation-contract note
    // at the top) has no statically-known account names, only the runtime IDL
    // loaded in `load()` does — same reason `.methods.createMarket(...)` above
    // resolves loosely. `as any` here is that erasure, not an unchecked guess.
    const acct = await (c.program.account as any).market.fetchNullable(new c.web3.PublicKey(marketPubkey));
    if (!acct) return null;
    const a = acct as Record<string, unknown>;
    const resolved = Boolean(a.resolved);
    const side = Number(a.winningSide ?? a.winning_side ?? 0);
    // The unnamed sentinel is the all-zero pubkey. Reporting it as a real
    // address would have the UI offer a claim button to nobody.
    const rawCreator = String(a.creator ?? "");
    const creator = rawCreator && rawCreator !== UNNAMED_CREATOR ? rawCreator : null;
    return {
      resolved,
      authority: a.authority ? String(a.authority) : null,
      closeTime: Number(a.closeTime ?? a.close_time ?? 0),
      winningSide: resolved ? (side === 0 ? "yes" : "no") : null,
      totalYesLamports: Number(a.totalYes ?? a.total_yes ?? 0),
      totalNoLamports: Number(a.totalNo ?? a.total_no ?? 0),
      creator,
      creatorFeeBps: sane(Number(a.creatorFeeBps ?? a.creator_fee_bps ?? 0)),
      creatorFeeLamports: Number(a.creatorFeeLamports ?? a.creator_fee_lamports ?? 0),
      creatorFeeClaimed: Boolean(a.creatorFeeClaimed ?? a.creator_fee_claimed),
      protocolFeeBps: sane(Number(a.protocolFeeBps ?? a.protocol_fee_bps ?? 0)),
      protocolFeeLamports: Number(a.protocolFeeLamports ?? a.protocol_fee_lamports ?? 0),
      protocolFeeClaimed: Boolean(a.protocolFeeClaimed ?? a.protocol_fee_claimed),
    };
  } catch (e) {
    console.error("[chain] fetchMarketOnChain failed:", (e as Error).message);
    return null;
  }
}

export interface OnChainPosition {
  side: "yes" | "no";
  lamports: number;
  claimed: boolean;
}

/** confirmTransaction can reject with a bare object, so never read .message blind. */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
}

/**
 * Broadcast a transaction the USER already signed.
 *
 * The client used to call window.solana.signAndSendTransaction, which hands
 * BROADCASTING to the wallet, and a wallet broadcasts to whatever cluster it
 * happens to be set to. Visitors run Phantom on mainnet while this app runs on
 * devnet, so every stake was aimed at a cluster where the program does not
 * exist: the simulation failed, Phantom showed its red banner, and no bet could
 * ever land. Fifteen markets, zero SOL.
 *
 * Signing and sending are separable, so they are separated. The wallet still
 * signs, and nothing here can sign for it: this only relays bytes that already
 * carry the user's signature, to the same node the rest of the server reads
 * from. Non-custodial is unchanged, because a signature is the whole of custody.
 */
export interface SubmitResult { ok: boolean; signature?: string; confirmed?: boolean; error?: string; badRequest?: boolean }

export async function submitSignedTx(txBase64: string): Promise<SubmitResult> {
  const c = await load();
  if (!c) return { ok: false, error: "chain-unavailable" };
  try {
    const raw = Buffer.from(txBase64, "base64");

    /**
     * REFUSE ANYTHING THAT IS NOT OURS.
     *
     * Without this the endpoint is an open relay: anybody could post any signed
     * Solana transaction and have our node broadcast it, on our rate limit and
     * from our IP. The transaction must touch this program, which is the only
     * thing a stake, a claim or a fee collection ever does.
     */
    const tx = c.web3.Transaction.from(raw);
    // EXACTLY ONE instruction, and it must be ours. `some()` would let a rider
    // through: a Solana transaction carries many instructions, so one harmless
    // call to our program would buy an attacker a free relay for everything
    // else in the same envelope. Verified against production that this refuses
    // nothing real: a prepared take_position decodes to exactly one instruction,
    // and nothing in src/ or public/ adds a ComputeBudget instruction.
    const mine = c.programId.toBase58();
    if (tx.instructions.length !== 1 || tx.instructions[0].programId.toBase58() !== mine) {
      return { ok: false, error: "not-our-program", badRequest: true };
    }
    // The wallet is the only thing that can sign, so an unsigned envelope is a
    // client bug, not a chain failure. Catching it here keeps it out of the RPC.
    if (!tx.verifySignatures()) return { ok: false, error: "unsigned", badRequest: true };

    // skipPreflight false on purpose: preflight is a simulation against OUR
    // node, so a transaction the program would reject is refused here with a
    // readable reason instead of being paid for and reverting on chain.
    const signature = await c.connection.sendRawTransaction(raw, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });
    /**
     * ONCE sendRawTransaction RETURNS, THE SIGNATURE IS A FACT.
     *
     * Confirmation can still fail for reasons that say nothing about whether
     * the transaction landed: most sharply, if the RPC websocket never
     * establishes, web3.js reports an expiry for a stake that is sitting on
     * chain. Reporting that as a plain error over a re-armed button invites the
     * user to stake a second time, and the program allows adding to a position
     * on the same side, so the retry costs them real money.
     *
     * So a confirmation problem is reported as ok with confirmed:false and the
     * signature, and the client shows "sent, confirming" with a link. Only a
     * send that threw, or a transaction the chain actually rejected, is a
     * failure, because in both of those nothing was staked.
     */
    try {
      const bh = await c.connection.getLatestBlockhash("confirmed");
      const res = await c.connection.confirmTransaction(
        { signature, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
        "confirmed",
      );
      if (res.value.err) return { ok: false, error: "rejected", signature };
      return { ok: true, signature, confirmed: true };
    } catch (e) {
      console.error("[chain] confirm failed but it was sent:", errText(e));
      return { ok: true, signature, confirmed: false };
    }
  } catch (e) {
    // confirmTransaction can reject with a plain object rather than an Error,
    // so reading .message straight off it would log undefined.
    const m = errText(e);
    console.error("[chain] submitSignedTx failed:", m);
    // A short stable code, never the raw web3.js sentence: the client renders
    // these, and "Signature 5xY... has expired: block height exceeded." is not
    // a thing to show somebody who just tried to place a bet.
    const code = /custom program error|Simulation failed|preflight/i.test(m) ? "preflight-failed"
      : /expired|block height/i.test(m) ? "expired"
      : /Invalid|deserialize|buffer/i.test(m) ? "malformed"
      : "unavailable";
    return { ok: false, error: code, badRequest: code === "malformed" };
  }
}

/** A user's position on a market, or null if they have never staked. */
export async function fetchPosition(marketPubkey: string, userPubkey: string): Promise<OnChainPosition | null> {
  const c = await load();
  if (!c) return null;
  try {
    const marketPk = new c.web3.PublicKey(marketPubkey);
    const userPk = new c.web3.PublicKey(userPubkey);
    const acct = await (c.program.account as any).position.fetchNullable(positionPda(c, marketPk, userPk));
    if (!acct) return null;
    const a = acct as Record<string, unknown>;
    return { side: Number(a.side) === 0 ? "yes" : "no", lamports: Number(a.amount), claimed: Boolean(a.claimed) };
  } catch (e) {
    console.error("[chain] fetchPosition failed:", (e as Error).message);
    return null;
  }
}

/**
 * Build (never sign) a take_position transaction with the USER's wallet as fee
 * payer and signer — the server assembles it, the user's own wallet signs and
 * broadcasts it client-side. Returns base64-serialized tx bytes, or null on
 * any failure (unconfigured, bad pubkey, RPC unreachable).
 */
export async function preparePositionTx(args: {
  marketPubkey: string; userPubkey: string; side: "yes" | "no"; lamports: number;
}): Promise<string | null> {
  const c = await load();
  if (!c) return null;
  try {
    const marketPk = new c.web3.PublicKey(args.marketPubkey);
    const userPk = new c.web3.PublicKey(args.userPubkey);
    const ix = await c.program.methods
      .takePosition(args.side === "yes" ? 0 : 1, new c.BN(args.lamports))
      .accountsStrict({
        user: userPk, market: marketPk, vault: vaultPda(c, marketPk), position: positionPda(c, marketPk, userPk),
        systemProgram: c.web3.SystemProgram.programId,
      })
      .instruction();
    const { blockhash } = await c.connection.getLatestBlockhash("confirmed");
    const tx = new c.web3.Transaction({ feePayer: userPk, recentBlockhash: blockhash }).add(ix);
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  } catch (e) {
    console.error("[chain] preparePositionTx failed:", (e as Error).message);
    return null;
  }
}

/** Same shape as preparePositionTx, for claim_winnings. */
export async function prepareClaimTx(args: { marketPubkey: string; userPubkey: string }): Promise<string | null> {
  const c = await load();
  if (!c) return null;
  try {
    const marketPk = new c.web3.PublicKey(args.marketPubkey);
    const userPk = new c.web3.PublicKey(args.userPubkey);
    const ix = await c.program.methods
      .claimWinnings()
      .accountsStrict({
        owner: userPk, market: marketPk, vault: vaultPda(c, marketPk), position: positionPda(c, marketPk, userPk),
      })
      .instruction();
    const { blockhash } = await c.connection.getLatestBlockhash("confirmed");
    const tx = new c.web3.Transaction({ feePayer: userPk, recentBlockhash: blockhash }).add(ix);
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  } catch (e) {
    console.error("[chain] prepareClaimTx failed:", (e as Error).message);
    return null;
  }
}

/**
 * Same shape again, for claim_creator_fee: the payout to whoever tagged the
 * argument that became this market. This is the transaction that makes "being
 * loud pays" a fact rather than a slogan, so it is worth naming as such.
 *
 * The creator signs for themselves. The program's `has_one = creator` over a
 * Signer is what makes the fee unstealable, and the server assembling the
 * transaction does not weaken that: a tx built for the wrong wallet is simply
 * one the program rejects.
 */
export interface ProtocolFeeResult {
  ok: boolean;
  signature?: string | null;
  /** True when the fee had already been pulled. Idempotent, not an error. */
  alreadyClaimed?: boolean;
  /** What was swept, in lamports, when we could read it before pulling. */
  lamports?: number;
  error?: string;
}

/**
 * Pull oddie's own 2% out of one settled market's vault.
 *
 * NOT a prepare-for-the-user function, and that asymmetry is the program's,
 * not ours: `claim_creator_fee` is signed by the CREATOR (so it must be built
 * unsigned and handed to their wallet), while `claim_protocol_fee` is signed
 * by the market's AUTHORITY, which is the admin key this server already holds.
 * So this signs and sends directly, exactly like resolveMarketOnChain.
 *
 * Until this existed, resolve fixed protocol_fee_lamports into every market
 * and nothing anywhere could ever move it: 100% of the product's own revenue
 * accrued into vaults with no door. Invisible on devnet, where the numbers
 * were play money.
 *
 * Read-before-write, same reason as resolve: a sweep that runs twice over the
 * same market must report success rather than jam the whole run on the ones
 * that are already correct.
 */
export async function claimProtocolFee(marketPubkey: string): Promise<ProtocolFeeResult> {
  const c = await load();
  if (!c) return { ok: false, error: "chain layer not configured" };

  const before = await fetchMarketOnChain(marketPubkey).catch(() => null);
  if (!before) return { ok: false, error: "market unreadable" };
  if (!before.resolved) return { ok: false, error: "not resolved yet" };
  if (before.protocolFeeClaimed) return { ok: true, signature: null, alreadyClaimed: true, lamports: 0 };

  try {
    const marketPk = new c.web3.PublicKey(marketPubkey);
    const signature = await c.program.methods
      .claimProtocolFee()
      .accountsStrict({ authority: c.admin.publicKey, market: marketPk, vault: vaultPda(c, marketPk) })
      .rpc();
    console.log(`[chain] protocol fee swept ${marketPk.toBase58()} (${before.protocolFeeLamports} lamports, sig ${signature.slice(0, 8)}…)`);
    return { ok: true, signature, alreadyClaimed: false, lamports: before.protocolFeeLamports };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    // Landed between the read and the write: same verdict as resolve's.
    if (/AlreadyClaimed/i.test(msg)) return { ok: true, signature: null, alreadyClaimed: true, lamports: 0 };
    console.error("[chain] claimProtocolFee failed:", msg);
    return { ok: false, error: msg };
  }
}

export async function prepareCreatorFeeTx(args: {
  marketPubkey: string; creatorPubkey: string;
}): Promise<string | null> {
  const c = await load();
  if (!c) return null;
  try {
    const marketPk = new c.web3.PublicKey(args.marketPubkey);
    const creatorPk = new c.web3.PublicKey(args.creatorPubkey);
    const ix = await c.program.methods
      .claimCreatorFee()
      .accountsStrict({ creator: creatorPk, market: marketPk, vault: vaultPda(c, marketPk) })
      .instruction();
    const { blockhash } = await c.connection.getLatestBlockhash("confirmed");
    const tx = new c.web3.Transaction({ feePayer: creatorPk, recentBlockhash: blockhash }).add(ix);
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  } catch (e) {
    console.error("[chain] prepareCreatorFeeTx failed:", (e as Error).message);
    return null;
  }
}


// --- Reading a stake out of a signed transaction -----------------------------
//
// The submit relay is the one moment a real stake passes through our hands
// already signed, which makes it the one honest place to stamp the entry odds
// for the receipt system: stamping at prepare would let anyone farm
// good-looking entries without ever signing. So the relay needs to be able to
// READ the transaction it is about to broadcast, not merely check whose program
// it calls.

import { createHash } from "node:crypto";

/** Anchor's instruction discriminator: the first 8 bytes of
 *  sha256("global:<name>"). Computed rather than pasted, so it cannot drift
 *  from the convention it encodes. */
export function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

export interface TakePositionInfo {
  user: string;
  market: string;
  side: "yes" | "no";
  lamports: number;
}

/**
 * Decode one instruction IF it is take_position; null for anything else.
 *
 * Pure on purpose: data plus account keys in, verdict out, so the offline suite
 * can pin the byte layout without a chain or even web3. The layout is Anchor's:
 * 8-byte discriminator, then the args in order (side u8, amount u64 LE). The
 * account order is the TakePosition context's: user, market, vault, position,
 * system_program.
 */
export function decodeTakePositionIx(data: Buffer, accountKeys: string[]): TakePositionInfo | null {
  if (data.length !== 8 + 1 + 8) return null;
  if (!data.subarray(0, 8).equals(anchorDiscriminator("take_position"))) return null;
  const side = data.readUInt8(8);
  if (side !== 0 && side !== 1) return null;
  const lamports = Number(data.readBigUInt64LE(9));
  if (!Number.isSafeInteger(lamports) || lamports <= 0) return null;
  if (accountKeys.length < 2) return null;
  return { user: accountKeys[0], market: accountKeys[1], side: side === 0 ? "yes" : "no", lamports };
}

/** The same read against a base64 transaction, for the relay. Null whenever the
 *  envelope is not a single take_position: the relay carries claims and fee
 *  collections through the same door, and those simply have no entry to stamp. */
export async function takePositionFromTx(txBase64: string): Promise<TakePositionInfo | null> {
  try {
    const { web3 } = await import("@coral-xyz/anchor");
    const tx = web3.Transaction.from(Buffer.from(txBase64, "base64"));
    if (tx.instructions.length !== 1) return null;
    const ix = tx.instructions[0];
    return decodeTakePositionIx(Buffer.from(ix.data), ix.keys.map((k) => k.pubkey.toBase58()));
  } catch {
    return null;
  }
}

/**
 * What the crowd said, 0-100, for one side of a pool AS IT STANDS. Called with
 * the state read just before a stake is broadcast, so the staker's own money is
 * not in it yet: "called YES at 30" must mean the crowd said 30, not "30 after
 * I moved it".
 *
 * An empty pool answers 50. No crowd, no information, and no contrarian credit
 * for disagreeing with nobody.
 */
export function entryShareOf(state: { totalYesLamports: number; totalNoLamports: number }, side: "yes" | "no"): number {
  const pool = state.totalYesLamports + state.totalNoLamports;
  if (pool <= 0) return 50;
  const mine = side === "yes" ? state.totalYesLamports : state.totalNoLamports;
  return Math.max(0, Math.min(100, Math.round((100 * mine) / pool)));
}
