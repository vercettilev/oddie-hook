/**
 * The loop that closes the product: a mention on X becomes a market on Solana
 * and a reply under the argument that started it, with nobody in the middle.
 *
 * Everything the loop touches arrives as an injected dependency rather than an
 * import. That is not ceremony: the real versions of these call X, call
 * Anthropic, and spend SOL, so a version of this file that imported them could
 * only be tested by doing all three. With the seams here, the entire decision
 * tree runs offline against fakes, which is the only way the "don't post twice"
 * rules below are actually checked rather than merely written down.
 *
 * ORDER OF OPERATIONS, and why it is this order:
 *
 *   claim -> extract -> mint -> reply -> settle
 *
 * The claim comes first and is durable. A crash anywhere after it leaves a row
 * saying "someone was working on this" and the next sweep skips the tweet. That
 * loses a reply. The alternative order loses nothing on a crash and instead
 * risks replying twice to the same person, which is the one failure that
 * damages the account rather than the backlog. Under-posting is recoverable by
 * hand; double-posting is not.
 */

import type { Extraction } from "../matching/extractClaim.js";
import type { Mention } from "./client.js";
import { buildTweetReply } from "../matching/tweetReply.js";
import { claimMention, settleMention, botStateGet, botStateSet, PERSISTENT } from "../store/markets.js";
import { SINCE_KEY } from "./client.js";

export interface MintedMarket {
  ok: true;
  slug: string;
}
export type MintResult = MintedMarket | { ok: false; status: number; error: string };

export interface SweepDeps {
  /** Read mentions newer than `sinceId`. */
  mentions(sinceId: string | null, max?: number): Promise<{ items: Mention[]; newestId: string | null }>;
  /** Read one tweet, for the parent claim a mention is replying to. */
  tweet(id: string): Promise<{ id: string; text: string; authorHandle: string | null } | null>;
  extract(text: string): Promise<Extraction>;
  /** An OPEN market already made from this source post, if there is one. */
  existingMarket?(sourceUrl: string): Promise<{ slug: string; question: string } | null>;
  openMarket(input: {
    question: string;
    closeInput: unknown;
    sourceUrl: string;
    category?: string;
    resolutionCriteria?: string | null;
    resolvability?: string | null;
  }): Promise<MintResult>;
  /** The share card for a market, as PNG bytes. */
  cardPng(slug: string): Promise<Buffer | null>;
  uploadMedia(png: Buffer): Promise<string>;
  postReply(opts: { text: string; inReplyTo: string; mediaIds?: string[] }): Promise<{ id: string }>;
  /** Our own handle, without the @. Used only to strip routing out of the
   *  claim text; defaults to oddiefun. */
  botHandle?: string;
  /** Tickets left for a handle, and the spend when a tag opens a market. Both
   *  optional so every existing caller and test constructs SweepDeps unchanged;
   *  absent, the sweep behaves exactly as it did before the season existed. */
  ticketsLeft?(handle: string): Promise<number>;
  spendTicket?(slug: string, tagger: string, source: string | null): Promise<boolean>;
  /** Public origin, for building the /m/{slug} permalink the reply carries. */
  baseUrl: string;
  /** The bot's own user id, so it can never answer itself. */
  botUserId: string;
  /** When true, everything runs except the two calls that touch the world. */
  dryRun: boolean;
  /**
   * Whether the once-only ledger actually survives a restart. Defaults to the
   * store's own answer; it is a seam only so the offline test can drive the
   * real posting path AND still assert that the guard fires when it is false.
   */
  durable?: boolean;
  log?(line: string, extra?: Record<string, unknown>): void;
}

export interface SweepResult {
  looked: number;
  replied: number;
  skipped: number;
  failed: number;
  /** What each mention became, in order. The dry-run output, and the test's assertion surface. */
  decisions: Array<{
    tweetId: string;
    outcome: "replied" | "skipped" | "failed";
    reason?: string;
    slug?: string;
    text?: string;
  }>;
  newestId: string | null;
}

/**
 * How many mentions one sweep will act on.
 *
 * Low on purpose, and the reason is money rather than rate limits: every
 * mention that clears the gate mints a Solana account out of oddie's own
 * wallet. A thread that tags us two hundred times should drain over an hour of
 * polls, not spend two hundred rent deposits in one tick, and a runaway is
 * bounded by this number times the poll rate rather than by whatever X returns.
 */
export const SWEEP_CAP = 5;

/** Strip the @handles X puts at the front of a reply, so the claim text we
 *  grade is the sentence and not the routing. */
export function stripLeadingMentions(text: string): string {
  return text.replace(/^(?:\s*@[A-Za-z0-9_]{1,15})+/, "").trim();
}

/**
 * Take OUR OWN handle out of the claim, wherever it sits.
 *
 * Tagging does not have to be a reply, and in a standalone post the tag
 * usually lands at the END ("GTA drops before 2027, what do you say
 * @oddiefun"). stripLeadingMentions only looks at the front, so that handle
 * went into the grader as if it were part of the argument.
 *
 * ONLY our handle, never a blanket trailing strip: a mention at the end can be
 * the subject of the claim itself ("the next CEO will be @jack"), and removing
 * it would grade a sentence with its subject cut out.
 */
export function stripBotHandle(text: string, handle: string): string {
  const h = handle.replace(/^@+/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return text;
  return text.replace(new RegExp(`@${h}\\b`, "gi"), " ").replace(/\s{2,}/g, " ").trim();
}

/** Tweets are addressed by handle in the URL, but any handle resolves; the id
 *  is what makes it canonical. `i/web` is X's own handle-free form. */
export function tweetUrl(handle: string | null, id: string): string {
  return handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/web/status/${id}`;
}

export async function runMentionSweep(deps: SweepDeps): Promise<SweepResult> {
  const log = deps.log ?? (() => {});
  const result: SweepResult = { looked: 0, replied: 0, skipped: 0, failed: 0, decisions: [], newestId: null };

  // Posting for real without a database would mean the "exactly once" ledger
  // and the rotated refresh token both live in a map that dies with the
  // process. That is not a degraded mode, it is the double-post mode.
  if (!deps.dryRun && !(deps.durable ?? PERSISTENT)) {
    throw new Error("refusing to post: DATABASE_URL is unset, so the once-only ledger would not survive a restart");
  }

  const sinceId = await botStateGet(SINCE_KEY);
  const { items, newestId } = await deps.mentions(sinceId, 20);
  result.newestId = newestId;
  // Oldest first. X returns newest first, and answering a thread backwards
  // reads as a bot even when every individual reply is right.
  const ordered = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const m of ordered) {
    if (result.looked >= SWEEP_CAP) break;
    result.looked++;

    const decide = (outcome: "replied" | "skipped" | "failed", extra: Record<string, unknown> = {}) => {
      result[outcome === "replied" ? "replied" : outcome === "skipped" ? "skipped" : "failed"]++;
      result.decisions.push({ tweetId: m.id, outcome, ...extra } as SweepResult["decisions"][number]);
    };

    if (m.authorId === deps.botUserId) {
      // Our own replies mention the people we answer, which means they come
      // back to us as mentions. Without this the bot answers itself forever.
      await claimMention(m.id, m.authorHandle);
      await settleMention(m.id, "skipped", { reason: "self" });
      decide("skipped", { reason: "self" });
      continue;
    }

    const fresh = await claimMention(m.id, m.authorHandle);
    if (!fresh) { decide("skipped", { reason: "already-decided" }); continue; }

    try {
      // The claim is the tweet being replied to, not the mention. "@oddiefun"
      // under someone's take means "price THAT", and grading the mention text
      // would grade the word "@oddiefun".
      const parent = m.repliedToId ? await deps.tweet(m.repliedToId) : null;
      // Tagging is not required to be a reply. With no parent the mention IS
      // the claim, so the person's own post becomes the market.
      const claimText = stripBotHandle(
        parent ? parent.text : stripLeadingMentions(m.text),
        deps.botHandle ?? "oddiefun",
      );
      if (!claimText || claimText.length < 12) {
        await settleMention(m.id, "skipped", { reason: "no-claim" });
        decide("skipped", { reason: "no-claim" });
        continue;
      }

      // Provenance points at the CLAIM, because the 3% belongs to whoever made
      // the argument worth pricing. When there is no parent, the mention is the
      // claim and its author is the creator.
      const sourceHandle = parent ? parent.authorHandle : m.authorHandle;
      const sourceId = parent ? parent.id : m.id;
      const sourceUrl = tweetUrl(sourceHandle, sourceId);

      // ONE POST, ONE MARKET. Checked before a token is spent, because several
      // people tagging the same hot take is the expected case: the model is not
      // needed to know we already answered this post, and minting again would
      // split one question's pool across two pari-mutuel markets while costing
      // a second rent deposit out of our own wallet.
      const already = deps.existingMarket ? await deps.existingMarket(sourceUrl).catch(() => null) : null;
      if (already) {
        const permalink = `${deps.baseUrl.replace(/\/+$/, "")}/m/${already.slug}`;
        const reply = buildTweetReply({ question: already.question, permalink, hook: "" });
        if (deps.dryRun) {
          await settleMention(m.id, "skipped", { reason: "dry-run", slug: already.slug });
          decide("skipped", { reason: "dry-run:existing", slug: already.slug, text: reply.primary });
          log("dry-run reply to an existing market", { tweetId: m.id, slug: already.slug });
          continue;
        }
        // Each person who tagged still gets an answer; they just all land in the
        // same pool.
        let mediaIds: string[] | undefined;
        try {
          const png = await deps.cardPng(already.slug);
          if (png) mediaIds = [await deps.uploadMedia(png)];
        } catch (e) {
          log("card failed, replying without it", { tweetId: m.id, err: (e as Error).message });
        }
        const posted = await deps.postReply({ text: reply.primary, inReplyTo: m.id, mediaIds });
        await settleMention(m.id, "replied", { slug: already.slug, replyId: posted.id });
        decide("replied", { reason: "existing", slug: already.slug, text: reply.primary });
        log("replied with the market this post already has", { tweetId: m.id, slug: already.slug });
        continue;
      }

      // OUT OF TICKETS: checked BEFORE the model call and before the mint, so
      // an exhausted tagger costs neither an opus call nor a rent deposit.
      // Silent, like every other gate here, and their own page is where the
      // balance lives, so there is somewhere honest to go and see it.
      if (deps.ticketsLeft && m.authorHandle) {
        const left = await deps.ticketsLeft(m.authorHandle).catch(() => 1);
        if (left <= 0) {
          await settleMention(m.id, "skipped", { reason: "no-tickets" });
          decide("skipped", { reason: "no-tickets" });
          continue;
        }
      }

      // Capped for the same reason the admin route caps at 4000: the parent's
      // full text goes into an opus prompt with adaptive thinking, and X's post
      // limit is not our budget. A long-form post was a ~6k-token user message
      // on a call that already carries a 1.5k-token system prompt.
      const ex = await deps.extract(claimText.slice(0, 4000));
      if (ex.resolvability === "unresolvable" || !ex.appropriate || !ex.question) {
        // Silence, not an explanation. A public "I can't make a market out of
        // that" is a reply that helps nobody, lands under someone's post, and
        // is exactly the kind of thing that gets an account muted. The reason
        // is recorded where we can read it instead.
        await settleMention(m.id, "skipped", { reason: `gate:${ex.resolvability}${ex.appropriate ? "" : "/inappropriate"}` });
        decide("skipped", { reason: `gate:${ex.resolvability}` });
        continue;
      }

      const minted = await deps.openMarket({
        question: ex.question,
        closeInput: ex.close_time,
        sourceUrl,
        category: ex.category,
        resolutionCriteria: ex.resolution_criteria || null,
        resolvability: ex.resolvability,
      });
      if (!minted.ok) {
        await settleMention(m.id, "failed", { reason: `mint:${minted.status} ${minted.error}` });
        decide("failed", { reason: `mint:${minted.status}` });
        continue;
      }

      // The market exists, so the ticket is spent. After the mint on purpose:
      // a tag that failed to become a market costs the tagger nothing.
      if (deps.spendTicket && m.authorHandle) {
        await deps.spendTicket(minted.slug, m.authorHandle, sourceHandle).catch((e) =>
          log("ticket spend failed (market still stands)", { tweetId: m.id, err: (e as Error).message }));
      }

      const permalink = `${deps.baseUrl.replace(/\/+$/, "")}/m/${minted.slug}`;
      // No yesPct: a market minted a second ago has an empty vault and
      // therefore no price. The reply says nothing about odds rather than
      // quoting a 50 nobody set.
      const reply = buildTweetReply({ question: ex.question, permalink, hook: ex.hook });

      if (deps.dryRun) {
        await settleMention(m.id, "skipped", { reason: "dry-run", slug: minted.slug });
        decide("skipped", { reason: "dry-run", slug: minted.slug, text: reply.primary });
        log("dry-run reply", { tweetId: m.id, slug: minted.slug, text: reply.primary });
        continue;
      }

      // The card is the thing that stops a scroll, but a reply with no card is
      // still a working reply. An image failure must not cost the market a
      // reply it already paid rent for.
      let mediaIds: string[] | undefined;
      try {
        const png = await deps.cardPng(minted.slug);
        if (png) mediaIds = [await deps.uploadMedia(png)];
      } catch (e) {
        log("card failed, replying without it", { tweetId: m.id, err: (e as Error).message });
      }

      const posted = await deps.postReply({ text: reply.primary, inReplyTo: m.id, mediaIds });
      await settleMention(m.id, "replied", { slug: minted.slug, replyId: posted.id });
      decide("replied", { slug: minted.slug, text: reply.primary });
      log("replied", { tweetId: m.id, slug: minted.slug, replyId: posted.id });
    } catch (e) {
      await settleMention(m.id, "failed", { reason: (e as Error).message.slice(0, 300) });
      decide("failed", { reason: (e as Error).message.slice(0, 120) });
      log("sweep item failed", { tweetId: m.id, err: (e as Error).message });
    }
  }

  // Advance only over what was actually looked at. Taking X's `newest_id`
  // wholesale would skip every mention past the cap, permanently: they are
  // older than the new watermark and no later poll would ever return them.
  const lastLooked = ordered.slice(0, result.looked).at(-1)?.id ?? null;
  if (lastLooked) await botStateSet(SINCE_KEY, lastLooked);

  return result;
}
