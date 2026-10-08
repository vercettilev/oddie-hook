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
 * SEEN LATER. A call that runs for hours is said again every quarter hour while
 * chat is moving, and on Twitch the line is pinned, so somebody who arrives in
 * the second hour still sees what to type.
 *
 * One kind of call oddie settles itself: a coin's candle (src/live/priceCall.ts),
 * read the moment it closes. It takes answers for three minutes by default,
 * never past its candle's close.
 *
 * Platform-free on purpose: Kick is the first adapter (src/kick), Twitch plugs
 * into the same engine with its own client.
 */

import { binanceCandles, candleWindow, outcomeFor, parsePriceCall, priceText, sizeLabel, type Candle, type CandleSource, type PriceCall } from "./priceCall.js";

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
  | { kind: "help" }
  | { kind: "market"; claim: string };

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
/** A candle call with no length takes answers this long, never past its candle's close. */
export const CANDLE_CALL_LOCK_MS = 3 * 60_000;
export const QUESTION_MAX = 180;
/** How often chat hears the running split while a call is open. */
export const SPLIT_GAP_MS = 45_000;
/** How often a channel's runners hear how !yes and !no work when nothing is open. */
export const PICK_HELP_GAP_MS = 10 * 60_000;

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
  opened: (q: string, minutes: number | null, url: string) => minutes === null
    ? `oddie call: "${q}" Type !yes or !no. Open until it's settled, earlier calls score more. Standings: ${url}`
    : `oddie call: "${q}" Type !yes or !no, calls lock in ${minutes} min, earlier calls score more. Standings: ${url}`,
  split: (q: string, t: Tally, msLeft: number | null) => msLeft === null
    ? `"${q}" ${split(t)}. !yes or !no, earlier calls score more`
    : `"${q}" ${split(t)}, ${left(msLeft)} left. !yes or !no`,
  reminder: (q: string, t: Tally, msLeft: number | null) =>
    `Still open: "${q}"${t.yes + t.no ? ` ${split(t)}` : ""}${msLeft === null ? "" : `, ${left(msLeft)} left`}. Type !yes or !no, earlier calls score more.`,
  locked: (t: Tally) => t.yes + t.no
    ? `Calls are locked: ${split(t)}. Mods settle it with !call yes or !call no.`
    : "Calls are locked for this one. The next one is yours.",
  lockedCandle: (t: Tally, pc: PriceCall) =>
    `${t.yes + t.no ? `Calls are locked: ${split(t)}.` : "Calls are locked for this one."} oddie settles it when the ${sizeLabel(pc.size)} candle closes.`,
  candleRead: (pc: PriceCall, c: Candle, venue: string) => pc.test.kind === "green" || pc.test.kind === "red"
    ? `${pc.asset} ${sizeLabel(pc.size)} candle opened ${priceText(c.open)}, closed ${priceText(c.close)} on ${venue}.`
    : `${pc.asset} ${sizeLabel(pc.size)} candle closed at ${priceText(c.close)} on ${venue}.`,
  candleToMods: (q: string) => `"${q}" is yours to settle: !call yes or !call no.`,
  /** A new call took the room: the old one keeps its answers and waits. */
  switched: (q: string, t: Tally, pc: PriceCall | null = null) => (t.yes + t.no
    ? `Locked "${short(q)}" at ${split(t)}.`
    : `Locked "${short(q)}".`) + (pc ? ` oddie settles it when the ${sizeLabel(pc.size)} candle closes.` : " It waits for its result."),
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
  help: "Mods: !call <question> opens a vote that stays open until you settle it (!call 5m <question> locks in five minutes), chat answers !yes or !no, settle with !call yes or !call no.",
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
  /** Where a candle call's result is read. Absent: Binance. */
  candles?: CandleSource;
}

/** A candle call between its lock and its result. */
interface CandleWait { call: LiveCall; pc: PriceCall; openAt: number; closeAt: number; nextTryAt: number; busy: boolean }

/** A finished candle is on Binance within a second or two of the close. */
export const CANDLE_GRACE_MS = 3_000;
export const CANDLE_RETRY_MS = 15_000;
/** How long after the close oddie keeps reading before the call goes back to the mods. */
export const CANDLE_GIVE_UP_MS = 10 * 60_000;

const lastSplit = new Map<string, number>();
/** Candle calls oddie settles itself, from their lock on. Kept in memory: a
 *  restart between a lock and its close leaves that one call to the mods,
 *  which is where every call lived before. */
const candleWaits = new Map<string, CandleWait>();
const lastPickHelp = new Map<string, number>();
/** When a channel's chat last moved, and when each call was last said. */
const lastActivity = new Map<string, number>();
const lastSaid = new Map<string, number>();
/** Test seam. */
export function _resetLive(): void { lastSplit.clear(); lastPickHelp.clear(); lastActivity.clear(); lastSaid.clear(); candleWaits.clear(); }

const roomKey = (m: { platform: Platform; channelId: string }) => `${m.platform}:${m.channelId}`;

async function sayQuiet(deps: LiveDeps, m: { platform: Platform; channelId: string }, text: string, replyTo?: string): Promise<string | null> {
  try { const id = await deps.say(m.platform, m.channelId, text, replyTo); return typeof id === "string" && id ? id : null; }
  catch (e) { deps.log("live chat line not delivered", { err: (e as Error).message }); return null; }
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

/** A locked call that names a coin's candle waits for it; any other waits for the mods. */
function waitForCandle(call: LiveCall): PriceCall | null {
  const pc = parsePriceCall(call.question);
  if (!pc) return null;
  const { openAt, closeAt } = candleWindow(pc, call.openedAt);
  candleWaits.set(call.id, { call, pc, openAt, closeAt, nextTryAt: closeAt + CANDLE_GRACE_MS, busy: false });
  return pc;
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
  const pc = waitForCandle(call);
  await sayQuiet(deps, call, pc ? LIVE_COPY.lockedCandle(tally, pc) : LIVE_COPY.locked(tally));
  await unpinIfIdle(deps, call);
  return true;
}

/**
 * Read a locked candle call's candle and settle it, as a mod's !call yes would,
 * with the number in front. A mod who settled or canceled first wins: the
 * store settles once. Not readable by ten minutes after the close, the call
 * goes back to the mods in one line.
 */
async function settleCandle(w: CandleWait, deps: LiveDeps): Promise<boolean> {
  const source = deps.candles ?? binanceCandles;
  const now = deps.now();
  const candle = await source.candle(w.pc.asset, w.pc.size, w.openAt).catch((e) => {
    deps.log("live candle not read", { id: w.call.id, asset: w.pc.asset, size: w.pc.size, err: (e as Error).message });
    return null;
  });
  if (!candle) {
    if (now - w.closeAt < CANDLE_GIVE_UP_MS) { w.nextTryAt = now + CANDLE_RETRY_MS; return false; }
    candleWaits.delete(w.call.id);
    const still = (await deps.store.unsettled(w.call.platform, w.call.channelId).catch(() => [] as LiveCall[])).some((c) => c.id === w.call.id);
    if (still) await sayQuiet(deps, w.call, LIVE_COPY.candleToMods(w.call.question));
    deps.log("live candle handed to mods", { platform: w.call.platform, channel: w.call.channelId, id: w.call.id });
    return false;
  }
  const outcome = outcomeFor(w.pc.test, candle);
  const tally = await deps.store.tally(w.call.id);
  const points = pointsFor(tally, outcome);
  const done = await deps.store.settle(w.call.id, outcome, points, now);
  candleWaits.delete(w.call.id);
  if (!done) return false;
  const url = await deps.standingsUrl(w.call.platform, w.call.channelId);
  await sayQuiet(deps, w.call, `${LIVE_COPY.candleRead(w.pc, candle, source.venue)} ${LIVE_COPY.settled(w.call.question, outcome, done.right, done.total, done.top, url)}`);
  deps.log("live call settled", { platform: w.call.platform, channel: w.call.channelId, id: w.call.id, outcome, right: done.right, total: done.total, by: "candle" });
  return true;
}

async function settleCandles(deps: LiveDeps): Promise<number> {
  let n = 0;
  for (const w of [...candleWaits.values()]) {
    if (w.busy || deps.now() < w.nextTryAt) continue;
    w.busy = true;
    try { if (await settleCandle(w, deps)) n++; }
    catch (e) {
      // The store blinked: the candle is still there next time.
      w.nextTryAt = deps.now() + CANDLE_RETRY_MS;
      deps.log("live candle not settled", { id: w.call.id, err: (e as Error).message });
    }
    finally { w.busy = false; }
  }
  return n;
}

/**
 * !yes or !no with nothing taking answers. From a viewer it is chat. From the
 * channel's owner or a mod it is a mistake worth one line: the first Twitch
 * pilot typed one with a market open in chat and no call, and heard nothing
 * back. Once per ten minutes per channel, so a mod hammering !yes is answered
 * once. A call waiting for its result gets its own line and its own ten
 * minutes, how to settle it: a runner's !yes there most likely means the result.
 */
async function pickHelp(msg: ChatMessage, waiting: LiveCall | null, now: number, deps: LiveDeps): Promise<string> {
  if (!msg.canRun) return "no-open-call";
  const key = `${roomKey(msg)}:${waiting?.id ?? ""}`;
  const last = lastPickHelp.get(key);
  if (last !== undefined && now - last < PICK_HELP_GAP_MS) return "no-open-call";
  for (const [k, at] of lastPickHelp) if (now - at >= PICK_HELP_GAP_MS) lastPickHelp.delete(k);
  lastPickHelp.set(key, now);
  await sayQuiet(deps, msg, waiting ? LIVE_COPY.settleFirst(waiting.question) : LIVE_COPY.pickHelp, msg.messageId);
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

  if (!msg.canRun) return "not-allowed";

  if (cmd.kind === "help") { await sayQuiet(deps, msg, LIVE_COPY.help, msg.messageId); return "help"; }

  if (cmd.kind === "open") {
    // The new call takes the room. The one taking answers keeps them and waits
    // for its result, so nothing anybody said is lost.
    const running = await deps.store.current(msg.platform, msg.channelId);
    if (running && (await deps.store.lock(running.id, now))) {
      lastSplit.delete(running.id); lastSaid.delete(running.id);
      await sayQuiet(deps, msg, LIVE_COPY.switched(running.question, await deps.store.tally(running.id), waitForCandle(running)));
    }
    // A candle call oddie settles itself, so it does not stay open until a mod
    // settles it: three minutes by default, never past its candle's close.
    let minutes = cmd.minutes;
    let closesAt = now + (minutes === null ? CALL_OPEN_MAX_MS : minutes * 60_000);
    const pc = minutes === null ? parsePriceCall(cmd.question) : null;
    if (pc) {
      closesAt = Math.min(now + CANDLE_CALL_LOCK_MS, candleWindow(pc, now).closeAt);
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
    const id = await sayQuiet(deps, msg, LIVE_COPY.opened(opened.question, minutes, await deps.standingsUrl(msg.platform, msg.channelId)));
    await pinQuiet(deps, msg, id);
    deps.log("live call opened", { platform: msg.platform, channel: msg.channelId, id: opened.id, minutes, candle: Boolean(pc) });
    return "opened";
  }

  // settle or cancel: which call. One waiting is that one; a number names one;
  // a bare cancel means the one taking answers; anything else is asked.
  const waiting = await deps.store.unsettled(msg.platform, msg.channelId);
  if (!waiting.length) return "no-call";
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
    lastSplit.delete(target.id); lastSaid.delete(target.id); candleWaits.delete(target.id);
    await unpinIfIdle(deps, msg);
    await sayQuiet(deps, msg, LIVE_COPY.canceled);
    return "canceled";
  }

  // settle: a call still taking answers is locked first, so a late answer
  // cannot slip in after the result is known.
  if (target.lockedAt === null) await deps.store.lock(target.id, now);
  lastSplit.delete(target.id); lastSaid.delete(target.id); candleWaits.delete(target.id);
  const tally = await deps.store.tally(target.id);
  const points = pointsFor(tally, cmd.outcome);
  const done = await deps.store.settle(target.id, cmd.outcome, points, now);
  if (!done) return "no-call";
  await unpinIfIdle(deps, msg);
  await sayQuiet(deps, msg, LIVE_COPY.settled(target.question, cmd.outcome, done.right, done.total, done.top, await deps.standingsUrl(msg.platform, msg.channelId)));
  deps.log("live call settled", { platform: msg.platform, channel: msg.channelId, id: target.id, outcome: cmd.outcome, right: done.right, total: done.total });
  return "settled";
}

/** The clock: timed calls whose time is up are locked and announced, and candle
 *  calls whose candle has closed are settled. */
export async function lockDue(deps: LiveDeps): Promise<number> {
  let n = 0;
  for (const call of await deps.store.due(deps.now()).catch(() => [] as LiveCall[])) {
    if (await lockAndSay(call, deps).catch(() => false)) n++;
  }
  await settleCandles(deps);
  return n;
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
