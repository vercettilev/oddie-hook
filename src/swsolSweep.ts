/**
 * A LONG MARKET'S IDLE SOL EARNS WHILE IT WAITS, AND IS HOME BEFORE THE END.
 *
 * A market's pool sits in its vault from the first stake to the verdict, and on
 * a market that runs for weeks that is weeks of staking rewards nobody gets.
 * This decides, market by market, what each vault does on this pass: park its
 * idle SOL in Sanctum's swSOL, bring home what it parked, or nothing. The moves
 * themselves are park_swsol and unpark_swsol in the program, which pin every
 * account and let the SOL go nowhere but the pool and back to the vault.
 *
 * Bringing SOL home ALWAYS runs. Parking runs only when SWSOL_PARK_ENABLED is
 * on, so switching parking off can never strand what an earlier pass parked.
 *
 * The verdict unparks too (resolveMarketOnChain puts the unpark in front of the
 * resolve, in one transaction), but a market that settles on that transaction
 * alone has one chance; coming home a day before the close gives it about
 * fifty passes to find Sanctum's liquid reserve.
 */
export const DAY_MS = 86_400_000;
/** Parking starts only with a week or more to go. */
export const PARK_MIN_LEFT_MS = 7 * DAY_MS;
/** Everything parked is unparked once the close is this near, or the market is settled. */
export const UNPARK_BEFORE_CLOSE_MS = DAY_MS;
/** A market's first park creates its swSOL account, about 0.0015 SOL of rent
 *  that stays with the vault for good. At roughly 7% a year a pool earns that
 *  back in about 8 SOL-days, so a smaller park would cost us more than it
 *  earns anybody. */
export const MIN_PARK_SOL_DAYS = 8;
/** Minting markets comes first: below this the admin wallet parks nothing. */
export const ADMIN_FLOOR_LAMPORTS = 50_000_000;
/** What one park can cost the admin wallet at most: the swSOL account's rent
 *  plus fees, rounded up. Spent from the floor check within one pass. */
export const PARK_COST_LAMPORTS = 2_500_000;

export interface VaultView {
  /** Settled on chain, or by us and the chain has not caught up. */
  resolved: boolean;
  /** The program's close time; ours in the database can differ from it. */
  closeTimeMs: number;
  /** SOL in the vault above its rent. */
  idleLamports: number;
  /** SOL the vault holds as swSOL. */
  parkedLamports: number;
}

export type SwsolAction = { kind: "park" | "unpark"; lamports: number } | null;

export function swsolAction(
  v: VaultView, now: number, opts: { parkEnabled: boolean; adminLamports: number | null },
): SwsolAction {
  const left = v.closeTimeMs - now;
  if (v.resolved || left <= UNPARK_BEFORE_CLOSE_MS) {
    return v.parkedLamports > 0 ? { kind: "unpark", lamports: v.parkedLamports } : null;
  }
  if (!opts.parkEnabled || left < PARK_MIN_LEFT_MS) return null;
  if (opts.adminLamports === null || opts.adminLamports < ADMIN_FLOOR_LAMPORTS) return null;
  if ((v.idleLamports / 1e9) * (left / DAY_MS) < MIN_PARK_SOL_DAYS) return null;
  return { kind: "park", lamports: v.idleLamports };
}

export interface SwsolCandidate {
  slug: string;
  onchainPubkey: string | null;
  resolvedOutcome: string | null;
  retiredAt: string | null;
}

export type SwsolMoveResult = { ok: true; signature: string } | { ok: false; error: string };

export interface SwsolDeps {
  list(): Promise<SwsolCandidate[]>;
  /** The program's view of each market; null when it could not be read. */
  markets(pubkeys: string[]): Promise<Map<string, { resolved: boolean; closeTime: number } | null>>;
  /** What each vault holds; null when it could not be read. */
  holdings(pubkeys: string[]): Promise<Map<string, { solLamports: number; swsolLamports: number } | null>>;
  adminLamports(): Promise<number | null>;
  park(pubkey: string, lamports: number): Promise<SwsolMoveResult>;
  unpark(pubkey: string, lamports: number): Promise<SwsolMoveResult>;
  parkEnabled: boolean;
  now(): number;
}

export interface SwsolMoveLog {
  slug: string;
  market: string;
  action: "park" | "unpark";
  lamports: number;
  signature?: string;
  error?: string;
}

export async function sweepSwsol(d: SwsolDeps): Promise<{ moved: SwsolMoveLog[]; failed: SwsolMoveLog[] }> {
  const rows = (await d.list()).filter((r): r is SwsolCandidate & { onchainPubkey: string } => Boolean(r.onchainPubkey));
  const moved: SwsolMoveLog[] = [];
  const failed: SwsolMoveLog[] = [];
  if (rows.length === 0) return { moved, failed };
  const pubkeys = rows.map((r) => r.onchainPubkey);
  const [markets, holdings, admin] = await Promise.all([d.markets(pubkeys), d.holdings(pubkeys), d.adminLamports()]);
  let adminLeft = admin;
  const now = d.now();
  for (const r of rows) {
    const m = markets.get(r.onchainPubkey);
    const h = holdings.get(r.onchainPubkey);
    if (!m || !h) continue; // unreadable: nothing is decided on a guess
    const action = swsolAction(
      {
        resolved: m.resolved || r.resolvedOutcome !== null,
        closeTimeMs: m.closeTime * 1000,
        idleLamports: h.solLamports,
        parkedLamports: h.swsolLamports,
      },
      now,
      // A retired market only ever brings SOL home.
      { parkEnabled: d.parkEnabled && !r.retiredAt, adminLamports: adminLeft },
    );
    if (!action) continue;
    const res = action.kind === "park"
      ? await d.park(r.onchainPubkey, action.lamports).catch((e): SwsolMoveResult => ({ ok: false, error: (e as Error).message }))
      : await d.unpark(r.onchainPubkey, action.lamports).catch((e): SwsolMoveResult => ({ ok: false, error: (e as Error).message }));
    const entry: SwsolMoveLog = { slug: r.slug, market: r.onchainPubkey, action: action.kind, lamports: action.lamports };
    if (res.ok) moved.push({ ...entry, signature: res.signature });
    else failed.push({ ...entry, error: res.error });
    if (action.kind === "park" && adminLeft !== null) adminLeft -= PARK_COST_LAMPORTS;
  }
  return { moved, failed };
}
