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
 * the room reports it: `!result yes` or `!result no`, the first report closes
 * the answers, and a minute later the majority settles it. A mod's !call yes or
 * !call no still wins over the room. A moment nobody reported is canceled, no
 * points, when the stream ends.
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
 * Platform-free on purpose: Kick is the first adapter (src/kick), Twitch plugs
 * into the same engine with its own client.
 */

import { binancePrices, parsePriceCall, planFor, readPriceCall, whenText, PRICE_SETTLE_LAG_MS, type PriceCall, type PricePlan, type PriceSource } from "./priceCall.js";

export type Platform = "kick" | "twitch";
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
  /** minutes null: open until it is settled. */
  | { kind: "open"; question: string; minutes: number | null }
  | { kind: "pick"; side: Side }
  /** which: the call's number in the waiting list (1 = oldest), null when not said. */
  | { kind: "settle"; outcome: Side; which: number | null }
  | { kind: "cancel"; which: number | null }
  /** "!call yes <more>": a settle word with a sentence after it. Neither a result nor a question. */
  | { kind: "settle-help" }
  | { kind: "help" }
  | { kind: "market"; claim: string }
  /** What happened, from anybody in the room: `!result yes`. */
  | { kind: "report"; side: Side };

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
/** A price call with no length takes answers this long, never past the moment its answer is known. */
export const PRICE_CALL_LOCK_MS = 3 * 60_000;
export const QUESTION_MAX = 180;
/** How often chat hears the running split while a call is open. */
export const SPLIT_GAP_MS = 45_000;
/** How often a channel's runners hear how !yes and !no work when nothing is open. */
export const PICK_HELP_GAP_MS = 10 * 60_000;
/** After the first !result, how long the room has to report before the majority settles it. */
export const REPORT_WINDOW_MS = 60_000;
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
  const report = /^!(result|sonu[cç])\s+(yes|evet|no|hay[ıi]r)(?=\s|$)/i.exec(text);
  if (report) return { kind: "report", side: YES_WORD.test(report[2]) ? "yes" : "no" };
  // !oddie is the market door; whatever follows is the claim, read like a tag.
  const market = /^!oddie(?=\s|$)\s*(.*)$/i.exec(text);
  if (market) return { kind: "market", claim: market[1].trim() };
  const m = /^!call(?=\s|$)\s*(.*)$/i.exec(text);
  if (!m) return null;
  const rest = m[1].trim();
  if (!rest) return { kind: "help" };
  // "!call yes" settles; "!call yes 2" settles the second call waiting.
  const settle = /^(yes|evet|no|hay[ıi]r)(?:\s+#?(\d{1,2}))?$/i.exec(rest);
  if (settle) return { kind: "settle", outcome: YES_WORD.test(settle[1]) ? "yes" : "no", which: settle[2] ? Number(settle[2]) : null };
  const cancel = /^(cancel|iptal)(?:\s+#?(\d{1,2}))?$/i.exec(rest);
  if (cancel) return { kind: "cancel", which: cancel[2] ? Number(cancel[2]) : null };
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

/* ----------------------------------------------------------------- copy -- */
// One line each: stream chats do not keep line breaks, and a wall scrolls away.

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
const left = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 60 ? `${Math.ceil(s / 60)} min` : `${s}s`;
};
const split = (t: Tally) => `${yesPct(t)}% YES from ${n(t.yes + t.no, "call", "calls")}`;
const short = (q: string, max = 60) => (q.length > max ? q.slice(0, max - 1).trimEnd() + "…" : q);

export const LIVE_COPY = {
  /** `room`: a moment only the stream shows, settled by the room's !result. */
  opened: (q: string, minutes: number | null, url: string, room = false) => {
    const how = room ? " When it's over, anybody types !result yes or !result no." : "";
    return minutes === null
      ? `oddie call: "${q}" Type !yes or !no. Open until it's settled, earlier calls score more.${how} Standings: ${url}`
      : `oddie call: "${q}" Type !yes or !no, calls lock in ${minutes} min, earlier calls score more.${how} Standings: ${url}`;
  },
  reportOpened: (q: string) => `Result in for "${short(q)}": type !result yes or !result no in the next minute. Mods can settle it with !call yes or !call no.`,
  reportTie: (q: string, yes: number, no: number) => `"${short(q)}" is tied ${yes}-${no}. One more minute: !result yes or !result no.`,
  reportToMods: (q: string) => `"${short(q)}" is still tied. Mods settle it: !call yes or !call no.`,
  roomSays: (agree: number, total: number, outcome: Side) => `${agree} of ${n(total, "report", "reports")} ${total === 1 ? "says" : "say"} ${outcome.toUpperCase()}.`,
  priceNoReport: (q: string) => `oddie reads "${short(q)}" off the price, no report needed.`,
  noResult: (q: string) => `No result came in for "${short(q)}" before the stream ended, so it's canceled. No points.`,
  split: (q: string, t: Tally, msLeft: number | null) => msLeft === null
    ? `"${q}" ${split(t)}. !yes or !no, earlier calls score more`
    : `"${q}" ${split(t)}, ${left(msLeft)} left. !yes or !no`,
  reminder: (q: string, t: Tally, msLeft: number | null) =>
    `Still open: "${q}"${t.yes + t.no ? ` ${split(t)}` : ""}${msLeft === null ? "" : `, ${left(msLeft)} left`}. Type !yes or !no, earlier calls score more.`,
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
  settled: (q: string, outcome: Side, right: number, total: number, top: number, url: string) => {
    const it = `It's ${outcome.toUpperCase()}: "${short(q, 80)}".`;
    if (!total) return `${it} The next one opens with !call. Standings: ${url}`;
    if (!right) return `${it} The whole room went the other way this time. Standings: ${url}`;
    return `${it} ${right} of ${total} called it right, up to +${top}, earlier calls scored more. Standings: ${url}`;
  },
  /** More than one call waits and the command did not say which. */
  which: (verb: string, qs: string[]) =>
    `Which one? ${qs.slice(0, 5).map((q, i) => `!call ${verb} ${i + 1} for "${short(q, 40)}"`).join(", ")}`,
  canceled: "Call canceled. The next one opens with !call.",
  busy: (q: string) => `One call at a time: "${q}" is still running.`,
  settleFirst: (q: string) => `To settle "${short(q)}": !call yes or !call no.`,
  settleOnly: "To settle, type only !call yes or !call no. To open a call, start with the question.",
  help: "Mods: !call <question> opens a vote (!call 5m <question> locks in five minutes), chat answers !yes or !no. oddie settles price calls itself; for anything else anybody types !result yes or !result no when it's over, and mods can always settle with !call yes or !call no.",
  pickHelp: "No vote is open. Start one with !call <question>, then chat answers !yes or !no. Take a market's YES or NO on its link.",
  // No line of oddie's starts with a command: an echo of it is never one.
  marketHelp: "Open a market with !oddie and a claim with a yes or no and a date, anybody can take it and oddie settles it. Reply !oddie to a message to open one on it.",
  hello: "oddie is here. !oddie <claim> opens a real market anybody can take, settled by oddie. Mods run votes with !call <question>, and chat answers !yes or !no.",
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
  open(input: { platform: Platform; channelId: string; question: string; openedById: string; openedByName: string; openedAt: number; closesAt: number; timed: boolean }): Promise<LiveCall | null>;
  /** One answer per person per call: true when this one is new. */
  pick(call: LiveCall, userId: string, username: string, side: Side, at: number): Promise<boolean>;
  tally(callId: string): Promise<Tally>;
  /** Locks a call once: true only for the caller that locked it. */
  lock(callId: string, at: number): Promise<boolean>;
  /** Settles once and scores each right answer by how early it came (pointsAt
   *  over `points`); null when already settled. `top` is the best one scored. */
  settle(callId: string, outcome: Side, points: number, at: number): Promise<{ right: number; total: number; top: number } | null>;
  cancel(callId: string, at: number): Promise<boolean>;
  /** Calls taking answers whose time is up. */
  due(now: number): Promise<LiveCall[]>;
  /** Calls taking answers, in every channel: the reminder walks them. */
  takingAnswers(): Promise<LiveCall[]>;
  /** Every call not settled or canceled, in every channel, oldest first: the
   *  clock walks them for waits a restart lost and streams that ended. */
  everyUnsettled(): Promise<LiveCall[]>;
}

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
  /** Where a price call's numbers are read. Absent: Binance. */
  prices?: PriceSource;
  /** Is the channel live now? null when the platform did not answer. Absent: a
   *  stream's end is never seen, and room calls wait for a report or the mods. */
  streamLive?(platform: Platform, channelId: string): Promise<boolean | null>;
}

/** A price call between its lock and its result. */
interface PriceWait { call: LiveCall; pc: PriceCall; plan: PricePlan; nextTryAt: number; busy: boolean }

/** How often a touch is looked for while its window is open, and how soon a
 *  source that did not answer is asked again. */
export const PRICE_POLL_MS = 15_000;
/** How long after its time is up oddie keeps reading before the call goes back to the mods. */
export const PRICE_GIVE_UP_MS = 10 * 60_000;

const lastSplit = new Map<string, number>();
/** Price calls oddie settles itself, from their lock on. Kept in memory: after
 *  a restart the clock gives each locked price call its wait back. */
const priceWaits = new Map<string, PriceWait>();
/** Price calls oddie could not read and handed to the mods. The clock gives a
 *  locked price call its wait back after a restart; without this it gave one
 *  back a minute after the hand-over too, and the room heard "yours to settle"
 *  every minute until a mod did. */
const handedToMods = new Set<string>();
const lastPickHelp = new Map<string, number>();
/** A room call's reports, from its first !result until the majority settles it. */
interface Reports { call: LiveCall; votes: Map<string, Side>; closeAt: number; extended: boolean }
const reports = new Map<string, Reports>();
/** Price calls whose "no report needed" line was said once. */
const toldPrice = new Set<string>();
/** Per channel: seen live since its calls opened. A live channel going dark is the stream ending. */
const seenLive = new Map<string, boolean>();
let lastWatch = 0;
/** When a channel's chat last moved, and when each call was last said. */
const lastActivity = new Map<string, number>();
const lastSaid = new Map<string, number>();
/** Test seam. */
export function _resetLive(): void {
  lastSplit.clear(); lastPickHelp.clear(); lastActivity.clear(); lastSaid.clear(); priceWaits.clear(); handedToMods.clear();
  reports.clear(); toldPrice.clear(); seenLive.clear(); lastWatch = 0;
}
/** Test seam: what a restart forgets (the waits and reports in memory), the store keeps. */
export function _forgetWaits(): void { priceWaits.clear(); handedToMods.clear(); reports.clear(); lastWatch = 0; }

const roomKey = (m: { platform: Platform; channelId: string }) => `${m.platform}:${m.channelId}`;

async function sayQuiet(deps: LiveDeps, m: { platform: Platform; channelId: string }, text: string, replyTo?: string): Promise<string | null> {
  try { const id = await deps.say(m.platform, m.channelId, text, replyTo); return typeof id === "string" && id ? id : null; }
  catch (e) { deps.log("live chat line not delivered", { err: (e as Error).message }); return null; }
}

/** The same words, and for a price question the same moment: "the next 5m
 *  candle" asked again once the candle has turned is the next round. */
function sameCall(call: LiveCall, question: string, now: number): boolean {
  const words = (q: string) => q.toLowerCase().replace(/\s+/g, " ").replace(/[\s?!.]+$/, "").trim();
  if (words(call.question) !== words(question)) return false;
  const pc = parsePriceCall(question);
  return !pc || planFor(pc, now).to === planFor(pc, call.openedAt).to;
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
function waitForPrice(call: LiveCall): string | null {
  const pc = parsePriceCall(call.question);
  if (!pc) return null;
  const plan = planFor(pc, call.openedAt);
  // A touch is looked for from the lock on; anything else is read once its time is up.
  priceWaits.set(call.id, { call, pc, plan, nextTryAt: pc.kind === "touch" ? 0 : plan.to + PRICE_SETTLE_LAG_MS, busy: false });
  return whenText(pc, plan);
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
  lastSplit.delete(call.id); lastSaid.delete(call.id);
  const tally = await deps.store.tally(call.id);
  const when = waitForPrice(call);
  await sayQuiet(deps, call, when ? LIVE_COPY.lockedPrice(tally, when) : LIVE_COPY.locked(tally));
  await unpinIfIdle(deps, call);
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
    w.nextTryAt = w.pc.kind === "touch" ? now + PRICE_POLL_MS : w.plan.to + PRICE_SETTLE_LAG_MS;
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
  const url = await deps.standingsUrl(w.call.platform, w.call.channelId);
  await sayQuiet(deps, w.call, `${read.said} ${LIVE_COPY.settled(w.call.question, read.outcome, done.right, done.total, done.top, url)}`);
  deps.log("live call settled", { platform: w.call.platform, channel: w.call.channelId, id: w.call.id, outcome: read.outcome, right: done.right, total: done.total, by: "price" });
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
async function pickHelp(msg: ChatMessage, waiting: LiveCall | null, now: number, deps: LiveDeps, quiet = "no-open-call"): Promise<string> {
  if (!msg.canRun) return quiet;
  const key = `${roomKey(msg)}:${waiting?.id ?? ""}`;
  const last = lastPickHelp.get(key);
  if (last !== undefined && now - last < PICK_HELP_GAP_MS) return quiet;
  for (const [k, at] of lastPickHelp) if (now - at >= PICK_HELP_GAP_MS) lastPickHelp.delete(k);
  lastPickHelp.set(key, now);
  const price = waiting ? priceWaits.get(waiting.id) : undefined;
  const line = !waiting ? LIVE_COPY.pickHelp
    : price ? LIVE_COPY.switched(waiting.question, await deps.store.tally(waiting.id), whenText(price.pc, price.plan))
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
    const last = lastSplit.get(call.id) ?? call.openedAt;
    if (now - last >= SPLIT_GAP_MS) {
      lastSplit.set(call.id, now);
      await sayQuiet(deps, msg, LIVE_COPY.split(call.question, await deps.store.tally(call.id), call.timed ? call.closesAt - now : null));
    }
    return "picked";
  }

  // The market door is for everybody, like a tag on X or Telegram. Bare, under
  // a message, it means that message; bare on its own it asks how.
  if (cmd.kind === "market") {
    const claim = cmd.claim || (msg.replyText ?? "").trim();
    if (!claim || !deps.market) { await sayQuiet(deps, msg, LIVE_COPY.marketHelp, msg.messageId); return "market-help"; }
    return deps.market(msg, claim);
  }

  // What happened is anybody's to say: the room settles the moments only it saw.
  if (cmd.kind === "report") return report(msg, cmd.side, now, deps);

  if (!msg.canRun) return "not-allowed";

  if (cmd.kind === "help") { await sayQuiet(deps, msg, LIVE_COPY.help, msg.messageId); return "help"; }
  if (cmd.kind === "settle-help") { await sayQuiet(deps, msg, LIVE_COPY.settleOnly, msg.messageId); return "settle-help"; }

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
      return "again";
    }
    // The new call takes the room. The one taking answers keeps them and waits
    // for its result, so nothing anybody said is lost.
    if (running && (await deps.store.lock(running.id, now))) {
      lastSplit.delete(running.id); lastSaid.delete(running.id);
      await sayQuiet(deps, msg, LIVE_COPY.switched(running.question, await deps.store.tally(running.id), waitForPrice(running)));
    }
    // A price call oddie settles itself, so it does not stay open until a mod
    // settles it: three minutes by default, never past the moment its answer is known.
    let minutes = cmd.minutes;
    let closesAt = now + (minutes === null ? CALL_OPEN_MAX_MS : minutes * 60_000);
    const pc = minutes === null ? parsePriceCall(cmd.question) : null;
    if (pc) {
      closesAt = Math.min(now + PRICE_CALL_LOCK_MS, planFor(pc, now).to);
      minutes = Math.max(1, Math.ceil((closesAt - now) / 60_000));
    }
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
    lastSplit.set(opened.id, now); lastSaid.set(opened.id, now);
    const id = await sayQuiet(deps, msg, LIVE_COPY.opened(opened.question, minutes, await deps.standingsUrl(msg.platform, msg.channelId), !parsePriceCall(opened.question)));
    await pinQuiet(deps, msg, id);
    deps.log("live call opened", { platform: msg.platform, channel: msg.channelId, id: opened.id, minutes, price: pc?.kind ?? null });
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
    lastSplit.delete(target.id); lastSaid.delete(target.id); priceWaits.delete(target.id); reports.delete(target.id);
    await unpinIfIdle(deps, msg);
    await sayQuiet(deps, msg, LIVE_COPY.canceled);
    return "canceled";
  }

  // settle: a call still taking answers is locked first, so a late answer
  // cannot slip in after the result is known.
  if (target.lockedAt === null) await deps.store.lock(target.id, now);
  lastSplit.delete(target.id); lastSaid.delete(target.id); priceWaits.delete(target.id); reports.delete(target.id);
  const tally = await deps.store.tally(target.id);
  const points = pointsFor(tally, cmd.outcome);
  const done = await deps.store.settle(target.id, cmd.outcome, points, now);
  if (!done) return "no-call";
  await unpinIfIdle(deps, msg);
  await sayQuiet(deps, msg, LIVE_COPY.settled(target.question, cmd.outcome, done.right, done.total, done.top, await deps.standingsUrl(msg.platform, msg.channelId)));
  deps.log("live call settled", { platform: msg.platform, channel: msg.channelId, id: target.id, outcome: cmd.outcome, right: done.right, total: done.total });
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
  await closeReports(deps);
  await watchStreams(deps);
  return n;
}

/**
 * !result yes / !result no. The call it is about: one the room is already
 * reporting, else the room call taking answers, else the newest room call
 * waiting. The first report closes the answers (nobody calls a result they
 * just saw) and opens a minute for everybody else's.
 */
async function report(msg: ChatMessage, side: Side, now: number, deps: LiveDeps): Promise<string> {
  const waiting = await deps.store.unsettled(msg.platform, msg.channelId);
  const open = [...reports.values()].find((r) => r.call.platform === msg.platform && r.call.channelId === msg.channelId);
  if (open) {
    if (!open.votes.has(msg.senderId)) open.votes.set(msg.senderId, side);
    return "reported";
  }
  const rooms = waiting.filter((c) => !parsePriceCall(c.question));
  const target = rooms.find((c) => c.lockedAt === null) ?? rooms[rooms.length - 1];
  if (!target) {
    const price = waiting[waiting.length - 1];
    if (!price) return "no-call";
    if (!toldPrice.has(price.id)) { toldPrice.add(price.id); await sayQuiet(deps, msg, LIVE_COPY.priceNoReport(price.question), msg.messageId); }
    return "price-call";
  }
  reports.set(target.id, { call: target, votes: new Map([[msg.senderId, side]]), closeAt: now + REPORT_WINDOW_MS, extended: false });
  if (target.lockedAt === null && (await deps.store.lock(target.id, now))) { lastSplit.delete(target.id); lastSaid.delete(target.id); }
  await sayQuiet(deps, msg, LIVE_COPY.reportOpened(target.question));
  await unpinIfIdle(deps, msg);
  deps.log("live call reported", { platform: msg.platform, channel: msg.channelId, id: target.id });
  return "reported";
}

/** Settle a room call on its reports, said with the count in front. */
async function settleOnReports(r: Reports, outcome: Side, deps: LiveDeps): Promise<boolean> {
  const tally = await deps.store.tally(r.call.id);
  const points = pointsFor(tally, outcome);
  const done = await deps.store.settle(r.call.id, outcome, points, deps.now());
  if (!done) return false;
  const agree = [...r.votes.values()].filter((v) => v === outcome).length;
  await unpinIfIdle(deps, r.call);
  const url = await deps.standingsUrl(r.call.platform, r.call.channelId);
  await sayQuiet(deps, r.call, `${LIVE_COPY.roomSays(agree, r.votes.size, outcome)} ${LIVE_COPY.settled(r.call.question, outcome, done.right, done.total, done.top, url)}`);
  deps.log("live call settled", { platform: r.call.platform, channel: r.call.channelId, id: r.call.id, outcome, right: done.right, total: done.total, by: "room" });
  return true;
}

/** A minute after the first report: the majority settles it; a tie gets one more minute, then the mods. */
async function closeReports(deps: LiveDeps): Promise<void> {
  const now = deps.now();
  for (const [id, r] of [...reports]) {
    if (now < r.closeAt) continue;
    const yes = [...r.votes.values()].filter((v) => v === "yes").length, no = r.votes.size - yes;
    if (yes === no) {
      if (!r.extended) { r.extended = true; r.closeAt = now + REPORT_WINDOW_MS; await sayQuiet(deps, r.call, LIVE_COPY.reportTie(r.call.question, yes, no)); continue; }
      reports.delete(id);
      await sayQuiet(deps, r.call, LIVE_COPY.reportToMods(r.call.question));
      continue;
    }
    reports.delete(id);
    await settleOnReports(r, yes > no ? "yes" : "no", deps).catch((e) => deps.log("live report not settled", { id, err: (e as Error).message }));
  }
}

/**
 * Once a minute: price calls a restart left without their wait get it back (the
 * store kept them, memory did not), calls nobody settled in a day are put away,
 * and a channel that was live and went dark has ended its stream. Then its room
 * calls settle on what the room reported, or are canceled with no points.
 */
async function watchStreams(deps: LiveDeps): Promise<void> {
  const now = deps.now();
  if (now - lastWatch < STREAM_POLL_MS) return;
  lastWatch = now;
  const all = await deps.store.everyUnsettled().catch(() => [] as LiveCall[]);
  const roomsBy = new Map<string, LiveCall[]>();
  for (const c of all) {
    if (now - c.openedAt > CALL_FORGET_MS) {
      if (await deps.store.cancel(c.id, now).catch(() => false)) deps.log("live call forgotten", { platform: c.platform, channel: c.channelId, id: c.id });
      continue;
    }
    if (parsePriceCall(c.question)) {
      if (c.lockedAt !== null && !priceWaits.has(c.id) && !handedToMods.has(c.id)) waitForPrice(c);
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
      const r = reports.get(c.id);
      reports.delete(c.id);
      const yes = r ? [...r.votes.values()].filter((v) => v === "yes").length : 0, no = r ? r.votes.size - yes : 0;
      if (r && yes !== no) { await settleOnReports(r, yes > no ? "yes" : "no", deps).catch(() => false); continue; }
      if (!(await deps.store.cancel(c.id, now).catch(() => false))) continue;
      lastSplit.delete(c.id); lastSaid.delete(c.id);
      await sayQuiet(deps, c, LIVE_COPY.noResult(c.question));
    }
    await unpinIfIdle(deps, calls[0]);
  }
}

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
    const id = await sayQuiet(deps, call, LIVE_COPY.reminder(call.question, await deps.store.tally(call.id), call.timed ? call.closesAt - now : null));
    await pinQuiet(deps, call, id);
    n++;
  }
  return n;
}
