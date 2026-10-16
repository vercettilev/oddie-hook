/**
 * THE SCREEN SETTLES IT: when to look, and when a look is enough.
 *
 * Every room call (opened with !call, not a price, not a match oddie opened
 * itself) on a live stream gets its picture read every five seconds
 * (src/games/screen.ts): a victory or defeat screen does not stay up long
 * (Lev, 16 Oct). One reading never settles anything. A sure yes or no is
 * looked at again six seconds later (X keeps its picture cached up to five,
 * so this is a new one), and only the same sure answer twice in a row
 * settles the call, with what was on screen said in front of the result. Anything unclear in between starts over. Room reports (!result) and
 * the streamer's own !call yes keep working the whole time; whoever is first
 * settles it, once.
 *
 * WHAT IT COSTS. About 0.17 of a cent a look, so about $1.20 an hour while a
 * call is open on X (its pictures are bigger) and $0.50 on Twitch or Kick.
 * Only while a call is open and the stream live, never past a call's third
 * hour, and never more than 720 looks a channel an hour.
 *
 * WHAT IT NEVER DOES. It never looks in the first minute of a call, so the
 * last match's result screen, still up when the next call opens, cannot
 * settle it. It never looks at a channel that said !matches off, at a stream
 * that is not live, or at a channel past its hourly budget. It never touches
 * a market: markets settle through their own resolution, never from a picture.
 */
import { personFixOutage } from "../inference.js";
import { isRoomCall, settleOnScreen, type LiveCall, type LiveDeps } from "./calls.js";

/** How often an open room call's picture is read: a result screen does not stay up long. */
export const SCREEN_EVERY_MS = 5_000;
/** A sure answer is looked at again this soon, while the result is still on screen
 *  and past X's five-second picture cache, so it is a new picture. */
export const SCREEN_CONFIRM_MS = 6_000;
/** The second sure answer has to come within this long of the first. */
export const SCREEN_AGREE_MS = 3 * 60_000;
/** How sure the reader must be for an answer to count at all. */
export const SCREEN_SURE = 0.85;
/** No look in a call's first minute: the last result may still be on screen. */
export const SCREEN_GRACE_MS = 60_000;
/** At most this many pictures a tick, read side by side. */
export const SCREENS_PER_PASS = 3;
/** At most this many pictures a channel an hour: one every five seconds. */
export const SCREEN_PER_HOUR = 720;
/** A call open longer than this is not looked at any more: a forgotten call
 *  would otherwise be read all day. The streamer's !call yes still settles it. */
export const SCREEN_MAX_AGE_MS = 3 * 60 * 60_000;
/** A channel off stream, opted out or over budget is asked again after this long. */
export const SCREEN_IDLE_MS = 60_000;
/** A reader outage only a person can fix pauses every look for this long. */
export const SCREEN_OUTAGE_MS = 10 * 60_000;

interface Look { nextAt: number; decided: { answer: "yes" | "no"; at: number; seen: string } | null }
const looks = new Map<string, Look>();
const spent = new Map<string, { hour: number; n: number }>();
const liveAt = new Map<string, { at: number; live: boolean }>();
let channelsAt = 0;
let channelInfo = new Map<string, { name: string; matchCalls: boolean }>();
let outageUntil = 0;

/** Test seam. */
export function _resetScreens(): void {
  looks.clear(); spent.clear(); liveAt.clear(); channelInfo = new Map(); channelsAt = 0; outageUntil = 0;
}

const keyOf = (c: { platform: string; channelId: string }) => `${c.platform}:${c.channelId}`;

async function channelsNow(deps: LiveDeps, now: number): Promise<Map<string, { name: string; matchCalls: boolean }>> {
  if (now - channelsAt < SCREEN_IDLE_MS && channelInfo.size) return channelInfo;
  const rows = await deps.store.channels().catch(() => null);
  if (rows) {
    channelInfo = new Map(rows.map((r) => [keyOf(r), { name: r.name || r.slug, matchCalls: r.matchCalls }]));
    channelsAt = now;
  }
  return channelInfo;
}

async function isLive(deps: LiveDeps, call: LiveCall, now: number): Promise<boolean> {
  if (!deps.streamLive) return false;
  const k = keyOf(call);
  const seen = liveAt.get(k);
  if (seen && now - seen.at < SCREEN_IDLE_MS) return seen.live;
  const live = (await deps.streamLive(call.platform, call.channelId).catch(() => null)) === true;
  liveAt.set(k, { at: now, live });
  return live;
}

function withinBudget(k: string, now: number): boolean {
  const hour = Math.floor(now / 3_600_000);
  const s = spent.get(k);
  if (!s || s.hour !== hour) { spent.set(k, { hour, n: 1 }); return true; }
  if (s.n >= SCREEN_PER_HOUR) return false;
  s.n++;
  return true;
}

/** The clock's screen pass: the room calls due a look, a few a tick. Returns how many it settled. */
export async function watchScreens(deps: LiveDeps): Promise<number> {
  const source = deps.screen;
  if (!source) return 0;
  const now = deps.now();
  if (now < outageUntil) return 0;
  const calls = (await deps.store.everyUnsettled().catch(() => [] as LiveCall[]))
    .filter((c) => isRoomCall(c) && now - c.openedAt <= SCREEN_MAX_AGE_MS);
  const open = new Set(calls.map((c) => c.id));
  for (const id of looks.keys()) if (!open.has(id)) looks.delete(id);
  if (!calls.length) return 0;
  for (const c of calls) if (!looks.has(c.id)) looks.set(c.id, { nextAt: c.openedAt + SCREEN_GRACE_MS, decided: null });
  const due = calls.filter((c) => now >= looks.get(c.id)!.nextAt).sort((a, b) => looks.get(a.id)!.nextAt - looks.get(b.id)!.nextAt);
  if (!due.length) return 0;
  const chans = await channelsNow(deps, now);
  const take: Array<{ call: LiveCall; name: string }> = [];
  for (const call of due) {
    if (take.length >= SCREENS_PER_PASS) break;
    const l = looks.get(call.id)!;
    const k = keyOf(call);
    const ch = chans.get(k);
    if (!ch || !ch.matchCalls || !(await isLive(deps, call, now)) || !withinBudget(k, now)) { l.nextAt = now + SCREEN_IDLE_MS; l.decided = null; continue; }
    take.push({ call, name: ch.name });
  }
  // Side by side: three streams' reads take as long as one.
  const outs = await Promise.all(take.map(({ call, name }) => lookOnce(deps, source, call, name, now)));
  return outs.filter(Boolean).length;
}

/** One look at one call: true when it settled the call. */
async function lookOnce(deps: LiveDeps, source: NonNullable<LiveDeps["screen"]>, call: LiveCall, name: string, now: number): Promise<boolean> {
  const l = looks.get(call.id);
  if (!l) return false;
  try {
    const jpeg = await source.grab(call.platform, call.channelId);
    if (!jpeg) { l.nextAt = now + SCREEN_EVERY_MS; l.decided = null; return false; }
    const r = await source.ask(jpeg, call.question, name);
    deps.log("screen read", { platform: call.platform, channel: call.channelId, id: call.id, answer: r?.answer ?? null, sure: r?.sure ?? null, seen: r?.seen ?? null });
    if (!r || r.answer === "unclear" || r.sure < SCREEN_SURE) { l.nextAt = now + SCREEN_EVERY_MS; l.decided = null; return false; }
    if (l.decided && l.decided.answer === r.answer && now - l.decided.at <= SCREEN_AGREE_MS) {
      looks.delete(call.id);
      return settleOnScreen(call, r.answer, r.seen || l.decided.seen, deps);
    }
    // The first sure answer: look again while it is still on screen.
    l.decided = { answer: r.answer, at: now, seen: r.seen };
    l.nextAt = now + SCREEN_CONFIRM_MS;
    return false;
  } catch (e) {
    l.nextAt = now + SCREEN_EVERY_MS; l.decided = null;
    const fix = personFixOutage((e as Error).message);
    if (fix) { outageUntil = now + SCREEN_OUTAGE_MS; deps.log("screen paused: the reader is out", { why: fix, err: (e as Error).message.slice(0, 200) }); }
    else deps.log("screen: call not read", { platform: call.platform, channel: call.channelId, id: call.id, err: (e as Error).message.slice(0, 200) });
    return false;
  }
}
