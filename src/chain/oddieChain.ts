/**
 * Layer 2 — the on-chain proof. When an admin creates a Community market we ALSO
 * mint it on the oddie-chain pari-mutuel program on Solana devnet, as a provable
 * "this market really exists on Solana" artifact. Create-only: users still play
 * with virtual tokens off-chain.
 *
 * ISOLATION IS THE CONTRACT: this module has NO top-level runtime dependency on
 * @coral-xyz/anchor (or anything that can throw). The heavy libs load lazily via
 * dynamic import() inside a guarded init, so ANY failure here — a bad import, a
 * missing/broken key, an RPC outage — degrades to "no on-chain badge" and NEVER
 * crashes server boot or blocks the product. On-chain is a bonus, not a boot dep.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
// Type-only import: erased at compile time, so it adds ZERO runtime dependency.
import type * as Anchor from "@coral-xyz/anchor";

/**
 * ONCHAIN_ENABLED — master switch for the whole on-chain layer, default OFF.
 * Oddie's repositioning (2026-07) makes community markets the product and parks
 * the Solana layer: with the flag off, no devnet create_market is attempted and
 * no badge/explorer link is emitted anywhere. Everything below — the Anchor
 * client, admin keypair wiring, minting — is intact and tested; it is PRESERVED
 * for a future grant demo. Set ONCHAIN_ENABLED=true to restore the full
 * behavior with zero code changes.
 */
const ONCHAIN = (process.env.ONCHAIN_ENABLED ?? "false").toLowerCase() === "true";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const CLUSTER = "devnet";
const SECRET = process.env.SOLANA_ADMIN_SECRET_KEY;
const IDL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "oddie_chain_idl.json");

// A create needs ~0.0039 SOL (Market + Vault rent + fee). Refuse below a small
// buffer so we fail fast+soft rather than eating a doomed tx fee.
const MIN_LAMPORTS = 10_000_000; // 0.01 SOL
const LAMPORTS_PER_SOL = 1_000_000_000;

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

/** Solana Explorer link for a market account on devnet. */
export function explorerUrl(pubkey: string): string {
  return `https://explorer.solana.com/address/${pubkey}?cluster=${CLUSTER}`;
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
}): Promise<MintResult | null> {
  const c = await load();
  if (!c) return null;
  try {
    if (args.question.length > 180) {
      console.error("[chain] question exceeds 180 bytes; skipping on-chain mint");
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
    const [marketPda] = c.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("market"), c.admin.publicKey.toBuffer(), marketIdBn.toArrayLike(Buffer, "le", 8)],
      c.programId,
    );
    const [vaultPda] = c.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer()],
      c.programId,
    );

    const signature = await c.program.methods
      .createMarket(marketIdBn, args.question, new c.BN(args.closeTime))
      .accountsStrict({
        authority: c.admin.publicKey,
        market: marketPda,
        vault: vaultPda,
        systemProgram: c.web3.SystemProgram.programId,
      })
      .rpc();

    console.log(`[chain] minted market ${marketPda.toBase58()} (sig ${signature.slice(0, 8)}…)`);
    return { pubkey: marketPda.toBase58(), signature };
  } catch (e) {
    console.error("[chain] mintMarket failed (virtual market still created):", (e as Error).message);
    return null;
  }
}

// --- real-stakes ("skin in the game", opt-in, ONCHAIN_ENABLED-gated) --------
// Everything below plays a real user's own wallet against take_position /
// claim_winnings on the SAME pari-mutuel program mintMarket already writes to.
// The admin keypair signs nothing here except resolveMarketOnChain (the
// authority-only instruction) — a user's stake and claim are transactions
// the SERVER only ASSEMBLES; the user's own wallet signs and broadcasts them.
// Same isolation contract as the rest of this file: any failure degrades to
// null, never throws past this module.

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
export async function resolveMarketOnChain(marketPubkey: string, outcome: "yes" | "no"): Promise<string | null> {
  const c = await load();
  if (!c) return null;
  try {
    const marketPk = new c.web3.PublicKey(marketPubkey);
    const signature = await c.program.methods
      .resolveMarket(outcome === "yes" ? 0 : 1)
      .accountsStrict({ authority: c.admin.publicKey, market: marketPk })
      .rpc();
    console.log(`[chain] resolved ${marketPk.toBase58()} -> ${outcome} (sig ${signature.slice(0, 8)}…)`);
    return signature;
  } catch (e) {
    console.error("[chain] resolveMarketOnChain failed:", (e as Error).message);
    return null;
  }
}

export interface OnChainMarketState {
  resolved: boolean;
  winningSide: "yes" | "no" | null;
  totalYesLamports: number;
  totalNoLamports: number;
}

/** Read a market's live on-chain state — pool sizes and (once resolved) the
 *  outcome. Anchor's account decoder returns camelCased field names from the
 *  IDL's snake_case; read both to survive either. */
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
    return {
      resolved,
      winningSide: resolved ? (side === 0 ? "yes" : "no") : null,
      totalYesLamports: Number(a.totalYes ?? a.total_yes ?? 0),
      totalNoLamports: Number(a.totalNo ?? a.total_no ?? 0),
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
