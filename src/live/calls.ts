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
 * WHO DOES WHAT. The channel's owner and its moderators open, settle and
 * cancel calls; everybody answers. One call at a time per channel, one answer
 * per person, and an answer is final: a call changed after the room has moved
 * is a call made with hindsight.
 *
 * Platform-free on purpose: Kick is the first adapter (src/kick), Twitch plugs
 * into the same engine with its own client.
 */

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
}

export type LiveCommand =
  | { kind: "open"; question: string; minutes: number }
  | { kind: "pick"; side: Side }
  | { kind: "settle"; outcome: Side }
  | { kind: "cancel" }
  | { kind: "help" };

export const CALL_MINUTES_DEFAULT = 3;
export const CALL_MINUTES_MAX = 30;
export const QUESTION_MAX = 180;
/** How often chat hears the running split while a call is open. */
export const SPLIT_GAP_MS = 45_000;

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
  const m = /^!oddie(?=\s|$)\s*(.*)$/i.exec(text);
  if (!m) return null;
  const rest = m[1].trim();
  if (!rest) return { kind: "help" };
  if (YES_WORD.test(rest)) return { kind: "settle", outcome: "yes" };
  if (NO_WORD.test(rest)) return { kind: "settle", outcome: "no" };
  if (/^(cancel|iptal)$/i.test(rest)) return { kind: "cancel" };
  // A length only at the START, where it cannot be part of the question:
  // "!oddie 5m will I win" is five minutes; "will he hit 5m followers" is not.
  let minutes = CALL_MINUTES_DEFAULT;
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
  closesAt: number;
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

export const LIVE_COPY = {
  opened: (q: string, minutes: number, url: string) =>
    `oddie call: "${q}" Type !yes or !no, calls lock in ${minutes} min. Standings: ${url}`,
  split: (q: string, t: Tally, msLeft: number) =>
    `"${q}" ${yesPct(t)}% YES from ${n(t.yes + t.no, "call", "calls")}, ${left(msLeft)} left. !yes or !no`,
  locked: (t: Tally) => t.yes + t.no
    ? `Calls are locked: ${yesPct(t)}% YES from ${n(t.yes + t.no, "call", "calls")}. The result is next.`
    : "Calls are locked for this one. The next one is yours.",
  settled: (outcome: Side, right: number, total: number, points: number, url: string) => {
    const it = `It's ${outcome.toUpperCase()}.`;
    if (!total) return `${it} Next call opens with !oddie. Standings: ${url}`;
    if (!right) return `${it} The whole room went the other way this time. Standings: ${url}`;
    return `${it} ${right} of ${total} called it right, +${points} each. Standings: ${url}`;
  },
  canceled: "Call canceled. The next one opens with !oddie.",
  busy: (q: string) => `One call at a time: "${q}" is still running.`,
  settleFirst: (q: string) => `Settle "${q}" first: !oddie yes or !oddie no.`,
  help: "Mods: !oddie <question> opens a call (!oddie 5m <question> for five minutes). Chat: !yes or !no. Settle with !oddie yes or !oddie no.",
  hello: "oddie is here. Mods: !oddie <question> opens a call, chat answers !yes or !no, and the standings live on oddie.",
};

/* --------------------------------------------------------------- engine -- */

export interface LiveStore {
  /** The channel's call that is not settled or canceled, if any. */
  current(platform: Platform, channelId: string): Promise<LiveCall | null>;
  /** Opens a call, or returns null when the channel already has one (the
   *  store enforces one at a time, so two mods at once cannot open two). */
  open(input: { platform: Platform; channelId: string; question: string; openedById: string; openedByName: string; openedAt: number; closesAt: number }): Promise<LiveCall | null>;
  /** One answer per person per call: true when this one is new. */
  pick(call: LiveCall, userId: string, username: string, side: Side, at: number): Promise<boolean>;
  tally(callId: string): Promise<Tally>;
  /** Locks a call once: true only for the caller that locked it. */
  lock(callId: string, at: number): Promise<boolean>;
  /** Settles once and scores the right answers; null when already settled. */
  settle(callId: string, outcome: Side, points: number, at: number): Promise<{ right: number; total: number } | null>;
  cancel(callId: string, at: number): Promise<boolean>;
  /** Open calls whose time is up. */
  due(now: number): Promise<LiveCall[]>;
}

export interface LiveDeps {
  store: LiveStore;
  now(): number;
  /** Say one line in this channel's chat, as oddie. */
  say(platform: Platform, channelId: string, text: string, replyTo?: string): Promise<void>;
  /** Where this channel's standings live on oddie. */
  standingsUrl(platform: Platform, channelId: string): Promise<string>;
  log(line: string, extra?: Record<string, unknown>): void;
}

const lastSplit = new Map<string, number>();
/** Test seam. */
export function _resetLive(): void { lastSplit.clear(); }

async function sayQuiet(deps: LiveDeps, m: { platform: Platform; channelId: string }, text: string, replyTo?: string): Promise<void> {
  try { await deps.say(m.platform, m.channelId, text, replyTo); }
  catch (e) { deps.log("live chat line not delivered", { err: (e as Error).message }); }
}

/** Lock a call that is due and tell the room. Once, whoever gets there first. */
async function lockAndSay(call: LiveCall, deps: LiveDeps): Promise<boolean> {
  if (!(await deps.store.lock(call.id, deps.now()))) return false;
  lastSplit.delete(call.id);
  await sayQuiet(deps, call, LIVE_COPY.locked(await deps.store.tally(call.id)));
  return true;
}

/**
 * One chat line. Returns what it did, for the log and the tests. Ordinary
 * chat, and anything a viewer may not do, costs nothing and says nothing: a
 * bot that answers every refusal becomes the loudest thing in the room.
 */
export async function handleChat(msg: ChatMessage, deps: LiveDeps): Promise<string> {
  const cmd = parseCommand(msg.text);
  if (!cmd) return "chat";
  const now = deps.now();

  if (cmd.kind === "pick") {
    const call = await deps.store.current(msg.platform, msg.channelId);
    if (!call || call.lockedAt !== null) return "no-open-call";
    if (now >= call.closesAt) { await lockAndSay(call, deps); return "late"; }
    const fresh = await deps.store.pick(call, msg.senderId, msg.senderName, cmd.side, now);
    if (!fresh) return "already-picked";
    const last = lastSplit.get(call.id) ?? call.openedAt;
    if (now - last >= SPLIT_GAP_MS) {
      lastSplit.set(call.id, now);
      await sayQuiet(deps, msg, LIVE_COPY.split(call.question, await deps.store.tally(call.id), call.closesAt - now));
    }
    return "picked";
  }

  if (!msg.canRun) return "not-allowed";

  if (cmd.kind === "help") { await sayQuiet(deps, msg, LIVE_COPY.help, msg.messageId); return "help"; }

  const call = await deps.store.current(msg.platform, msg.channelId);

  if (cmd.kind === "open") {
    if (call) {
      await sayQuiet(deps, msg, call.lockedAt !== null || now >= call.closesAt ? LIVE_COPY.settleFirst(call.question) : LIVE_COPY.busy(call.question), msg.messageId);
      return "busy";
    }
    const opened = await deps.store.open({
      platform: msg.platform, channelId: msg.channelId, question: cmd.question,
      openedById: msg.senderId, openedByName: msg.senderName, openedAt: now, closesAt: now + cmd.minutes * 60_000,
    });
    if (!opened) return "busy";
    lastSplit.set(opened.id, now);
    await sayQuiet(deps, msg, LIVE_COPY.opened(opened.question, cmd.minutes, await deps.standingsUrl(msg.platform, msg.channelId)));
    deps.log("live call opened", { platform: msg.platform, channel: msg.channelId, id: opened.id, minutes: cmd.minutes });
    return "opened";
  }

  if (!call) return "no-call";

  if (cmd.kind === "cancel") {
    if (!(await deps.store.cancel(call.id, now))) return "no-call";
    lastSplit.delete(call.id);
    await sayQuiet(deps, msg, LIVE_COPY.canceled);
    return "canceled";
  }

  // settle: an open call is locked first, so a late answer cannot slip in
  // after the result is known.
  if (call.lockedAt === null) await deps.store.lock(call.id, now);
  lastSplit.delete(call.id);
  const tally = await deps.store.tally(call.id);
  const points = pointsFor(tally, cmd.outcome);
  const done = await deps.store.settle(call.id, cmd.outcome, points, now);
  if (!done) return "no-call";
  await sayQuiet(deps, msg, LIVE_COPY.settled(cmd.outcome, done.right, done.total, points, await deps.standingsUrl(msg.platform, msg.channelId)));
  deps.log("live call settled", { platform: msg.platform, channel: msg.channelId, id: call.id, outcome: cmd.outcome, right: done.right, total: done.total });
  return "settled";
}

/** The clock: calls whose time is up are locked and announced. */
export async function lockDue(deps: LiveDeps): Promise<number> {
  let n = 0;
  for (const call of await deps.store.due(deps.now()).catch(() => [] as LiveCall[])) {
    if (await lockAndSay(call, deps).catch(() => false)) n++;
  }
  return n;
}
