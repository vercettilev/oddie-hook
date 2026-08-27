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
  /** Whether the bot is allowed to actually post. */
  dryRun: boolean;
  /** The settled card for a market, as PNG bytes. */
  cardPng(slug: string, outcome: "yes" | "no"): Promise<Buffer | null>;
  uploadMedia(png: Buffer): Promise<string>;
  postReply(opts: { text: string; inReplyTo: string; mediaIds?: string[] }): Promise<{ id: string }>;
  log(msg: string, extra?: Record<string, unknown>): void;
}

export interface ResolutionOutcome {
  posted: boolean;
  reason?: "no-thread" | "no-market" | "dry-run" | "post-failed";
  replyId?: string;
  text?: string;
}

/** The public sentence. Deliberately about the market and not about a person. */
export function resolutionText(question: string, outcome: "yes" | "no", url: string): string {
  const side = outcome.toUpperCase();
  // The question is NOT repeated: it is one tap up the thread, and repeating it
  // under itself reads as a bot filling space. The card carries it anyway.
  return `Settled: ${side}.\n\nEveryone who called it is paid from the pool, on chain.\n\n${url}`;
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

  const url = `https://oddie.fun/m/${slug}`;
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

  try {
    const posted = await deps.postReply({ text, inReplyTo, mediaIds });
    deps.log("resolution posted", { slug, outcome, replyId: posted.id });
    return { posted: true, replyId: posted.id, text };
  } catch (e) {
    deps.log("resolution: post failed", { slug, err: (e as Error).message });
    return { posted: false, reason: "post-failed", text };
  }
}
