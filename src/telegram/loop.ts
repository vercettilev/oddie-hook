/**
 * oddie in Telegram groups: somebody tags the bot under a claim, a market opens
 * under it, the bot answers with the card.
 *
 * THE MARKET SIDE WAS ALREADY DONE, and this file is the proof of how little of
 * it is X-shaped. Extraction, the mint (openMarketFromClaim), the one-post-one-
 * market rule (sourcePostKey already keys t.me links as tg:/<chat>/<id>) and
 * the card are the same code the X bot runs. What lives here is only what is
 * specific to Telegram: which message is the claim, how to link to it, and how
 * to answer in a chat.
 *
 * Three rules carried over from the X loop, because they were each paid for:
 *
 *   NEVER POST TWICE. Once a reply has been handed to Telegram, a throw does
 *   not prove it failed -- a timeout on a delivered message throws the same way
 *   -- so that message is settled for good and never retried.
 *
 *   ONE POST, ONE MARKET. Tagging the same claim twice answers with the market
 *   it already has.
 *
 *   BOOKKEEPING NEVER OWES MORE THAN THE ANSWER. Recording who somebody is can
 *   fail; the person who tagged is still owed a market.
 *
 * And one that is new, because Telegram's delivery works differently from X's.
 * Passing an offset to getUpdates CONFIRMS every earlier update and Telegram
 * never sends it again. A mint that failed (Solana unreachable, wallet dry) is
 * exactly the case that deserves another go, so the offset is held AT the first
 * such update: it comes back on the next poll, everything after it is already
 * settled and is skipped, and the retry is bounded by the same attempt limit
 * the X ledger enforces.
 *
 * GUEST MODE, THE SAME FLOW IN ANY CHAT. Since Bot API 10.0 a person can tag
 * the bot in a chat it was never added to, a private chat between two people
 * included. The update is `guest_message`, the bot may answer exactly once, and
 * nothing else it sends into that chat is accepted. So a guest tag gets a short
 * reply at once, before the slow part, and that reply is then edited into the
 * answer. Its ledger key is `tgg:`, never `tg:`: a guest chat's id can equal the
 * id of a chat the bot really is in.
 *
 * WHEN THE MODEL IS OUT, A TAG WAITS INSTEAD OF BOUNCING. Reading a claim is a
 * paid model call, and the model can be out for minutes (overloaded) or hours
 * (the credit balance ran dry, which is how this was found: three tags in a
 * row answered "tag me again in a minute", and again, and again). A tag that
 * hits that is parked: the chat is told it will open shortly, the words are
 * held in memory only, and every sweep tries again with a growing gap until
 * the model answers. Then the same reply is edited into the market (a guest
 * reply) or the card is posted under the tag and the note removed (a group).
 * Twelve hours later it gives up and says so. The operator hears about an
 * outage that needs a person (billing, a refused key) once, on Telegram.
 *
 * IDENTITY IS THE NUMERIC ID FROM THE FIRST ROW. The ledger author is
 * `tg:<user id>`, never the @name: Telegram's own schema makes username
 * optional, so a person may not have one, and one they do have can be changed
 * or given away. The name is recorded beside the id, as display.
 */
import type { Extraction } from "../matching/extractClaim.js";
import type { PriceClaim } from "../price/index.js";
import type { MintResult } from "../x/mentionLoop.js";
import { createHash } from "node:crypto";
import type { GuestContent, TgCallbackQuery, TgMessage, TgUpdate, TgUser } from "./client.js";
import { buildTweetReply } from "../matching/tweetReply.js";
import { claimMention, settleMention, botStateGet, botStateSet } from "../store/markets.js";

export const TG_OFFSET_KEY = "tg_offset";

export interface TgSweepDeps {
  /** The bot's own @name, without the @. Used to recognise a tag. */
  botUsername: string;
  updates(offset: number | null): Promise<TgUpdate[]>;
  extract(text: string): Promise<Extraction>;
  existingMarket?(sourceUrl: string): Promise<{ slug: string; question: string } | null>;
  openMarket(input: {
    question: string;
    closeInput: unknown;
    sourceUrl: string | null;
    category?: string;
    resolutionCriteria?: string | null;
    priceClaim?: PriceClaim | null;
    claimText?: string | null;
    resolvability?: string | null;
    hook?: string | null;
    /** Who opened it, as `tg:<user id>`. The 2% belongs to this person. */
    openerId?: string | null;
  }): Promise<MintResult>;
  /** Answer in the chat, threaded under `replyTo`. A photo when there is one. */
  reply(opts: { chatId: number; replyTo: number; text: string; photoUrl: string | null }): Promise<void>;
  /** A guest tag's one reply; returns its inline_message_id. */
  guestAnswer?(guestQueryId: string, content: GuestContent): Promise<string>;
  /** Rewrite that reply in place. */
  guestEdit?(inlineMessageId: string, content: GuestContent): Promise<void>;
  /** "Continue with Telegram": the bot was opened from a sign-in link. What
   *  to show the person, or null when the link is unknown or expired. */
  loginAsk?(nonce: string, user: TgUser): Promise<{ code: string; asking: string } | null>;
  /** Their Yes. True when a browser was signed in. */
  loginConfirm?(nonce: string, user: TgUser): Promise<boolean>;
  /** One message with one tappable button, in this person's chat with the bot. */
  sendPrompt?(chatId: number, text: string, button: { text: string; callback: string }): Promise<void>;
  answerCallback?(id: string, text?: string): Promise<void>;
  editMessage?(chatId: number, messageId: number, text: string): Promise<void>;
  /** A plain threaded reply in a group; returns its message id, so a parked
   *  tag's note can be edited or removed once the market is open. */
  replyText?(chatId: number, replyTo: number, text: string): Promise<number>;
  deleteMessage?(chatId: number, messageId: number): Promise<void>;
  /** The operator's own chat: an outage only a person can fix. */
  alertOps?(text: string): Promise<void>;
  /** Clock seam for the parked queue. */
  now?(): number;
  /** Guest tags from this person in the last day, and how many they get. */
  guestTriesToday?(author: string): Promise<number>;
  guestDailyTries?: number;
  rememberPerson?(platformId: string, handle: string | null): Promise<{ renamedFrom: string | null }>;
  /** The private one-tap URL that lets this Telegram user link a wallet and
   *  collect their 2%. Null when the feature is not configured. */
  earnLink?(tgUserId: number): string | null;
  /** Markets this person opened in the last 24 hours. Absent = no cap. */
  openedToday?(author: string): Promise<number>;
  dailyCap?: number;
  /** People the day's caps never apply to (the operator, testing). */
  uncapped?(user: TgUser): Promise<boolean>;
  /** Where the market page lives, and where its card image can be fetched. */
  baseUrl: string;
  cardUrl(slug: string): string;
  dryRun?: boolean;
  log?(msg: string, extra?: Record<string, unknown>): void;
}

export interface TgSweepResult {
  looked: number;
  replied: number;
  skipped: number;
  failed: number;
  retried: number;
  /** Tags set aside because the model is out; see parkTag. */
  parked: number;
  newOffset: number | null;
  decisions: Array<{ key: string; outcome: "replied" | "skipped" | "failed" | "retry" | "parked"; reason?: string; slug?: string }>;
}

/* ------------------------------------------------------------ small parts -- */

/** The ledger author for a Telegram user: the stable id, namespaced. */
export const tgAuthor = (userId: number): string => `tg:${userId}`;

/** Does this message tag the bot? Entities first (exact), plain text second. */
export function tagsBot(msg: TgMessage, botUsername: string): boolean {
  const text = msg.text ?? msg.caption ?? "";
  const want = `@${botUsername}`.toLowerCase();
  const ents = msg.entities ?? msg.caption_entities ?? [];
  for (const e of ents) {
    if (e.type === "mention" && text.slice(e.offset, e.offset + e.length).toLowerCase() === want) return true;
  }
  // A word boundary after the name, so @oddiefunbot does not match @oddiefunbotx.
  return new RegExp(`(^|\\s)@${escapeRe(botUsername)}(?![A-Za-z0-9_])`, "i").test(text);
}

export function stripBotTag(text: string, botUsername: string): string {
  return text.replace(new RegExp(`@${escapeRe(botUsername)}(?![A-Za-z0-9_])`, "gi"), " ").replace(/\s+/g, " ").trim();
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A link to one message, in the two forms t.me has and sourceUrlKind accepts:
 * t.me/<name>/<id> for a public group, t.me/c/<internal>/<id> for a private
 * supergroup. A basic group and a private chat have no message link at all, so
 * they return null and the market simply has no source post -- which also means
 * no one-post-one-market dedupe there, stated rather than faked.
 */
export function messageLink(chat: TgMessage["chat"], messageId: number): string | null {
  if (chat.type !== "supergroup" && chat.type !== "channel") return null;
  if (chat.username) return `https://t.me/${chat.username}/${messageId}`;
  const id = String(chat.id);
  return id.startsWith("-100") ? `https://t.me/c/${id.slice(4)}/${messageId}` : null;
}

/**
 * A MESSAGE THAT HAS NO LINK STILL HAS A SOURCE. A private chat and a basic
 * group have no t.me link, and they are exactly where guest mode and two
 * friends' new group put the bot. The market records an opaque marker instead,
 * a hash of the chat and the message: enough for one-post-one-market, and it
 * reveals neither, since in a one-to-one chat the chat id can be a person's own
 * user id. See TG_PRIVATE_SOURCE in the store.
 */
export function privateSource(chatId: number, messageId: number): string {
  return `tg-private:${createHash("sha256").update(`${chatId}:${messageId}`).digest("hex").slice(0, 16)}`;
}

/**
 * WHICH MESSAGE IS THE CLAIM. A reply-tag is the whole point -- somebody said
 * something, somebody else tags the bot under it -- so the parent is the claim
 * and the source. A tag on its own carries the claim in its own text. A reply
 * to the BOT is not a claim about the world; it falls through to the tag's own
 * words.
 */
export function claimOf(msg: TgMessage, botUsername: string): { text: string; source: TgMessage } {
  const parent = msg.reply_to_message;
  const parentText = parent ? (parent.text ?? parent.caption ?? "").trim() : "";
  if (parent && parentText && !parent.from?.is_bot) return { text: parentText, source: parent };
  return { text: stripBotTag(msg.text ?? msg.caption ?? "", botUsername), source: msg };
}

/* ----------------------------------------------------------------- copy -- */
// Short, and about what to do next rather than what went wrong.

export const TG_COPY = {
  empty: "Reply to a claim and tag me, or write the claim right after my name.",
  unmarketable:
    "I open markets on claims with a clear yes or no and a date. Tag me under one of those.",
  cap: (n: number) => `That's ${n} markets from you today. More tomorrow.`,
  /* The chat with the bot itself is where a person talks to oddie, not where
     markets open: there is nobody here to take the other side. */
  dm: "Tag me under a claim in any chat, a group or a private one, and I'll open a market on it right there.\n\nOpened one already? Send /earn to collect your 2%.",
  /* A guest tag gets one reply, sent at once and then edited into the answer,
     because reading the claim takes a few seconds. */
  reading: "Reading the claim…",
  /* After that reply, another go is impossible: the one reply is spent. So a
     passing outage is said as the next step rather than retried. */
  later: "Tag me again in a minute and I'll open it.",
  /* The model is out and the tag is parked: said as what happens next, and it
     does happen, by itself, once the model is back. */
  parked: "Got it. I'll open this market right here shortly.",
  /* A parked tag that waited its twelve hours, or outlived a restart. */
  expired: "Tag me again and I'll open it.",
  /* Left in place of the note only when the note could not be removed. */
  openedBelow: "Opened. It's right below.",
  guestCap: "That's plenty from you today. Tag me again tomorrow.",
  /* Signing a browser in. The code is on the page too: it is how a person
     knows the browser asking is the one in front of them. */
  loginAsk: (asking: string, code: string) =>
    `Sign in to oddie on ${asking}?\n\nCode ${code}, the same as on the page.\n\nTap only if you just pressed Continue with Telegram yourself.`,
  loginYes: "Yes, sign me in",
  loginDone: "Signed in. You can go back to oddie.",
  loginExpired: "That sign-in link has expired. Press Continue with Telegram on oddie again.",
  /* Where the 2% is collected. Sent ONLY in a private chat: the URL binds a
     wallet to this person's markets, so in a group anybody could take it. */
  earn: (link: string) =>
    `Connect a wallet and you collect 2% of every market you open. Markets you opened before count too, even ones that already closed.\n\n${link}\n\nThis link is yours and works for 30 minutes.`,
  earnOff: "Collecting isn't switched on yet. Your 2% is kept for you and you can collect it once it is.",
  /* Under a market that just opened, where the whole group reads it. The deep
     link is safe to post publicly: whoever taps it lands in THEIR OWN chat with
     the bot, authenticated by Telegram, and can only link their own markets. */
  opener: (who: string, bot: string) =>
    `Opened by ${who}, who earns 2% of the pool.\nCollect it: https://t.me/${bot}?start=earn`,
};

/** How to name a Telegram user in a group: their @name when they have one,
 *  otherwise the first name Telegram always provides. */
export const tgDisplayName = (u: { username?: string; first_name: string }): string =>
  u.username ? `@${u.username}` : u.first_name;

const EARN_COMMAND = /^\/(?:start\s+earn|earn|wallet|collect)\b/i;
const LOGIN_COMMAND = /^\/start\s+login_([a-f0-9]{32})$/i;
const LOGIN_CALLBACK = /^login:([a-f0-9]{32})$/;

/**
 * A tap on the sign-in button. Answered whatever happens: an unanswered
 * callback leaves the person's button spinning. The prompt is then rewritten,
 * so a spent button cannot be tapped again.
 */
async function handleCallback(cq: TgCallbackQuery, deps: TgSweepDeps): Promise<void> {
  const m = LOGIN_CALLBACK.exec(cq.data ?? "");
  if (!m || !deps.loginConfirm) { await deps.answerCallback?.(cq.id); return; }
  const ok = await deps.loginConfirm(m[1], cq.from).catch(() => false);
  await deps.answerCallback?.(cq.id, ok ? "Signed in" : "This sign-in has expired").catch(() => {});
  if (cq.message) {
    await deps.editMessage?.(cq.message.chat.id, cq.message.message_id, ok ? TG_COPY.loginDone : TG_COPY.loginExpired).catch(() => {});
  }
}

/* ------------------------------------------------------------- parking -- */

export const PARK_MAX_MS = 12 * 3600_000;
const PARK_MAX = 200;
const ALERT_GAP_MS = 3 * 3600_000;

export type ModelOutage = "billing" | "auth" | "config" | "busy" | "network";

/**
 * Is this failure the MODEL being out, rather than something about the claim?
 * Only these are worth parking: another go at the same words after the model
 * is back can succeed. A 4xx that is not about money or the key is a request
 * we got wrong, and waiting would not change it.
 */
export function modelOutage(err: unknown): ModelOutage | null {
  const m = err instanceof Error ? err.message : String(err ?? "");
  const st = /^extract (\d{3})\b/.exec(m);
  if (st) {
    const code = Number(st[1]);
    if (code === 400 && /credit balance|billing/i.test(m)) return "billing";
    if (code === 401 || code === 403) return "auth";
    if (code === 429 || code >= 500) return "busy";
    return null;
  }
  if (/^extraction unavailable/i.test(m)) return "config";
  if (/timeout|timed out|aborted|fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(m)) return "network";
  return null;
}

interface ParkedTag {
  key: string;
  guest: boolean;
  guestReplyId: string | null;
  chatId: number;
  tagMessageId: number;
  /** The group note ("Got it..."), removed once the card is up. */
  noteId: number | null;
  /** The claim, for the model. In memory only: from a private chat these are
   *  a person's words to a friend, and they are never written anywhere. */
  text: string;
  /** What the ledger may keep, as on the first attempt. */
  keptText: string | null;
  sourceUrl: string;
  author: string;
  from: TgUser;
  at: number;
  tries: number;
  nextAt: number;
}

const parked = new Map<string, ParkedTag>();
const lastAlert = new Map<ModelOutage, number>();

export function parkedCount(): number { return parked.size; }
/** Test seam. */
export function _resetParked(): void { parked.clear(); lastAlert.clear(); }

const nowOf = (deps: TgSweepDeps): number => (deps.now ? deps.now() : Date.now());
/** A minute, then two, four, eight, and every fifteen after that. */
const parkGap = (tries: number): number => Math.min(15 * 60_000, 60_000 * 2 ** Math.max(0, tries - 1));

function guestContent(text: string, slug: string | null, baseUrl: string): GuestContent {
  const url = slug ? `${baseUrl.replace(/\/+$/, "")}/m/${slug}` : null;
  return { text, previewUrl: url, button: url ? { text: "Take a side", url } : null };
}

export const OPS_COPY: Record<"billing" | "auth" | "config", (waiting: number) => string> = {
  billing: (n) => `oddie can't read claims right now: the Anthropic credit balance is empty.\n\n`
    + `${n} tag${n === 1 ? " is" : "s are"} waiting and will open by themselves once it is topped up:\nhttps://console.anthropic.com/settings/billing`,
  auth: (n) => `oddie can't read claims right now: Anthropic refused the API key (ANTHROPIC_API_KEY on Railway).\n\n`
    + `${n} tag${n === 1 ? " is" : "s are"} waiting.`,
  config: (n) => `oddie can't read claims right now: ANTHROPIC_API_KEY is not set on Railway.\n\n`
    + `${n} tag${n === 1 ? " is" : "s are"} waiting.`,
};

/** Tell the operator, once per kind per three hours, and only about outages a
 *  person has to fix. Busy and network outages clear by themselves. */
async function alertOnce(kind: ModelOutage, deps: TgSweepDeps): Promise<void> {
  if (!deps.alertOps || kind === "busy" || kind === "network") return;
  const now = nowOf(deps);
  const last = lastAlert.get(kind);
  if (last !== undefined && now - last < ALERT_GAP_MS) return;
  lastAlert.set(kind, now);
  await deps.alertOps(OPS_COPY[kind](parked.size)).catch(() => {});
}

/** Set a tag aside: say so in the chat, keep the work in memory, and write the
 *  ledger row as decided so Telegram's redelivery never double-handles it. */
async function parkTag(
  t: Omit<ParkedTag, "noteId" | "at" | "tries" | "nextAt">, kind: ModelOutage, err: unknown, deps: TgSweepDeps,
): Promise<void> {
  const now = nowOf(deps);
  let noteId: number | null = null;
  if (t.guest) {
    if (t.guestReplyId && deps.guestEdit) await deps.guestEdit(t.guestReplyId, { text: TG_COPY.parked }).catch(() => {});
  } else if (deps.replyText) {
    noteId = await deps.replyText(t.chatId, t.tagMessageId, TG_COPY.parked).catch(() => null);
  }
  parked.set(t.key, { ...t, noteId, at: now, tries: 1, nextAt: now + parkGap(1) });
  const msg = err instanceof Error ? err.message : String(err);
  await settleMention(t.key, "failed", {
    reason: `parked:${kind} ${msg}`.slice(0, 300), claimText: t.keptText,
    // Where the note is, so a restart that loses this queue can still take it back.
    replyId: t.guest ? t.guestReplyId : noteId !== null ? `note:${t.chatId}:${noteId}` : null,
  }).catch(() => {});
}

/** Give up on a parked tag and say so where it was promised. */
async function releaseTag(t: ParkedTag, why: string, deps: TgSweepDeps): Promise<void> {
  parked.delete(t.key);
  if (t.guest) { if (t.guestReplyId && deps.guestEdit) await deps.guestEdit(t.guestReplyId, { text: TG_COPY.expired }).catch(() => {}); }
  else if (t.noteId !== null && deps.editMessage) await deps.editMessage(t.chatId, t.noteId, TG_COPY.expired).catch(() => {});
  await settleMention(t.key, "failed", { reason: `parked-${why}` }).catch(() => {});
}

/**
 * After a restart the queue is gone, and every note it left says "shortly".
 * Those are taken back here, from the ledger: a guest reply by its inline id, a
 * group note by the chat and message the ledger kept.
 */
export async function releaseOrphanedParks(
  rows: Array<{ key: string; replyId: string | null }>,
  io: {
    guestEdit?(inlineMessageId: string, content: GuestContent): Promise<void>;
    editMessage?(chatId: number, messageId: number, text: string): Promise<void>;
    settle(key: string): Promise<void>;
  },
): Promise<number> {
  let n = 0;
  for (const r of rows) {
    const note = r.replyId ? /^note:(-?\d+):(\d+)$/.exec(r.replyId) : null;
    if (r.key.startsWith("tgg:") && r.replyId && io.guestEdit) await io.guestEdit(r.replyId, { text: TG_COPY.expired }).catch(() => {});
    else if (note && io.editMessage) await io.editMessage(Number(note[1]), Number(note[2]), TG_COPY.expired).catch(() => {});
    await io.settle(r.key).catch(() => {});
    n++;
  }
  return n;
}

/**
 * What is left once the claim has been read: the gate, the mint, the answer,
 * the ledger. Shared by a fresh tag and a parked one finishing later. A mint
 * outage on a group tag comes back as "retry" for the caller to decide: a
 * fresh tag holds the offset, a parked one has no offset left to hold.
 */
async function finishClaim(
  job: {
    key: string; guest: boolean; keptText: string | null; sourceUrl: string; author: string; from: TgUser;
    answer(text: string, slug: string | null): Promise<void>;
    replyId(): string | null;
  },
  ex: Extraction, deps: TgSweepDeps,
): Promise<{ outcome: "replied" | "skipped" | "failed" | "retry"; reason: string; slug?: string; ledgerReason?: string }> {
  const log = deps.log ?? (() => {});
  if (ex.resolvability === "unresolvable" || !ex.appropriate || !ex.question) {
    await job.answer(TG_COPY.unmarketable, null);
    await settleMention(job.key, "skipped", { reason: `gate:${ex.resolvability}`, claimText: job.keptText });
    return { outcome: "skipped", reason: `gate:${ex.resolvability}` };
  }

  const minted = await deps.openMarket({
    question: ex.question,
    closeInput: ex.close_time,
    sourceUrl: job.sourceUrl,
    category: ex.category,
    resolutionCriteria: ex.resolution_criteria || null,
    priceClaim: ex.price_claim,
    claimText: job.keptText,
    resolvability: ex.resolvability,
    hook: ex.hook || null,
    openerId: job.author,
  });
  if (!minted.ok) {
    /* A REFUSAL IS AN ANSWER; ONLY AN OUTAGE IS WORTH ANOTHER GO. A 4xx is
       the mint telling us this claim cannot become a market -- a price
       claim it could not pin to one token, say -- and asking again gets the
       same answer after another paid extraction. That is what happened
       three times in five seconds on the first live tag. A 5xx or a
       network failure is the one case another attempt can fix. */
    const refused = minted.status >= 400 && minted.status < 500;
    if (refused) {
      await job.answer(TG_COPY.unmarketable, null);
      await settleMention(job.key, "skipped", { reason: `mint:${minted.status} ${minted.error}`, claimText: job.keptText });
      return { outcome: "skipped", reason: `mint:${minted.status}` };
    }
    /* A GUEST TAG CANNOT BE TRIED AGAIN: its one reply is already out, and
       a second answerGuestQuery is refused. It says what to do instead. */
    if (job.guest && job.replyId()) {
      await job.answer(TG_COPY.later, null);
      await settleMention(job.key, "failed", { reason: `mint:${minted.status} ${minted.error}`, claimText: job.keptText, replyId: job.replyId() });
      return { outcome: "failed", reason: `mint:${minted.status}` };
    }
    return { outcome: "retry", reason: "mint", ledgerReason: `mint:${minted.status} ${minted.error}` };
  }

  const permalink = `${deps.baseUrl.replace(/\/+$/, "")}/m/${minted.slug}`;
  const reply = buildTweetReply({ question: ex.question, permalink, hook: ex.hook });
  /* THE INCENTIVE, SAID WHERE THE ROOM CAN SEE IT. "Bring the room, own the
     room" only works if the room can see that opening a market pays. Only
     under a market that just opened: a pointer to an existing one was
     opened by somebody else, and naming the tagger there would be false. */
  const openerLine = TG_COPY.opener(tgDisplayName(job.from), deps.botUsername);
  /* In a guest reply the preview above the text is the card and the page's
     own title, and the button is the link, so the full reply said the
     question three times. The headline and the opener are what is left. */
  await job.answer(job.guest ? `${ex.hook || ex.question}\n\n${openerLine}` : `${reply.primary}\n\n${openerLine}`, minted.slug);
  /* "opened" is what the daily cap counts: a pointer to a market that
     already existed opened nothing and costs the person nothing. A guest
     reply keeps its inline id: it is the only way to show the result there. */
  await settleMention(job.key, "replied", { slug: minted.slug, reason: "opened", claimText: job.keptText, replyId: job.replyId() });
  log("telegram market opened", { key: job.key, slug: minted.slug });
  return { outcome: "replied", reason: "opened", slug: minted.slug };
}

/**
 * Try the parked tags whose turn it is. One that still meets an outage stops
 * the round: the rest would meet the same one, and each try is a call.
 */
async function drainParked(deps: TgSweepDeps, result: TgSweepResult): Promise<void> {
  if (!parked.size || deps.dryRun) return;
  const log = deps.log ?? (() => {});
  for (const t of [...parked.values()]) {
    const now = nowOf(deps);
    if (now - t.at > PARK_MAX_MS) {
      await releaseTag(t, "expired", deps);
      result.failed++; result.decisions.push({ key: t.key, outcome: "failed", reason: "parked-expired" });
      log("telegram parked tag expired", { key: t.key });
      continue;
    }
    if (t.nextAt > now) continue;
    let ex: Extraction;
    try {
      ex = await deps.extract(t.text.slice(0, 4000));
    } catch (e) {
      const kind = modelOutage(e);
      t.tries++;
      t.nextAt = now + parkGap(t.tries);
      if (kind) { await alertOnce(kind, deps); break; }
      // Not the model: something about these words. Waiting will not help.
      await releaseTag(t, "error", deps);
      result.failed++; result.decisions.push({ key: t.key, outcome: "failed", reason: "parked-error" });
      log("telegram parked tag failed", { key: t.key, err: (e as Error).message });
      continue;
    }
    parked.delete(t.key);
    const answer = async (text: string, slug: string | null): Promise<void> => {
      if (t.guest) {
        if (!t.guestReplyId || !deps.guestEdit) throw new Error("the guest reply is gone");
        await deps.guestEdit(t.guestReplyId, guestContent(text, slug, deps.baseUrl));
        return;
      }
      // Words only: the note becomes them. A market: its card goes under the
      // tag, where it always goes, and the note that promised it is removed.
      if (!slug && t.noteId !== null && deps.editMessage) { await deps.editMessage(t.chatId, t.noteId, text); return; }
      await deps.reply({ chatId: t.chatId, replyTo: t.tagMessageId, text, photoUrl: slug ? deps.cardUrl(slug) : null });
      if (t.noteId !== null) {
        const noteId = t.noteId;
        const removed = deps.deleteMessage ? await deps.deleteMessage(t.chatId, noteId).then(() => true, () => false) : false;
        if (!removed && deps.editMessage) await deps.editMessage(t.chatId, noteId, TG_COPY.openedBelow).catch(() => {});
      }
    };
    try {
      const done = await finishClaim({
        key: t.key, guest: t.guest, keptText: t.keptText, sourceUrl: t.sourceUrl, author: t.author, from: t.from,
        answer, replyId: () => t.guestReplyId,
      }, ex, deps);
      if (done.outcome === "retry") {
        // A parked group tag has no offset left to hold: said, not retried.
        await answer(TG_COPY.later, null).catch(() => {});
        await settleMention(t.key, "failed", { reason: done.ledgerReason ?? "mint", claimText: t.keptText }).catch(() => {});
        result.failed++; result.decisions.push({ key: t.key, outcome: "failed", reason: "unparked:mint" });
        continue;
      }
      if (done.outcome === "replied") result.replied++;
      else if (done.outcome === "skipped") result.skipped++;
      else result.failed++;
      result.decisions.push({ key: t.key, outcome: done.outcome, reason: `unparked:${done.reason}`, slug: done.slug });
      log("telegram parked tag finished", { key: t.key, outcome: done.outcome, waitedMin: Math.round((now - t.at) / 60_000) });
    } catch (e) {
      await settleMention(t.key, "failed", { reason: `parked-post:${(e as Error).message}`.slice(0, 300) }).catch(() => {});
      result.failed++; result.decisions.push({ key: t.key, outcome: "failed", reason: "parked-post" });
      log("telegram parked tag failed after posting", { key: t.key, err: (e as Error).message });
    }
  }
}

/* ---------------------------------------------------------------- sweep -- */

export async function runTelegramSweep(deps: TgSweepDeps): Promise<TgSweepResult> {
  const log = deps.log ?? (() => {});
  const result: TgSweepResult = { looked: 0, replied: 0, skipped: 0, failed: 0, retried: 0, parked: 0, newOffset: null, decisions: [] };

  // Parked tags first: the ones waiting longest are owed their market first.
  await drainParked(deps, result).catch((e) => log("parked drain failed", { err: (e as Error).message }));

  const stored = await botStateGet(TG_OFFSET_KEY);
  const offset = stored !== null && Number.isFinite(Number(stored)) ? Number(stored) : null;
  const updates = await deps.updates(offset);
  if (!updates.length) return result;

  let maxId = -1;
  let holdAt: number | null = null;

  for (const u of updates) {
    maxId = Math.max(maxId, u.update_id);
    if (u.callback_query) {
      if (!deps.dryRun) await handleCallback(u.callback_query, deps).catch((e) => log("callback failed", { err: (e as Error).message }));
      continue;
    }
    const guest = u.guest_message ?? null;
    const msg = u.message ?? guest;
    if (!msg || !msg.from || msg.from.is_bot) continue;
    /* A GUEST MESSAGE COUNTS ONLY WHEN IT NAMES THE BOT. Guest mode also
       delivers every reply to the bot's own message in that chat, and two
       people talking under a card are not asking for anything. */
    if (guest && (!guest.guest_query_id || !tagsBot(msg, deps.botUsername))) continue;
    // A guest message from a private chat is a chat between two people, not
    // with the bot: it takes the claim path, never the DM one.
    const isPrivate = !guest && msg.chat.type === "private";
    if (!guest && !isPrivate && !tagsBot(msg, deps.botUsername)) continue;
    // Telegram sends "/start" the moment somebody opens a chat with the bot.
    // Only DMs get a reply to a bare command: in a group, an untagged command
    // was never meant for us.

    result.looked++;
    const key = `${guest ? "tgg" : "tg"}:${msg.chat.id}:${msg.message_id}`;
    /* PRIVATE WORDS STAY PRIVATE. In a one-to-one chat the claim is usually the
       OTHER person's message, written to one friend. Only the question the model
       draws from it is ever published; the words themselves are not even kept. */
    const keepText = !(guest && msg.chat.type === "private");
    const author = tgAuthor(msg.from.id);
    const decide = (outcome: TgSweepResult["decisions"][number]["outcome"], extra: { reason?: string; slug?: string } = {}) => {
      if (outcome === "replied") result.replied++;
      else if (outcome === "skipped") result.skipped++;
      else if (outcome === "retry") { result.retried++; holdAt = holdAt === null ? u.update_id : Math.min(holdAt, u.update_id); }
      else result.failed++;
      result.decisions.push({ key, outcome, ...extra });
    };

    if (!(await claimMention(key, author))) { decide("skipped", { reason: "already-decided" }); continue; }

    // Best effort: somebody who tagged is owed an answer whether or not we
    // managed to write down who they are.
    if (deps.rememberPerson) {
      const seen = await deps.rememberPerson(String(msg.from.id), msg.from.username ?? null).catch(() => null);
      if (seen?.renamedFrom) log("telegram name changed", { author, was: seen.renamedFrom, now: msg.from.username ?? null });
    }

    let postAttempted = false;
    /** A guest tag's reply, once sent: every later answer edits it. */
    let guestReplyId: string | null = null;
    /** Answer in this chat. `slug` names the market to show: its card as the
     *  photo in a group, its page as the preview and the button in a guest reply. */
    const answer = async (text: string, slug: string | null) => {
      if (deps.dryRun) { log("dry-run telegram reply", { key, text }); return; }
      postAttempted = true;
      if (guest) {
        if (!deps.guestAnswer || !deps.guestEdit) throw new Error("guest mode is not wired");
        const content = guestContent(text, slug, deps.baseUrl);
        if (guestReplyId) await deps.guestEdit(guestReplyId, content);
        else guestReplyId = await deps.guestAnswer(guest.guest_query_id!, content);
        return;
      }
      await deps.reply({ chatId: msg.chat.id, replyTo: msg.message_id, text, photoUrl: slug ? deps.cardUrl(slug) : null });
    };

    try {
      /* A PRIVATE CHAT OPENS NO MARKET, and is answered before anything is
         spent. The mint requires a linkable source post, and a DM has none; it
         used to reach the extraction anyway, so the "/start" Telegram sends
         when somebody opens the chat was graded by a paid model call and then
         refused. */
      if (isPrivate) {
        /* /start earn is what the deep link under a market sends, and /earn is
           the same thing typed. Telegram guarantees msg.from is the person in
           this chat, which is what lets the link be bound to them. */
        /* A SIGN-IN LINK asks, and never signs in by itself: the button does.
           See src/telegram/login.ts for why the tap is the consent. */
        const login = LOGIN_COMMAND.exec((msg.text ?? "").trim());
        if (login) {
          const ask = deps.loginAsk ? await deps.loginAsk(login[1], msg.from).catch(() => null) : null;
          if (ask && deps.sendPrompt && !deps.dryRun) {
            postAttempted = true;
            await deps.sendPrompt(msg.chat.id, TG_COPY.loginAsk(ask.asking, ask.code),
              { text: TG_COPY.loginYes, callback: `login:${login[1]}` });
          } else {
            await answer(TG_COPY.loginExpired, null);
          }
          await settleMention(key, "skipped", { reason: "login" });
          decide("skipped", { reason: "login" });
          continue;
        }
        const wantsEarn = EARN_COMMAND.test((msg.text ?? "").trim());
        if (wantsEarn) {
          const link = deps.earnLink ? deps.earnLink(msg.from.id) : null;
          await answer(link ? TG_COPY.earn(link) : TG_COPY.earnOff, null);
          await settleMention(key, "skipped", { reason: "earn" });
          decide("skipped", { reason: "earn" });
          continue;
        }
        await answer(TG_COPY.dm, null);
        await settleMention(key, "skipped", { reason: "dm" });
        decide("skipped", { reason: "dm" });
        continue;
      }

      const claim = claimOf(msg, deps.botUsername);
      if (!claim.text) {
        await answer(TG_COPY.empty, null);
        await settleMention(key, "skipped", { reason: "empty" });
        decide("skipped", { reason: "empty" });
        continue;
      }

      /* A LINK WHEN THERE IS ONE, AN OPAQUE MARKER WHEN THERE IS NOT. A basic
         group and a private chat have no t.me link. They used to be refused,
         with a request to change a group setting; the marker keeps provenance
         and one-post-one-market without a link. See privateSource. */
      const sourceUrl = messageLink(claim.source.chat, claim.source.message_id)
        ?? privateSource(claim.source.chat.id, claim.source.message_id);
      const claimText = keepText ? claim.text : null;

      // ONE POST, ONE MARKET. Free: no cap, no extraction.
      const already = sourceUrl && deps.existingMarket
        ? await deps.existingMarket(sourceUrl).catch(() => null)
        : null;
      if (already) {
        const permalink = `${deps.baseUrl.replace(/\/+$/, "")}/m/${already.slug}`;
        const reply = buildTweetReply({ question: already.question, permalink, hook: "" });
        // A guest reply shows the market page as its preview and has a button
        // to it, so the words need only name the market once.
        await answer(guest ? already.question : reply.primary, already.slug);
        await settleMention(key, "replied", { slug: already.slug, reason: "existing", claimText, replyId: guestReplyId });
        decide("replied", { reason: "existing", slug: already.slug });
        continue;
      }

      /* THE CAPS ARE FOR STRANGERS. Whoever runs oddie tests it by tagging it,
         and five markets a day is a wall in the middle of a test. */
      const uncapped = deps.uncapped ? await deps.uncapped(msg.from).catch(() => false) : false;

      /* ANYBODY ON TELEGRAM CAN SUMMON A GUEST BOT, and every summons that
         reaches the model is paid for, market or not. This row was claimed
         above, so it is already in the count. */
      if (!uncapped && guest && deps.guestTriesToday && deps.guestDailyTries && deps.guestDailyTries > 0) {
        const tries = await deps.guestTriesToday(author).catch(() => 0);
        if (tries > deps.guestDailyTries) {
          await answer(TG_COPY.guestCap, null);
          await settleMention(key, "skipped", { reason: "guest-cap" });
          decide("skipped", { reason: "guest-cap" });
          continue;
        }
      }

      if (!uncapped && deps.openedToday && deps.dailyCap && deps.dailyCap > 0) {
        const n = await deps.openedToday(author).catch(() => 0);
        if (n >= deps.dailyCap) {
          await answer(TG_COPY.cap(deps.dailyCap), null);
          await settleMention(key, "skipped", { reason: "cap" });
          decide("skipped", { reason: "cap" });
          continue;
        }
      }

      // The guest reply goes out now, before the slow part, and is edited into
      // the answer: a few silent seconds after a tag reads as a dead bot.
      if (guest && !deps.dryRun && !guestReplyId) await answer(TG_COPY.reading, null);

      // Capped for the same reason the X loop caps it: this goes into a model
      // prompt, and a pasted wall of text is not our budget.
      let ex: Extraction;
      try {
        ex = await deps.extract(claim.text.slice(0, 4000));
      } catch (e) {
        // The model is out, not the claim: park it (see the header).
        const kind = modelOutage(e);
        if (!kind || deps.dryRun || parked.size >= PARK_MAX) throw e;
        await parkTag({
          key, guest: Boolean(guest), guestReplyId, chatId: msg.chat.id, tagMessageId: msg.message_id,
          text: claim.text, keptText: claimText, sourceUrl, author, from: msg.from,
        }, kind, e, deps);
        result.parked++;
        result.decisions.push({ key, outcome: "parked", reason: kind });
        log("telegram tag parked until the model is back", { key, kind, err: (e as Error).message.slice(0, 160) });
        await alertOnce(kind, deps);
        continue;
      }

      const done = await finishClaim({
        key, guest: Boolean(guest), keptText: claimText, sourceUrl, author, from: msg.from,
        answer, replyId: () => guestReplyId,
      }, ex, deps);
      if (done.outcome === "retry") {
        // Nothing was posted, provably, so another go cannot double-post.
        await settleMention(key, "retry", { reason: done.ledgerReason, claimText });
        decide("retry", { reason: done.reason });
        continue;
      }
      decide(done.outcome, { reason: done.reason, slug: done.slug });
    } catch (e) {
      // A guest reply that already said "Reading the claim…" must not say it
      // forever: its one reply is spent, so it is edited into the next step.
      if (guest && guestReplyId && deps.guestEdit) {
        await deps.guestEdit(guestReplyId, { text: TG_COPY.later }).catch(() => {});
      }
      const outcome = postAttempted ? "failed" : "retry";
      await settleMention(key, outcome, { reason: (e as Error).message.slice(0, 300), replyId: guestReplyId }).catch(() => {});
      decide(outcome, { reason: (e as Error).message.slice(0, 120) });
      log(postAttempted ? "telegram item failed after posting, not retrying" : "telegram item failed before posting, will retry",
        { key, err: (e as Error).message });
    }
  }

  /* HOLD THE OFFSET AT THE FIRST RETRY. Everything before it is confirmed and
     will not come back; it and everything after it will, and the settled ones
     are skipped by the ledger on arrival. With nothing to retry, confirm the
     whole batch. */
  result.newOffset = holdAt ?? (maxId >= 0 ? maxId + 1 : null);
  if (result.newOffset !== null) await botStateSet(TG_OFFSET_KEY, String(result.newOffset));
  return result;
}
