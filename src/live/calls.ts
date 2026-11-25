/**
 * LIVE CALLS: a question a stream's chat answers YES or NO, free.
 *
 * WHY THIS EXISTS NEXT TO KICK'S AND TWITCH'S OWN PREDICTIONS. Both platforms
 * already run a channel-points prediction in chat, and a free oddie call alone
 * would only be a copy of it. Two things they cannot do are the point:
 *
 *   - THE RECORD TRAVELS. Channel points live and die in one channel. A call on
 *     oddie is kept against the viewer, across every stream that runs oddie,
 *     and ranked the way oddie ranks everything: being right while the room
 *     disagreed is worth more than agreeing with it.
 *   - IT CAN BECOME REAL. The same question can later be opened as a real
 *     market, and the channel that brought the room earns its 2%.
 *
 * So chat stays exactly as easy as the native feature (!yes, !no) and the
 * standings live on oddie, which is what brings a viewer there.
 *
 * TWO DOORS IN ONE CHAT. `!oddie <claim>` is the same door as tagging oddie on
 * X or Telegram: anybody may knock, the claim is read, a real market opens and
 * oddie's resolver settles it. `!call <question>` is the quick free vote for a
 * moment no resolver can see ("clutch this round?"), run by the channel.
 *
 * WHO DOES WHAT. The channel's owner and its moderators open, settle and
 * cancel calls; everybody answers. One answer per person, and an answer is
 * final: a call changed after the room has moved is a call made with hindsight.
 *
 * OPEN UNTIL IT IS SETTLED (Lev, 8 Oct, after the first Twitch pilot). A call
 * used to lock after three minutes, and "before the stream ends?" closing in
 * three minutes read as broken. A call now takes answers until the channel
 * settles it, and earlier answers score more, so a late !yes on a result
 * everybody can see is worth almost nothing. `!call 5m <question>` still locks
 * in five minutes, for a moment that is over fast ("clutch this round?").
 *
 * ONE CALL TAKES ANSWERS AT A TIME, so a bare !yes always means one thing. A new
 * !call locks the one taking answers (its answers stay, it waits for its
 * result) and takes the room; any number can wait. With more than one waiting,
 * `!call yes 2` names which, and a bare `!call yes` is asked which one.
 *
 * EVERY CALL SETTLES WITHOUT A MOD (Lev, 8 Oct: streamers want the result to
 * drop without typing !call yes). A price or candle call is read off the price
 * (src/live/priceCall.ts). Any other call is a moment only the stream shows, so
 * oddie reads it off the stream (src/live/screenCalls.ts); a mod's !call yes or
 * !call no settles it whenever they like. Viewers never settle a call (Lev, 19
 * Oct): the room's !result let one viewer close the answers and decide it. A
 * moment nobody settled is canceled, no points, when the stream ends.
 *
 * SEEN LATER. A call that runs for hours is said again every quarter hour while
 * chat is moving, and on Twitch the line is pinned, so somebody who arrives in
 * the second hour still sees what to type.
 *
 * One kind of call oddie settles itself: a coin's price (src/live/priceCall.ts),
 * a candle's close, the price at a moment or a touch on the way, read the
 * moment the answer is in. It takes answers for three minutes by default,
 * never past the moment its answer is known.
 *
 * And one more, on Twitch and Kick (Lev, 24 Nov): the stream's own viewer
 * count (src/live/viewerCall.ts). "Will we hit 500 viewers today?" is read
 * off the platform's count from its open on, YES at the first reading there,
 * NO when the stream ends first. Three minutes of answers too, so it runs
 * behind the show's other calls instead of holding the room for hours.
 *
 * Platform-free on purpose: Kick is the first adapter (src/kick), Twitch plugs
 * into the same engine with its own client, and YouTube (src/youtube) runs it
 * votes only (deps.votesOnly).
 */

import { binancePrices, holdAtOpen, parsePriceCall, planFor, readPriceCall, readsOnTheWay, touchAtOpen, whenText, PRICE_SETTLE_LAG_MS, type PriceCall, type PricePlan, type PriceSource } from "./priceCall.js";
import { parseViewerCall, viewerDeadline, viewerMet, viewerWhenText, viewersShort, viewersText, type ViewerCall } from "./viewerCall.js";
import { faceitConfigured, type GameSource } from "../games/faceit.js";
import type { FrameSource } from "../games/frames.js";
import type { ScreenSource } from "../games/screen.js";
import { reportOpened, reportSettled } from "./openedMail.js";

export type Platform = "kick" | "twitch" | "youtube" | "x";
export type Side = "yes" | "no";

export interface ChatMessage {
  platform: Platform;
  channelId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  /** The channel's owner or one of its moderators. */
  canRun: boolean;
  text: string;
  /** The message this one replied to: under a claim, a bare !oddie means it. */
  replyText?: string | null;
  /** The channel's own name, for the market's provenance. */
  channelSlug?: string;
  /** A line oddie said itself, coming back through the platform's chat feed:
   *  never a command, and never the room moving. */
  fromOddie?: boolean;
}

export type LiveCommand =
  /** minutes null: open until it is settled. repeat: `!call repeat`, it opens again after each result. */
  | { kind: "open"; question: string; minutes: number | null; repeat?: boolean }
  /** `!call stop`: the repeating call opens no new round. */
  | { kind: "stop" }
  /** A bare `!call repeat`: how it works. */
  | { kind: "repeat-help" }
  | { kind: "pick"; side: Side }
  /** which: the call's number in the waiting list (1 = oldest), null when not said. */
  | { kind: "settle"; outcome: Side; which: number | null }
  | { kind: "cancel"; which: number | null }
  /** "!call yes <more>": a settle word with a sentence after it. Neither a result nor a question. */
  | { kind: "settle-help" }
  | { kind: "help" }
  | { kind: "market"; claim: string }
  /** `!faceit <nick>` links the channel's FACEIT account; `!faceit off` unlinks; bare, it says how. */
  | { kind: "faceit"; arg: string }
  /** `!me`: the caller's own record, said back to them. Anybody's. */
  | { kind: "me" }
  /** `!top`: this stream's best three callers so far. Anybody's. */
  | { kind: "top" }
  /** `!matches off` / `!matches on`: whether oddie opens a call per match from the stream by itself; bare, it says how. */
  | { kind: "matches"; arg: string }
  /** `!markets on` / `!markets off`: whether !oddie opens real markets in this chat; bare, it says how. */
  | { kind: "markets"; arg: string };

export const CALL_MINUTES_MAX = 30;
/** A call with no length takes answers until it is settled; this only stops one
 *  nobody ever settles from taking answers forever. */
export const CALL_OPEN_MAX_MS = 12 * 60 * 60_000;
/** Earlier answers score more: a right answer's points halve every half hour
 *  after the call opened, never below a tenth. */
export const EARLY_HALF_LIFE_MS = 30 * 60_000;
export const EARLY_FLOOR = 0.1;
/** A call still taking answers is said again this often, if chat moved since. */
export const REMIND_GAP_MS = 15 * 60_000;
/** A price call with no length takes answers this long, never past the moment its answer is known.
 *  A viewer-count call too (src/live/viewerCall.ts). */
export const PRICE_CALL_LOCK_MS = 3 * 60_000;
/** How often a viewer-count call's stream is asked for its count. */
export const VIEWER_POLL_MS = 30_000;
/** A count nobody could read for this long: the call goes back to the mods. */
export const VIEWER_GIVE_UP_MS = 10 * 60_000;
/** A stream dark on every reading for this long has ended. A shorter gap is a
 *  dropped connection, and the same stream comes back. */
export const VIEWER_DARK_MS = 2 * 60_000;
/** The room hears once how close the count is, from this share of the way on. */
export const VIEWER_CLOSE_SHARE = 0.9;
export const QUESTION_MAX = 180;
/** A run of right calls is said next to the name from this many on (🔥3). */
export const STREAK_SHOWN = 3;
/** A person hears their own record (!me) at most this often in one chat. */
export const ME_GAP_MS = 10 * 60_000;
/** Results closer together than this are one stream; a longer gap starts the next. */
export const STREAM_GAP_MS = 3 * 60 * 60_000;
/** A room hears its stream's best callers (!top) at most this often. */
export const TOP_GAP_MS = 60_000;
export const WEEK_MS = 7 * 24 * 60 * 60_000;
/** Monday 00:00 UTC of the week `ms` is in: the weekly boards turn over there. */
export function weekStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
}
/** THE SEASON, a calendar month in UTC (Lev, 3 Nov, after CRSH's seasons with
 *  an end date). At a few calls a show a week barely ranked anybody; a month
 *  gives the board a name and a day it closes on. */
export function seasonStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
/** The first moment of the next season. */
export function seasonEnd(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
/** Somebody who called it, and their run of right calls with this one in. */
export interface Winner { name: string; streak: number }
/** What !me says: settled calls answered and right, the run now, the place in this channel this week. */
export interface CallerRecord { right: number; calls: number; streak: number; weekRank: number | null }
/** How often chat hears who answered and the running split while a call is open. */
export const SPLIT_GAP_MS = 30_000;
/** How often a channel's runners hear how !yes and !no work when nothing is open. */
export const PICK_HELP_GAP_MS = 10 * 60_000;
/** How often the clock asks whether a channel with calls waiting is still live, and
 *  looks for price calls a restart left without their wait. */
export const STREAM_POLL_MS = 60_000;
/** A call nobody settled for this long is put away quietly. */
export const CALL_FORGET_MS = 24 * 60 * 60_000;

const YES_WORD = /^(yes|evet)$/i;
const NO_WORD = /^(no|hay[ıi]r)$/i;

/**
 * What a chat line asks for, or null for ordinary chat. A command must START
 * the line: "!yes" is an answer, "i'd say !yes" is conversation.
 */
export function parseCommand(raw: string): LiveCommand | null {
  const text = String(raw ?? "").trim().replace(/\s+/g, " ");
  const pick = /^!(yes|evet|no|hay[ıi]r)(?=\s|$)/i.exec(text);
  if (pick) return { kind: "pick", side: YES_WORD.test(pick[1]) ? "yes" : "no" };
  if (/^!me(?=\s|$)/i.test(text)) return { kind: "me" };
  if (/^!top(?=\s|$)/i.test(text)) return { kind: "top" };
  // !oddie is the market door; whatever follows is the claim, read like a tag.
  const market = /^!oddie(?=\s|$)\s*(.*)$/i.exec(text);
  if (market) return { kind: "market", claim: market[1].trim() };
  // The channel's FACEIT account: every match it plays opens a call by itself.
  const fx = /^!faceit(?=\s|$)\s*(.*)$/i.exec(text);
  if (fx) return { kind: "faceit", arg: fx[1].trim().replace(/^@/, "").slice(0, 40) };
  // Match calls read off the stream itself: on until the channel says otherwise.
  const mt = /^!matches(?=\s|$)\s*(.*)$/i.exec(text);
  if (mt) return { kind: "matches", arg: mt[1].trim().slice(0, 20) };
  // Real markets in this chat: the streamer's to turn on (a new Twitch channel starts without).
  const mk = /^!markets(?=\s|$)\s*(.*)$/i.exec(text);
  if (mk) return { kind: "markets", arg: mk[1].trim().slice(0, 20) };
  const m = /^!call(?=\s|$)\s*(.*)$/i.exec(text);
  if (!m) return null;
  const rest = m[1].trim();
  if (!rest) return { kind: "help" };
  // "!call yes" settles; "!call yes 2" settles the second call waiting.
  const settle = /^(yes|evet|no|hay[ıi]r)(?:\s+#?(\d{1,2}))?$/i.exec(rest);
  if (settle) return { kind: "settle", outcome: YES_WORD.test(settle[1]) ? "yes" : "no", which: settle[2] ? Number(settle[2]) : null };
  const cancel = /^(cancel|iptal)(?:\s+#?(\d{1,2}))?$/i.exec(rest);
  if (cancel) return { kind: "cancel", which: cancel[2] ? Number(cancel[2]) : null };
  if (/^(stop|dur)$/i.test(rest)) return { kind: "stop" };
  if (/^(repeat|tekrar)$/i.test(rest)) return { kind: "repeat-help" };
  // "!call repeat <question>": the same question opens again after each result,
  // a round or a run at a time, until !call stop (Lev, 4 Nov: on a show nobody
  // should have to type a call between games).
  const rep = /^(?:repeat|tekrar)\s+(.+)$/i.exec(rest);
  if (rep) {
    const inner = parseCommand(`!call ${rep[1]}`);
    return inner?.kind === "open" ? { ...inner, repeat: true } : { kind: "repeat-help" };
  }
  // A settle word with more after it is neither. Live on 8 Oct a streamer pasted
  // "!call yes in chat (the 13:30 utc candle closed ...)" from a DM and it opened
  // as a question on stream, while the call he meant stayed unsettled. Settling
  // on it would guess; "!call no way he clutches this" reads as a question but
  // costs one rephrase, and a junk call costs the room.
  if (/^(yes|evet|no|hay[ıi]r|cancel|iptal)\b/i.test(rest)) return { kind: "settle-help" };
  // A length only at the START, where it cannot be part of the question:
  // "!call 5m will I win" is five minutes; "will he hit 5m followers" is not.
  let minutes: number | null = null;
  let question = rest;
  const dur = /^(\d{1,2})\s*(?:m|min|mins|dk)\b\s*(.*)$/i.exec(rest);
  if (dur) {
    minutes = Math.max(1, Math.min(CALL_MINUTES_MAX, Number(dur[1])));
    question = dur[2].trim();
  }
  if (!question) return { kind: "help" };
  if (question.length > QUESTION_MAX) question = question.slice(0, QUESTION_MAX - 1).trimEnd() + "…";
  return { kind: "open", question, minutes };
}

export interface LiveCall {
  id: string;
  platform: Platform;
  channelId: string;
  question: string;
  openedAt: number;
  /** A timed call locks here; an untimed one only stops at CALL_OPEN_MAX_MS. */
  closesAt: number;
  /** Opened with a length (!call 5m ...): it locks on its own. */
  timed: boolean;
  lockedAt: number | null;
  outcome: Side | null;
  settledAt: number | null;
  /** The FACEIT match this call is about: oddie opened it and settles it (src/live/gameCalls.ts). */
  matchId: string | null;
}

export interface Tally { yes: number; no: number }

/** The points a right answer earns: what share of the room it went against.
 *  Right with 20% agreeing is 80; right with everybody is 1, never 0. */
export function pointsFor(tally: Tally, outcome: Side): number {
  const total = tally.yes + tally.no;
  if (!total) return 0;
  const share = Math.round((tally[outcome] / total) * 100);
  return Math.max(1, 100 - share);
}

/** What an answer given `elapsedMs` after the call opened keeps of its points. */
export function earlyShare(elapsedMs: number): number {
  return Math.max(EARLY_FLOOR, Math.pow(0.5, Math.max(0, elapsedMs) / EARLY_HALF_LIFE_MS));
}

/** A right answer's points: the room it went against, times how early it was. */
export function pointsAt(base: number, elapsedMs: number): number {
  return base > 0 ? Math.max(1, Math.round(base * earlyShare(elapsedMs))) : 0;
}

export const yesPct = (t: Tally): number => {
  const total = t.yes + t.no;
  return total ? Math.round((t.yes / total) * 100) : 0;
};

/* HOW CHAT VOTED (Lev, 24 Nov). A result is a story when the room was wrong:
   "Chat voted no." in the result line, on the card and in the post. It is said
   only when it is exactly true: enough answers to be a vote, and one side
   ahead. Two answers, or a tie, say nothing. */
export const CHAT_VOTE_MIN = 3;
export function chatVoted(t: Tally): Side | null {
  if (t.yes + t.no < CHAT_VOTE_MIN || t.yes === t.no) return null;
  return t.yes > t.no ? "yes" : "no";
}
/** The same, from what a settle hands back: how many were right, of how many. */
export const chatVotedOf = (outcome: Side, right: number, total: number): Side | null =>
  chatVoted(outcome === "yes" ? { yes: right, no: total - right } : { yes: total - right, no: right });

/** A call about the streamer: asked in the first person ("will I win this
 *  game?", the hello's own example), by them or by a mod typing for them. */
export const aboutStreamer = (q: string): boolean => /(^|[^\p{L}\p{N}_'])(i|i'm|i'll|i've|im|my|me|myself)(?=$|[^\p{L}\p{N}_'])/iu.test(q);

/** A settled call's own page, under its channel's (src/live/channelRoutes.ts):
 *  the card to post. "" where the channel's page is not linked (X, YouTube). */
export const callPageUrl = (channelUrl: string, callId: string): string => (channelUrl ? `${channelUrl.replace(/\/+$/, "")}/call/${callId}` : "");

/* ----------------------------------------------------------------- copy -- */
// One line each: stream chats do not keep line breaks, and a wall scrolls away.

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
const left = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 60 ? `${Math.ceil(s / 60)} min` : `${s}s`;
};
const split = (t: Tally) => `${yesPct(t)}% YES from ${n(t.yes + t.no, "call", "calls")}`;
const short = (q: string, max = 60) => (q.length > max ? q.slice(0, max - 1).trimEnd() + "…" : q);
/* WHO, SAID IN A FEW NAMES (Lev, 16 Oct: oddie's lines were too long, and the
   room wants to see who called what). Three names, then how many more. */
const at = (name: string) => `@${name.replace(/^@+/, "")}`;
type Named = string | Winner;
const nameOf = (w: Named) => (typeof w === "string" ? w : w.name);
const runOf = (w: Named) => (typeof w === "string" || w.streak < STREAK_SHOWN ? 0 : w.streak);
const fire = (n: number) => (n >= STREAK_SHOWN ? ` 🔥${n}` : "");
const who = (names: Named[], count = names.length) =>
  names.slice(0, 3).map((w) => at(nameOf(w)) + fire(runOf(w))).join(" ") + (count > 3 ? ` +${count - 3}` : "");
const leading = (t: Tally) => (t.no > t.yes ? `${100 - yesPct(t)}% no` : `${yesPct(t)}% yes`);

export const LIVE_COPY = {
  /** One short line (Lev, 16 Oct) that says what to type, since a new room has
   *  never seen !yes (Lev, 26 Oct, before Showdown's first stream). A call with
   *  no length takes answers into the game, so it says early answers score more,
   *  as a match's own call does (src/live/gameCalls.ts). */
  opened: (q: string, minutes: number | null, url: string, note = "") =>
    `call: "${q}" ${note ? `${note} ` : ""}Type !yes or !no${minutes === null ? ", earlier calls score more" : `, locks in ${minutes} min`}${url ? `. Standings: ${url}` : ""}`,
  noResult: (q: string) => `No result came in for "${short(q)}" before the stream ended, so it's canceled. No points.`,
  /** The answers since the last such line, by name, and where the room stands. */
  split: (t: Tally, yesBy: string[], noBy: string[], msLeft: number | null) => {
    const sides = [yesBy.length ? `${who(yesBy)} yes` : "", noBy.length ? `${who(noBy)} no` : ""].filter(Boolean).join(" · ");
    return `${sides ? `${sides} → ` : ""}${leading(t)}${msLeft === null ? "" : `, ${left(msLeft)} left`}`;
  },
  /** `settleBy`: who settles a call the screen has not (SETTLE_HINT_AFTER_MS), else null. */
  reminder: (q: string, t: Tally, msLeft: number | null, settleBy: string | null = null) =>
    `still open: "${q}"${t.yes + t.no ? ` ${leading(t)}` : ""}${msLeft === null ? "" : `, ${left(msLeft)} left`}. !yes or !no${settleBy === null ? "" : `. Not on screen yet: ${settleBy} or a mod settles it with !call yes or !call no`}`,
  locked: (t: Tally) => t.yes + t.no
    ? `Calls are locked: ${split(t)}. Mods settle it with !call yes or !call no.`
    : "Calls are locked for this one. The next one is yours.",
  /** `when` is priceCall's whenText: "when the 30m candle closes", "at 14:13 UTC". */
  lockedPrice: (t: Tally, when: string) =>
    `${t.yes + t.no ? `Calls are locked: ${split(t)}.` : "Calls are locked for this one."} oddie settles it ${when}.`,
  priceToMods: (q: string) => `"${q}" is yours to settle: !call yes or !call no.`,
  /** A new call took the room: the old one keeps its answers and waits. Also a
   *  runner's answer to a stray !yes while oddie reads a price call. */
  switched: (q: string, t: Tally, when: string | null = null) => (t.yes + t.no
    ? `Locked "${short(q)}" at ${split(t)}.`
    : `Locked "${short(q)}".`) + (when ? ` oddie settles it ${when}.` : " It waits for its result."),
  /** The result in one line (Mozaiiic at Showdown, 28 Oct: "On stream: VICTORY
   *  WINNER: STANCIFKA AMOUNT WON: +…. NO: "…". @a @b called it." read as
   *  several sentences and was not clear): the outcome on its question, then
   *  who called it. The question stays, since a tournament's call can wait
   *  beside a game's. `winners`: who called it right, earliest first; a run of
   *  🔥3 or more is named first, so the streaks are what the room sees. `top`
   *  stays on the page.
   *
   *  THE ROOM WAS WRONG (Lev, 24 Nov): when chat voted the other way
   *  (chatVoted), the line says so, the one dry thing a streamer reads out
   *  loud. `star` is the streamer's name on a call about them: a YES the room
   *  voted against is theirs, "<star> didn't check the chat." Never on a NO,
   *  which would be a jab at somebody who just lost. `url` is the call's own
   *  page (callPageUrl), where its card is. */
  settled: (q: string, outcome: Side, right: number, total: number, _top: number, url: string, winners: Named[] = [], star: string | null = null) => {
    const it = `Result: ${outcome.toUpperCase()} on "${short(q, 50)}"`;
    const where = url ? ` Card: ${url}` : "";
    if (!total) return `${it} The next one opens with !call.${where}`;
    const voted = chatVotedOf(outcome, right, total);
    const wrong = voted && voted !== outcome ? ` Chat voted ${voted}.${star && outcome === "yes" ? ` ${star} didn't check the chat.` : ""}` : "";
    if (!right) return `${it}${wrong} Nobody called it.${where}`;
    const shown = [...winners].sort((a, b) => runOf(b) - runOf(a));
    return `${it}${wrong} Called it: ${shown.length ? who(shown, right) : `${right} of ${total}`}.${where}`;
  },
  /** The screen gave the call up (screenGivesUp): the mods settle it. */
  screenUnsure: (q: string) => `No sure result on "${short(q, 50)}" from the screen. Mods: !call yes or !call no settles it.`,
  /** !me, to the person who asked. Never a link: it is said on every platform. */
  me: (name: string, r: CallerRecord) => r.calls
    ? `${at(name)}: ${r.right}/${r.calls} right${fire(r.streak).replace(/^ /, " · ")}${r.weekRank ? ` · #${r.weekRank} here this week` : ""}`
    : `${at(name)}: your record starts with the next result. !yes or !no on the next call`,
  /** The week's first call in a channel names last week's best there. */
  lastWeekTop: (name: string, right: number, calls: number) => `last week's top caller here: ${at(name)}, ${right}/${calls} right`,
  /** This stream's best callers by points (Lev, 26 Oct), at most three. */
  streamTop: (top: Array<{ username: string; points: number }>) =>
    `top callers this stream: ${top.slice(0, 3).map((t) => `${at(t.username)} ${t.points} pts`).join(" · ")}`,
  streamTopNone: "top callers this stream: none yet. !yes or !no on the next call",
  /** More than one call waits and the command did not say which. */
  which: (verb: string, qs: string[]) =>
    `Which one? ${qs.slice(0, 5).map((q, i) => `!call ${verb} ${i + 1} for "${short(q, 40)}"`).join(", ")}`,
  canceled: "Call canceled. The next one opens with !call.",
  /* !call repeat (Lev, 4 Nov): one call that comes back after every result. The
     round number keeps each line its own, and X refuses a line it just took. */
  next: (q: string, round: number, minutes: number | null) =>
    `round ${round}: "${q}" Type !yes or !no${minutes === null ? "" : `, locks in ${minutes} min`}`,
  repeatOn: "It opens again after each result. !call stop ends it.",
  repeatOff: "Repeat off: no new round after this one.",
  repeatNone: "Nothing is repeating. Start one with !call repeat and the question.",
  repeatHow: "To bring a call back after every result: !call repeat <question>. !call stop ends it.",
  predictionLong: "Twitch predictions take 45 characters at most, so this one runs in chat. A shorter question opens there too.",
  busy: (q: string) => `One call at a time: "${q}" is still running.`,
  settleFirst: (q: string) => `To settle "${short(q)}": !call yes or !call no.`,
  settleOnly: "To settle, type only !call yes or !call no. To open a call, start with the question.",
  help: "Mods: !call <question> opens a vote (!call 5m <question> locks in five minutes, !call repeat <question> brings it back after each result), chat answers !yes or !no. oddie settles price calls itself and reads results off the stream; mods can always settle with !call yes or !call no. !me shows your record.",
  pickHelp: "No vote is open. Start one with !call <question>, then chat answers !yes or !no. Take a market's YES or NO on its link.",
  // No line of oddie's starts with a command: an echo of it is never one.
  marketHelp: "Open a market with !oddie and a claim with a yes or no and a date, anybody can take it and oddie settles it. Reply !oddie to a message to open one on it.",
  hello: "oddie is here. Mods: !call will I win this game? opens a call, chat answers !yes or !no and oddie settles it off the stream. Anybody can open a real market with !oddie <claim>.",
  /* CS2 on FACEIT (src/games/faceit.ts, src/live/gameCalls.ts). */
  faceitHow: "Mods: !faceit <nickname> links this channel's FACEIT account. Every CS2 match it plays then opens a call by itself, and oddie settles it from the result.",
  faceitStatus: (nick: string) => `FACEIT: linked to ${nick}. Every match opens a call by itself. !faceit off unlinks.`,
  faceitLinked: (nick: string) => `FACEIT linked: ${nick}. From now on every match ${nick} plays opens a call by itself, and oddie settles it when the match ends.`,
  faceitUnlinked: "FACEIT unlinked. Calls open with !call again.",
  faceitNotFound: (nick: string) => `No FACEIT player called "${nick}". Check the spelling on faceit.com.`,
  faceitOff: "FACEIT is not set up on oddie yet.",
  /* Match calls read off the stream itself (src/live/frameCalls.ts). */
  /* The stream read by oddie (Lev, 16 Oct): a call settles itself when its
     result shows on screen (src/live/screenCalls.ts), and on Twitch and Kick a
     CS2 or Dota 2 match opens its own call (src/live/frameCalls.ts). One switch for both. */
  matchesHow: "Mods: oddie reads this stream. A call settles itself when its result shows on screen, and on Twitch and Kick every CS2 or Dota 2 match opens a call by itself. !matches off stops that, !matches on brings it back.",
  matchesOff: "Stream reading off. Calls settle with !call yes or !call no, and no match opens a call by itself. !matches on brings it back.",
  matchesOn: "Stream reading on. A call settles itself when its result shows on screen, and CS2 or Dota 2 matches open their own calls where oddie can read them.",
  /* A channel that runs votes only (YouTube, whose rules keep money out of the chat): oddie
     never names a market there, and never posts a link. */
  helloVotes: "oddie is here. Mods open a vote with !call <question>, chat answers !yes or !no, and oddie settles price calls itself.",
  /* A chat without real markets (a Twitch channel since 5 Nov, until its
     streamer says !markets on): the hello names calls only. */
  helloCalls: "oddie is here. Mods: !call will I win this game? opens a call, chat answers !yes or !no and oddie settles it off the stream.",
  marketsOn: "Markets on: !oddie <claim> opens a real market anybody can take, settled by oddie. !markets off turns them off.",
  marketsOff: "Markets off: this chat runs calls only. !markets on brings them back.",
  marketsHow: "Calls only here. The streamer can turn real markets on with !markets on, and !markets off turns them off again.",
  marketsOwner: "Only the streamer can turn markets on.",
  votesHere: "Here oddie runs votes: mods open one with !call <question>, chat answers !yes or !no.",
  pickHelpVotes: "No vote is open. Start one with !call <question>, then chat answers !yes or !no.",
  matchesElsewhere: "Match calls read off the stream run on Twitch and Kick. Here mods open them with !call <question>.",
  /* A VIEWER-COUNT CALL (src/live/viewerCall.ts), on Twitch and Kick. */
  /** In the opening line, after the question: where the count stands. */
  viewersNow: (count: number) => `${viewersText(count)} watching now.`,
  /** Asked for a number the stream already has: no call. */
  viewersAlready: (count: number) => `Already at ${viewersText(count)} viewers. Ask for a number above that.`,
  /** Once a call, nine tenths of the way there. */
  viewersClose: (count: number, short: number) => `${viewersText(count)} watching, ${viewersText(short)} to go.`,
  /** In front of the result line, the reading it was settled on. */
  viewersYes: (count: number) => `${viewersText(count)} watching.`,
  /** `peak`: the highest count read, when every reading since the open is in it. */
  viewersEnded: (peak: number | null) => `The stream ended.${peak === null ? "" : ` Highest count read: ${viewersText(peak)}.`}`,
  viewersTimeUp: (peak: number | null) => `Time is up.${peak === null ? "" : ` Highest count read: ${viewersText(peak)}.`}`,
  /** !oddie on a viewer count: a number anybody can buy carries no money. */
  viewersNoMarket: "A viewer count is a call, never a market. Mods open it with !call and the same question.",
};

/* --------------------------------------------------------------- engine -- */

export interface LiveStore {
  /** The channel's call taking answers, if any: there is at most one. */
  current(platform: Platform, channelId: string): Promise<LiveCall | null>;
  /** Every call not settled or canceled, oldest first: the one taking answers
   *  and the ones waiting for their result. */
  unsettled(platform: Platform, channelId: string): Promise<LiveCall[]>;
  /** Opens a call, or returns null when the channel already has one taking
   *  answers (the store enforces it, so two mods at once cannot open two). */
  open(input: { platform: Platform; channelId: string; question: string; openedById: string; openedByName: string; openedAt: number; closesAt: number; timed: boolean; matchId?: string | null }): Promise<LiveCall | null>;
  /** One answer per person per call: true when this one is new. */
  pick(call: LiveCall, userId: string, username: string, side: Side, at: number): Promise<boolean>;
  tally(callId: string): Promise<Tally>;
  /** Locks a call once: true only for the caller that locked it. */
  lock(callId: string, at: number): Promise<boolean>;
  /** Settles once and scores each right answer by how early it came (pointsAt
   *  over `points`); null when already settled. `top` is the best one scored. */
  settle(callId: string, outcome: Side, points: number, at: number): Promise<{ right: number; total: number; top: number; winners?: Winner[] } | null>;
  /** !me. Absent: !me is chat. */
  record?(platform: Platform, userId: string, channelId: string, now: number): Promise<CallerRecord>;
  /** Calls the channel opened at or after `since`: the week's first call says last week's best. */
  openedSince?(platform: Platform, channelId: string, since: number): Promise<number>;
  /** The channel's best caller over [since, until), with at least one right call. */
  topCaller?(platform: Platform, channelId: string, since: number, until: number): Promise<{ username: string; right: number; calls: number } | null>;
  /** Keeps the picture a call was settled on, for its channel page. Absent: nothing kept. */
  saveFrame?(callId: string, jpeg: Buffer, seen: string): Promise<void>;
  /** The channel as its streamer is called, for a result about them (LIVE_COPY.settled). Absent: never named. */
  channelName?(platform: Platform, channelId: string): Promise<string | null>;
  /** When the channel's latest results came in, newest first: where this stream's run of them starts. */
  settledTimes?(platform: Platform, channelId: string, limit: number): Promise<number[]>;
  /** The channel's best callers by points over results at or after `since`, best first; the house never ranks. */
  topCallers?(platform: Platform, channelId: string, since: number, limit: number): Promise<Array<{ username: string; points: number }>>;
  cancel(callId: string, at: number): Promise<boolean>;
  /** Calls taking answers whose time is up. */
  due(now: number): Promise<LiveCall[]>;
  /** Calls taking answers, in every channel: the reminder walks them. */
  takingAnswers(): Promise<LiveCall[]>;
  /** Every call not settled or canceled, in every channel, oldest first: the
   *  clock walks them for waits a restart lost and streams that ended. */
  everyUnsettled(): Promise<LiveCall[]>;
  /** The channel's FACEIT account: found by oddie from the channel's name, or set with !faceit. */
  faceit(platform: Platform, channelId: string): Promise<{ id: string; nick: string } | null>;
  /** Null unlinks AND stops oddie looking for one again; a link turns the looking back on. */
  setFaceit(platform: Platform, channelId: string, link: { id: string; nick: string } | null): Promise<void>;
  /** Every channel with a FACEIT account: the clock's game pass walks them. */
  withFaceit(): Promise<Array<{ platform: Platform; channelId: string; name: string | null; faceitId: string; faceitNick: string; gsiSeenAt: number | null }>>;
  /** The channel's Game State Integration token (src/games/gsi.ts): made on first ask when `create`. */
  gsiToken(platform: Platform, channelId: string, create: boolean): Promise<string | null>;
  channelByGsiToken(token: string): Promise<{ platform: Platform; channelId: string; slug: string; name: string | null } | null>;
  markGsiSeen(platform: Platform, channelId: string, at: number): Promise<void>;
  /** Active channels with no account that oddie has not looked for lately. */
  withoutFaceit(now: number): Promise<Array<{ platform: Platform; channelId: string; slug: string; name: string | null }>>;
  markFaceitProbe(platform: Platform, channelId: string, at: number): Promise<void>;
  /** Every active channel, for the picture pass (src/live/frameCalls.ts): with
   *  what else may read it (a FACEIT account, a talking game) and whether it wants match calls. */
  channels(): Promise<Array<{ platform: Platform; channelId: string; slug: string; name: string | null; faceitId: string | null; matchCalls: boolean; gsiSeenAt: number | null }>>;
  /** `!matches off` and `!matches on`: whether oddie may open match calls from the stream by itself. */
  setMatchCalls(platform: Platform, channelId: string, on: boolean): Promise<void>;
  /** Whether !oddie opens real markets in this chat. Absent: it does, where the platform allows them. */
  marketsOn?(platform: Platform, channelId: string): Promise<boolean>;
  /** `!markets on` and `!markets off`. */
  setMarkets?(platform: Platform, channelId: string, on: boolean): Promise<void>;
  /** The channel's `!call repeat`, kept where a restart finds it. Absent: no repeats. */
  repeat?(platform: Platform, channelId: string): Promise<Repeat | null>;
  setRepeat?(platform: Platform, channelId: string, r: Repeat | null): Promise<void>;
}

/** A call that opens again after each of its results: who asked, and how many rounds so far. */
export interface Repeat { question: string; minutes: number | null; byId: string; byName: string; round: number }

export interface LiveDeps {
  store: LiveStore;
  now(): number;
  /** Say one line in this channel's chat, as oddie. The line's id when the
   *  platform gives one back. */
  say(platform: Platform, channelId: string, text: string, replyTo?: string): Promise<string | void>;
  /** Pin a line oddie said, where the platform allows it (Twitch). */
  pin?(platform: Platform, channelId: string, messageId: string): Promise<void>;
  /** Take oddie's pin down again, when the call it was for is over. */
  unpin?(platform: Platform, channelId: string): Promise<void>;
  /** Where this channel's standings live on oddie. */
  standingsUrl(platform: Platform, channelId: string): Promise<string>;
  log(line: string, extra?: Record<string, unknown>): void;
  /** The market door (src/live/claims.ts). Absent: !oddie is only explained. */
  market?(msg: ChatMessage, claim: string): Promise<string>;
  /** Votes only (YouTube): !oddie, the help lines and the match calls never name a
   *  market there, and standingsUrl gives "" so no line carries a link. */
  votesOnly?: boolean;
  /** Where a price call's numbers are read. Absent: Binance. */
  prices?: PriceSource;
  /** Is the channel live now? null when the platform did not answer. Absent: a
   *  stream's end is never seen, and room calls wait for a report or the mods. */
  streamLive?(platform: Platform, channelId: string): Promise<boolean | null>;
  /** Where FACEIT matches are read (src/games/faceit.ts). Absent: the one
   *  configured at boot from FACEIT_API_KEY, if any. */
  games?: GameSource;
  /** The stream's state and category now, for the picture pass (src/live/frameCalls.ts),
   *  and how many are watching, for a viewer-count call (src/live/viewerCall.ts). */
  streamGame?(platform: Platform, channelId: string): Promise<{ live: boolean; game: string | null; viewers?: number | null } | null>;
  /** Where a picture of the stream is taken and read (src/games/frames.ts). Absent: no picture pass. */
  frames?: FrameSource;
  /** Where a room call's answer is read off the stream (src/games/screen.ts). Absent: the screen settles nothing. */
  screen?: ScreenSource;
  /** The operator hears about an outage only a person can fix (src/server.ts
   *  tgOpsAlert, on Telegram). Absent: a log line and nothing else. */
  alertOps?(text: string): Promise<void>;
  /** The platform's own prediction panel (Twitch, src/twitch/routes.ts): a call
   *  opens there too, and its result or cancel ends it. "too-long": the
   *  question does not fit there. Absent, or refused: the call runs in chat alone. */
  predictionOpen?(call: LiveCall, minutes: number | null): Promise<"opened" | "too-long" | null>;
  /** null: canceled, the points go back. */
  predictionEnd?(call: LiveCall, outcome: Side | null): Promise<void>;
}

/** A price call between its lock and its result. `atEnd`: a touch the price
 *  was already past at the open, read where its window ends (readPriceCall). */
interface PriceWait { call: LiveCall; pc: PriceCall; plan: PricePlan; atEnd: boolean; nextTryAt: number; busy: boolean }

/** How often a touch is looked for while its window is open, and how soon a
 *  source that did not answer is asked again. */
export const PRICE_POLL_MS = 15_000;
/** How long after its time is up oddie keeps reading before the call goes back to the mods. */
export const PRICE_GIVE_UP_MS = 10 * 60_000;

const lastSplit = new Map<string, number>();
/** Who answered each call since its last split line, by side. */
const newSince = new Map<string, { yes: string[]; no: string[] }>();
/** Where a stream's viewer count can be read (src/live/viewerCall.ts). X hands
 *  none over; YouTube's is not read. */
const VIEWER_PLATFORMS: ReadonlySet<Platform> = new Set<Platform>(["twitch", "kick"]);
/** The viewer-count call in a question, where the platform publishes a count. Anywhere else it is a room call. */
export const viewerCallOf = (c: { platform: Platform; question: string }): ViewerCall | null =>
  (VIEWER_PLATFORMS.has(c.platform) ? parseViewerCall(c.question) : null);
/** A moment only the stream shows: settled off the stream or by a mod, not by a price, a match or a viewer count. */
export const isRoomCall = (c: LiveCall): boolean => !c.matchId && !parsePriceCall(c.question) && !viewerCallOf(c);
/** Price calls oddie settles itself, from their lock on. Kept in memory: after
 *  a restart the clock gives each locked price call its wait back. */
const priceWaits = new Map<string, PriceWait>();
/** Price calls oddie could not read and handed to the mods. The clock gives a
 *  locked price call its wait back after a restart; without this it gave one
 *  back a minute after the hand-over too, and the room heard "yours to settle"
 *  every minute until a mod did. */
const handedToMods = new Set<string>();
/** A viewer-count call from its open to its result. Kept in memory: after a
 *  restart the clock gives each one its wait back, without the readings it lost. */
interface ViewerWait {
  call: LiveCall; vc: ViewerCall; deadline: number | null; nextTryAt: number; busy: boolean;
  /** The highest count read, and whether every reading since the open is in it. */
  peak: number | null; whole: boolean;
  /** When the platform last said something this call can be read from, and
   *  since when it has not: no answer, or a stream never seen on air. */
  readAt: number | null; unreadSince: number | null;
  /** Seen on air since this wait began, and since when every reading found it
   *  dark. Dark before it was ever seen on air is a stream not started yet. */
  live: boolean; darkSince: number | null;
  /** The room heard how close the count is. */
  nudged: boolean;
}
const viewerWaits = new Map<string, ViewerWait>();
const lastPickHelp = new Map<string, number>();
/** When each person last heard their own record, per chat. */
const lastMe = new Map<string, number>();
/** When each room last heard its stream's best callers (!top). */
const lastTop = new Map<string, number>();
/** Per channel: seen live since its calls opened. A live channel going dark is the stream ending. */
const seenLive = new Map<string, boolean>();
let lastWatch = 0;
/** When a channel's chat last moved, and when each call was last said. */
const lastActivity = new Map<string, number>();
const lastSaid = new Map<string, number>();
/** Test seam. */
export function _resetLive(): void {
  lastSplit.clear(); newSince.clear(); lastPickHelp.clear(); lastMe.clear(); lastTop.clear(); lastActivity.clear(); lastSaid.clear(); priceWaits.clear(); handedToMods.clear();
  viewerWaits.clear(); seenLive.clear(); lastWatch = 0;
}
/** Test seam: what a restart forgets (the waits in memory), the store keeps. */
export function _forgetWaits(): void { priceWaits.clear(); viewerWaits.clear(); handedToMods.clear(); lastWatch = 0; }

const roomKey = (m: { platform: Platform; channelId: string }) => `${m.platform}:${m.channelId}`;

async function sayQuiet(deps: LiveDeps, m: { platform: Platform; channelId: string }, text: string, replyTo?: string): Promise<string | null> {
  try { const id = await deps.say(m.platform, m.channelId, text, replyTo); return typeof id === "string" && id ? id : null; }
  catch (e) { deps.log("live chat line not delivered", { err: (e as Error).message }); return null; }
}

/**
 * THIS STREAM'S BEST CALLERS (Lev, 26 Oct). A stream is the channel's latest
 * run of results with no gap of STREAM_GAP_MS between them, the last one no
 * longer ago than that: the store keeps results, not when a stream went live,
 * and this reads the same on every platform. Null when the run is empty.
 */
async function streamTop(deps: LiveDeps, m: { platform: Platform; channelId: string }, now: number): Promise<{ results: number; top: Array<{ username: string; points: number }> } | null> {
  if (!deps.store.settledTimes || !deps.store.topCallers) return null;
  const times = await deps.store.settledTimes(m.platform, m.channelId, 50);
  if (!times.length || now - times[0] > STREAM_GAP_MS) return null;
  let start = times[0], results = 1;
  for (let i = 1; i < times.length && start - times[i] <= STREAM_GAP_MS; i++) { start = times[i]; results++; }
  const top = (await deps.store.topCallers(m.platform, m.channelId, start, 3)).filter((t) => t.points > 0);
  return { results, top };
}

/** What a room call's result line carries besides the result: the call's own
 *  page, and the streamer's name when the call is about them (aboutStreamer). */
async function resultExtras(deps: LiveDeps, call: LiveCall): Promise<{ url: string; star: string | null }> {
  const url = callPageUrl(await deps.standingsUrl(call.platform, call.channelId), call.id);
  const star = aboutStreamer(call.question) && deps.store.channelName
    ? await deps.store.channelName(call.platform, call.channelId).catch(() => null) : null;
  return { url, star };
}

/** After a result, from the stream's second on, its best callers so far: X
 *  closes the chat with the stream, so the room sees them before it ends,
 *  wherever it ends. Never in the way of the result line said before it. */
export async function sayStreamTop(deps: LiveDeps, m: { platform: Platform; channelId: string }, now: number): Promise<void> {
  const s = await streamTop(deps, m, now).catch((e) => { deps.log("live stream top not read", { err: (e as Error).message }); return null; });
  if (s && s.results >= 2 && s.top.length) await sayQuiet(deps, m, LIVE_COPY.streamTop(s.top));
}

/** The same words, and for a price question the same moment: "the next 5m
 *  candle" asked again once the candle has turned is the next round. */
/** Two wordings of one question: case, spacing and a closing "?" or "!" do not count. */
function sameQuestion(a: string, b: string): boolean {
  const words = (q: string) => q.toLowerCase().replace(/\s+/g, " ").replace(/[\s?!.]+$/, "").trim();
  return words(a) === words(b);
}

function sameCall(call: LiveCall, question: string, now: number): boolean {
  if (!sameQuestion(call.question, question)) return false;
  const pc = parsePriceCall(question);
  return !pc || planFor(pc, now).to === planFor(pc, call.openedAt).to;
}

/** When a new call stops taking answers: its own length, or for a price call
 *  three minutes by default and never past the moment its answer is known. A
 *  viewer-count call the same: left open it would hold the room for the whole
 *  stream, and the show's other calls open behind the one taking answers. */
function closeFor(platform: Platform, question: string, asked: number | null, now: number): { closesAt: number; minutes: number | null; pc: PriceCall | null } {
  let minutes = asked;
  let closesAt = now + (minutes === null ? CALL_OPEN_MAX_MS : minutes * 60_000);
  const pc = minutes === null ? parsePriceCall(question) : null;
  if (pc) {
    closesAt = Math.min(now + PRICE_CALL_LOCK_MS, planFor(pc, now).to);
    minutes = Math.max(1, Math.ceil((closesAt - now) / 60_000));
  }
  const vc = viewerCallOf({ platform, question });
  if (vc) {
    if (asked === null) closesAt = now + PRICE_CALL_LOCK_MS;
    closesAt = Math.min(closesAt, viewerDeadline(vc, now) ?? closesAt);
    minutes = Math.max(1, Math.ceil((closesAt - now) / 60_000));
  }
  return { closesAt, minutes, pc };
}

/**
 * THE WEEK TURNS OVER (Lev, 16 Oct): the channel's first call of the week names
 * last week's best caller there, after the call's own line. The store counts
 * the week's calls, so a restart or a second instance does not say it twice.
 */
async function sayLastWeek(deps: LiveDeps, m: { platform: Platform; channelId: string }, now: number): Promise<void> {
  if (!deps.store.openedSince || !deps.store.topCaller) return;
  const week = weekStart(now);
  const n = await deps.store.openedSince(m.platform, m.channelId, week).catch(() => 0);
  if (n !== 1) return;
  const top = await deps.store.topCaller(m.platform, m.channelId, week - WEEK_MS, week).catch(() => null);
  if (top) await sayQuiet(deps, m, LIVE_COPY.lastWeekTop(top.username, top.right, top.calls));
}

/** Pin a call's line where the platform can; a refusal never stops the call. */
async function pinQuiet(deps: LiveDeps, m: { platform: Platform; channelId: string }, messageId: string | null): Promise<void> {
  if (!messageId || !deps.pin) return;
  try { await deps.pin(m.platform, m.channelId, messageId); }
  catch (e) { deps.log("live pin failed", { platform: m.platform, channel: m.channelId, err: (e as Error).message.slice(0, 200) }); }
}
async function unpinQuiet(deps: LiveDeps, m: { platform: Platform; channelId: string }): Promise<void> {
  if (!deps.unpin) return;
  try { await deps.unpin(m.platform, m.channelId); }
  catch (e) { deps.log("live unpin failed", { platform: m.platform, channel: m.channelId, err: (e as Error).message.slice(0, 200) }); }
}

/** A locked call that names a coin's price waits for it; any other waits for the
 *  mods. Returns when it settles, for the room ("when the 30m candle closes"). */
async function waitForPrice(call: LiveCall, deps: LiveDeps): Promise<string | null> {
  const pc = parsePriceCall(call.question);
  if (!pc) return null;
  const plan = planFor(pc, call.openedAt);
  // A touch the price was already past at the open, or a hold it had already
  // broken, is read where its window ends, and the room hears that moment.
  // Unread, it is looked for on the way; readPriceCall reads the open again.
  let atEnd = false;
  if (pc.kind === "touch" || pc.kind === "hold") {
    const ref = await (deps.prices ?? binancePrices).priceAt(pc.asset, call.openedAt).catch(() => null);
    atEnd = ref !== null && (pc.kind === "touch" ? touchAtOpen(pc, ref).met : holdAtOpen(pc, ref).broken);
  }
  // A touch, hold or ATH is looked for from the lock on; anything else is read once its time is up.
  priceWaits.set(call.id, { call, pc, plan, atEnd, nextTryAt: readsOnTheWay(pc) && !atEnd ? 0 : plan.to + PRICE_SETTLE_LAG_MS, busy: false });
  return whenText(pc, plan, atEnd);
}

/** How many are watching, as the platform said it: null when it gave no count. */
function countOf(info: { live: boolean; viewers?: number | null } | null): number | null {
  return info && info.live && typeof info.viewers === "number" && Number.isFinite(info.viewers) ? Math.max(0, Math.floor(info.viewers)) : null;
}

/** The first count that settles it: 500, or 501 for "more than 500". */
const viewersNeeded = (vc: ViewerCall): number => (vc.above ? vc.target + 1 : vc.target);

/** Start reading a viewer-count call's stream. `atOpen`: what the platform
 *  said as the call opened, so every reading since is in its peak. Without it
 *  (a restart) the peak is never said, the "close" line is taken as said, and
 *  the stream has to be seen on air again before going dark can end it. */
function watchViewers(call: LiveCall, vc: ViewerCall, now: number, atOpen?: { live: boolean; count: number | null }): ViewerWait {
  const first = atOpen?.count ?? null;
  const w: ViewerWait = {
    call, vc, deadline: viewerDeadline(vc, call.openedAt), nextTryAt: first === null ? now : now + VIEWER_POLL_MS, busy: false,
    peak: first, whole: atOpen !== undefined, readAt: first === null ? null : now, unreadSince: null, live: atOpen?.live === true, darkSince: null,
    // An open already nine tenths of the way says so in its own line.
    nudged: atOpen === undefined || (first !== null && first >= Math.ceil(viewersNeeded(vc) * VIEWER_CLOSE_SHARE)),
  };
  viewerWaits.set(call.id, w);
  return w;
}

/** When a viewer-count call settles, for the room; null for any other call. */
function viewerWhen(call: LiveCall): string | null {
  const vc = viewerCallOf(call);
  return vc ? viewerWhenText(vc, viewerDeadline(vc, call.openedAt)) : null;
}

/** The pin is for the call taking answers: with none left in the channel, it comes down. */
async function unpinIfIdle(deps: LiveDeps, m: { platform: Platform; channelId: string }): Promise<void> {
  if (!deps.unpin) return;
  const open = await deps.store.current(m.platform, m.channelId).catch(() => null);
  if (!open) await unpinQuiet(deps, m);
}

/** Lock a call that is due and tell the room. Once, whoever gets there first. */
async function lockAndSay(call: LiveCall, deps: LiveDeps): Promise<boolean> {
  if (!(await deps.store.lock(call.id, deps.now()))) return false;
  lastSplit.delete(call.id); newSince.delete(call.id); lastSaid.delete(call.id);
  const tally = await deps.store.tally(call.id);
  const when = (await waitForPrice(call, deps)) ?? viewerWhen(call);
  await sayQuiet(deps, call, when ? LIVE_COPY.lockedPrice(tally, when) : LIVE_COPY.locked(tally));
  await unpinIfIdle(deps, call);
  if (viewerCallOf(call)) await resumeRepeat(deps, call);
  return true;
}

/**
 * Read a locked price call and settle it, as a mod's !call yes would, with the
 * number in front. A mod who settled or canceled first wins: the store settles
 * once. Not readable by ten minutes after its time, the call goes back to the
 * mods in one line.
 */
async function settlePrice(w: PriceWait, deps: LiveDeps): Promise<boolean> {
  const source = deps.prices ?? binancePrices;
  const now = deps.now();
  const read = await readPriceCall(w.pc, w.plan, w.call.openedAt, source, now).catch((e) => {
    deps.log("live price not read", { id: w.call.id, asset: w.pc.asset, kind: w.pc.kind, err: (e as Error).message });
    return null;
  });
  if (read === "wait") {
    w.nextTryAt = readsOnTheWay(w.pc) && !w.atEnd ? now + PRICE_POLL_MS : w.plan.to + PRICE_SETTLE_LAG_MS;
    return false;
  }
  if (!read) {
    if (now - w.plan.to < PRICE_GIVE_UP_MS) { w.nextTryAt = now + PRICE_POLL_MS; return false; }
    priceWaits.delete(w.call.id);
    handedToMods.add(w.call.id);
    const still = (await deps.store.unsettled(w.call.platform, w.call.channelId).catch(() => [] as LiveCall[])).some((c) => c.id === w.call.id);
    if (still) await sayQuiet(deps, w.call, LIVE_COPY.priceToMods(w.call.question));
    deps.log("live price handed to mods", { platform: w.call.platform, channel: w.call.channelId, id: w.call.id });
    return false;
  }
  const tally = await deps.store.tally(w.call.id);
  const points = pointsFor(tally, read.outcome);
  const done = await deps.store.settle(w.call.id, read.outcome, points, now);
  priceWaits.delete(w.call.id);
  if (!done) return false;
  await deps.predictionEnd?.(w.call, read.outcome).catch(() => {});
  const { url, star } = await resultExtras(deps, w.call);
  await sayQuiet(deps, w.call, `${read.said} ${LIVE_COPY.settled(w.call.question, read.outcome, done.right, done.total, done.top, url, done.winners, star)}`);
  await sayStreamTop(deps, w.call, now);
  deps.log("live call settled", { platform: w.call.platform, channel: w.call.channelId, id: w.call.id, outcome: read.outcome, right: done.right, total: done.total, by: "price" });
  // The operator's mail (src/live/openedMail.ts): a person's call has its result.
  if (w.call.matchId === null) {
    reportSettled({ platform: w.call.platform, channelId: w.call.channelId, callId: w.call.id, question: w.call.question, outcome: read.outcome,
      source: "price", right: done.right, total: done.total, winners: (done.winners ?? []).map((x) => x.name), frame: false });
  }
  await reopenRepeat(w.call, deps);
  return true;
}

async function settlePrices(deps: LiveDeps): Promise<number> {
  let n = 0;
  for (const w of [...priceWaits.values()]) {
    if (w.busy || deps.now() < w.nextTryAt) continue;
    w.busy = true;
    try { if (await settlePrice(w, deps)) n++; }
    catch (e) {
      // The store blinked: the price is still there next time.
      w.nextTryAt = deps.now() + PRICE_POLL_MS;
      deps.log("live price not settled", { id: w.call.id, err: (e as Error).message });
    }
    finally { w.busy = false; }
  }
  return n;
}

/**
 * A viewer-count call's result, said with the reading in front, as a price
 * call's is. A mod who settled or canceled first wins: the store settles once.
 */
async function finishViewer(w: ViewerWait, outcome: Side, said: string, deps: LiveDeps): Promise<boolean> {
  const now = deps.now();
  const call = w.call;
  viewerWaits.delete(call.id);
  const wasOpen = await deps.store.lock(call.id, now).catch(() => false);
  lastSplit.delete(call.id); newSince.delete(call.id); lastSaid.delete(call.id);
  const tally = await deps.store.tally(call.id);
  const done = await deps.store.settle(call.id, outcome, pointsFor(tally, outcome), now);
  if (!done) return false;
  await deps.predictionEnd?.(call, outcome).catch(() => {});
  await unpinIfIdle(deps, call);
  const { url, star } = await resultExtras(deps, call);
  await sayQuiet(deps, call, `${said} ${LIVE_COPY.settled(call.question, outcome, done.right, done.total, done.top, url, done.winners, star)}`);
  await sayStreamTop(deps, call, now);
  deps.log("live call settled", { platform: call.platform, channel: call.channelId, id: call.id, outcome, right: done.right, total: done.total, by: "viewers", target: w.vc.target, peak: w.peak });
  // The operator's mail (src/live/openedMail.ts): a person's call has its result.
  reportSettled({ platform: call.platform, channelId: call.channelId, callId: call.id, question: call.question, outcome,
    source: "viewers", right: done.right, total: done.total, winners: (done.winners ?? []).map((x) => x.name), frame: false });
  // It was still taking answers: the room is free for the repeat it kept waiting.
  if (wasOpen) await resumeRepeat(deps, call);
  return true;
}

/** A count oddie cannot read goes back to the mods in one line, as a price does. */
async function viewersToMods(w: ViewerWait, deps: LiveDeps): Promise<false> {
  viewerWaits.delete(w.call.id);
  handedToMods.add(w.call.id);
  const still = (await deps.store.unsettled(w.call.platform, w.call.channelId).catch(() => [] as LiveCall[])).some((c) => c.id === w.call.id);
  if (still) await sayQuiet(deps, w.call, LIVE_COPY.priceToMods(w.call.question));
  deps.log("live viewers handed to mods", { platform: w.call.platform, channel: w.call.channelId, id: w.call.id });
  return false;
}

/**
 * One look at a viewer-count call's stream. The first count at the number is a
 * YES. A stream that was on air and has been dark for two minutes has ended, a
 * NO (a shorter gap is a dropped connection). A call with a length is a NO at
 * its end, read then and not after. Ten minutes with no answer from the
 * platform and the call is the mods'.
 */
async function settleViewer(w: ViewerWait, deps: LiveDeps): Promise<boolean> {
  const now = deps.now();
  const info = deps.streamGame
    ? await deps.streamGame(w.call.platform, w.call.channelId).catch((e) => { deps.log("live viewers not read", { id: w.call.id, err: (e as Error).message.slice(0, 200) }); return null; })
    : null;
  const count = countOf(info);
  const dark = info !== null && !info.live;
  // The next look: half a minute on, and never past the end of its own length.
  w.nextTryAt = w.deadline !== null && now < w.deadline ? Math.min(now + VIEWER_POLL_MS, w.deadline) : now + VIEWER_POLL_MS;
  if (info?.live) { w.live = true; w.darkSince = null; }
  else if (dark && w.darkSince === null) w.darkSince = now;
  // Read: a count, or a stream that was on air and is dark. A stream never seen
  // on air has nothing to read yet, and is not waited on forever.
  const read = count !== null || (dark && w.live);
  if (read) { w.readAt = now; w.unreadSince = null; }
  else if (w.unreadSince === null) w.unreadSince = now;
  const peak = () => (w.whole ? w.peak : null);
  if (count !== null) {
    if (w.peak === null || count > w.peak) w.peak = count;
    if (viewerMet(w.vc, count)) return finishViewer(w, "yes", LIVE_COPY.viewersYes(count), deps);
  }
  if (dark && w.live && w.darkSince !== null && now - w.darkSince >= VIEWER_DARK_MS) return finishViewer(w, "no", LIVE_COPY.viewersEnded(peak()), deps);
  if (w.deadline !== null && now >= w.deadline) {
    // Short of it on this reading or the one before, or no stream at all: a NO.
    // Not read for longer than that: nobody knows, and the mods say.
    if (count !== null || dark || (w.readAt !== null && now - w.readAt <= 2 * VIEWER_POLL_MS)) return finishViewer(w, "no", LIVE_COPY.viewersTimeUp(peak()), deps);
    return viewersToMods(w, deps);
  }
  if (w.unreadSince !== null && now - w.unreadSince >= VIEWER_GIVE_UP_MS) return viewersToMods(w, deps);
  // Nine tenths of the way: the room hears it once, while there is something to do about it.
  if (count !== null && !w.nudged && count >= Math.ceil(viewersNeeded(w.vc) * VIEWER_CLOSE_SHARE)) {
    w.nudged = true;
    await sayQuiet(deps, w.call, LIVE_COPY.viewersClose(count, viewersShort(w.vc, count)));
  }
  return false;
}

async function settleViewers(deps: LiveDeps): Promise<number> {
  let n = 0;
  for (const w of [...viewerWaits.values()]) {
    if (w.busy || deps.now() < w.nextTryAt) continue;
    w.busy = true;
    try { if (await settleViewer(w, deps)) n++; }
    catch (e) {
      // The store blinked: the count is still there next time.
      w.nextTryAt = deps.now() + VIEWER_POLL_MS;
      deps.log("live viewers not settled", { id: w.call.id, err: (e as Error).message });
    }
    finally { w.busy = false; }
  }
  return n;
}

/**
 * !yes or !no with nothing taking answers, or a settle with nothing to settle.
 * From a viewer it is chat. From the channel's owner or a mod it is a mistake
 * worth one line: the first Twitch pilot typed !yes or !no with a market open
 * in chat and no call, then !call yes, no or cancel, and heard nothing back
 * either time.
 * Once per ten minutes per channel, so a mod hammering !yes is answered once.
 * A call waiting for its result gets its own line and its own ten minutes: how
 * to settle it, since a runner's !yes there most likely means the result. A
 * price call is the exception: oddie reads it, and a mod's settle would beat
 * the number, so the line says what it waits for instead.
 */
/** Whether !oddie opens real markets in this chat: never where the platform
 *  runs votes only, and not where the channel has them off. A store that
 *  cannot tell keeps them, as every channel had them before 5 Nov. */
async function marketsHere(deps: LiveDeps, msg: ChatMessage): Promise<boolean> {
  if (deps.votesOnly) return false;
  if (!deps.store.marketsOn) return true;
  return deps.store.marketsOn(msg.platform, msg.channelId).catch(() => true);
}

async function pickHelp(msg: ChatMessage, waiting: LiveCall | null, now: number, deps: LiveDeps, quiet = "no-open-call"): Promise<string> {
  if (!msg.canRun) return quiet;
  const key = `${roomKey(msg)}:${waiting?.id ?? ""}`;
  const last = lastPickHelp.get(key);
  if (last !== undefined && now - last < PICK_HELP_GAP_MS) return quiet;
  for (const [k, at] of lastPickHelp) if (now - at >= PICK_HELP_GAP_MS) lastPickHelp.delete(k);
  lastPickHelp.set(key, now);
  const price = waiting ? priceWaits.get(waiting.id) : undefined;
  const counted = waiting && viewerWaits.has(waiting.id) ? viewerWhen(waiting) : null;
  const line = !waiting ? (await marketsHere(deps, msg) ? LIVE_COPY.pickHelp : LIVE_COPY.pickHelpVotes)
    : price ? LIVE_COPY.switched(waiting.question, await deps.store.tally(waiting.id), whenText(price.pc, price.plan, price.atEnd))
    : counted ? LIVE_COPY.switched(waiting.question, await deps.store.tally(waiting.id), counted)
    : LIVE_COPY.settleFirst(waiting.question);
  await sayQuiet(deps, msg, line, msg.messageId);
  return "pick-help";
}

/**
 * One chat line. Returns what it did, for the log and the tests. Ordinary
 * chat, and anything a viewer may not do, costs nothing and says nothing: a
 * bot that answers every refusal becomes the loudest thing in the room.
 */
export async function handleChat(msg: ChatMessage, deps: LiveDeps): Promise<string> {
  // Live on 8 Oct: oddie's own "!oddie <a claim ...>" help line came back
  // through Twitch's chat feed, was read as a claim, and oddie answered itself.
  if (msg.fromOddie) return "own";
  const now = deps.now();
  // Any line counts as the room moving; the reminder only speaks into a live chat.
  lastActivity.set(roomKey(msg), now);
  const cmd = parseCommand(msg.text);
  if (!cmd) return "chat";

  if (cmd.kind === "pick") {
    const call = await deps.store.current(msg.platform, msg.channelId);
    if (!call) {
      const waiting = msg.canRun ? (await deps.store.unsettled(msg.platform, msg.channelId).catch(() => [] as LiveCall[]))[0] ?? null : null;
      return pickHelp(msg, waiting, now, deps);
    }
    if (call.timed && now >= call.closesAt) { await lockAndSay(call, deps); return "late"; }
    const fresh = await deps.store.pick(call, msg.senderId, msg.senderName, cmd.side, now);
    if (!fresh) return "already-picked";
    // Who answered since the last split line: said by name in the next one.
    // The first answer is said at once (Lev's live, 16 Oct: a !yes with no
    // word back reads as broken); after it, a line at most every 30 seconds,
    // and the clock says the ones still waiting (sayVotes).
    const since = newSince.get(call.id) ?? { yes: [], no: [] };
    since[cmd.side].push(msg.senderName);
    newSince.set(call.id, since);
    const last = lastSplit.get(call.id);
    if (last === undefined || now - last >= SPLIT_GAP_MS) {
      lastSplit.set(call.id, now);
      newSince.delete(call.id);
      await sayQuiet(deps, msg, LIVE_COPY.split(await deps.store.tally(call.id), since.yes, since.no, call.timed ? call.closesAt - now : null));
    }
    return "picked";
  }

  // The market door is for everybody, like a tag on X or Telegram. Bare, under
  // a message, it means that message; bare on its own it asks how.
  if (cmd.kind === "market") {
    if (!(await marketsHere(deps, msg))) { await sayQuiet(deps, msg, LIVE_COPY.votesHere, msg.messageId); return "votes-only"; }
    const claim = cmd.claim || (msg.replyText ?? "").trim();
    if (!claim || !deps.market) { await sayQuiet(deps, msg, LIVE_COPY.marketHelp, msg.messageId); return "market-help"; }
    // A viewer count is a number anybody can buy: a vote, never money (src/live/viewerCall.ts).
    if (parseViewerCall(claim)) { await sayQuiet(deps, msg, LIVE_COPY.viewersNoMarket, msg.messageId); return "viewers-no-market"; }
    return deps.market(msg, claim);
  }

  /* !ME (Lev, 16 Oct): a viewer's own record, said to them in the chat they
     asked in. Once per ten minutes per person per chat, so a room asking all
     at once is answered once each, and a store without records says nothing. */
  if (cmd.kind === "me") {
    if (!deps.store.record) return "chat";
    const key = `${roomKey(msg)}:${msg.senderId}`;
    const last = lastMe.get(key);
    if (last !== undefined && now - last < ME_GAP_MS) return "me-quiet";
    for (const [k, t] of lastMe) if (now - t >= ME_GAP_MS) lastMe.delete(k);
    lastMe.set(key, now);
    const r = await deps.store.record(msg.platform, msg.senderId, msg.channelId, now).catch((e) => {
      deps.log("live record not read", { err: (e as Error).message });
      return null;
    });
    if (!r) return "me-quiet";
    await sayQuiet(deps, msg, LIVE_COPY.me(msg.senderName, r), msg.messageId);
    return "me";
  }

  /* !TOP (Lev, 26 Oct): this stream's best callers, for anybody. Once a
     minute a room, so a room asking all at once hears it once. */
  if (cmd.kind === "top") {
    if (!deps.store.settledTimes || !deps.store.topCallers) return "chat";
    const key = roomKey(msg);
    const last = lastTop.get(key);
    if (last !== undefined && now - last < TOP_GAP_MS) return "top-quiet";
    lastTop.set(key, now);
    const s = await streamTop(deps, msg, now).catch((e) => { deps.log("live stream top not read", { err: (e as Error).message }); return null; });
    await sayQuiet(deps, msg, s?.top.length ? LIVE_COPY.streamTop(s.top) : LIVE_COPY.streamTopNone, msg.messageId);
    return "top";
  }

  if (!msg.canRun) return "not-allowed";

  /* THE CHANNEL'S FACEIT ACCOUNT. Linked once, by a runner; from then on the
     clock opens a call per match and settles it (src/live/gameCalls.ts). */
  if (cmd.kind === "faceit") {
    const games = deps.games ?? faceitConfigured();
    if (!games) { await sayQuiet(deps, msg, LIVE_COPY.faceitOff, msg.messageId); return "faceit-off"; }
    if (!cmd.arg) {
      const cur = await deps.store.faceit(msg.platform, msg.channelId).catch(() => null);
      await sayQuiet(deps, msg, cur ? LIVE_COPY.faceitStatus(cur.nick) : LIVE_COPY.faceitHow, msg.messageId);
      return "faceit-how";
    }
    if (/^(off|unlink|remove|stop)$/i.test(cmd.arg)) {
      await deps.store.setFaceit(msg.platform, msg.channelId, null);
      await sayQuiet(deps, msg, LIVE_COPY.faceitUnlinked, msg.messageId);
      deps.log("faceit unlinked", { platform: msg.platform, channel: msg.channelId });
      return "faceit-unlinked";
    }
    const p = await games.player(cmd.arg).catch((e) => { deps.log("faceit player not read", { nick: cmd.arg, err: (e as Error).message }); return null; });
    if (!p) { await sayQuiet(deps, msg, LIVE_COPY.faceitNotFound(cmd.arg), msg.messageId); return "faceit-not-found"; }
    await deps.store.setFaceit(msg.platform, msg.channelId, { id: p.id, nick: p.nick });
    await sayQuiet(deps, msg, LIVE_COPY.faceitLinked(p.nick), msg.messageId);
    deps.log("faceit linked", { platform: msg.platform, channel: msg.channelId, nick: p.nick });
    return "faceit-linked";
  }

  /* MATCH CALLS FROM THE STREAM (src/live/frameCalls.ts): on for every channel
     until a runner says otherwise. The picture pass reads the flag. */
  if (cmd.kind === "matches") {
    // YouTube's stream is never read. X Live runs votes too, but its screen
    // is read (src/live/screenCalls.ts), so its streamer can turn that off.
    if (deps.votesOnly && msg.platform === "youtube") { await sayQuiet(deps, msg, LIVE_COPY.matchesElsewhere, msg.messageId); return "matches-elsewhere"; }
    if (/^(off|stop|no)$/i.test(cmd.arg)) {
      await deps.store.setMatchCalls(msg.platform, msg.channelId, false);
      await sayQuiet(deps, msg, LIVE_COPY.matchesOff, msg.messageId);
      deps.log("match calls off", { platform: msg.platform, channel: msg.channelId });
      return "matches-off";
    }
    if (/^(on|start|yes)$/i.test(cmd.arg)) {
      await deps.store.setMatchCalls(msg.platform, msg.channelId, true);
      await sayQuiet(deps, msg, LIVE_COPY.matchesOn, msg.messageId);
      deps.log("match calls on", { platform: msg.platform, channel: msg.channelId });
      return "matches-on";
    }
    await sayQuiet(deps, msg, LIVE_COPY.matchesHow, msg.messageId);
    return "matches-how";
  }

  /* REAL MARKETS IN THIS CHAT (Lev, 5 Nov). Money is the streamer's call:
     only the channel's own account turns markets on; a mod may turn them off.
     The channel's id is its owner's user id on Twitch, Kick and YouTube. */
  if (cmd.kind === "markets") {
    if (deps.votesOnly || !deps.store.setMarkets) { await sayQuiet(deps, msg, LIVE_COPY.votesHere, msg.messageId); return "votes-only"; }
    if (/^(off|stop|no)$/i.test(cmd.arg)) {
      await deps.store.setMarkets(msg.platform, msg.channelId, false);
      await sayQuiet(deps, msg, LIVE_COPY.marketsOff, msg.messageId);
      deps.log("markets off", { platform: msg.platform, channel: msg.channelId });
      return "markets-off";
    }
    if (/^(on|start|yes)$/i.test(cmd.arg)) {
      if (msg.senderId !== msg.channelId) { await sayQuiet(deps, msg, LIVE_COPY.marketsOwner, msg.messageId); return "markets-owner"; }
      await deps.store.setMarkets(msg.platform, msg.channelId, true);
      await sayQuiet(deps, msg, LIVE_COPY.marketsOn, msg.messageId);
      deps.log("markets on", { platform: msg.platform, channel: msg.channelId });
      return "markets-on";
    }
    await sayQuiet(deps, msg, await marketsHere(deps, msg) ? LIVE_COPY.marketsOn : LIVE_COPY.marketsHow, msg.messageId);
    return "markets-how";
  }

  if (cmd.kind === "help") { await sayQuiet(deps, msg, LIVE_COPY.help, msg.messageId); return "help"; }
  if (cmd.kind === "settle-help") { await sayQuiet(deps, msg, LIVE_COPY.settleOnly, msg.messageId); return "settle-help"; }
  if (cmd.kind === "repeat-help") { await sayQuiet(deps, msg, LIVE_COPY.repeatHow, msg.messageId); return "repeat-help"; }
  // !call stop: the call open now keeps its answers and its result; no round after it.
  if (cmd.kind === "stop") {
    const rep = await deps.store.repeat?.(msg.platform, msg.channelId).catch(() => null);
    if (!rep) { await sayQuiet(deps, msg, LIVE_COPY.repeatNone, msg.messageId); return "no-repeat"; }
    await deps.store.setRepeat?.(msg.platform, msg.channelId, null);
    await sayQuiet(deps, msg, LIVE_COPY.repeatOff, msg.messageId);
    deps.log("live repeat off", { platform: msg.platform, channel: msg.channelId, rounds: rep.round });
    return "repeat-off";
  }

  if (cmd.kind === "open") {
    const running = await deps.store.current(msg.platform, msg.channelId);
    // The same question while it still takes answers is the streamer bringing it
    // back up, not a second vote. Live on 8 Oct the same candle question twice in
    // ninety seconds locked the first and opened its twin, and one candle would
    // have been settled twice. So it is said again where everybody sees it.
    if (running && running.closesAt > now && sameCall(running, cmd.question, now)) {
      lastSaid.set(running.id, now);
      const id = await sayQuiet(deps, msg, LIVE_COPY.reminder(running.question, await deps.store.tally(running.id), running.timed ? running.closesAt - now : null));
      await pinQuiet(deps, msg, id);
      // "!call repeat" on the call already running: this one is round 1.
      if (cmd.repeat && !viewerCallOf(running)) {
        await deps.store.setRepeat?.(msg.platform, msg.channelId, { question: running.question, minutes: cmd.minutes, byId: msg.senderId, byName: msg.senderName, round: 1 });
        await sayQuiet(deps, msg, LIVE_COPY.repeatOn);
      }
      return "again";
    }
    /* A VIEWER-COUNT CALL (src/live/viewerCall.ts) is read off the platform's
       count. The same number already waiting for its result is said again
       instead of asked twice, and a number the stream already has is a call
       decided at its open: either is said, and nothing in the room changes.
       A stream not on air yet opens it all the same (the first minute of a
       stream is when it is asked), and the count is read once there is one. */
    const vc = viewerCallOf({ platform: msg.platform, question: cmd.question });
    let atOpen: { live: boolean; count: number | null } | undefined;
    if (vc) {
      const twin = vc.minutes !== null ? undefined : (await deps.store.unsettled(msg.platform, msg.channelId).catch(() => [] as LiveCall[])).find((c) => {
        const o = viewerCallOf(c);
        return o !== null && o.minutes === null && o.target === vc.target && o.above === vc.above;
      });
      if (twin) {
        const t = await deps.store.tally(twin.id);
        await sayQuiet(deps, msg, twin.lockedAt === null ? LIVE_COPY.reminder(twin.question, t, twin.timed ? twin.closesAt - now : null)
          : handedToMods.has(twin.id) ? LIVE_COPY.settleFirst(twin.question)
          : LIVE_COPY.switched(twin.question, t, viewerWhen(twin)), msg.messageId);
        return "again";
      }
      const info = deps.streamGame ? await deps.streamGame(msg.platform, msg.channelId).catch(() => null) : null;
      if (info) atOpen = { live: info.live, count: countOf(info) };
    }
    // How many are watching as it opens, when the platform said.
    const watching = atOpen?.count ?? null;
    if (vc && watching !== null && viewerMet(vc, watching)) { await sayQuiet(deps, msg, LIVE_COPY.viewersAlready(watching), msg.messageId); return "viewers-already"; }
    // A count that was reached stays reached: no round after it.
    const repeat = cmd.repeat === true && !vc;
    // The new call takes the room. The one taking answers keeps them and waits
    // for its result, so nothing anybody said is lost.
    if (running && (await deps.store.lock(running.id, now))) {
      lastSplit.delete(running.id); newSince.delete(running.id); lastSaid.delete(running.id);
      await sayQuiet(deps, msg, LIVE_COPY.switched(running.question, await deps.store.tally(running.id), (await waitForPrice(running, deps)) ?? viewerWhen(running)));
    }
    // A price call oddie settles itself, so it does not stay open until a mod settles it.
    const { closesAt, minutes, pc } = closeFor(msg.platform, cmd.question, cmd.minutes, now);
    const opened = await deps.store.open({
      platform: msg.platform, channelId: msg.channelId, question: cmd.question,
      openedById: msg.senderId, openedByName: msg.senderName, openedAt: now, closesAt, timed: minutes !== null,
    });
    if (!opened) {
      // Two runners at once: the other one's call took the room.
      const other = await deps.store.current(msg.platform, msg.channelId);
      if (other) await sayQuiet(deps, msg, LIVE_COPY.busy(other.question), msg.messageId);
      return "busy";
    }
    // A different question means the show moved on: the old repeat opens no new
    // round. Not a viewer-count call, which runs beside the show: the repeat
    // stays, and comes back when this one stops taking answers (resumeRepeat).
    const rep = await deps.store.repeat?.(msg.platform, msg.channelId).catch(() => null);
    if (repeat) await deps.store.setRepeat?.(msg.platform, msg.channelId, { question: opened.question, minutes: cmd.minutes, byId: msg.senderId, byName: msg.senderName, round: 1 });
    else if (rep && !vc && !sameQuestion(rep.question, opened.question)) await deps.store.setRepeat?.(msg.platform, msg.channelId, null);
    lastSaid.set(opened.id, now);
    // Read from the open on: the count can get there while the room still answers.
    if (vc) watchViewers(opened, vc, now, atOpen ?? { live: false, count: null });
    const id = await sayQuiet(deps, msg, LIVE_COPY.opened(opened.question, minutes, await deps.standingsUrl(msg.platform, msg.channelId), watching === null ? "" : LIVE_COPY.viewersNow(watching)));
    await pinQuiet(deps, msg, id);
    const panel = await deps.predictionOpen?.(opened, minutes).catch(() => null);
    if (panel === "too-long") await sayQuiet(deps, msg, LIVE_COPY.predictionLong, msg.messageId);
    if (repeat) await sayQuiet(deps, msg, LIVE_COPY.repeatOn);
    await sayLastWeek(deps, msg, now);
    deps.log("live call opened", { platform: msg.platform, channel: msg.channelId, id: opened.id, minutes, price: pc?.kind ?? null, viewers: vc?.target ?? null, repeat });
    // The operator's mail (src/live/openedMail.ts): a person opened this one.
    reportOpened({ kind: "call", platform: msg.platform, channelId: msg.channelId, question: opened.question, by: msg.senderName });
    return "opened";
  }

  // settle or cancel: which call. One waiting is that one; a number names one;
  // a bare cancel means the one taking answers; anything else is asked.
  const waiting = await deps.store.unsettled(msg.platform, msg.channelId);
  // Nothing to settle: the runner hears how calls work, as a stray !yes would.
  if (!waiting.length) return pickHelp(msg, null, now, deps, "no-call");
  let target: LiveCall | undefined;
  if (cmd.which !== null) target = waiting[cmd.which - 1];
  else if (waiting.length === 1) target = waiting[0];
  else if (cmd.kind === "cancel") target = waiting.find((c) => c.lockedAt === null);
  if (!target) {
    await sayQuiet(deps, msg, LIVE_COPY.which(cmd.kind === "cancel" ? "cancel" : cmd.outcome, waiting.map((c) => c.question)), msg.messageId);
    return "which";
  }

  if (cmd.kind === "cancel") {
    if (!(await deps.store.cancel(target.id, now))) return "no-call";
    lastSplit.delete(target.id); newSince.delete(target.id); lastSaid.delete(target.id); priceWaits.delete(target.id); viewerWaits.delete(target.id);
    await deps.predictionEnd?.(target, null).catch(() => {});
    // Canceling the repeating call ends the repeat too.
    const rep = await deps.store.repeat?.(msg.platform, msg.channelId).catch(() => null);
    if (rep && sameQuestion(rep.question, target.question)) await deps.store.setRepeat?.(msg.platform, msg.channelId, null);
    await unpinIfIdle(deps, msg);
    await sayQuiet(deps, msg, LIVE_COPY.canceled);
    return "canceled";
  }

  // settle: a call still taking answers is locked first, so a late answer
  // cannot slip in after the result is known.
  if (target.lockedAt === null) await deps.store.lock(target.id, now);
  lastSplit.delete(target.id); newSince.delete(target.id); lastSaid.delete(target.id); priceWaits.delete(target.id); viewerWaits.delete(target.id);
  const tally = await deps.store.tally(target.id);
  const points = pointsFor(tally, cmd.outcome);
  const done = await deps.store.settle(target.id, cmd.outcome, points, now);
  if (!done) return "no-call";
  await deps.predictionEnd?.(target, cmd.outcome).catch(() => {});
  await unpinIfIdle(deps, msg);
  const { url, star } = await resultExtras(deps, target);
  await sayQuiet(deps, msg, LIVE_COPY.settled(target.question, cmd.outcome, done.right, done.total, done.top, url, done.winners, star));
  await sayStreamTop(deps, msg, now);
  deps.log("live call settled", { platform: msg.platform, channel: msg.channelId, id: target.id, outcome: cmd.outcome, right: done.right, total: done.total });
  // The operator's mail (src/live/openedMail.ts): a person's call has its result. Not oddie's own match calls.
  if (target.matchId === null) {
    reportSettled({ platform: msg.platform, channelId: msg.channelId, callId: target.id, question: target.question, outcome: cmd.outcome,
      source: "streamer", by: msg.senderName, right: done.right, total: done.total, winners: (done.winners ?? []).map((x) => x.name), frame: false });
  }
  await reopenRepeat(target, deps);
  return "settled";
}

/** The clock: timed calls whose time is up are locked and announced, and price
 *  calls whose answer is in are settled. */
export async function lockDue(deps: LiveDeps): Promise<number> {
  let n = 0;
  for (const call of await deps.store.due(deps.now()).catch(() => [] as LiveCall[])) {
    if (await lockAndSay(call, deps).catch(() => false)) n++;
  }
  await settlePrices(deps);
  await settleViewers(deps);
  await watchStreams(deps);
  return n;
}

/**
 * THE SCREEN SETTLED IT (src/live/screenCalls.ts): a room call whose answer
 * showed on the stream, read twice in a row. Settled as a mod's !call would,
 * with what was on screen in front. False when somebody settled it first.
 */
export async function settleOnScreen(call: LiveCall, outcome: Side, seen: string, deps: LiveDeps, frame?: Buffer): Promise<boolean> {
  const now = deps.now();
  if (call.lockedAt === null) await deps.store.lock(call.id, now).catch(() => false);
  lastSplit.delete(call.id); newSince.delete(call.id); lastSaid.delete(call.id);
  const tally = await deps.store.tally(call.id);
  const done = await deps.store.settle(call.id, outcome, pointsFor(tally, outcome), now);
  if (!done) return false;
  await deps.predictionEnd?.(call, outcome).catch(() => {});
  // The picture it was settled on, so anybody can see what oddie saw (Lev, 27
  // Oct): kept on the channel page, since a live chat takes no picture.
  if (frame && deps.store.saveFrame) {
    await deps.store.saveFrame(call.id, frame, seen).catch((e) => deps.log("live frame not kept", { id: call.id, err: (e as Error).message.slice(0, 200) }));
  }
  await unpinIfIdle(deps, call);
  const { url, star } = await resultExtras(deps, call);
  // What was read off the screen stays with the kept picture, not in the chat line.
  await sayQuiet(deps, call, LIVE_COPY.settled(call.question, outcome, done.right, done.total, done.top, url, done.winners, star));
  await sayStreamTop(deps, call, now);
  deps.log("live call settled", { platform: call.platform, channel: call.channelId, id: call.id, outcome, right: done.right, total: done.total, by: "screen" });
  // The operator's mail (src/live/openedMail.ts), with the picture it was settled on.
  if (call.matchId === null) {
    reportSettled({ platform: call.platform, channelId: call.channelId, callId: call.id, question: call.question, outcome,
      source: "screen", right: done.right, total: done.total, winners: (done.winners ?? []).map((x) => x.name), frame: Boolean(frame && deps.store.saveFrame) });
  }
  await reopenRepeat(call, deps);
  return true;
}

/**
 * THE SCREEN GIVES A CALL UP (5 Nov, Twitch VODs). A sure answer nothing
 * confirmed, or two that disagree: the result went by too fast, or the
 * picture misled. Left open, the call waited into the next game and settled
 * on that one, a game late and as often wrong as right. So its voting closes,
 * the mods are asked once, and the screen stops looking at it
 * (src/live/screenCalls.ts). Their !call yes or !call no settles it as ever.
 */
export async function screenGivesUp(call: LiveCall, deps: LiveDeps): Promise<void> {
  if (call.lockedAt === null) await deps.store.lock(call.id, deps.now()).catch(() => false);
  await sayQuiet(deps, call, LIVE_COPY.screenUnsure(call.question));
  deps.log("live call left to the mods", { platform: call.platform, channel: call.channelId, id: call.id });
}

/**
 * !CALL REPEAT (Lev, 4 Nov): once the repeating call has its result, the same
 * question opens again, a round on, in the name of whoever started it. The
 * screen still waits out its first minute (src/live/screenCalls.ts), so the
 * result that is still up never settles the new round. A stream that went dark
 * ends the repeat instead, and a call that took the room in between is left be.
 */
async function reopenRepeat(call: LiveCall, deps: LiveDeps): Promise<void> {
  const rep = await deps.store.repeat?.(call.platform, call.channelId).catch(() => null);
  if (!rep || !sameQuestion(rep.question, call.question)) return;
  await openRound(call, rep, deps);
}

/**
 * THE REPEAT A VIEWER-COUNT CALL KEPT WAITING. A viewer-count call takes the
 * room for its three minutes and leaves the channel's repeat alone. A round
 * whose result came in meanwhile could not open its next one (one call takes
 * answers at a time), so it opens here, the moment the room is free: nothing
 * taking answers, and no round of the repeat still waiting for its result.
 */
async function resumeRepeat(deps: LiveDeps, m: { platform: Platform; channelId: string }): Promise<void> {
  const rep = await deps.store.repeat?.(m.platform, m.channelId).catch(() => null);
  if (!rep) return;
  const waiting = await deps.store.unsettled(m.platform, m.channelId).catch(() => null);
  if (!waiting || waiting.some((c) => c.lockedAt === null || sameQuestion(c.question, rep.question))) return;
  await openRound(m, rep, deps);
}

/** The repeat's next round, in the name of whoever started it. */
async function openRound(call: { platform: Platform; channelId: string }, rep: Repeat, deps: LiveDeps): Promise<void> {
  if (deps.streamLive && (await deps.streamLive(call.platform, call.channelId).catch(() => null)) === false) {
    await deps.store.setRepeat?.(call.platform, call.channelId, null).catch(() => {});
    deps.log("live repeat ended with the stream", { platform: call.platform, channel: call.channelId, rounds: rep.round });
    return;
  }
  const now = deps.now();
  const { closesAt, minutes } = closeFor(call.platform, rep.question, rep.minutes, now);
  const opened = await deps.store.open({
    platform: call.platform, channelId: call.channelId, question: rep.question,
    openedById: rep.byId, openedByName: rep.byName, openedAt: now, closesAt, timed: minutes !== null,
  }).catch(() => null);
  if (!opened) return;
  const round = rep.round + 1;
  await deps.store.setRepeat?.(call.platform, call.channelId, { ...rep, round }).catch(() => {});
  lastSaid.set(opened.id, now);
  const id = await sayQuiet(deps, call, LIVE_COPY.next(opened.question, round, minutes));
  await pinQuiet(deps, call, id);
  await deps.predictionOpen?.(opened, minutes).catch(() => null);
  deps.log("live call repeated", { platform: call.platform, channel: call.channelId, id: opened.id, round });
}

/**
 * Once a minute: price calls a restart left without their wait get it back (the
 * store kept them, memory did not), calls nobody settled in a day are put away,
 * and a channel that was live and went dark has ended its stream. Then its room
 * calls nobody settled are canceled with no points.
 */
async function watchStreams(deps: LiveDeps): Promise<void> {
  const now = deps.now();
  if (now - lastWatch < STREAM_POLL_MS) return;
  lastWatch = now;
  const all = await deps.store.everyUnsettled().catch(() => null);
  if (!all) return;
  // A viewer-count call settled or canceled some other way is not read again.
  // One opened while the list was being read is not in it yet, and stays.
  const open = new Set(all.map((c) => c.id));
  for (const [id, w] of viewerWaits) if (!open.has(id) && w.call.openedAt < now) viewerWaits.delete(id);
  const roomsBy = new Map<string, LiveCall[]>();
  for (const c of all) {
    if (now - c.openedAt > CALL_FORGET_MS) {
      if (await deps.store.cancel(c.id, now).catch(() => false)) deps.log("live call forgotten", { platform: c.platform, channel: c.channelId, id: c.id });
      viewerWaits.delete(c.id);
      continue;
    }
    if (parsePriceCall(c.question)) {
      if (c.lockedAt !== null && !priceWaits.has(c.id) && !handedToMods.has(c.id)) await waitForPrice(c, deps);
      continue;
    }
    // A match call is FACEIT's to settle, stream or no stream (src/live/gameCalls.ts).
    if (c.matchId) continue;
    // A viewer-count call is the count's to settle (src/live/viewerCall.ts): a
    // restart lost its wait, and the readings before it with it.
    const vc = viewerCallOf(c);
    if (vc) {
      if (!viewerWaits.has(c.id) && !handedToMods.has(c.id)) watchViewers(c, vc, now);
      continue;
    }
    const k = roomKey(c);
    roomsBy.set(k, [...(roomsBy.get(k) ?? []), c]);
  }
  if (!deps.streamLive) return;
  for (const [k, calls] of roomsBy) {
    const { platform, channelId } = calls[0];
    const live = await deps.streamLive(platform, channelId).catch(() => null);
    if (live === true) { seenLive.set(k, true); continue; }
    if (live !== false || !seenLive.get(k)) continue;
    seenLive.set(k, false);
    deps.log("live stream ended", { platform, channel: channelId, calls: calls.length });
    for (const c of calls) {
      if (!(await deps.store.cancel(c.id, now).catch(() => false))) continue;
      lastSplit.delete(c.id); newSince.delete(c.id); lastSaid.delete(c.id);
      await deps.predictionEnd?.(c, null).catch(() => {});
      await sayQuiet(deps, c, LIVE_COPY.noResult(c.question));
    }
    await deps.store.setRepeat?.(platform, channelId, null).catch(() => {});
    await unpinIfIdle(deps, calls[0]);
  }
}

/**
 * NOT ON SCREEN YET (Lev, 25 Nov). IsaacBeast's first call, "will isaac die in
 * the next mission", was read off his stream 1,041 times in 70 minutes and
 * never settled: he lived, and GTA 6 ended that mission in a cutscene with
 * no result on screen, so the NO it needed never showed. He paused for his last
 * 26 minutes, talking to chat, then went off air, and the call was canceled
 * with no points. So from half an hour on, the reminder of an open call that
 * waits on the screen says who can settle it: the streamer or a mod, by name.
 * Only where the screen reads (Twitch, Kick, X), only a call with no length of
 * its own, and only a room call: a price, a viewer count or a FACEIT match is
 * settled by its own source.
 */
export const SETTLE_HINT_AFTER_MS = 30 * 60_000;
const SCREEN_READS: ReadonlySet<Platform> = new Set<Platform>(["twitch", "kick", "x"]);

/**
 * The clock, too: a call taking answers is said again every REMIND_GAP_MS, and
 * pinned again, but only into a chat that moved since it was last said. A quiet
 * room is not talked at, and nobody who arrives in the second hour of a call
 * has to scroll for it.
 */
export async function remindOpen(deps: LiveDeps): Promise<number> {
  const now = deps.now();
  let n = 0;
  const live = await deps.store.takingAnswers().catch(() => [] as LiveCall[]);
  const ids = new Set(live.map((c) => c.id));
  for (const id of lastSaid.keys()) if (!ids.has(id)) lastSaid.delete(id);
  for (const call of live) {
    if (call.timed && call.closesAt - now < REMIND_GAP_MS) continue; // over before it would help
    const said = lastSaid.get(call.id) ?? call.openedAt;
    if (now - said < REMIND_GAP_MS || (lastActivity.get(roomKey(call)) ?? 0) <= said) continue;
    lastSaid.set(call.id, now);
    const settleBy = !call.timed && isRoomCall(call) && SCREEN_READS.has(call.platform) && now - call.openedAt >= SETTLE_HINT_AFTER_MS
      ? ((await deps.store.channelName?.(call.platform, call.channelId).catch(() => null)) || "the streamer") : null;
    const id = await sayQuiet(deps, call, LIVE_COPY.reminder(call.question, await deps.store.tally(call.id), call.timed ? call.closesAt - now : null, settleBy));
    await pinQuiet(deps, call, id);
    n++;
  }
  return n;
}

/** The answers since the last split line, said by the clock once the gap is
 *  up. A call's first answer, and any after the gap, is said at once (the
 *  pick); one inside the gap waits for the next, and on a quiet stream there
 *  may be none. Returns how many lines it said. */
export async function sayVotes(deps: LiveDeps): Promise<number> {
  if (!newSince.size) return 0;
  const now = deps.now();
  let n = 0;
  const live = await deps.store.takingAnswers().catch(() => [] as LiveCall[]);
  for (const call of live) {
    const since = newSince.get(call.id);
    if (!since || (!since.yes.length && !since.no.length)) continue;
    if (now - (lastSplit.get(call.id) ?? 0) < SPLIT_GAP_MS) continue;
    lastSplit.set(call.id, now);
    newSince.delete(call.id);
    await sayQuiet(deps, call, LIVE_COPY.split(await deps.store.tally(call.id), since.yes, since.no, call.timed ? call.closesAt - now : null));
    n++;
  }
  return n;
}
