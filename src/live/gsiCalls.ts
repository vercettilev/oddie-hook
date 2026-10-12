/**
 * Match calls from the game itself (src/games/gsi.ts): the streamer's CS2 or
 * Dota 2 POSTs its state here, and oddie opens the match call when the match
 * goes live and settles it when the game says it is over.
 *
 * Everything a FACEIT match call is (src/live/gameCalls.ts), with the game as
 * the source: the same question, the same lines, the same standings
 * (src/live/matchCalls.ts). The game talks several times a second while a
 * round is live, so this acts only on transitions and keeps one small state
 * per channel in memory: which match is on, and which call is about it. A
 * restart loses that state and finds the call again by its match id in the
 * store.
 *
 * A channel whose game is talking (a snapshot in the last two minutes) is
 * left alone by the FACEIT pass and by the picture pass, so a match is never
 * called twice.
 */
import { bodyToken, readSnapshot, type GsiSnapshot } from "../games/gsi.js";
import type { LiveDeps, Platform } from "./calls.js";
import { GSI_STALE_MS } from "./gameCalls.js";
import { abandonMatchCall, handToMods, matchCall, openMatchCall, settleMatchCall } from "./matchCalls.js";
/** How often a talking game's "seen" mark is written. */
const SEEN_EVERY_MS = 30_000;

export type GsiOutcome = "unknown-token" | "bad-token" | "not-a-game" | "nothing" | "opened" | "settled" | "to-mods" | "abandoned";

interface MatchState { key: string; map: string | null; opened: boolean; callId: string | null; phase: string }
const matches = new Map<string, MatchState>();
const seenAt = new Map<string, number>();
/** Test seam. */
export function _resetGsi(): void { matches.clear(); seenAt.clear(); }

const chKey = (p: Platform, c: string) => `${p}:${c}`;

export async function handleGsi(token: string, body: unknown, deps: LiveDeps): Promise<GsiOutcome> {
  const ch = await deps.store.channelByGsiToken(token).catch(() => null);
  if (!ch) return "unknown-token";
  if (bodyToken(body) !== token) return "bad-token";
  const now = deps.now();
  const k = chKey(ch.platform, ch.channelId);
  if (now - (seenAt.get(k) ?? 0) >= SEEN_EVERY_MS) {
    seenAt.set(k, now);
    await deps.store.markGsiSeen(ch.platform, ch.channelId, now).catch(() => {});
  }
  const snap = readSnapshot(body);
  if (!snap) return "not-a-game";
  const state = matches.get(k) ?? null;

  /* A NEW MATCH: live, and nothing on, or a different map, or the one that
     was on is over. Dota names its match; CS2 does not, so the key is the
     moment it went live. */
  const newMatch = snap.phase === "live" && (!state || state.phase === "over" || (snap.matchId ? state.key !== `gsi:${snap.game}:${snap.matchId}` : snap.map !== state.map));
  if (newMatch) {
    if (state && state.phase !== "over" && state.opened) {
      // A match ended without the game saying so: the next one started.
      const old = await matchCall(deps, ch, state.key, state.callId).catch(() => null);
      if (old) await abandonMatchCall(deps, ch, old, state.key, now).catch(() => false);
    }
    const key = snap.matchId ? `gsi:${snap.game}:${snap.matchId}` : `gsi:${snap.game}:${snap.steamId ?? "?"}:${snap.map ?? "?"}:${now}`;
    const next: MatchState = { key, map: snap.map, opened: false, callId: null, phase: "live" };
    matches.set(k, next);
    const o = await openMatchCall(deps, ch, key, snap.map, now, { game: snap.game });
    if (typeof o !== "object") return "nothing";
    next.opened = true; next.callId = o.call.id;
    return "opened";
  }

  if (snap.phase === "over" && state && state.phase !== "over") {
    state.phase = "over";
    const call = await matchCall(deps, ch, state.key, state.callId);
    if (!call) return "nothing";
    // A draw, or an end the game did not score: the mods settle it, said once.
    if (snap.won === null) return (await handToMods(deps, ch, call, state.key, now)) ? "to-mods" : "nothing";
    return (await settleMatchCall(deps, ch, call, snap.won, snap.score, snap.map, snap.game, now)) ? "settled" : "nothing";
  }

  if (state && snap.phase !== "over") state.phase = snap.phase;
  return "nothing";
}

/** Whether this channel's game has talked lately: the other readers step aside. */
export function gsiTalking(seen: number | null | undefined, now: number): boolean {
  return seen != null && now - seen < GSI_STALE_MS;
}

export type { GsiSnapshot };
