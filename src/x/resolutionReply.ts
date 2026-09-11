// When a market settles, oddie answers its OWN reply.
//
// The bot already replied once, with the card, under the tweet where somebody
// made the claim. That reply's id is stored (x_mention.reply_id), so the thread
// is reachable from the slug alone. Replying to it puts the result back in
// front of exactly the people who saw the argument, from @oddiefun, needing
// nobody's permission and touching nobody's account.
//
// A REPLY **AND** A QUOTE, which is a correction of what this header used to
// say. "A quote detaches from the audience that cared" was true and beside the
// point: the reply cannot reach any audience at all. X's published ranking code
// filters replies out for anyone who does not follow us, discounts them again
// for anyone who does, and gates the mutual-follow boost on not being a reply.
// So a result posted only as a reply is a result nobody outside that one thread
// will ever see, and an outcome is the single most postable thing this product
// ever produces.
//
// They do different jobs and both are wanted. The REPLY lands where the
// argument was, under our own card, notifying the people in it. The QUOTE is an
// original post against the claim that provoked it, and it is the only shape
// that travels.
//
// WHAT THEY MAY AND MAY NOT SAY. Both are about the MARKET. Neither ever names
// a bettor: not the winners, not the side, not the size. A wallet's owner
// connected X to see their own page, which is not consent to be published to
// their followers as somebody who gambles, and none of it was public to begin
// with. The one person named is the OPENER, who tagged a stranger's take in
// public and asked for it to be priced.
//
// "You lost" is never posted anywhere. The personal half belongs in the app.

import { replyIdForSlug, communityMarketDetail } from "../store/markets.js";
import { buildResolutionQuote } from "../matching/tweetReply.js";

export interface ResolutionDeps {
  /** Public origin for the /m/{slug} link the reply carries. Optional so every
   *  existing caller and test is unchanged; the server passes the APP host,
   *  because a link that lands on the apex only to 301 to the app is a hop on
   *  the one path that brings strangers in. */
  baseUrl?: string;
  /** Whether the bot is allowed to actually post. */
  dryRun: boolean;
  /** The settled card for a market, as PNG bytes. */
  cardPng(slug: string, outcome: "yes" | "no"): Promise<Buffer | null>;
  uploadMedia(png: Buffer): Promise<string>;
  postReply(opts: { text: string; inReplyTo: string; mediaIds?: string[] }): Promise<{ id: string }>;
  log(msg: string, extra?: Record<string, unknown>): void;
  /**
   * WHO THE CREATOR CUT IS OWED TO, and it is the OPENER, not the author of the
   * claim. This was called `authorHandle` and described as "the source author",
   * which is a stale description of a payee that moved: openMarket writes
   * market_surfacer.handle from `taggerHandle` explicitly, precisely so the 2%
   * follows whoever tagged the post rather than whoever wrote it. The code was
   * already right; the name and the comment were pointing at the wrong person,
   * which is the kind of pair that gets "fixed" in the wrong direction later.
   *
   * The lamports are the market's on-chain creator_fee_lamports: zero until
   * resolve, and zero forever if nobody backed the winning side.
   */
  payeeHandle?(slug: string): Promise<string | null>;
  payeeFeeLamports?(slug: string): Promise<number>;
  /**
   * The crowd, for the quote. Counts and one price, never identities: see
   * buildResolutionQuote for why no bettor is ever named.
   */
  crowd?(slug: string, outcome: "yes" | "no"): Promise<{ stakers: number; winners: number; bestEntryPct: number | null }>;
  /**
   * The post to quote, as a tweet id. Null when the claim did not come from X
   * at all (Telegram, the app, the API), in which case there is nothing to
   * quote and the thread reply is the whole announcement.
   */
  quoteTarget?(slug: string): Promise<string | null>;
  /** An ORIGINAL post quoting that claim. Separate from postReply because it is
   *  a different endpoint shape and, per X's own ranking code, the only one of
   *  the two that can reach anybody outside the thread. */
  postQuote?(opts: { text: string; quoteTweetId: string; mediaIds?: string[] }): Promise<{ id: string }>;
}

export interface ResolutionOutcome {
  posted: boolean;
  reason?: "no-thread" | "no-market" | "dry-run" | "post-failed";
  replyId?: string;
  text?: string;
  /** The payee-credit reply, when one was owed and posted. */
  creditReplyId?: string;
  creditText?: string;
  /** The quote post, when the claim came from X and the seam was wired. */
  quoteId?: string;
  quoteText?: string;
}

/** The public sentence. Deliberately about the market and not about a person. */
export function resolutionText(question: string, outcome: "yes" | "no", url: string): string {
  const side = outcome.toUpperCase();
  // The question is NOT repeated: it is one tap up the thread, and repeating it
  // under itself reads as a bot filling space. The card carries it anyway.
  return `Settled: ${side}.\n\nEveryone who called it is paid from the pool, on chain.\n\n${url}`;
}

/**
 * The ONE @-mention oddie ever sends, and the one place it is not spam.
 *
 * IT GOES TO THE OPENER. The reply chain notifies whoever is IN it, and the
 * payee may not be: a tagger who opened the market from a reply is in the
 * thread, but the credit has to work either way and the @-mention is what makes
 * it reliable. This used to be documented as going to "the source author",
 * which was a description left over from before the 2% moved to the tagger;
 * market_surfacer.handle has been written from `taggerHandle` since.
 *
 * It fires ONLY when there is a fee owed (someone backed the winning side), so
 * it never sprays a tag at a market nobody staked. It is a payout notice and
 * not a pitch, which is exactly why the @-mention is defensible here and would
 * not be at create time: there is real money waiting behind the link.
 *
 * The handle is normalised to one leading @: X notifies on the mention wherever
 * the reply sits, which is the whole point, since the author is not in the
 * chain the reply inherits.
 */
export function authorCreditText(handle: string, url: string): string {
  const at = `@${handle.replace(/^@+/, "")}`;
  // "The market you opened", not "your take". On a reply-tag the payee did not
  // write the claim - they picked it out of somebody else's timeline and asked
  // for it to be priced - and telling them their take earned a cut is simply
  // false for the majority of the markets this product makes.
  return `${at}, the market you opened drew real SOL, so it earned you a creator cut.\n\nConnect a wallet to collect it: ${url}`;
}

/**
 * Post the result into the thread this market came from.
 *
 * Best-effort by construction: every failure returns rather than throws, so a
 * resolution can never be held up by X being unreachable. The money has already
 * moved on chain by the time this runs; this is the announcement, not the
 * settlement.
 */
export async function postResolution(
  slug: string,
  outcome: "yes" | "no",
  deps: ResolutionDeps,
): Promise<ResolutionOutcome> {
  const detail = await communityMarketDetail(slug).catch(() => null);
  if (!detail) { deps.log("resolution: unknown market", { slug }); return { posted: false, reason: "no-market" }; }

  // No thread means this market was not born from a tag: created in the app, or
  // by the API. There is nothing to answer and that is not a failure.
  const inReplyTo = await replyIdForSlug(slug).catch(() => null);
  if (!inReplyTo) { deps.log("resolution: no thread to answer", { slug }); return { posted: false, reason: "no-thread" }; }

  const url = `${(deps.baseUrl ?? "https://oddie.fun").replace(/\/+$/, "")}/m/${slug}`;
  const text = resolutionText(detail.question, outcome, url);

  if (deps.dryRun) {
    deps.log("resolution dry-run", { slug, outcome, inReplyTo, text });
    return { posted: false, reason: "dry-run", replyId: inReplyTo, text };
  }

  // Same rule the mention loop follows: the card is what stops a scroll, but a
  // reply without it is still a working reply, so an image failure must never
  // cost the result its announcement.
  let mediaIds: string[] | undefined;
  try {
    const png = await deps.cardPng(slug, outcome);
    if (png) mediaIds = [await deps.uploadMedia(png)];
  } catch (e) {
    deps.log("resolution: card failed, posting without it", { slug, err: (e as Error).message });
  }

  let replyId: string;
  try {
    const posted = await deps.postReply({ text, inReplyTo, mediaIds });
    replyId = posted.id;
    deps.log("resolution posted", { slug, outcome, replyId });
  } catch (e) {
    deps.log("resolution: post failed", { slug, err: (e as Error).message });
    return { posted: false, reason: "post-failed", text };
  }

  // The author credit rides as a SEPARATE reply under the announcement, never
  // awaited into it: it is the one @-mention we send, and a market with no fee
  // owed simply does not get one. Best-effort throughout, because a payout
  // notice failing must never unwind a resolution that already posted.
  const out: ResolutionOutcome = { posted: true, replyId, text };

  /* THE QUOTE, which is the half of this that anybody outside the thread can
     see. Posted AFTER the reply and never awaited into it: the reply is the
     announcement and it has already succeeded by the time we get here, so a
     quote that fails must not turn a posted resolution into a failed one.
     Skipped silently when the claim did not come from X (nothing to quote) or
     when the caller never wired the seam, which keeps every existing test and
     the Telegram path behaving exactly as before.
     ITS OWN UPLOAD. A media id is spent by the post it is attached to, so the
     card is rendered once and uploaded twice rather than reused; a reuse that
     silently failed would drop the image off the one post that travels. */
  const handle = deps.payeeHandle ? await deps.payeeHandle(slug).catch(() => null) : null;
  const lamports = deps.payeeFeeLamports ? await deps.payeeFeeLamports(slug).catch(() => 0) : 0;
  const feeOwed = Boolean(handle) && lamports > 0;
  /** Set by the quote when it carried the credit itself, so the separate reply
   *  below does not say the same thing to the same person at the URL tier. */
  let creditCarried = false;

  try {
    const quoteId = deps.quoteTarget && deps.postQuote ? await deps.quoteTarget(slug) : null;
    if (quoteId) {
      const c = deps.crowd ? await deps.crowd(slug, outcome).catch(() => null) : null;
      const quoteText = buildResolutionQuote({
        outcome, permalink: url, opener: handle, feeOwed,
        stakers: c?.stakers ?? 0, winners: c?.winners ?? 0, bestEntryPct: c?.bestEntryPct ?? null,
      });
      let qMedia: string[] | undefined;
      try {
        const png = await deps.cardPng(slug, outcome);
        if (png) qMedia = [await deps.uploadMedia(png)];
      } catch (e) {
        deps.log("resolution: quote card failed, quoting without it", { slug, err: (e as Error).message });
      }
      const q = await deps.postQuote!({ text: quoteText, quoteTweetId: quoteId, mediaIds: qMedia });
      out.quoteId = q.id;
      out.quoteText = quoteText;
      // Only once it actually posted. A quote that threw has told nobody
      // anything, and the reply below is then the payout notice again.
      creditCarried = feeOwed;
      deps.log("resolution quoted the claim", { slug, quoteId: q.id, quotedTweet: quoteId });
    }
  } catch (e) {
    deps.log("resolution: quote failed (non-fatal)", { slug, err: (e as Error).message });
  }

  /* THE FALLBACK PAYOUT NOTICE, and it is now only a fallback.
     The quote above already @-mentions the opener and says a cut was earned, so
     sending this as well would be a third post at the URL tier telling one
     person something they have already been notified about. It still fires when
     there was no quote - a claim that never came from X has nothing to quote,
     and that opener would otherwise never be told at all. */
  try {
    if (handle && lamports > 0 && !creditCarried) {
      const creditText = authorCreditText(handle, url);
      const credit = await deps.postReply({ text: creditText, inReplyTo: replyId });
      out.creditReplyId = credit.id;
      out.creditText = creditText;
      deps.log("resolution credited the opener", { slug, handle, creditReplyId: credit.id });
    }
  } catch (e) {
    deps.log("resolution: opener credit failed (non-fatal)", { slug, err: (e as Error).message });
  }
  return out;
}
