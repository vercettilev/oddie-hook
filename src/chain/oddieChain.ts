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

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const CLUSTER = "devnet";
const SECRET = process.env.SOLANA_ADMIN_SECRET_KEY;
const IDL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "oddie_chain_idl.json");

// A create needs ~0.0039 SOL (Market + Vault rent + fee). Refuse below a small
// buffer so we fail fast+soft rather than eating a doomed tx fee.
const MIN_LAMPORTS = 10_000_000; // 0.01 SOL
const LAMPORTS_PER_SOL = 1_000_000_000;

export type MintResult = { pubkey: string; signature: string };

// --- pure, import-safe helpers (no anchor, cannot throw at load) -------------

/** Whether the on-chain layer is configured at all (admin key present). */
export function isChainEnabled(): boolean {
  return Boolean(SECRET);
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
