/**
 * THE CALL READ OFF THE PICTURE (src/games/frames.ts): for a channel live in
 * Counter-Strike or Dota 2, one frame of the stream every so often. A match
 * on screen opens the call; the end screen settles it. Nothing to link,
 * nothing to install, nothing to type: the stream is the source.
 *
 * WHEN THE PICTURE IS LOOKED AT. Once a minute while the channel idles in the
 * category (menu, lobby, warmup), once a minute through a match, every twenty
 * seconds from match point so the end screen is not missed (it stays up for
 * about half a minute). Every five minutes for a channel that is off or in
 * another category. Never for a channel whose game is talking (GSI), whose
 * FACEIT account is read by the game pass, or that said !matches off. At
 * most a few channels a tick, so a slow stream never holds the clock.
 *
 * HOW A MATCH ENDS HERE. The end screen says win or loss: that settles it. A
 * tie goes to the mods. A match that leaves the screen without an end screen
 * (the streamer tabbed out, the stream dropped, the next match began) ends by
 * its last score when a side reached the win and the streamer's side was
 * read; otherwise, after five minutes unseen, it is the mods', said once, and
 * when the next match overran it, it is canceled like any match without a
 * result. The scoreboard that lingers after an end is not a new match: a new
 * one has a smaller score or another map.
 *
 * The two score columns are the two sides of the HUD, and they swap at the
 * half: a reading of 5:7 after 7:5 is the same match. The streamer's side is
 * whatever the picture last said, and the end screen is believed over it.
 */
import { faceitConfigured } from "../games/faceit.js";
import type { FrameGame, FrameReading, FrameSource } from "../games/frames.js";
import { personFixOutage } from "../inference.js";
import type { LiveDeps, Platform } from "./calls.js";
import { GSI_STALE_MS } from "./gameCalls.js";
import { abandonMatchCall, handToMods, matchCall, openMatchCall, settleMatchCall, type MatchChannel } from "./matchCalls.js";

/** How often the picture is looked at: idling in the category, in a match, from match point. */
export const FRAME_IDLE_MS = 60_000;
export const FRAME_MATCH_MS = 60_000;
export const FRAME_POINT_MS = 20_000;
/** A channel off stream, in another category, or read some other way is asked again after this long. */
export const FRAME_OFF_MS = 5 * 60_000;
/** A match not seen for this long is over, one way or another. */
export const FRAME_GONE_MS = 5 * 60_000;
/** A reader outage only a person can fix (src/inference.ts) pauses every channel for this long. */
export const FRAME_OUTAGE_MS = 10 * 60_000;
/** How long a stream's playlist is reused before a fresh one is asked for. */
export const PLAYLIST_TTL_MS = 10 * 60_000;
/** How many channels one tick of the clock reads at most. */
export const FRAMES_PER_PASS = 4;
/** How long the final scoreboard may linger on screen after an end before a HUD is the next match. */
export const LINGER_MS = 3 * 60_000;
/** CS2: the score that wins a map, and the one from which the end is near. */
export const WIN_AT = 13;
export const MATCH_POINT = 12;

export type Score = { left: number; right: number };
export type HudSide = "left" | "right";

export interface FrameMatch {
  key: string; game: FrameGame; map: string | null;
  callId: string | null; opened: boolean;
  score: Score | null; side: HudSide | null;
  /** When the match was last on screen, and when it ended here. */
  seenAt: number; endedAt: number | null;
  phase: "live" | "over";
}
interface Watch { nextAt: number; playlist: { url: string; until: number } | null; match: FrameMatch | null }
const watches = new Map<string, Watch>();
let outageUntil = 0;
/** Test seam. */
export function _resetFrames(): void { watches.clear(); outageUntil = 0; }
/** Test seam: the match a channel is watching. */
export function _frameMatch(platform: Platform, channelId: string): FrameMatch | null { return watches.get(`${platform}:${channelId}`)?.match ?? null; }

export type FrameOutcome = "off" | "idle" | "opened" | "waiting" | "match" | "settled" | "to-mods" | "abandoned" | "unread";

/** Which game a category is: Twitch's "Counter-Strike", Kick's "Counter-Strike 2", either's "Dota 2". */
export function gameOf(category: string | null | undefined): FrameGame | null {
  if (!category) return null;
  if (/counter[\s-]*strike/i.test(category)) return "cs2";
  if (/\bdota\b/i.test(category)) return "dota2";
  return null;
}

/** The score from the streamer's side, when their side is known. */
export function mineOf(score: Score | null, side: HudSide | null): { mine: number; theirs: number } | null {
  if (!score || !side) return null;
  return side === "left" ? { mine: score.left, theirs: score.right } : { mine: score.right, theirs: score.left };
}

/** CS2: the side the score says has won the map, when it says. A map ends at
 *  thirteen unless both reached twelve, when it goes on; so thirteen against
 *  twelve is not an end this reader can call, nor is any overtime. */
export function decidedSide(game: FrameGame, score: Score | null): HudSide | null {
  if (game !== "cs2" || !score) return null;
  if (score.left >= WIN_AT && score.right < WIN_AT - 1) return "left";
  if (score.right >= WIN_AT && score.left < WIN_AT - 1) return "right";
  return null;
}

/** Whether a score seen now belongs to the match seen before: scores only grow
 *  within a match, and the two columns swap at the half. */
export function continues(prev: Score | null, cur: Score): boolean {
  if (!prev) return true;
  return (cur.left >= prev.left && cur.right >= prev.right) || (cur.left >= prev.right && cur.right >= prev.left);
}

/**
 * The clock's picture pass: the channels due a look, a few a tick. Returns
 * how many calls it opened or ended.
 */
export async function watchFrames(deps: LiveDeps): Promise<number> {
  const source = deps.frames;
  if (!source || !deps.streamGame) return 0;
  const now = deps.now();
  if (now < outageUntil) return 0;
  const games = deps.games ?? faceitConfigured();
  let n = 0, looked = 0;
  for (const ch of await deps.store.channels().catch(() => [])) {
    if (looked >= FRAMES_PER_PASS) break;
    const k = `${ch.platform}:${ch.channelId}`;
    const w = watches.get(k) ?? { nextAt: 0, playlist: null, match: null };
    watches.set(k, w);
    if (now < w.nextAt) continue;
    if (!ch.matchCalls) { w.nextAt = now + FRAME_OFF_MS; continue; }
    // The game itself is talking: it opens and settles this channel's matches (src/live/gsiCalls.ts).
    if (ch.gsiSeenAt != null && now - ch.gsiSeenAt < GSI_STALE_MS) { w.nextAt = now + FRAME_IDLE_MS; continue; }
    // FACEIT reads this channel (src/live/gameCalls.ts): one source per channel, one call per match.
    if (ch.faceitId && games) { w.nextAt = now + FRAME_OFF_MS; continue; }
    looked++;
    const out = await watchOne(deps, source, ch, w, now).catch((e) => {
      w.nextAt = now + FRAME_IDLE_MS;
      deps.log("frames: channel not read", { platform: ch.platform, channel: ch.channelId, err: (e as Error).message });
      return "unread" as const;
    });
    if (out === "opened" || out === "settled" || out === "to-mods" || out === "abandoned") n++;
  }
  return n;
}

async function watchOne(deps: LiveDeps, source: FrameSource, ch: MatchChannel, w: Watch, now: number): Promise<FrameOutcome> {
  const st = await deps.streamGame!(ch.platform, ch.channelId).catch(() => null);
  if (!st) { w.nextAt = now + FRAME_IDLE_MS; return "unread"; }
  const game = st.live ? gameOf(st.game) : null;
  if (!game) {
    // Off, or not in a game this reads. A match that was on screen is gone with it.
    w.playlist = null;
    if (w.match?.phase === "live") {
      if (now - w.match.seenAt >= FRAME_GONE_MS) { w.nextAt = now + FRAME_OFF_MS; return finish(deps, ch, w.match, "gone", now); }
      w.nextAt = now + FRAME_IDLE_MS;
      return "off";
    }
    w.nextAt = now + FRAME_OFF_MS;
    return "off";
  }
  if (!w.playlist || now >= w.playlist.until) {
    const url = await source.playlist(ch.platform, ch.slug);
    if (!url) { w.nextAt = now + FRAME_OFF_MS; deps.log("frames: no playlist", { platform: ch.platform, channel: ch.channelId }); return "unread"; }
    w.playlist = { url, until: now + PLAYLIST_TTL_MS };
  }
  const jpeg = await source.grab(w.playlist.url).catch((e) => { w.playlist = null; throw e; });
  if (!jpeg) { w.playlist = null; w.nextAt = now + FRAME_IDLE_MS; return "unread"; }
  let reading: FrameReading | null;
  try { reading = await source.read(jpeg); }
  catch (e) {
    const fix = personFixOutage((e as Error).message);
    if (fix) { outageUntil = now + FRAME_OUTAGE_MS; deps.log("frames paused: the reader is out", { why: fix, err: (e as Error).message }); }
    throw e;
  }
  if (!reading) { w.nextAt = now + FRAME_IDLE_MS; return "unread"; }
  return apply(deps, ch, w, reading, game, now);
}

async function apply(deps: LiveDeps, ch: MatchChannel, w: Watch, r: FrameReading, game: FrameGame, now: number): Promise<FrameOutcome> {
  const m = w.match;
  if (r.view === "match") {
    // The HUD is up but the digits were not read: the match is on, that is all it says.
    if (!r.score) { w.nextAt = now + FRAME_MATCH_MS; if (m?.phase === "live") m.seenAt = now; return "match"; }
    // The scoreboard lingering after an end is the match that just ended: its
    // score, a round more at most, minutes before any next match could start.
    if (m?.phase === "over" && m.endedAt !== null && now - m.endedAt < LINGER_MS && continues(m.score, r.score)) { w.nextAt = now + FRAME_MATCH_MS; return "idle"; }
    const fresh = !m || m.phase === "over" || (m.map !== null && r.map !== null && m.map !== r.map) || !continues(m.score, r.score);
    if (fresh) {
      if (m && m.phase === "live" && m.opened) await finish(deps, ch, m, "overrun", now).catch((e) => { deps.log("frames: last match not ended", { err: (e as Error).message }); return "idle" as const; });
      w.match = { key: `frame:${game}:${ch.platform}:${ch.channelId}:${now}`, game, map: r.map, callId: null, opened: false, score: r.score, side: r.side, seenAt: now, endedAt: null, phase: "live" };
    } else if (m) {
      m.score = r.score; m.seenAt = now;
      if (r.side) m.side = r.side;
      if (r.map && !m.map) m.map = r.map;
    }
    const cur = w.match!;
    const near = game === "cs2" && cur.score !== null && Math.max(cur.score.left, cur.score.right) >= MATCH_POINT;
    w.nextAt = now + (near ? FRAME_POINT_MS : FRAME_MATCH_MS);
    if (cur.opened) return "match";
    const o = await openMatchCall(deps, ch, cur.key, cur.map, now, { by: "frames", game });
    if (typeof o === "object") { cur.opened = true; cur.callId = o.call.id; return "opened"; }
    if (o === "not-opened") {
      const c = await matchCall(deps, ch, cur.key, null);
      if (c) { cur.opened = true; cur.callId = c.id; }
    }
    return "waiting";
  }
  if (r.view === "end") {
    w.nextAt = now + FRAME_MATCH_MS;
    if (!m || m.phase !== "live") return "idle";
    m.phase = "over"; m.endedAt = now;
    const call = m.opened ? await matchCall(deps, ch, m.key, m.callId) : null;
    if (!call) return "idle";
    if (r.result === "win" || r.result === "loss") {
      const won = r.result === "win";
      // The score is said only when it is a final one: the last look at the HUD
      // is often a round short. The screen is right about who won; a final
      // score that disagrees had the sides the wrong way round.
      let score = decidedSide(m.game, m.score) ? mineOf(m.score, r.side ?? m.side) : null;
      if (score && score.mine !== score.theirs && (score.mine > score.theirs) !== won) score = { mine: score.theirs, theirs: score.mine };
      return (await settleMatchCall(deps, ch, call, won, score, m.map, "frames", now)) ? "settled" : "idle";
    }
    return (await handToMods(deps, ch, call, m.key, now)) ? "to-mods" : "idle";
  }
  // "other": the picture is not a match right now.
  w.nextAt = now + FRAME_IDLE_MS;
  if (m && m.phase === "live" && now - m.seenAt >= FRAME_GONE_MS) return finish(deps, ch, m, "gone", now);
  return "idle";
}

/** A match that left the screen without an end screen: by its score when the
 *  score is an end, else to the mods (gone) or canceled (overrun). */
async function finish(deps: LiveDeps, ch: MatchChannel, m: FrameMatch, why: "overrun" | "gone", now: number): Promise<FrameOutcome> {
  m.phase = "over"; m.endedAt = now;
  const call = m.opened ? await matchCall(deps, ch, m.key, m.callId) : null;
  if (!call) return "idle";
  const d = decidedSide(m.game, m.score);
  if (d && m.side) return (await settleMatchCall(deps, ch, call, d === m.side, mineOf(m.score, m.side), m.map, "frames", now)) ? "settled" : "idle";
  if (why === "overrun") return (await abandonMatchCall(deps, ch, call, m.key, now)) ? "abandoned" : "idle";
  return (await handToMods(deps, ch, call, m.key, now)) ? "to-mods" : "idle";
}
