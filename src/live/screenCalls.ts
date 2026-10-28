/**
 * THE SCREEN SETTLES IT: when to look, and when a look is enough.
 *
 * Every room call (opened with !call, not a price, not a match oddie opened
 * itself) on a live stream gets its picture read every four seconds
 * (src/games/screen.ts): a victory or defeat screen does not stay up long
 * (Lev, 16 Oct; Showdown's VICTORY screen stays about six seconds). One
 * reading never settles anything. A sure yes or no is looked at again two
 * seconds later, while it is still up, and only the same sure answer twice in
 * a row settles the call, with what was on screen said in front of the
 * result. On Twitch and Kick that second look is a new frame; on X it can be
 * the same picture, which X caches up to five seconds. Anything unclear in
 * between starts over. The streamer's own !call yes or !call no keeps working
 * the whole time; whoever is first settles it, once.
 *
 * WHY THESE NUMBERS (Aleksa's Showdown stream, 16 Oct, read 17 Oct: 470
 * frames, two questions, 940 reads, not one wrong sure answer). On its frames
 * two seconds apart, looks every five seconds with the second one six seconds
 * later never caught the six-second VICTORY screen; every four seconds with
 * the second two seconds later caught it 98 times in 100. The server's pass
 * runs every second so a look happens when it falls due, not at the next
 * five-second beat; a picture and a read take a couple of seconds, so on
 * Twitch and Kick the second look lands nearer three seconds after the first.
 *
 * WHAT IT COSTS. About 0.17 of a cent a look, every platform's picture being
 * full size (src/games/screen.ts SCREEN_FRAME_WIDTH), so about $1.50 an hour
 * while a call is open: a Showdown game of ten to sixteen minutes, 25 to 40
 * cents. Only while a call is open and the stream live, never past a call's
 * third hour, and never more than 900 looks a call an hour.
 *
 * A TOURNAMENT IS NOT A GAME (Lev, 22 Oct). A call over more than one game,
 * a tournament, a series or a night of play (src/games/screen.ts callScope),
 * waits through many games for one result. Its reader says what the picture
 * is, and only the event's own page settles it: a champion, final standings,
 * the named player eliminated, read the same way by the strong model too. No
 * game's result screen does, however sure the reading. It is looked at every
 * eight seconds rather than four, for eight hours rather than three, and the
 * strong model only when its page reads decided, a few looks a stream. Each
 * call counts its own looks, so a tournament call left open beside a game's
 * never eats the looks the game's result screen needs.
 *
 * A NUMBER IS CHECKED TWICE (28 Oct, BR1). A call on a round's kills or time
 * alive (src/games/screen.ts statRule) is answered by comparing the number
 * the reader copies off the round's result panel, never by the reader's own
 * yes or no, and settles only where the strong model copies the same number
 * into the same answer, twice in a row: once a round, a few cents.
 *
 * WHAT IT NEVER DOES. It never looks in the first minute of a call, so the
 * last match's result screen, still up when the next call opens, cannot
 * settle it. It never looks at a channel that said !matches off, at a stream
 * that is not live, or at a call past its hourly budget. It never touches
 * a market: markets settle through their own resolution, never from a picture.
 */
import { personFixOutage } from "../inference.js";
import { callScope, statRule } from "../games/screen.js";
import { isRoomCall, settleOnScreen, type LiveCall, type LiveDeps } from "./calls.js";

/** How often an open room call's picture is read: a result screen does not stay up long. */
export const SCREEN_EVERY_MS = 4_000;
/** A sure answer is looked at again this soon, while the result is still on screen:
 *  six seconds later, Showdown's VICTORY screen was always gone. */
export const SCREEN_CONFIRM_MS = 2_000;
/** The second sure answer has to come within this long of the first. */
export const SCREEN_AGREE_MS = 3 * 60_000;
/** How sure the reader must be for an answer to count at all. */
export const SCREEN_SURE = 0.85;
/** No look in a call's first minute: the last result may still be on screen. */
export const SCREEN_GRACE_MS = 60_000;
/** At most this many pictures a tick, read side by side. */
export const SCREENS_PER_PASS = 3;
/** At most this many pictures a call an hour: one every four seconds. */
export const SCREEN_PER_HOUR = 900;
/** An event call (a tournament, a series) is read this often: its result does
 *  not hang on a six-second banner, and it is open for hours. */
export const SCREEN_EVENT_EVERY_MS = 8_000;
/** The server runs the pass this often; a pass between two looks only checks the time. */
export const SCREEN_TICK_MS = 1_000;
/** The open calls are listed from the store at most this often, not every tick. */
export const SCREEN_LIST_MS = 5_000;
/** A call open longer than this is not looked at any more: a forgotten call
 *  would otherwise be read all day. The streamer's !call yes still settles it. */
export const SCREEN_MAX_AGE_MS = 3 * 60 * 60_000;
/** An event call is looked at this long: a tournament outlasts three hours. */
export const SCREEN_EVENT_MAX_AGE_MS = 8 * 60 * 60_000;
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
let listed: LiveCall[] = [];
let listedAt = 0;

/** Test seam. */
export function _resetScreens(): void {
  looks.clear(); spent.clear(); liveAt.clear(); channelInfo = new Map(); channelsAt = 0; outageUntil = 0;
  listed = []; listedAt = 0;
}

const keyOf = (c: { platform: string; channelId: string }) => `${c.platform}:${c.channelId}`;
const isEvent = (c: LiveCall) => callScope(c.question) === "event";
/** A call on one number of a round's result panel (src/games/screen.ts statRule). */
const isStat = (c: LiveCall) => statRule(c.question) !== null;
const everyOf = (c: LiveCall) => (isEvent(c) ? SCREEN_EVENT_EVERY_MS : SCREEN_EVERY_MS);
const maxAgeOf = (c: LiveCall) => (isEvent(c) ? SCREEN_EVENT_MAX_AGE_MS : SCREEN_MAX_AGE_MS);

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

/** `k` is the call's id: each call counts its own looks. */
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
  const watched = (cs: LiveCall[]) => cs.filter((c) => isRoomCall(c) && now - c.openedAt <= maxAgeOf(c));
  // The store is asked again whenever a look falls due, so a call settled some
  // other way is never looked at after, and every five seconds for new calls;
  // a pass with nothing due only checks the time.
  const dueNow = watched(listed).some((c) => now >= (looks.get(c.id)?.nextAt ?? 0));
  if (dueNow || !listedAt || now - listedAt >= SCREEN_LIST_MS || now < listedAt) {
    listed = await deps.store.everyUnsettled().catch(() => [] as LiveCall[]);
    listedAt = now;
  }
  const calls = watched(listed);
  const open = new Set(calls.map((c) => c.id));
  for (const id of looks.keys()) if (!open.has(id)) looks.delete(id);
  for (const id of spent.keys()) if (!open.has(id)) spent.delete(id);
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
    if (!ch || !ch.matchCalls || !(await isLive(deps, call, now)) || !withinBudget(call.id, now)) { l.nextAt = now + SCREEN_IDLE_MS; l.decided = null; continue; }
    take.push({ call, name: ch.name });
  }
  // Side by side: three streams' reads take as long as one.
  const outs = await Promise.all(take.map(({ call, name }) => lookOnce(deps, source, call, name, now)));
  const settled = outs.filter(Boolean).length;
  // A call this pass settled leaves the list at the next pass, not five seconds on.
  if (settled) listedAt = 0;
  return settled;
}

/** One look at one call: true when it settled the call. */
async function lookOnce(deps: LiveDeps, source: NonNullable<LiveDeps["screen"]>, call: LiveCall, name: string, now: number): Promise<boolean> {
  const l = looks.get(call.id);
  if (!l) return false;
  try {
    const jpeg = await source.grab(call.platform, call.channelId);
    if (!jpeg) { l.nextAt = now + everyOf(call); l.decided = null; return false; }
    const r = await source.ask(jpeg, call.question, name);
    deps.log("screen read", { platform: call.platform, channel: call.channelId, id: call.id, answer: r?.answer ?? null, sure: r?.sure ?? null, seen: r?.seen ?? null });
    // An event call is settled on the event's own page, never on one game's
    // result, however sure the answer beside it (src/games/screen.ts).
    if (!r || r.answer === "unclear" || r.sure < SCREEN_SURE || (isEvent(call) && r.screen !== "event")) { l.nextAt = now + everyOf(call); l.decided = null; return false; }
    let seen = r.seen;
    if (isEvent(call) || isStat(call)) {
      // ...and only where the strong model reads the same page the same way,
      // and a number off a round's result panel only where it reads the same
      // number into the same answer.
      const c = source.confirm ? await source.confirm(jpeg, call.question, name) : null;
      deps.log("screen confirm", { platform: call.platform, channel: call.channelId, id: call.id, answer: c?.answer ?? null, sure: c?.sure ?? null, screen: c?.screen ?? null, seen: c?.seen ?? null });
      if (!c || c.answer !== r.answer || c.sure < SCREEN_SURE || (isEvent(call) && c.screen !== "event")) { l.nextAt = now + everyOf(call); l.decided = null; return false; }
      seen = c.seen || r.seen;
    }
    if (l.decided && l.decided.answer === r.answer && now - l.decided.at <= SCREEN_AGREE_MS) {
      looks.delete(call.id);
      return settleOnScreen(call, r.answer, seen || l.decided.seen, deps, jpeg);
    }
    // The first sure answer: look again while it is still on screen.
    l.decided = { answer: r.answer, at: now, seen };
    l.nextAt = now + SCREEN_CONFIRM_MS;
    return false;
  } catch (e) {
    l.nextAt = now + everyOf(call); l.decided = null;
    const fix = personFixOutage((e as Error).message);
    if (fix) { outageUntil = now + SCREEN_OUTAGE_MS; deps.log("screen paused: the reader is out", { why: fix, err: (e as Error).message.slice(0, 200) }); }
    else deps.log("screen: call not read", { platform: call.platform, channel: call.channelId, id: call.id, err: (e as Error).message.slice(0, 200) });
    return false;
  }
}
