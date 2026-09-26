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
 * IDENTITY IS THE NUMERIC ID FROM THE FIRST ROW. The ledger author is
 * `tg:<user id>`, never the @name: Telegram's own schema makes username
 * optional, so a person may not have one, and one they do have can be changed
 * or given away. The name is recorded beside the id, as display.
 */
import type { Extraction } from "../matching/extractClaim.js";
import type { PriceClaim } from "../price/index.js";
import type { MintResult } from "../x/mentionLoop.js";
import type { TgMessage, TgUpdate } from "./client.js";
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
  rememberPerson?(platformId: string, handle: string | null): Promise<{ renamedFrom: string | null }>;
  /** The private one-tap URL that lets this Telegram user link a wallet and
   *  collect their 2%. Null when the feature is not configured. */
  earnLink?(tgUserId: number): string | null;
  /** Markets this person opened in the last 24 hours. Absent = no cap. */
  openedToday?(author: string): Promise<number>;
  dailyCap?: number;
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
  newOffset: number | null;
  decisions: Array<{ key: string; outcome: "replied" | "skipped" | "failed" | "retry"; reason?: string; slug?: string }>;
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
  /* A basic group. Its messages have no t.me link, and a market has to be able
     to show where it came from, so the mint refuses it. Telegram upgrades the
     group to a supergroup the moment chat history is made visible to new
     members, which keeps it private and gives every message a link. */
  needsLinks:
    "To open markets here I need message links. In this group's settings, set Chat History for New Members to Visible, then tag me again.",
  /* A private chat. Markets come from public arguments, so a DM is where the
     person talks to oddie, not where markets open. */
  dm: "Add me to a group and tag me under a claim. I'll open a market on it right there.\n\nOpened one already? Send /earn to collect your 2%.",
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

/* ---------------------------------------------------------------- sweep -- */

export async function runTelegramSweep(deps: TgSweepDeps): Promise<TgSweepResult> {
  const log = deps.log ?? (() => {});
  const result: TgSweepResult = { looked: 0, replied: 0, skipped: 0, failed: 0, retried: 0, newOffset: null, decisions: [] };

  const stored = await botStateGet(TG_OFFSET_KEY);
  const offset = stored !== null && Number.isFinite(Number(stored)) ? Number(stored) : null;
  const updates = await deps.updates(offset);
  if (!updates.length) return result;

  let maxId = -1;
  let holdAt: number | null = null;

  for (const u of updates) {
    maxId = Math.max(maxId, u.update_id);
    const msg = u.message;
    if (!msg || !msg.from || msg.from.is_bot) continue;
    const isPrivate = msg.chat.type === "private";
    if (!isPrivate && !tagsBot(msg, deps.botUsername)) continue;
    // Telegram sends "/start" the moment somebody opens a chat with the bot.
    // Only DMs get a reply to a bare command: in a group, an untagged command
    // was never meant for us.

    result.looked++;
    const key = `tg:${msg.chat.id}:${msg.message_id}`;
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
    const answer = async (text: string, photoUrl: string | null) => {
      if (deps.dryRun) { log("dry-run telegram reply", { key, text }); return; }
      postAttempted = true;
      await deps.reply({ chatId: msg.chat.id, replyTo: msg.message_id, text, photoUrl });
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

      const sourceUrl = messageLink(claim.source.chat, claim.source.message_id);
      /* NO LINK, NO MARKET -- AND SAY SO. openMarketFromClaim refuses a market
         with no source ("a market with no source can never show who it came
         from"), and a basic group's messages have no t.me link. This used to be
         discovered at the mint, after a paid extraction, then retried three
         times in five seconds, then abandoned without a word to the person who
         tagged. Checked first now, and answered with the one setting that
         fixes it. */
      if (!sourceUrl) {
        await answer(TG_COPY.needsLinks, null);
        await settleMention(key, "skipped", { reason: "unlinkable", claimText: claim.text });
        decide("skipped", { reason: "unlinkable" });
        continue;
      }

      // ONE POST, ONE MARKET. Free: no cap, no extraction.
      const already = sourceUrl && deps.existingMarket
        ? await deps.existingMarket(sourceUrl).catch(() => null)
        : null;
      if (already) {
        const permalink = `${deps.baseUrl.replace(/\/+$/, "")}/m/${already.slug}`;
        const reply = buildTweetReply({ question: already.question, permalink, hook: "" });
        await answer(reply.primary, deps.cardUrl(already.slug));
        await settleMention(key, "replied", { slug: already.slug, reason: "existing", claimText: claim.text });
        decide("replied", { reason: "existing", slug: already.slug });
        continue;
      }

      if (deps.openedToday && deps.dailyCap && deps.dailyCap > 0) {
        const n = await deps.openedToday(author).catch(() => 0);
        if (n >= deps.dailyCap) {
          await answer(TG_COPY.cap(deps.dailyCap), null);
          await settleMention(key, "skipped", { reason: "cap" });
          decide("skipped", { reason: "cap" });
          continue;
        }
      }

      // Capped for the same reason the X loop caps it: this goes into a model
      // prompt, and a pasted wall of text is not our budget.
      const ex = await deps.extract(claim.text.slice(0, 4000));
      if (ex.resolvability === "unresolvable" || !ex.appropriate || !ex.question) {
        await answer(TG_COPY.unmarketable, null);
        await settleMention(key, "skipped", { reason: `gate:${ex.resolvability}`, claimText: claim.text });
        decide("skipped", { reason: `gate:${ex.resolvability}` });
        continue;
      }

      const minted = await deps.openMarket({
        question: ex.question,
        closeInput: ex.close_time,
        sourceUrl,
        category: ex.category,
        resolutionCriteria: ex.resolution_criteria || null,
        priceClaim: ex.price_claim,
        claimText: claim.text,
        resolvability: ex.resolvability,
        hook: ex.hook || null,
        openerId: author,
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
          await answer(TG_COPY.unmarketable, null);
          await settleMention(key, "skipped", { reason: `mint:${minted.status} ${minted.error}`, claimText: claim.text });
          decide("skipped", { reason: `mint:${minted.status}` });
          continue;
        }
        // Nothing was posted, provably, so another go cannot double-post.
        await settleMention(key, "retry", { reason: `mint:${minted.status} ${minted.error}`, claimText: claim.text });
        decide("retry", { reason: "mint" });
        continue;
      }

      const permalink = `${deps.baseUrl.replace(/\/+$/, "")}/m/${minted.slug}`;
      const reply = buildTweetReply({ question: ex.question, permalink, hook: ex.hook });
      /* THE INCENTIVE, SAID WHERE THE ROOM CAN SEE IT. "Bring the room, own the
         room" only works if the room can see that opening a market pays. Only
         under a market that just opened: a pointer to an existing one was
         opened by somebody else, and naming the tagger there would be false. */
      const openerLine = TG_COPY.opener(tgDisplayName(msg.from), deps.botUsername);
      await answer(`${reply.primary}\n\n${openerLine}`, deps.cardUrl(minted.slug));
      /* "opened" is what the daily cap counts: a pointer to a market that
         already existed opened nothing and costs the person nothing. */
      await settleMention(key, "replied", { slug: minted.slug, reason: "opened", claimText: claim.text });
      decide("replied", { reason: "opened", slug: minted.slug });
      log("telegram market opened", { key, slug: minted.slug });
    } catch (e) {
      const outcome = postAttempted ? "failed" : "retry";
      await settleMention(key, outcome, { reason: (e as Error).message.slice(0, 300) }).catch(() => {});
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
