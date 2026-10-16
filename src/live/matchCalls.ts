/**
 * What every match call does the same way, whoever saw the match: the FACEIT
 * pass (src/live/gameCalls.ts), the game itself (src/live/gsiCalls.ts), the
 * picture (src/live/frameCalls.ts). Opened under the stream name and keyed by
 * the match, settled from a winner with the score said, handed to the mods
 * once when nobody can read the result, canceled when the next match overran
 * it. The chat lines are GAME_COPY's; the standings are the same standings.
 *
 * The readers keep their own small state and decide WHEN; this file is only
 * WHAT, so a match call looks the same in the room whichever way it was seen.
 */
import { scoreTextFrom } from "../games/faceit.js";
import { CALL_OPEN_MAX_MS, LIVE_COPY, pointsFor, type LiveCall, type LiveDeps, type Platform } from "./calls.js";
import { GAME_COPY, matchQuestion } from "./gameCalls.js";

export interface MatchChannel { platform: Platform; channelId: string; slug: string; name: string | null }

export async function sayQuiet(deps: LiveDeps, m: { platform: Platform; channelId: string }, text: string): Promise<string | null> {
  try { const id = await deps.say(m.platform, m.channelId, text); return typeof id === "string" && id ? id : null; }
  catch (e) { deps.log("live chat line not delivered", { err: (e as Error).message }); return null; }
}

/** The channel's unsettled call about this match: by the id the reader kept, or by the match key. */
export async function matchCall(deps: LiveDeps, ch: { platform: Platform; channelId: string }, key: string, callId: string | null): Promise<LiveCall | null> {
  const open = await deps.store.unsettled(ch.platform, ch.channelId).catch(() => [] as LiveCall[]);
  return open.find((c) => (callId && c.id === callId) || c.matchId === key) ?? null;
}

export type OpenOutcome = { call: LiveCall } | "off-stream" | "room-busy" | "not-opened";

/** Opens the match's call under the stream name, says so, pins it where it can. */
export async function openMatchCall(deps: LiveDeps, ch: MatchChannel, key: string, map: string | null, now: number, extra: Record<string, unknown> = {}): Promise<OpenOutcome> {
  const name = ch.name || ch.slug;
  // No calls for a channel that is not streaming: the match is real, the room is not there.
  const live = deps.streamLive ? await deps.streamLive(ch.platform, ch.channelId).catch(() => null) : null;
  if (live === false) { deps.log("live match seen off stream, no call", { platform: ch.platform, channel: ch.channelId, ...extra }); return "off-stream"; }
  if (await deps.store.current(ch.platform, ch.channelId).catch(() => null)) {
    deps.log("live match call waits, the room has a call open", { platform: ch.platform, channel: ch.channelId, match: key });
    return "room-busy";
  }
  const opened = await deps.store.open({
    platform: ch.platform, channelId: ch.channelId, question: matchQuestion(name, map),
    openedById: "oddie", openedByName: "oddie", openedAt: now, closesAt: now + CALL_OPEN_MAX_MS, timed: false, matchId: key,
  });
  if (!opened) return "not-opened"; // already opened for this match, by this clock a moment ago or by another instance
  const id = await sayQuiet(deps, ch, GAME_COPY.opened(name, map, await deps.standingsUrl(ch.platform, ch.channelId)));
  if (id && deps.pin) await deps.pin(ch.platform, ch.channelId, id).catch(() => {});
  deps.log("live match call opened", { platform: ch.platform, channel: ch.channelId, id: opened.id, match: key, map, ...extra });
  return { call: opened };
}

/** Settles the call from the streamer's result, and says the score from their side. */
export async function settleMatchCall(deps: LiveDeps, ch: MatchChannel, call: LiveCall, won: boolean, score: { mine: number; theirs: number } | null, map: string | null, by: string, now: number): Promise<boolean> {
  const side = won ? "yes" : "no";
  const tally = await deps.store.tally(call.id);
  const done = await deps.store.settle(call.id, side, pointsFor(tally, side), now);
  if (!done) return false;
  const url = await deps.standingsUrl(ch.platform, ch.channelId);
  await sayQuiet(deps, ch, `${GAME_COPY.result(ch.name || ch.slug, won, scoreTextFrom(score), map)} ${LIVE_COPY.settled(call.question, side, done.right, done.total, done.top, url, done.names)}`);
  deps.log("live call settled", { platform: ch.platform, channel: ch.channelId, id: call.id, outcome: side, right: done.right, total: done.total, by });
  return true;
}

/** A result nobody could read: the mods settle it, said once. */
export async function handToMods(deps: LiveDeps, ch: MatchChannel, call: LiveCall, key: string, now: number): Promise<boolean> {
  if (!(await deps.store.lock(call.id, now).catch(() => false))) return false;
  await sayQuiet(deps, ch, GAME_COPY.unreadable(call.question));
  deps.log("live match call handed to mods", { platform: ch.platform, channel: ch.channelId, id: call.id, match: key });
  return true;
}

/** A match that ended without a result before the next one started: canceled, said. */
export async function abandonMatchCall(deps: LiveDeps, ch: MatchChannel, call: LiveCall, key: string, now: number): Promise<boolean> {
  if (!(await deps.store.cancel(call.id, now).catch(() => false))) return false;
  await sayQuiet(deps, ch, GAME_COPY.abandoned(call.question));
  deps.log("live match call abandoned", { platform: ch.platform, channel: ch.channelId, id: call.id, match: key });
  return true;
}
