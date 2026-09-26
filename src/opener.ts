/**
 * Which open markets really pay a wallet its opener's cut.
 *
 * A market names its opener in one of two places: on its row, when the wallet
 * was known before the mint, or on chain, when it was named afterwards. The
 * store hands back both kinds as candidates and this decides, so the rule has
 * one home and a test.
 */
import type { MarketRead } from "./chain/oddieChain.js";

export interface OpenerCandidate {
  slug: string;
  question: string;
  closesAt: string | null;
  feeBps: number;
  onchainPubkey: string | null;
  /** The row itself names this wallet. */
  named: boolean;
}

export function marketsPaying(
  wallet: string, cands: readonly OpenerCandidate[], states: ReadonlyMap<string, MarketRead>,
): OpenerCandidate[] {
  return cands.filter((c) => {
    if (c.named) return true;
    // Only a successful read that names this exact wallet counts. An
    // unreadable account is left out rather than guessed at: this list tells
    // somebody a market is theirs.
    const r = c.onchainPubkey ? states.get(c.onchainPubkey) : undefined;
    return Boolean(r && r.ok && r.state.creator === wallet);
  });
}
