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
import { buildRefusalReply, buildTweetReply } from "../matching/tweetReply.js";
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
    /** Who tagged, i.e. who OPENED the market. The 2% goes to this person, and
     *  on a reply-tag it is not the author of sourceUrl. */
    taggerHandle: string | null;
    category?: string;
    resolutionCriteria?: string | null;
    resolvability?: string | null;
    /** The extraction's short headline, carried so the app can show the same
     *  punchy line this loop already puts in the reply. */
    hook?: string | null;
  }): Promise<MintResult>;
  /** The share card for a market, as PNG bytes. */
  cardPng(slug: string): Promise<Buffer | null>;
  /**
   * The card that goes under a tag we could not price: what a marketable claim
   * looks like, not a scolding. Optional, and its absence is what keeps the
   * gate silent — every existing caller and test that never heard of teaching
   * behaves exactly as it did before.
   */
  teachPng?(): Promise<Buffer | null>;
  /** How many teaching replies this handle has already had. */
  refusalsUsed?(handle: string | null): Promise<number>;
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

/**
 * How many times one handle is taught before oddie goes quiet on them.
 *
 * Small because the downside is asymmetric. A tagger who never gets the recipe
 * costs us one market; an account that replies to every unmarketable tag from
 * the same person gets reported, muted or filtered, and that costs us every
 * market. Two replies is enough to be a lesson and too few to be a habit.
 */
export const TEACH_CAP = 2;

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

      // Provenance points at the CLAIM: sourceUrl is the post being priced and
      // it is what the card quotes and what the one-post-one-market rule reads.
      // It is NOT the payee. The 2% goes to whoever OPENED the market, which on
      // a reply-tag is the tagger, and that handle is carried separately.
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
        // INAPPROPRIATE IS ALWAYS SILENT. There is no version of a public reply
        // under a post we refused on content grounds that reads as anything but
        // oddie commenting on it, and the reason is recorded where we can read
        // it instead.
        const teachPng = deps.teachPng;
        if (!ex.appropriate || !teachPng) {
          await settleMention(m.id, "skipped", { reason: `gate:${ex.resolvability}${ex.appropriate ? "" : "/inappropriate"}` });
          decide("skipped", { reason: `gate:${ex.resolvability}` });
          continue;
        }

        // TEACH, THEN GO QUIET. The tagger went to the trouble; silence teaches
        // them nothing and they tag us the same wrong way next time. But the
        // reply is capped PER HANDLE, and the cap is small on purpose: an
        // account that answers every unmarketable tag forever is an account
        // that gets muted, and a muted account ends the product. Two is the
        // whole budget — the first tag learns the recipe, the second is the
        // reminder, and after that we are just silence to that handle.
        const used = deps.refusalsUsed ? await deps.refusalsUsed(m.authorHandle).catch(() => TEACH_CAP) : 0;
        if (used >= TEACH_CAP) {
          await settleMention(m.id, "skipped", { reason: `gate:${ex.resolvability}/taught-out` });
          decide("skipped", { reason: "taught-out" });
          continue;
        }

        const teachText = buildRefusalReply(m.id);
        if (deps.dryRun) {
          await settleMention(m.id, "skipped", { reason: "dry-run" });
          decide("skipped", { reason: "dry-run:teach", text: teachText });
          log("dry-run teach reply", { tweetId: m.id, text: teachText });
          continue;
        }

        // THE CARD IS THE REPLY. The text is one sentence and it says only that
        // we could not open a market; every word of the teaching - the specimen
        // claim, the two spans underlined on it, the way back in - is drawn on
        // the image. So a failed upload does not downgrade this reply, it
        // empties it, and what would go out is the bare public refusal this
        // whole branch exists to avoid posting. Silence is the correct failure.
        let mediaIds: string[];
        try {
          const png = await teachPng();
          if (!png) throw new Error("no card");
          mediaIds = [await deps.uploadMedia(png)];
        } catch (e) {
          await settleMention(m.id, "skipped", { reason: `gate:${ex.resolvability}/no-card` });
          decide("skipped", { reason: "no-card" });
          log("teach card unavailable, staying silent rather than posting a bare refusal",
            { tweetId: m.id, err: (e as Error).message });
          continue;
        }
        // No permalink, ever. There is no market to link to, and a reply
        // carrying a URL is priced at a different tier by X than a plain one.
        const posted = await deps.postReply({ text: teachText, inReplyTo: m.id, mediaIds });
        // "taught" is the marker refusalsUsed counts, so the reason string is
        // load-bearing rather than a log line.
        await settleMention(m.id, "skipped", { reason: `taught:${ex.resolvability}`, replyId: posted.id });
        decide("skipped", { reason: "taught", text: teachText });
        log("taught instead of staying silent", { tweetId: m.id, handle: m.authorHandle, used: used + 1 });
        continue;
      }

      const minted = await deps.openMarket({
        taggerHandle: m.authorHandle,
        question: ex.question,
        closeInput: ex.close_time,
        sourceUrl,
        category: ex.category,
        resolutionCriteria: ex.resolution_criteria || null,
        resolvability: ex.resolvability,
        hook: ex.hook || null,
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
