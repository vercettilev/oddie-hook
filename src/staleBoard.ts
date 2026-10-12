/**
 * A MARKET NOBODY PUT MONEY IN AND NOBODY SETTLED LEAVES THE BOARD ON ITS OWN.
 *
 * The oracle settles markets with something to pay out. One that closed with
 * nothing in it never gets a verdict, so it stayed on the board forever, past
 * its close and open to nothing: on 12 Oct nine of them, closed between 27 Sep
 * and 9 Oct, sat under every live market (Lev: "temizleyelim").
 *
 * Two days after its close, a market that is still unsettled and whose vault
 * holds nothing is retired: the same act and the same guard as
 * scripts/retire-board.ts, which is retireMarket's own. An unminted market has
 * no vault and nothing at risk; a minted one is read from the chain, and a
 * vault that cannot be read is a refusal, never a zero. Two days leaves the
 * oracle and the operator their window for a market that did take money.
 *
 * Retired is undiscoverable, not gone: the permalink and the detail still
 * load, and anyone's positions still list it.
 */
export const STALE_AFTER_MS = 48 * 3600_000;

export interface StaleCandidate {
  slug: string;
  closesAt: string | null;
  resolvedOutcome: string | null;
  retiredAt: string | null;
  onchainPubkey: string | null;
}

export interface StaleDeps {
  list(): Promise<StaleCandidate[]>;
  /** Lamports staked in the market's vault; null when it cannot be read. */
  vault(onchainPubkey: string): Promise<number | null>;
  retire(slug: string, vaultLamports: number | null): Promise<{ ok: boolean; reason?: string }>;
  now(): number;
}

export async function retireStaleMarkets(deps: StaleDeps): Promise<{ retired: string[]; refused: Array<{ slug: string; reason: string }> }> {
  const now = deps.now();
  const stale = (await deps.list()).filter((m) =>
    !m.resolvedOutcome && !m.retiredAt && m.closesAt !== null && Date.parse(m.closesAt) + STALE_AFTER_MS <= now);
  const retired: string[] = [];
  const refused: Array<{ slug: string; reason: string }> = [];
  for (const m of stale) {
    const vault = m.onchainPubkey ? await deps.vault(m.onchainPubkey).catch(() => null) : 0;
    const out = await deps.retire(m.slug, vault).catch((e) => ({ ok: false, reason: (e as Error).message }));
    if (out.ok) retired.push(m.slug);
    else refused.push({ slug: m.slug, reason: out.reason ?? "refused" });
  }
  return { retired, refused };
}
