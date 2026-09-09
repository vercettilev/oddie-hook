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
 * What one market actually costs the admin wallet, measured against real
 * accounts rather than estimated: Market (314 bytes) 0.003076 + Vault (41
 * bytes) 0.001176 + the signature 0.000005.
 *
 * Nearly all of it is rent, and rent is refundable only through close_market,
 * which refuses any market whose totals are non-zero. Since mints happen
 * on-demand -- at the moment somebody is about to stake -- almost every minted
 * market carries stakes. So treat this as SPENT per market, not as a deposit.
 */
const COST_PER_MARKET_LAMPORTS = 4_257_000;

/**
 * The band between "still working" and "already stopped".
 *
 * MIN_LAMPORTS is a cliff: one market above it everything works, one market
 * below it every mint is refused and the only trace is a log line nobody
 * reads. A cliff with no approach is how a campaign stops silently mid-flight,
 * so this is the approach: roughly ten more markets of warning.
 */
const WARN_LAMPORTS = 50_000_000; // 0.05 SOL

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

/**
 * A STAKER'S OWN BALANCE, read through our RPC rather than theirs.
 *
 * The sheet used to offer 0.05 / 0.1 / 0.25 SOL chips to a wallet it had never
 * asked how much it held, and an underfunded tap died at preflight simulation
 * -- which the error map then reported as "the market may have just closed or
 * settled". A false statement about the market, on the most common first-timer
 * failure there is. Knowing the number lets the sheet grey out what cannot be
 * afforded instead of guessing wrong about why Solana said no.
 *
 * Read here and not in the browser because the RPC endpoint is ours and its
 * key does not belong in a page. Null on any failure: a sheet with no balance
 * behaves exactly as it did before, which is the safe direction.
 */
export async function walletBalanceLamports(address: string): Promise<number | null> {
  const c = await load();
  if (!c) return null;
  try {
    return await c.connection.getBalance(new c.web3.PublicKey(address));
  } catch {
    return null;
  }
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
 * How close the admin wallet is to stopping, in the terms an operator acts on.
 *
 * `marketsLeft` counts to the FLOOR, not to zero, because minting stops at the
 * floor: a wallet holding exactly MIN_LAMPORTS can open no markets at all, and
 * reporting its balance as "0.01 SOL" while the answer to "how many more?" is
 * zero is the kind of true-but-useless number that lets a campaign stall.
 *
 * Cached for a minute: every admin surface reads this, and an RPC call per
 * page paint would be a self-inflicted rate limit.
 */
export type ChainHealthState = "ok" | "low" | "stopped" | "off";

export interface ChainHealth {
  state: ChainHealthState;
  /** Null when the chain layer is off or the RPC could not be reached. */
  balanceSol: number | null;
  /** Markets still mintable before the floor stops them. Null when unknown. */
  marketsLeft: number | null;
  costPerMarketSol: number;
  floorSol: number;
  warnSol: number;
  admin: string | null;
  programId: string | null;
  cluster: string;
  /** Mints refused for lack of funds since this process started. */
  refusedForFunds: number;
  lastRefusalAt: string | null;
  checkedAt: string;
}

/**
 * The arithmetic, split out from the RPC so it can be tested without one.
 *
 * `marketsLeft` counts down to the FLOOR rather than to zero, because that is
 * where minting actually stops. A wallet sitting exactly on the floor has a
 * balance and no runway at all, and the two numbers have to disagree for the
 * gauge to be worth reading.
 */
export function chainRunway(lamports: number | null): {
  state: ChainHealthState; balanceSol: number | null; marketsLeft: number | null;
} {
  // Unreadable is its own answer. Reporting it as 0 invents an empty wallet and
  // reporting it as healthy hides a real one, and both lie toward money.
  if (lamports === null || !Number.isFinite(lamports)) {
    return { state: "off", balanceSol: null, marketsLeft: null };
  }
  return {
    state: lamports < MIN_LAMPORTS ? "stopped" : lamports < WARN_LAMPORTS ? "low" : "ok",
    balanceSol: lamports / LAMPORTS_PER_SOL,
    marketsLeft: Math.max(0, Math.floor((lamports - MIN_LAMPORTS) / COST_PER_MARKET_LAMPORTS)),
  };
}

let refusedForFunds = 0;
let lastRefusalAt: string | null = null;
let healthCache: { at: number; value: ChainHealth } | null = null;
const HEALTH_TTL_MS = 60_000;

export async function chainHealth(force = false): Promise<ChainHealth> {
  const now = Date.now();
  if (!force && healthCache && now - healthCache.at < HEALTH_TTL_MS) {
    // The counters are live even when the balance is a minute stale: a refusal
    // that happened ten seconds ago must not wait out the cache to be seen.
    return { ...healthCache.value, refusedForFunds, lastRefusalAt };
  }

  const base = {
    costPerMarketSol: COST_PER_MARKET_LAMPORTS / LAMPORTS_PER_SOL,
    floorSol: MIN_LAMPORTS / LAMPORTS_PER_SOL,
    warnSol: WARN_LAMPORTS / LAMPORTS_PER_SOL,
    cluster: CLUSTER,
    refusedForFunds,
    lastRefusalAt,
    checkedAt: new Date(now).toISOString(),
  };

  const c = await load();
  if (!c) {
    const value: ChainHealth = {
      ...base, state: "off", balanceSol: null, marketsLeft: null,
      admin: null, programId: null,
    };
    healthCache = { at: now, value };
    return value;
  }

  let lamports: number | null = null;
  try {
    lamports = await c.connection.getBalance(c.admin.publicKey);
  } catch {
    lamports = null; // unreachable RPC is not the same as an empty wallet
  }

  const value: ChainHealth = {
    ...base,
    ...chainRunway(lamports),
    admin: c.admin.publicKey.toBase58(),
    programId: c.programId.toBase58(),
  };
  healthCache = { at: now, value };
  return value;
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
      // Counted, not just logged. This is the number that turns "the site went
      // quiet" into "the site refused 14 bets since the balance ran out", and
      // it is the only user-visible consequence of an unfunded wallet.
      refusedForFunds++;
      lastRefusalAt = new Date().toISOString();
      console.error(
        `[chain] admin wallet ${c.admin.publicKey.toBase58()} low: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL ` +
          `(< ${(MIN_LAMPORTS / LAMPORTS_PER_SOL).toFixed(2)}). Fund it. Skipping on-chain mint. ` +
          `${refusedForFunds} mint(s) refused for funds so far.`,
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
function listingPda(c: ChainClient, market: InstanceType<typeof c.web3.PublicKey>, seller: InstanceType<typeof c.web3.PublicKey>) {
  return c.web3.PublicKey.findProgramAddressSync([Buffer.from("listing"), market.toBuffer(), seller.toBuffer()], c.programId)[0];
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

/**
 * THE DIFFERENCE BETWEEN "NOTHING IS THERE" AND "WE COULD NOT LOOK".
 *
 * fetchMarketOnChain answered `null` for both, and every caller coalesced that
 * null to zero. So a throttled RPC did not make the site say "we cannot read
 * this right now" -- it made every market on the page advertise an EMPTY POOL,
 * with real money sitting in the vault. Odds computed from it, entry shares
 * computed from it, "be the first to back this" printed under a market holding
 * a hundred stakes. The failure is silent, it looks like data, and it points at
 * money, which is the worst combination the three can make.
 *
 * So the read has three answers now, and callers have to spend one:
 *
 *   · ok         we read it, here is the state
 *   · absent     the account genuinely is not there (a market not yet minted)
 *   · unreadable we do not know, and MUST NOT be rendered as a number
 *
 * `absent` is knowledge. `unreadable` is the absence of knowledge. Collapsing
 * them was the bug.
 */
export type MarketRead =
  | { ok: true; state: OnChainMarketState }
  | { ok: false; reason: "absent" }
  | { ok: false; reason: "unreadable"; error: string };

/** The decode, split from the fetch so both the single and batched reads share
 *  exactly one interpretation of a Market account. */
function decodeMarket(a: Record<string, unknown>): OnChainMarketState {
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
}

/**
 * A few seconds of memory, and ONLY for successful reads.
 *
 * `unreadable` is never cached: it is the state we most want to leave behind,
 * and caching it would extend a blip into a stall. `absent` is never cached
 * either, because a market minted a second ago is absent and then is not, and
 * a cached "no such market" would hide it from the person who just opened it.
 *
 * The cache is OPT-IN per call rather than on by default. Money paths (the
 * entry share a staker is quoted, the pool a bet is priced against) pass
 * nothing and always read fresh; list and feed paints pass a maxAge and accept
 * a few seconds of staleness in exchange for not making one RPC call per row.
 */
const marketCache = new Map<string, { at: number; state: OnChainMarketState }>();
const MARKET_CACHE_MAX = 500;

function cacheGet(pubkey: string, maxAgeMs: number): OnChainMarketState | null {
  if (maxAgeMs <= 0) return null;
  const hit = marketCache.get(pubkey);
  if (!hit || Date.now() - hit.at > maxAgeMs) return null;
  return hit.state;
}

function cachePut(pubkey: string, state: OnChainMarketState): void {
  // Crude bound, not an LRU: this exists so a long-running process cannot grow
  // a map without limit, and the cost of dropping a warm entry is one RPC call.
  if (marketCache.size >= MARKET_CACHE_MAX) marketCache.clear();
  marketCache.set(pubkey, { at: Date.now(), state });
}

/** Drop a market from the read cache. Called after a write we KNOW changed it,
 *  so the next read cannot serve the pre-stake pool back to the staker. */
export function forgetMarket(pubkey: string): void {
  marketCache.delete(pubkey);
}

/**
 * One market, with the three-way answer.
 *
 * `maxAgeMs` defaults to 0: fresh unless a caller explicitly says otherwise.
 * The default has to be the safe one, because the unsafe one is invisible.
 */
export async function readMarket(
  marketPubkey: string, opts: { maxAgeMs?: number } = {},
): Promise<MarketRead> {
  const maxAge = opts.maxAgeMs ?? 0;
  const cached = cacheGet(marketPubkey, maxAge);
  if (cached) return { ok: true, state: cached };

  const c = await load();
  // The chain layer being off is not "this market is empty". It is the same
  // not-knowing as a dead RPC, and it gets the same answer.
  if (!c) return { ok: false, reason: "unreadable", error: "chain layer unavailable" };
  try {
    // The generic `Idl` type this module uses (see the isolation-contract note
    // at the top) has no statically-known account names, only the runtime IDL
    // loaded in `load()` does — same reason `.methods.createMarket(...)` above
    // resolves loosely. `as any` here is that erasure, not an unchecked guess.
    const acct = await (c.program.account as any).market.fetchNullable(new c.web3.PublicKey(marketPubkey));
    if (!acct) return { ok: false, reason: "absent" };
    const state = decodeMarket(acct as Record<string, unknown>);
    cachePut(marketPubkey, state);
    return { ok: true, state };
  } catch (e) {
    const error = (e as Error).message;
    console.error(`[chain] readMarket ${marketPubkey.slice(0, 8)}… unreadable:`, error);
    return { ok: false, reason: "unreadable", error };
  }
}

/**
 * Many markets in as few round trips as the RPC allows.
 *
 * This replaces the N+1 that every list endpoint was doing: one getAccountInfo
 * per row, fired in parallel, which is precisely the shape a public RPC rate
 * limits. Under that limit the old code did not slow down, it started
 * returning nulls, which the callers printed as zeroes. So batching is not a
 * performance nicety here; it is most of the fix for the lie above.
 *
 * Decoding is per-account and individually guarded ON PURPOSE. anchor's own
 * fetchMultiple decodes inside the batch and throws the whole call if a single
 * account fails its discriminator, which is exactly the IDL-drift case this
 * file warns about at the top: one stale account would blank an entire page of
 * healthy markets. Here a bad account is `unreadable` and its neighbours are
 * still `ok`.
 */
export async function readMarkets(
  marketPubkeys: string[], opts: { maxAgeMs?: number } = {},
): Promise<Map<string, MarketRead>> {
  const maxAge = opts.maxAgeMs ?? 0;
  const out = new Map<string, MarketRead>();
  // De-duplicated: the same market can appear twice in one feed page, and
  // asking the RPC about it twice is asking to be throttled.
  const wanted: string[] = [];
  for (const pk of marketPubkeys) {
    if (out.has(pk)) continue;
    const cached = cacheGet(pk, maxAge);
    if (cached) { out.set(pk, { ok: true, state: cached }); continue; }
    if (!wanted.includes(pk)) wanted.push(pk);
  }
  if (wanted.length === 0) return out;

  const c = await load();
  if (!c) {
    for (const pk of wanted) out.set(pk, { ok: false, reason: "unreadable", error: "chain layer unavailable" });
    return out;
  }

  const coder = (c.program.account as any).market.coder;
  const idlName = (c.program.account as any).market._idlAccount?.name ?? "Market";
  const mine = c.programId.toBase58();
  const CHUNK = 99; // getMultipleAccounts caps at 100; 99 matches anchor's own

  for (let i = 0; i < wanted.length; i += CHUNK) {
    const slice = wanted.slice(i, i + CHUNK);
    let infos: Array<{ data: Buffer; owner: { toBase58(): string } } | null>;
    try {
      infos = await c.connection.getMultipleAccountsInfo(slice.map((pk) => new c.web3.PublicKey(pk))) as any;
    } catch (e) {
      // A failed chunk is unreadable for that chunk only. The next chunk still
      // gets its chance rather than the whole page going dark on one blip.
      const error = (e as Error).message;
      console.error(`[chain] readMarkets chunk of ${slice.length} unreadable:`, error);
      for (const pk of slice) out.set(pk, { ok: false, reason: "unreadable", error });
      continue;
    }
    slice.forEach((pk, idx) => {
      const info = infos[idx];
      if (!info) { out.set(pk, { ok: false, reason: "absent" }); return; }
      if (info.owner.toBase58() !== mine) {
        // A PDA of ours is always owned by us, so this is an anomaly rather
        // than an empty market. Refusing to call it zero is the safe direction.
        out.set(pk, { ok: false, reason: "unreadable", error: "account is not owned by our program" });
        return;
      }
      try {
        const state = decodeMarket(coder.accounts.decode(idlName, info.data) as Record<string, unknown>);
        cachePut(pk, state);
        out.set(pk, { ok: true, state });
      } catch (e) {
        const error = (e as Error).message;
        console.error(`[chain] readMarkets decode ${pk.slice(0, 8)}… failed:`, error);
        out.set(pk, { ok: false, reason: "unreadable", error });
      }
    });
  }
  return out;
}

/**
 * The old shape, kept for callers where a missing market and an unreadable one
 * genuinely lead to the same branch (a resolve that will retry, a sweep that
 * skips). Anything that RENDERS A NUMBER must use readMarket instead, because
 * this signature cannot tell the caller which of the two it got.
 */
export async function fetchMarketOnChain(marketPubkey: string): Promise<OnChainMarketState | null> {
  const r = await readMarket(marketPubkey);
  return r.ok ? r.state : null;
}

/**
 * TWO LEGS, NOT A SIDE.
 *
 * A wallet can now hold both sides of a market, so "which side are you on" is
 * no longer a question a position can always answer. `side` and `lamports`
 * survive as DERIVED conveniences for the overwhelmingly common case of one
 * leg, and they are deliberately null and 0 when both are held: a caller that
 * has not thought about the two-sided case gets nothing to print rather than
 * half the truth.
 */
export interface OnChainPosition {
  amountYes: number;
  amountNo: number;
  /** The only side held, or null when both are. */
  side: "yes" | "no" | null;
  /** Everything this wallet has in the market, both legs. */
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
    // EXACTLY ONE instruction of OURS, and every other instruction must be
    // ComputeBudget. `some()` would let a rider through: a Solana transaction
    // carries many instructions, so one harmless call to our program would buy
    // an attacker a free relay for everything else in the same envelope.
    //
    // ComputeBudget is the one passenger allowed, and it is allowed because we
    // now put it there ourselves: without a priority fee a mainnet transaction
    // is dropped under congestion. It can move no money and touch no account,
    // so admitting it costs the guard nothing.
    //
    // LIGHTHOUSE IS THE SECOND PASSENGER, and it is Phantom that puts it there.
    //
    // Phantom augments transactions it signs with Lighthouse guard
    // instructions: assertions that the state after execution matches the
    // preview the user was shown, so a transaction cannot say one thing in the
    // wallet and do another on chain. They can only make a transaction FAIL.
    // Lighthouse asserts and reverts; it cannot move the signer's funds.
    // Program L2TEx… is the same address on devnet and mainnet-beta.
    //
    // Found the hard way, and only after the wall came down. On devnet Phantom
    // refused to simulate against a chain where this program did not exist, so
    // the bet died at the wallet and no Phantom-signed transaction ever reached
    // this relay. The first one that did, minutes after the mainnet deploy, was
    // refused BY US -- "we could not confirm this was an oddie bet" -- for
    // carrying the wallet's own safety instructions. Fixing the outer problem
    // is what exposed this one.
    //
    // Refusing it is not a safe default here: it makes the majority wallet on
    // Solana unable to place a bet at all, while protecting against a program
    // that by construction cannot take anything.
    const mine = c.programId.toBase58();
    const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
    const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
    const PASSENGERS = new Set([COMPUTE_BUDGET, LIGHTHOUSE]);
    const ours = tx.instructions.filter((i) => i.programId.toBase58() === mine);
    const strangers = tx.instructions.filter((i) => {
      const pid = i.programId.toBase58();
      return pid !== mine && !PASSENGERS.has(pid);
    });
    if (ours.length !== 1 || strangers.length > 0) {
      // SAID OUT LOUD. This refusal wrote nothing, anywhere: the user got "we
      // could not confirm this was an oddie bet" and the server log was
      // silent, so the one refusal on the money path that needs diagnosing was
      // the one carrying no evidence. Program ids only -- they are public, and
      // they are the entire question.
      console.error(JSON.stringify({
        evt: "relay_refused", reason: "not-our-program",
        ours: ours.length,
        strangers: strangers.map((i) => i.programId.toBase58()),
      }));
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
    // NOT ENOUGH SOL IS ITS OWN ANSWER, and it must be tested BEFORE the
    // generic one: an underfunded transaction fails simulation, so it used to
    // land in "preflight-failed", whose sentence tells the user the market may
    // have closed. That is a false statement about the market, delivered on
    // the most likely first-timer failure there is, and it sends somebody
    // looking for a problem that was never theirs.
    const code = /insufficient (lamports|funds)|debit an account|prior credit/i.test(m) ? "insufficient-funds"
      : /custom program error|Simulation failed|preflight/i.test(m) ? "preflight-failed"
      : /expired|block height/i.test(m) ? "expired"
      : /Invalid|deserialize|buffer/i.test(m) ? "malformed"
      : "unavailable";
    return { ok: false, error: code, badRequest: code === "malformed" };
  }
}

/** A user's position on a market, or null if they have never staked. */
const decodePosition = (a: Record<string, unknown>): OnChainPosition => {
  const amountYes = Number(a.amountYes ?? 0);
  const amountNo = Number(a.amountNo ?? 0);
  return {
    amountYes,
    amountNo,
    // Null when both legs are held: there is no single side to report, and
    // guessing one would put a wrong word next to somebody's money.
    side: amountYes > 0 && amountNo > 0 ? null : amountYes > 0 ? "yes" : amountNo > 0 ? "no" : null,
    lamports: amountYes + amountNo,
    claimed: Boolean(a.claimed),
  };
};

/**
 * A person's stake in one market, with the same three answers a market read
 * has, and for the same reason.
 *
 * "No position here" and "we could not check" are opposite facts about
 * somebody's own money: the first means nothing is owed, the second means we
 * do not know. Collapsing them is how a page tells a winner they have nothing
 * to collect because an RPC blinked.
 */
export type PositionRead =
  | { ok: true; position: OnChainPosition }
  | { ok: false; reason: "absent" }
  | { ok: false; reason: "unreadable"; error: string };

/**
 * Every position this wallet holds across the given markets, in as few round
 * trips as the RPC allows, keyed by MARKET pubkey.
 *
 * The routes that list what somebody has riding and what they can collect were
 * doing one getAccountInfo per market, and one of them did a second for the
 * market itself, so opening that page fired up to eighty calls. Deriving all
 * the PDAs first and asking once turns it into one.
 *
 * Never cached. A market's pool a few seconds stale is a rounding error on a
 * list; a person's own position a few seconds stale is their money, and the
 * moment it matters most is right after they changed it.
 */
export async function readPositions(
  marketPubkeys: string[], userPubkey: string,
): Promise<Map<string, PositionRead>> {
  const out = new Map<string, PositionRead>();
  const wanted = [...new Set(marketPubkeys)];
  if (wanted.length === 0) return out;

  const c = await load();
  if (!c) {
    for (const pk of wanted) out.set(pk, { ok: false, reason: "unreadable", error: "chain layer unavailable" });
    return out;
  }

  let userPk: InstanceType<typeof c.web3.PublicKey>;
  try {
    userPk = new c.web3.PublicKey(userPubkey);
  } catch {
    // A malformed wallet is the caller's error, not the chain's. Saying
    // "absent" would answer "you hold nothing" to a question we never asked.
    for (const pk of wanted) out.set(pk, { ok: false, reason: "unreadable", error: "invalid userPubkey" });
    return out;
  }

  const coder = (c.program.account as any).position.coder;
  const idlName = (c.program.account as any).position._idlAccount?.name ?? "Position";
  const mine = c.programId.toBase58();
  const CHUNK = 99;

  for (let i = 0; i < wanted.length; i += CHUNK) {
    const slice = wanted.slice(i, i + CHUNK);
    let pdas: Array<InstanceType<typeof c.web3.PublicKey>>;
    try {
      pdas = slice.map((pk) => positionPda(c, new c.web3.PublicKey(pk), userPk));
    } catch (e) {
      const error = (e as Error).message;
      for (const pk of slice) out.set(pk, { ok: false, reason: "unreadable", error });
      continue;
    }
    let infos: Array<{ data: Buffer; owner: { toBase58(): string } } | null>;
    try {
      infos = await c.connection.getMultipleAccountsInfo(pdas) as any;
    } catch (e) {
      const error = (e as Error).message;
      console.error(`[chain] readPositions chunk of ${slice.length} unreadable:`, error);
      for (const pk of slice) out.set(pk, { ok: false, reason: "unreadable", error });
      continue;
    }
    slice.forEach((pk, idx) => {
      const info = infos[idx];
      // No account at the PDA is the real, common answer: this wallet never
      // staked here, or already claimed and closed it.
      if (!info) { out.set(pk, { ok: false, reason: "absent" }); return; }
      if (info.owner.toBase58() !== mine) {
        out.set(pk, { ok: false, reason: "unreadable", error: "account is not owned by our program" });
        return;
      }
      try {
        out.set(pk, { ok: true, position: decodePosition(coder.accounts.decode(idlName, info.data) as Record<string, unknown>) });
      } catch (e) {
        const error = (e as Error).message;
        console.error(`[chain] readPositions decode ${pk.slice(0, 8)}… failed:`, error);
        out.set(pk, { ok: false, reason: "unreadable", error });
      }
    });
  }
  return out;
}

/** The old single-account shape. Same caveat as fetchMarketOnChain: it cannot
 *  tell "no position" from "could not check", so anything that decides what a
 *  person is owed should use readPositions. */
export async function fetchPosition(marketPubkey: string, userPubkey: string): Promise<OnChainPosition | null> {
  const c = await load();
  if (!c) return null;
  try {
    const marketPk = new c.web3.PublicKey(marketPubkey);
    const userPk = new c.web3.PublicKey(userPubkey);
    const acct = await (c.program.account as any).position.fetchNullable(positionPda(c, marketPk, userPk));
    if (!acct) return null;
    return decodePosition(acct as Record<string, unknown>);
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
    return buildUserTx(c, ix, userPk, blockhash);
  } catch (e) {
    console.error("[chain] preparePositionTx failed:", (e as Error).message);
    return null;
  }
}

/**
 * THE SEAT SWAP, in three transactions the user signs themselves.
 *
 * Nothing here touches the vault: the buyer pays the seller directly and the
 * seat changes hands, so `total_yes` and `total_no` do not move and the
 * multiple everybody else is counting on is what it was a block earlier. That
 * is the property that makes this the only exit shape a pari-mutuel can have,
 * and the reason none of these three needs a vault account at all.
 */
export async function prepareListTx(args: {
  marketPubkey: string; sellerPubkey: string; side: "yes" | "no"; lamports: number; expiresAt: number;
}): Promise<string | null> {
  const c = await load();
  if (!c) return null;
  try {
    const marketPk = new c.web3.PublicKey(args.marketPubkey);
    const sellerPk = new c.web3.PublicKey(args.sellerPubkey);
    const ix = await c.program.methods
      .listPosition(args.side === "yes" ? 0 : 1, new c.BN(args.lamports), new c.BN(args.expiresAt))
      .accountsStrict({
        seller: sellerPk, market: marketPk,
        position: positionPda(c, marketPk, sellerPk),
        listing: listingPda(c, marketPk, sellerPk),
        systemProgram: c.web3.SystemProgram.programId,
      })
      .instruction();
    const { blockhash } = await c.connection.getLatestBlockhash("confirmed");
    return buildUserTx(c, ix, sellerPk, blockhash);
  } catch (e) {
    console.error("[chain] prepareListTx failed:", (e as Error).message);
    return null;
  }
}

export async function prepareCancelListingTx(args: {
  marketPubkey: string; sellerPubkey: string;
}): Promise<string | null> {
  const c = await load();
  if (!c) return null;
  try {
    const marketPk = new c.web3.PublicKey(args.marketPubkey);
    const sellerPk = new c.web3.PublicKey(args.sellerPubkey);
    const ix = await c.program.methods
      .cancelListing()
      .accountsStrict({ seller: sellerPk, listing: listingPda(c, marketPk, sellerPk) })
      .instruction();
    const { blockhash } = await c.connection.getLatestBlockhash("confirmed");
    return buildUserTx(c, ix, sellerPk, blockhash);
  } catch (e) {
    console.error("[chain] prepareCancelListingTx failed:", (e as Error).message);
    return null;
  }
}

export async function prepareTakeListingTx(args: {
  marketPubkey: string; sellerPubkey: string; buyerPubkey: string;
}): Promise<string | null> {
  const c = await load();
  if (!c) return null;
  try {
    const marketPk = new c.web3.PublicKey(args.marketPubkey);
    const sellerPk = new c.web3.PublicKey(args.sellerPubkey);
    const buyerPk = new c.web3.PublicKey(args.buyerPubkey);
    const ix = await c.program.methods
      .takeListing()
      .accountsStrict({
        buyer: buyerPk, seller: sellerPk, market: marketPk,
        listing: listingPda(c, marketPk, sellerPk),
        sellerPosition: positionPda(c, marketPk, sellerPk),
        buyerPosition: positionPda(c, marketPk, buyerPk),
        systemProgram: c.web3.SystemProgram.programId,
      })
      .instruction();
    const { blockhash } = await c.connection.getLatestBlockhash("confirmed");
    return buildUserTx(c, ix, buyerPk, blockhash);
  } catch (e) {
    console.error("[chain] prepareTakeListingTx failed:", (e as Error).message);
    return null;
  }
}

export interface SeatForSale {
  seller: string;
  side: "yes" | "no";
  lamports: number;
  expiresAt: number;
}

/**
 * Every seat on sale in one market.
 *
 * EXPIRED LISTINGS ARE FILTERED OUT HERE, not left for the caller. The program
 * refuses them, so showing one is offering a button that cannot work, and the
 * account survives its own expiry because only the seller can close it.
 */
export async function listingsFor(marketPubkey: string): Promise<SeatForSale[]> {
  const c = await load();
  if (!c) return [];
  try {
    const marketPk = new c.web3.PublicKey(marketPubkey);
    const rows = await (c.program.account as any).listing.all([
      { memcmp: { offset: 8, bytes: marketPk.toBase58() } },
    ]);
    const now = Math.floor(Date.now() / 1000);
    return rows
      .map((r: any) => ({
        seller: String(r.account.seller),
        side: Number(r.account.side) === 0 ? ("yes" as const) : ("no" as const),
        lamports: Number(r.account.amount),
        expiresAt: Number(r.account.expiresAt),
      }))
      .filter((l: SeatForSale) => l.expiresAt > now && l.lamports > 0);
  } catch (e) {
    console.error("[chain] listingsFor failed:", (e as Error).message);
    return [];
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
    return buildUserTx(c, ix, userPk, blockhash);
  } catch (e) {
    console.error("[chain] prepareClaimTx failed:", (e as Error).message);
    return null;
  }
}

/**
 * THE USER'S OWN EXIT from a market nobody ever settled.
 *
 * Resolution here is MANUAL, so a market that never gets resolved is not an
 * exotic edge case: it is what happens whenever the operator is asleep, busy,
 * or gone. Without this the staker's money has no door at all, and "we will
 * settle it eventually" is not a property anyone should have to trust.
 *
 * The program makes it permissionless on purpose: the OWNER signs for
 * themselves, the authority is not involved, and it opens
 * REFUND_AFTER_CLOSE_SECS (30 days) after close_time. It returns the full
 * stake and, because the Position carries `close = owner`, the rent too.
 *
 * Guarded server-side before it hands out anything signable, same rule the
 * claim route learned the hard way: a prepare route that skips its checks
 * returns HTTP 200 and a guaranteed-revert transaction, which is worse than a
 * refusal because the wallet is the one that looks broken.
 */
/**
 * THE PRIORITY FEE, and why every transaction this file builds now carries one.
 *
 * Devnet has no fee market, so a bare zero-fee transaction always landed and
 * this was invisible. Mainnet deprioritises zero-fee transactions under
 * congestion and simply drops them; the user's wallet signs, the bytes go out,
 * and nothing ever happens. That failure is also the WORST one we have, because
 * submitSignedTx reports a dropped transaction as ok:true, confirmed:false,
 * which the client renders as "Sent".
 *
 * Price is per compute unit in micro-lamports and the default is deliberately
 * small: at the default 200k CU allocation, 10_000 micro-lamports is 2_000
 * lamports, i.e. 0.000002 SOL. Enough to clear the ordinary queue, nowhere near
 * enough to matter next to a bet. Tunable without a deploy for the day the
 * network is genuinely busy.
 */
const PRIORITY_MICRO_LAMPORTS = Math.max(0, Number(process.env.SOLANA_PRIORITY_MICRO_LAMPORTS ?? 10_000));

/** The one place a user-signed transaction is assembled, so the fee can never
 *  be added to two of the three paths and forgotten on the third. */
function buildUserTx(c: Awaited<ReturnType<typeof load>>, ix: unknown, feePayer: unknown, blockhash: string) {
  const chain = c as NonNullable<typeof c>;
  const tx = new chain.web3.Transaction({ feePayer: feePayer as never, recentBlockhash: blockhash });
  if (PRIORITY_MICRO_LAMPORTS > 0) {
    tx.add(chain.web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICRO_LAMPORTS }));
  }
  tx.add(ix as never);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

export async function prepareRefundTx(args: { marketPubkey: string; userPubkey: string }): Promise<string | null> {
  const c = await load();
  if (!c) return null;
  try {
    const marketPk = new c.web3.PublicKey(args.marketPubkey);
    const userPk = new c.web3.PublicKey(args.userPubkey);
    const ix = await c.program.methods
      .refundAfterDeadline()
      // accountsStrict resolves NOTHING for you: every account the program
      // declares has to be listed, system_program included. It was missing
      // here, so this builder threw "Account `systemProgram` not provided" on
      // every call and the refund route answered 502 from the day it shipped.
      // Found by simulating one on devnet; pinned by test-accounts-strict.
      .accountsStrict({
        owner: userPk, market: marketPk, vault: vaultPda(c, marketPk), position: positionPda(c, marketPk, userPk),
        systemProgram: c.web3.SystemProgram.programId,
      })
      .instruction();
    const { blockhash } = await c.connection.getLatestBlockhash("confirmed");
    return buildUserTx(c, ix, userPk, blockhash);
  } catch (e) {
    console.error("[chain] prepareRefundTx failed:", (e as Error).message);
    return null;
  }
}

/** When a market's refund window opens: close_time + 30 days, as a unix time.
 *  Mirrors REFUND_AFTER_CLOSE_SECS in the program; if that constant ever moves,
 *  this moves with it or the UI starts promising the wrong date. */
export const REFUND_AFTER_CLOSE_SECS = 30 * 24 * 60 * 60;
export function refundOpensAt(closeTimeUnix: number): number {
  return closeTimeUnix + REFUND_AFTER_CLOSE_SECS;
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
    return buildUserTx(c, ix, creatorPk, blockhash);
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
    // Find OUR instruction rather than assuming index 0: the envelope now
    // carries a ComputeBudget instruction in front of it. Assuming the old
    // position here would have returned null for every stake, which silently
    // kills the entry-odds stamp AND the Genesis new-bettor credit, with no
    // error anywhere.
    const programId = (await programIdString()) ?? "";
    const ix = tx.instructions.find((i) => i.programId.toBase58() === programId);
    if (!ix) return null;
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
