/**
 * Match calls from the game itself (src/games/gsi.ts): the streamer's CS2 or
 * Dota 2 POSTs its state here, and oddie opens the match call when the match
 * goes live and settles it when the game says it is over.
 *
 * Everything a FACEIT match call is (src/live/gameCalls.ts), with the game as
 * the source: the same question, the same lines, the same standings. The
 * game talks several times a second while a round is live, so this acts only
 * on transitions and keeps one small state per channel in memory: which
 * match is on, and which call is about it. A restart loses that state and
 * finds the call again by its match id in the store.
 *
 * A channel whose game is talking (a snapshot in the last two minutes) is
 * left alone by the FACEIT pass, so a match is never called twice.
 */
import { bodyToken, readSnapshot, type GsiSnapshot } from "../games/gsi.js";
import { scoreTextFrom } from "../games/faceit.js";
import { CALL_OPEN_MAX_MS, LIVE_COPY, pointsFor, type LiveCall, type LiveDeps, type Platform } from "./calls.js";
import { GAME_COPY, GSI_STALE_MS, matchQuestion } from "./gameCalls.js";
/** How often a talking game's "seen" mark is written. */
const SEEN_EVERY_MS = 30_000;

export type GsiOutcome = "unknown-token" | "bad-token" | "not-a-game" | "nothing" | "opened" | "settled" | "to-mods" | "abandoned";

interface MatchState { key: string; map: string | null; opened: boolean; callId: string | null; phase: string }
const matches = new Map<string, MatchState>();
const seenAt = new Map<string, number>();
/** Test seam. */
export function _resetGsi(): void { matches.clear(); seenAt.clear(); }

const chKey = (p: Platform, c: string) => `${p}:${c}`;

async function sayQuiet(deps: LiveDeps, m: { platform: Platform; channelId: string }, text: string): Promise<string | null> {
  try { const id = await deps.say(m.platform, m.channelId, text); return typeof id === "string" && id ? id : null; }
  catch (e) { deps.log("live chat line not delivered", { err: (e as Error).message }); return null; }
}

/** The channel's unsettled call about this match, by id or by match key. */
async function callFor(deps: LiveDeps, ch: { platform: Platform; channelId: string }, state: MatchState): Promise<LiveCall | null> {
  const open = await deps.store.unsettled(ch.platform, ch.channelId).catch(() => [] as LiveCall[]);
  return open.find((c) => (state.callId && c.id === state.callId) || c.matchId === state.key) ?? null;
}

/** A match ended without the game saying so: the next one started. */
async function abandon(deps: LiveDeps, ch: { platform: Platform; channelId: string }, state: MatchState): Promise<boolean> {
  const call = await callFor(deps, ch, state);
  if (!call || !(await deps.store.cancel(call.id, deps.now()).catch(() => false))) return false;
  await sayQuiet(deps, ch, GAME_COPY.abandoned(call.question));
  deps.log("live match call abandoned", { platform: ch.platform, channel: ch.channelId, id: call.id, match: state.key });
  return true;
}

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
  const name = ch.name || ch.slug;
  const state = matches.get(k) ?? null;

  /* A NEW MATCH: live, and nothing on, or a different map, or the one that
     was on is over. Dota names its match; CS2 does not, so the key is the
     moment it went live. */
  const newMatch = snap.phase === "live" && (!state || state.phase === "over" || (snap.matchId ? state.key !== `gsi:${snap.game}:${snap.matchId}` : snap.map !== state.map));
  if (newMatch) {
    if (state && state.phase !== "over" && state.opened) await abandon(deps, ch, state).catch(() => false);
    const key = snap.matchId ? `gsi:${snap.game}:${snap.matchId}` : `gsi:${snap.game}:${snap.steamId ?? "?"}:${snap.map ?? "?"}:${now}`;
    const next: MatchState = { key, map: snap.map, opened: false, callId: null, phase: "live" };
    matches.set(k, next);
    // No calls for a channel that is not streaming: the match is real, the room is not there.
    const live = deps.streamLive ? await deps.streamLive(ch.platform, ch.channelId).catch(() => null) : null;
    if (live === false) { deps.log("live match seen off stream, no call", { platform: ch.platform, channel: ch.channelId, game: snap.game }); return "nothing"; }
    if (await deps.store.current(ch.platform, ch.channelId).catch(() => null)) {
      deps.log("live match call waits, the room has a call open", { platform: ch.platform, channel: ch.channelId, match: key });
      return "nothing";
    }
    const opened = await deps.store.open({
      platform: ch.platform, channelId: ch.channelId, question: matchQuestion(name, snap.map),
      openedById: "oddie", openedByName: "oddie", openedAt: now, closesAt: now + CALL_OPEN_MAX_MS, timed: false, matchId: key,
    });
    if (!opened) return "nothing";
    next.opened = true; next.callId = opened.id;
    const id = await sayQuiet(deps, ch, GAME_COPY.opened(name, snap.map, await deps.standingsUrl(ch.platform, ch.channelId)));
    if (id && deps.pin) await deps.pin(ch.platform, ch.channelId, id).catch(() => {});
    deps.log("live match call opened", { platform: ch.platform, channel: ch.channelId, id: opened.id, match: key, game: snap.game, map: snap.map });
    return "opened";
  }

  if (snap.phase === "over" && state && state.phase !== "over") {
    state.phase = "over";
    const call = await callFor(deps, ch, state);
    if (!call) return "nothing";
    if (snap.won === null) {
      // A draw, or an end the game did not score: the mods settle it, said once.
      if (!(await deps.store.lock(call.id, now).catch(() => false))) return "nothing";
      await sayQuiet(deps, ch, GAME_COPY.unreadable(call.question));
      deps.log("live match call handed to mods", { platform: ch.platform, channel: ch.channelId, id: call.id, match: state.key });
      return "to-mods";
    }
    const side = snap.won ? "yes" : "no";
    const tally = await deps.store.tally(call.id);
    const done = await deps.store.settle(call.id, side, pointsFor(tally, side), now);
    if (!done) return "nothing";
    const url = await deps.standingsUrl(ch.platform, ch.channelId);
    await sayQuiet(deps, ch, `${GAME_COPY.result(name, snap.won, scoreTextFrom(snap.score), snap.map)} ${LIVE_COPY.settled(call.question, side, done.right, done.total, done.top, url)}`);
    deps.log("live call settled", { platform: ch.platform, channel: ch.channelId, id: call.id, outcome: side, right: done.right, total: done.total, by: snap.game });
    return "settled";
  }

  if (state && snap.phase !== "over") state.phase = snap.phase;
  return "nothing";
}

/** Whether this channel's game has talked lately: the FACEIT pass steps aside. */
export function gsiTalking(seen: number | null | undefined, now: number): boolean {
  return seen != null && now - seen < GSI_STALE_MS;
}

export type { GsiSnapshot };
