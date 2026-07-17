// The reply generator for "tweet mode": once a market is confirmed (a venue
// match auto-accepted, a closest match the operator approved, or a Community
// market just created), turn it into one ready-to-paste X reply, under the
// 280-char limit, plus an ASCII fallback.
//
// This is deliberately a pure function with no I/O: the manual-post workflow
// calls it today, and the same function drops straight into an automated
// listener later. Nothing here knows how the market was confirmed or how the
// reply gets posted — it only shapes text.
//
// The copy is QUESTION-FIRST and ODDS-FREE: the permalink's card / og:image
// already shows the live odds, so the tweet stays clean. Identical for a venue
// match and a freshly-created Community market — no "found it" / "made it"
// prefix, no "% yes · % no".

export const TWEET_LIMIT = 280;

// The "N free points" figure in the copy — a stake-sized number (one call costs
// 50). A single constant so the copy has one source of truth to change later.
export const FREE_POINTS = 50;

export interface TweetReplyInput {
  question: string;
  permalink: string; // canonical /m/{slug} URL
  // Retained for caller compatibility only — the copy no longer varies by odds,
  // market state, or close date, so none of these affect the output.
  yesPct?: number;
  kind?: "existing" | "new";
  closesAt?: string | null;
}

export interface TweetReply {
  primary: string;
  fallback: string;
}

/** Assemble prefix + question + suffix so the whole thing fits `limit`, trimming
 *  the QUESTION (never the CTA or the link) with an ellipsis when it's too long.
 *  The link is the payload; the question is the part that can give. */
function fit(prefix: string, question: string, suffix: string, limit: number): string {
  const room = limit - prefix.length - suffix.length;
  if (room <= 1) return (prefix + suffix).slice(0, limit); // pathological: no room for the question
  const q = question.length <= room ? question : question.slice(0, room - 1).trimEnd() + "…";
  return prefix + q + suffix;
}

export function buildTweetReply(input: TweetReplyInput): TweetReply {
  const link = input.permalink;
  return {
    // Copy box: question, blank line, CTA + arrow, permalink.
    primary: fit("", input.question, `\n\nMake your call with ${FREE_POINTS} free points ↓\n${link}`, TWEET_LIMIT),
    // Plain-text fallback: same message, single line, no arrow (ASCII only).
    fallback: fit("", input.question, ` Make your call with ${FREE_POINTS} free points: ${link}`, TWEET_LIMIT),
  };
}
