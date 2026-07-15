/**
 * Layer 2 — the on-chain proof. When an admin creates a Community market we ALSO
 * mint it on the oddie-chain pari-mutuel program on Solana devnet, as a provable
 * "this market really exists on Solana" artifact. Create-only: users still play
 * with virtual tokens off-chain. Every path here fails SOFT — if the key is
 * missing, the wallet is broke, or the RPC hiccups, `mintMarket` returns null and
 * the caller creates the virtual market anyway, just without the badge.
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import bs58 from "bs58";

const { Connection, Keypair, PublicKey, SystemProgram } = anchor.web3;

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const CLUSTER = "devnet";
const SECRET = process.env.SOLANA_ADMIN_SECRET_KEY;

// Lazily load the bundled IDL (default JSON import needs assertions under native
// ESM; reading the file avoids that and works identically under tsx).
const idl = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "oddie_chain_idl.json"),
    "utf8",
  ),
) as anchor.Idl & { address: string };

const PROGRAM_ID = new PublicKey(process.env.ODDIE_CHAIN_PROGRAM_ID ?? (idl as any).address);

// A create needs ~0.0039 SOL (Market + Vault rent + fee). Refuse to attempt
// below a small buffer so we fail fast+soft rather than eating a doomed tx fee.
const MIN_LAMPORTS = 10_000_000; // 0.01 SOL
const LAMPORTS_PER_SOL = 1_000_000_000;

export type MintResult = { pubkey: string; signature: string };

/** Whether the on-chain layer is configured at all (admin key present). */
export function isChainEnabled(): boolean {
  return Boolean(SECRET);
}

/** Solana Explorer link for a market account on devnet. */
export function explorerUrl(pubkey: string): string {
  return `https://explorer.solana.com/address/${pubkey}?cluster=${CLUSTER}`;
}

function parseKeypair(raw: string): anchor.web3.Keypair {
  const s = raw.trim();
  // Accept either the solana-keygen JSON array ([12,34,...]) or a base58 string.
  const bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s);
  return Keypair.fromSecretKey(bytes);
}

let cached: { program: anchor.Program; admin: anchor.web3.Keypair; connection: anchor.web3.Connection } | null = null;

function client() {
  if (cached) return cached;
  if (!SECRET) return null;
  let admin: anchor.web3.Keypair;
  try {
    admin = parseKeypair(SECRET);
  } catch (e) {
    console.error("[chain] SOLANA_ADMIN_SECRET_KEY is set but unparseable:", (e as Error).message);
    return null;
  }
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new anchor.Program(idl, provider);
  cached = { program, admin, connection };
  return cached;
}

/** The admin (market authority) address, for funding/status displays. null if unset. */
export function adminAddress(): string | null {
  const c = client();
  return c ? c.admin.publicKey.toBase58() : null;
}

/**
 * Mint a market on devnet. Returns the market PDA + tx signature on success, or
 * null on ANY failure (unconfigured, underfunded, RPC error). Never throws.
 *
 * `marketId` must be unique per authority (it seeds the PDA); the caller passes
 * the community market's own id so the two layers share one identifier.
 */
export async function mintMarket(args: {
  marketId: number;
  question: string;
  closeTime: number;
}): Promise<MintResult | null> {
  const c = client();
  if (!c) return null;
  const { program, admin, connection } = c;

  try {
    // On-chain guards mirror the program's own require!s, checked here so we fail
    // before spending a fee on a tx the program would reject anyway.
    if (args.question.length > 180) {
      console.error("[chain] question exceeds 180 bytes; skipping on-chain mint");
      return null;
    }
    const bal = await connection.getBalance(admin.publicKey);
    if (bal < MIN_LAMPORTS) {
      console.error(
        `[chain] admin wallet ${admin.publicKey.toBase58()} low: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL ` +
          `(< ${(MIN_LAMPORTS / LAMPORTS_PER_SOL).toFixed(2)}). Fund it. Skipping on-chain mint.`,
      );
      return null;
    }

    const marketIdBn = new BN(args.marketId);
    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), admin.publicKey.toBuffer(), marketIdBn.toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID,
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer()],
      PROGRAM_ID,
    );

    const signature = await program.methods
      .createMarket(marketIdBn, args.question, new BN(args.closeTime))
      .accountsStrict({
        authority: admin.publicKey,
        market: marketPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log(`[chain] minted market ${marketPda.toBase58()} (sig ${signature.slice(0, 8)}…)`);
    return { pubkey: marketPda.toBase58(), signature };
  } catch (e) {
    // Soft failure by design: the product must ship the virtual market regardless.
    console.error("[chain] mintMarket failed (virtual market still created):", (e as Error).message);
    return null;
  }
}

/** Balance of the admin wallet in SOL, or null if unconfigured/unreachable. */
export async function adminBalanceSol(): Promise<number | null> {
  const c = client();
  if (!c) return null;
  try {
    return (await c.connection.getBalance(c.admin.publicKey)) / LAMPORTS_PER_SOL;
  } catch {
    return null;
  }
}
