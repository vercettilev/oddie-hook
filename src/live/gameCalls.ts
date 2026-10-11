/**
 * Match calls: a call oddie opens when the streamer's FACEIT match starts and
 * settles from FACEIT when it ends. The streamer types !faceit <nick> once
 * (src/live/calls.ts); everything after that is this file and the clock.
 *
 * The call is an ordinary call in every other way: !yes and !no answer it,
 * earlier answers score more, a mod's !call yes or !call no still beats FACEIT,
 * and the standings are the same standings. What is new is who opens and who
 * settles.
 *
 * ONE MATCH, ONE CALL, ever: the store refuses a second call for the same
 * match id, so a result that FACEIT still lists as ongoing for a minute after
 * it ended cannot reopen it. A channel with a call already taking answers is
 * not interrupted: the match is picked up on the next minute, after the room's
 * call is done. An offline channel gets no calls at all.
 */
import { faceitConfigured, scoreText, sideFor, type GameMatch, type GameSource } from "../games/faceit.js";
import { CALL_OPEN_MAX_MS, LIVE_COPY, pointsFor, type LiveCall, type LiveDeps, type Platform } from "./calls.js";

/** How often linked channels are asked about their matches. */
export const GAME_POLL_MS = 60_000;

export const GAME_COPY = {
  opened: (nick: string, map: string | null, url: string) =>
    `FACEIT: ${nick} is in a match${map ? ` on ${map}` : ""}. Does ${nick} win it? Type !yes or !no, earlier calls score more. oddie settles it from FACEIT when the match ends. Standings: ${url}`,
  result: (nick: string, won: boolean, score: string | null, map: string | null) =>
    `FACEIT: ${nick} ${won ? "won" : "lost"}${score ? ` ${score}` : ""}${map ? ` on ${map}` : ""}.`,
  cancelled: (q: string) => `FACEIT cancelled that match, so "${q}" is canceled. No points.`,
  unreadable: (q: string) => `FACEIT ended the match without a result oddie can read, so "${q}" is yours to settle: !call yes or !call no.`,
};

export const matchQuestion = (nick: string, map: string | null): string => `${nick} wins this match${map ? ` on ${map}` : ""}?`;

let lastWatch = 0;
/** Test seam. */
export function _resetGames(): void { lastWatch = 0; }

async function sayQuiet(deps: LiveDeps, m: { platform: Platform; channelId: string }, text: string): Promise<string | null> {
  try { const id = await deps.say(m.platform, m.channelId, text); return typeof id === "string" && id ? id : null; }
  catch (e) { deps.log("live chat line not delivered", { err: (e as Error).message }); return null; }
}

async function settleFromMatch(call: LiveCall, m: GameMatch, link: { id: string; nick: string }, deps: LiveDeps): Promise<boolean> {
  const now = deps.now();
  if (m.status === "cancelled") {
    if (!(await deps.store.cancel(call.id, now))) return false;
    await sayQuiet(deps, call, GAME_COPY.cancelled(call.question));
    deps.log("live match call canceled", { platform: call.platform, channel: call.channelId, id: call.id, match: m.id });
    return true;
  }
  const r = sideFor(m, link.id);
  if (!r) {
    // The match ended but FACEIT names no winner, or the player is on neither
    // roster: the mods settle it, said once. A second look costs nothing.
    if (!(await deps.store.lock(call.id, now))) return false;
    await sayQuiet(deps, call, GAME_COPY.unreadable(call.question));
    deps.log("live match call handed to mods", { platform: call.platform, channel: call.channelId, id: call.id, match: m.id });
    return false;
  }
  const tally = await deps.store.tally(call.id);
  const done = await deps.store.settle(call.id, r.side, pointsFor(tally, r.side), now);
  if (!done) return false;
  const url = await deps.standingsUrl(call.platform, call.channelId);
  await sayQuiet(deps, call, `${GAME_COPY.result(link.nick, r.side === "yes", scoreText(m, r.mine), m.map)} ${LIVE_COPY.settled(call.question, r.side, done.right, done.total, done.top, url)}`);
  deps.log("live call settled", { platform: call.platform, channel: call.channelId, id: call.id, outcome: r.side, right: done.right, total: done.total, by: "faceit" });
  return true;
}

/**
 * The clock's game pass: every linked channel, once a minute. Settles the
 * match calls whose match ended, then opens one for a match in progress.
 * Returns how many calls it opened or settled.
 */
export async function watchGames(deps: LiveDeps): Promise<number> {
  const now = deps.now();
  if (now - lastWatch < GAME_POLL_MS) return 0;
  lastWatch = now;
  const games: GameSource | null = deps.games ?? faceitConfigured();
  if (!games) return 0;
  const linked = await deps.store.withFaceit().catch(() => []);
  let n = 0;
  for (const ch of linked) {
    const link = { id: ch.faceitId, nick: ch.faceitNick };
    const waiting = (await deps.store.unsettled(ch.platform, ch.channelId).catch(() => [] as LiveCall[])).filter((c) => c.matchId);
    for (const c of waiting) {
      const m = await games.match(c.matchId!).catch((e) => { deps.log("faceit match not read", { match: c.matchId, err: (e as Error).message }); return null; });
      if (!m || m.status === "live") continue;
      if (await settleFromMatch(c, m, link, deps).catch((e) => { deps.log("live match call not settled", { id: c.id, err: (e as Error).message }); return false; })) n++;
    }
    // No calls for a channel that is not streaming: the match may be real, the room is not there.
    const live = deps.streamLive ? await deps.streamLive(ch.platform, ch.channelId).catch(() => null) : null;
    if (live === false) continue;
    const m = await games.ongoing(link.id).catch((e) => { deps.log("faceit ongoing not read", { nick: link.nick, err: (e as Error).message }); return null; });
    if (!m || m.status !== "live") continue;
    if (waiting.some((c) => c.matchId === m.id)) continue;
    if (await deps.store.current(ch.platform, ch.channelId).catch(() => null)) {
      deps.log("live match call waits, the room has a call open", { platform: ch.platform, channel: ch.channelId, match: m.id });
      continue;
    }
    const opened = await deps.store.open({
      platform: ch.platform, channelId: ch.channelId, question: matchQuestion(link.nick, m.map),
      openedById: "oddie", openedByName: "oddie", openedAt: now, closesAt: now + CALL_OPEN_MAX_MS, timed: false, matchId: m.id,
    });
    if (!opened) continue; // already opened for this match, by this clock a moment ago or by another instance
    const id = await sayQuiet(deps, ch, GAME_COPY.opened(link.nick, m.map, await deps.standingsUrl(ch.platform, ch.channelId)));
    if (id && deps.pin) await deps.pin(ch.platform, ch.channelId, id).catch(() => {});
    deps.log("live match call opened", { platform: ch.platform, channel: ch.channelId, id: opened.id, match: m.id, map: m.map });
    n++;
  }
  return n;
}
