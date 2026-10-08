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
  /** The message this one replied to: under a claim, a bare !oddie means it. */
  replyText?: string | null;
  /** The channel's own name, for the market's provenance. */
  channelSlug?: string;
}

export type LiveCommand =
  | { kind: "open"; question: string; minutes: number }
  | { kind: "pick"; side: Side }
  | { kind: "settle"; outcome: Side }
  | { kind: "cancel" }
  | { kind: "help" }
  | { kind: "market"; claim: string };

export const CALL_MINUTES_DEFAULT = 3;
export const CALL_MINUTES_MAX = 30;
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
  if (YES_WORD.test(rest)) return { kind: "settle", outcome: "yes" };
  if (NO_WORD.test(rest)) return { kind: "settle", outcome: "no" };
  if (/^(cancel|iptal)$/i.test(rest)) return { kind: "cancel" };
  // A length only at the START, where it cannot be part of the question:
  // "!call 5m will I win" is five minutes; "will he hit 5m followers" is not.
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
    if (!total) return `${it} The next one opens with !call. Standings: ${url}`;
    if (!right) return `${it} The whole room went the other way this time. Standings: ${url}`;
    return `${it} ${right} of ${total} called it right, +${points} each. Standings: ${url}`;
  },
  canceled: "Call canceled. The next one opens with !call.",
  busy: (q: string) => `One call at a time: "${q}" is still running.`,
  settleFirst: (q: string) => `Settle "${q}" first: !call yes or !call no.`,
  help: "Mods: !call <question> opens a quick vote (!call 5m <question> for five minutes), chat answers !yes or !no, settle with !call yes or !call no.",
  pickHelp: "No vote is open. Start one with !call <question>, then chat answers !yes or !no. Take a market's YES or NO on its link.",
  marketHelp: "!oddie <a claim with a yes or no and a date> opens a real market anybody can take, and oddie settles it. Reply !oddie to a message to open one on it.",
  hello: "oddie is here. !oddie <claim> opens a real market anybody can take, settled by oddie. Mods run quick votes with !call <question>, and chat answers !yes or !no.",
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
  /** The market door (src/live/claims.ts). Absent: !oddie is only explained. */
  market?(msg: ChatMessage, claim: string): Promise<string>;
}

const lastSplit = new Map<string, number>();
const lastPickHelp = new Map<string, number>();
/** Test seam. */
export function _resetLive(): void { lastSplit.clear(); lastPickHelp.clear(); }

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
 * !yes or !no with nothing open. From a viewer it is chat. From the channel's
 * owner or a mod it is a mistake worth one line: the first Twitch pilot typed
 * one with a market open in chat and no call, and heard nothing back. Once per
 * ten minutes per channel, so a mod hammering !yes is answered once. A locked
 * call gets its own line and its own ten minutes, how to settle it: a runner's
 * !yes there most likely means the result.
 */
async function pickHelp(msg: ChatMessage, call: LiveCall | null, now: number, deps: LiveDeps): Promise<string> {
  if (!msg.canRun) return "no-open-call";
  const key = `${msg.platform}:${msg.channelId}:${call?.id ?? ""}`;
  const last = lastPickHelp.get(key);
  if (last !== undefined && now - last < PICK_HELP_GAP_MS) return "no-open-call";
  for (const [k, at] of lastPickHelp) if (now - at >= PICK_HELP_GAP_MS) lastPickHelp.delete(k);
  lastPickHelp.set(key, now);
  await sayQuiet(deps, msg, call ? LIVE_COPY.settleFirst(call.question) : LIVE_COPY.pickHelp, msg.messageId);
  return "pick-help";
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
    if (!call || call.lockedAt !== null) return pickHelp(msg, call, now, deps);
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

  // The market door is for everybody, like a tag on X or Telegram. Bare, under
  // a message, it means that message; bare on its own it asks how.
  if (cmd.kind === "market") {
    const claim = cmd.claim || (msg.replyText ?? "").trim();
    if (!claim || !deps.market) { await sayQuiet(deps, msg, LIVE_COPY.marketHelp, msg.messageId); return "market-help"; }
    return deps.market(msg, claim);
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
