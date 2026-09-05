// When a market settles, oddie answers its OWN reply.
//
// The bot already replied once, with the card, under the tweet where somebody
// made the claim. That reply's id is stored (x_mention.reply_id), so the thread
// is reachable from the slug alone. Replying to it puts the result back in
// front of exactly the people who saw the argument, from @oddiefun, needing
// nobody's permission and touching nobody's account.
//
// A REPLY, NOT A QUOTE. A quote starts a new post on our own timeline and
// detaches from the audience that cared; a reply lands in the thread and
// notifies the person who made the claim, because our card is sitting under
// their tweet. The result belongs where the argument was.
//
// WHAT IT MAY AND MAY NOT SAY. The public post is about the MARKET: it settled,
// here is the side. It never says who won, never names anybody, never implies
// the claimer was wrong. "You lost" under a stranger's tweet is a bad look even
// when it is true, and it can land on somebody who never staked at all. The
// personal half belongs in the app, where it already lives as a notice.

import { replyIdForSlug, communityMarketDetail } from "../store/markets.js";

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
   * The take's author and what they earned, for the credit reply below. Both
   * seams so the test can drive the crediting path without a chain or a store:
   * the handle is the source author (surfacerFor), the lamports are the market's
   * on-chain creator_fee_lamports, which is zero until resolve and zero forever
   * if nobody backed the winning side.
   */
  authorHandle?(slug: string): Promise<string | null>;
  authorFeeLamports?(slug: string): Promise<number>;
}

export interface ResolutionOutcome {
  posted: boolean;
  reason?: "no-thread" | "no-market" | "dry-run" | "post-failed";
  replyId?: string;
  text?: string;
  /** The author-credit reply, when one was owed and posted. */
  creditReplyId?: string;
  creditText?: string;
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
 * The result reply lands under oddie's own reply to whoever TAGGED it, so the
 * tagger is in the thread and the person whose take actually earned the 2% —
 * the source author — is two levels up and never notified. They are the one
 * with money to claim, and this is how they hear about it.
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
  return `${at}, your take drew a crowd and real SOL moved on it, so it earned you a creator cut.\n\nConnect a wallet to collect it: ${url}`;
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
  try {
    const handle = deps.authorHandle ? await deps.authorHandle(slug) : null;
    const lamports = deps.authorFeeLamports ? await deps.authorFeeLamports(slug) : 0;
    if (handle && lamports > 0) {
      const creditText = authorCreditText(handle, url);
      const credit = await deps.postReply({ text: creditText, inReplyTo: replyId });
      out.creditReplyId = credit.id;
      out.creditText = creditText;
      deps.log("resolution credited author", { slug, handle, creditReplyId: credit.id });
    }
  } catch (e) {
    deps.log("resolution: author credit failed (non-fatal)", { slug, err: (e as Error).message });
  }
  return out;
}
