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
 * third hour, and never more than 900 looks a channel an hour.
 *
 * WHAT IT NEVER DOES. It never looks in the first minute of a call, so the
 * last match's result screen, still up when the next call opens, cannot
 * settle it. It never looks at a call over more than one game (manyGames). It
 * never looks at a channel that said !matches off, at a stream
 * that is not live, or at a channel past its hourly budget. It never touches
 * a market: markets settle through their own resolution, never from a picture.
 */
import { personFixOutage } from "../inference.js";
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
/** At most this many pictures a channel an hour: one every four seconds. */
export const SCREEN_PER_HOUR = 900;
/** The server runs the pass this often; a pass between two looks only checks the time. */
export const SCREEN_TICK_MS = 1_000;
/** The open calls are listed from the store at most this often, not every tick. */
export const SCREEN_LIST_MS = 5_000;
/** A call open longer than this is not looked at any more: a forgotten call
 *  would otherwise be read all day. The streamer's !call yes still settles it. */
export const SCREEN_MAX_AGE_MS = 3 * 60 * 60_000;
/** A channel off stream, opted out or over budget is asked again after this long. */
export const SCREEN_IDLE_MS = 60_000;
/** A reader outage only a person can fix pauses every look for this long. */
export const SCREEN_OUTAGE_MS = 10 * 60_000;

/* A WIN OVER MANY GAMES IS NEVER ON ONE GAME'S SCREEN (Lev, 22 Oct). In a
   Showdown tournament every game ends on a WINNER banner, and a best of three
   puts one up after every map, so "does GPPoker win Lucky 13?" read off the
   screen would settle YES on the first game GPPoker took, hours before the
   tournament is decided. A call about a tournament, a series, a final, a day
   of play or the whole night is the mods' to settle when it is over: the
   screen never looks at it. A call that names its one game ("this game",
   "the next hand") is read as before, whatever else it says. */

/** The one game a call can name. */
const ONE_GAME = /\b(?:this|that|the next|next|the last|last)\s+(?:one|game|round|match|hand|map|fight|run|race|life|duel|battle|pot|flip|spin|draw|point|showdown|attempt|try|pull)\b/i;
/** Words that put a call over more than one game. */
const MANY_WORDS = new RegExp(`\\b(?:${[
  /tournaments?|championships?|champions?|champ|trophy|trophies|series|brackets?|playoffs?/,
  /finals|(?:semi|quarter)-?finals?|final table|whole thing|overall|podium|seasons?/,
  // "the final", but not the last moment of one game: "the final boss", "the final round".
  /the final(?!\s+(?:boss|round|hand|kill|circle|zone|lap|wave|stage|level|map|game|fight|card|river|question|score|minute))/,
  /top\s*\d+|(?:1st|first|2nd|second|3rd|third)\s+place|(?:win|wins|winning|take|takes)\s+it\s+all|takes?\s+(?:it\s+)?(?:down|home)/,
  /in a row|day\s*\d+|qualif(?:y|ies|ied|iers?|ication)|advances?|in the money|tonight|today|this week(?:end)?|(?:by|at|until) the end/,
].map((r) => r.source).join("|")})\\b`, "i");
/** A game's own nouns: what "win the ..." may name and still be one game. */
const GAME_NOUN = "one|games?|rounds?|match(?:es)?|hands?|maps?|fights?|pots?|flips?|races?|duels?|battles?|points?|showdown|draws?|spins?|w|dub";
/** "win" followed by an event's name: "win Lucky 13", "win the cup", "win 3 games".
 *  What may follow it in a call about one game: nothing, a word that names no
 *  event, or one of the game's own nouns. */
const WIN_NAMES_EVENT = new RegExp(
  `\\b(?:wins?|winning|won)\\s+(?:(?:the|a|an)\\s+(?!(?:(?:next|first|last)\\s+)?(?:${GAME_NOUN})\\b)` +
  `|(?!(?:the|a|an|this|that|it|here|now|again|vs\\.?|versus|against|by|with|or|and|if|when|before|after|big|easy|easily|clean|fast|back|on|out|over|${GAME_NOUN}` +
  `|in\\s+(?:\\d+|under|less|fewer|one|two|three|a|time))\\b))[a-z0-9$]`, "i");
/** "the Lucky 13 winner", "winner of Lucky 13": a winner of something bigger than a game. */
const WINNER_OF_EVENT = new RegExp(
  `\\b(?!(?:the|a|an|this|that|next|last|my|his|her|their|our|your|be|is|round|game|hand|map|match|fight|race|pot)\\b)[\\w$']+\\s+winners?\\b` +
  `|\\bwinners?\\s+of\\s+(?!(?:this|that|the\\s+(?:next\\s+)?(?:${GAME_NOUN}))\\b)`, "i");
/** "in Lucky 13", "at Worlds": an event named by its own capitalized name. */
const AT_EVENT = /\b(?:in|at)\s+(?!(?:This|That|The|A|An|My|His|Her|Their|Our|Your|One|Chat|Game|Round|Match|Hand|Map)\b)[A-Z][\w']*/;

/** A call over more than one game, whose answer no single game's screen shows. */
export function manyGames(question: string): boolean {
  const q = String(question ?? "");
  if (ONE_GAME.test(q)) return false;
  return MANY_WORDS.test(q) || WIN_NAMES_EVENT.test(q) || WINNER_OF_EVENT.test(q) || AT_EVENT.test(q);
}

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
  const watched = (cs: LiveCall[]) => cs.filter((c) => isRoomCall(c) && !manyGames(c.question) && now - c.openedAt <= SCREEN_MAX_AGE_MS);
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
