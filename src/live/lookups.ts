/**
 * THE PLATFORM WENT QUIET (24 Nov). "Is this channel live" is asked of Kick and
 * Twitch all day, and every asker reads a refusal as "the platform did not
 * answer" and moves on without a line in the log: the end-of-stream sweep and
 * the repeat's next round (src/live/calls.ts), the went-live watcher
 * (src/live/openedMail.ts), the channel page's player
 * (src/live/channelRoutes.ts), and the picture, game, match and screen passes.
 * For one slow moment that is right. It also meant a lookup refused for hours
 * (an operation switched off, a token the platform will not take, a rate
 * limit) stopped calls ending with their stream, kept the screen from settling
 * them, and silenced the went-live mail, the player and the picture pass, and
 * nobody heard of it. Kick has deprecated the operation this was asked of
 * since 23 Jun 2026 (src/kick/client.ts): the day it was switched off would
 * have looked like a quiet afternoon.
 *
 * So the adapters hand their lookups over through here (src/kick/routes.ts,
 * src/twitch/routes.ts), and this only counts. The asker gets exactly what it
 * got before: the platform's answer, or the same throw, in its own catch.
 *
 * WHAT COUNTS. An answer is a lookup that came back: "not live" is an answer.
 * A refusal is one that threw: a status that is not OK, a token not given, no
 * answer in time. A platform that is not set up is not asked through here at
 * all, so it is neither. Each platform has its own count, and one answer for
 * any channel ends the stretch: a channel refused while others on its platform
 * answer is that channel's trouble, not the platform gone quiet.
 *
 * WHEN IT IS TOLD. Once every lookup on a platform has been refused for
 * QUIET_AFTER_MS: one line in the log with the last error, and one mail to the
 * operator (src/live/openedMail.ts), as when the Kick voice signs out
 * (src/kick/routes.ts). Then at most once in QUIET_ALERT_GAP_MS while it
 * lasts. The first answer forgets all of it, so the next silence is told from
 * the start, and a silence that was told leaves one line in the log when it
 * ends.
 */
import type { Platform } from "./calls.js";
import { PLATFORM_NAME, reportAlert } from "./openedMail.js";

/**
 * How long every lookup must have been refused before it is the platform and
 * not a slow moment. Taken from how often the engine asks. The one asker that
 * never stops is the went-live watcher: every active channel, once every two
 * minutes, wherever the operator's mail is on (src/server.ts). A channel with
 * a call waiting is also asked once a minute by the sweep (STREAM_POLL_MS) and
 * by the screen (SCREEN_IDLE_MS), a viewer-count call asks every thirty
 * seconds (VIEWER_POLL_MS), and a channel page somebody has open asks every
 * thirty (LIVE_TTL_MS). So in ten minutes
 * the slowest steady asker has come round five more times and the sweep ten,
 * with not one answer among them. A slow moment (a timeout, a burst of 5xx, a
 * rate limit that clears within its minute) costs a pass or two. Ten minutes
 * is also when the engine itself stops waiting on a platform: a viewer-count
 * call it cannot read goes back to the mods then (VIEWER_GIVE_UP_MS), so the
 * operator hears as the first call is handed back, not hours on.
 *
 * Refusals further apart than this are not one stretch either. The longest any
 * asker waits between two looks at a channel is five minutes (the picture
 * pass, for one that is off air: FRAME_OFF_MS), so two refusals more than ten
 * minutes apart had nobody asking between them, and say nothing about the
 * time between: the stretch starts over at the later one.
 */
export const QUIET_AFTER_MS = 10 * 60_000;
/** The operator hears of the same silence again only after this long: the Kick voice's gap. */
export const QUIET_ALERT_GAP_MS = 6 * 60 * 60_000;

type Log = (line: string, extra?: Record<string, unknown>) => void;

interface Quiet {
  /** When the first lookup of the stretch was asked: nothing has answered since. */
  since: number;
  /** When the last refusal came back. */
  lastAt: number;
  /** The stretch's refusals, and the channels they were for (never more than the platform has). */
  lookups: number;
  channels: Set<string>;
  /** When the operator was last told of this silence; null until then. */
  toldAt: number | null;
}
/** Only the platforms with a stretch running: an answer takes its platform out. */
const quiet = new Map<Platform, Quiet>();
/** Test seam: forget every platform's stretch. */
export function _resetLookups(): void { quiet.clear(); }

/** Counting is never worth a lookup: whatever goes wrong in here, the asker still gets what the platform said. */
function quietly(f: () => void): void {
  try { f(); } catch { /* the lookup's own answer or throw goes on */ }
}

/**
 * One "is this channel live" lookup, asked of `platform` and counted. It
 * resolves and throws exactly as `ask` does.
 */
export async function counted<T>(platform: Platform, channelId: string, log: Log, ask: () => Promise<T>): Promise<T> {
  const askedAt = Date.now();
  let answer: T;
  try { answer = await ask(); }
  catch (e) {
    quietly(() => refused(platform, channelId, askedAt, e, log));
    throw e;
  }
  quietly(() => answered(platform, log));
  return answer;
}

function answered(platform: Platform, log: Log): void {
  const q = quiet.get(platform);
  if (!q) return;
  quiet.delete(platform);
  // Only a silence the operator was told of is worth the line that ends it.
  if (q.toldAt !== null) log(`${platform} answers whether a channel is live again`, { quietMin: Math.round((Date.now() - q.since) / 60_000) });
}

function refused(platform: Platform, channelId: string, askedAt: number, e: unknown, log: Log): void {
  const now = Date.now();
  let q = quiet.get(platform);
  if (!q) {
    q = { since: askedAt, lastAt: now, lookups: 0, channels: new Set(), toldAt: null };
    quiet.set(platform, q);
  } else if (askedAt - q.lastAt > QUIET_AFTER_MS) {
    // Nobody asked in between: not one stretch. What the operator was told of it stands until an answer.
    q.since = askedAt; q.lookups = 0; q.channels.clear();
  }
  q.lookups++;
  q.channels.add(channelId);
  q.lastAt = now;
  if (now - q.since < QUIET_AFTER_MS) return;
  if (q.toldAt !== null && now - q.toldAt < QUIET_ALERT_GAP_MS) return;
  q.toldAt = now;
  const name = PLATFORM_NAME[platform];
  const err = ((e as Error)?.message ?? String(e)).replace(/\s+/g, " ").trim().slice(0, 160);
  const since = new Date(q.since).toISOString();
  const channels = q.channels.size;
  // The mail first: it never throws, and a log that did would otherwise cost it.
  reportAlert({
    title: `${name} has stopped answering whether a channel is live`,
    text: `${name} has not answered one live lookup since ${since.slice(0, 10)} ${since.slice(11, 16)} UTC: ${q.lookups} asked, for ${channels} channel${channels === 1 ? "" : "s"}, `
      + `and the last came back "${err}". Until it answers again, calls in ${name} chats do not end with their stream and the screen settles none of them, `
      + `and the went-live mail, the channel page's player and the picture pass are quiet for ${name}. `
      + "Open calls stay open, and the streamer or a mod can settle one with !call yes or !call no. "
      + `A 400, 401, 403 or 404 in that error points at our side: the ${name} app's key on Railway, or a lookup ${name} has changed or switched off. `
      + `A 429, a 5xx or no status at all is ${name}'s side, and clears when ${name} does.`,
  });
  log(`${platform} is not answering whether a channel is live, calls there do not end with the stream until it does`,
    { since, lookups: q.lookups, channels, err });
}
