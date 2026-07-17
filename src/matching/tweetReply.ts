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
  /** Optional short teaser above the question (e.g. "PSG or not?"). Included only
   *  when the whole reply still fits under the limit with the FULL question. */
  hook?: string;
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
  const cta = `Pick a side with ${FREE_POINTS} free points`;
  const suffix = `\n\n${cta} ↓\n${link}`;
  const hook = (input.hook ?? "").trim();

  // The hook rides on top ONLY if the whole reply — hook + the FULL (untruncated)
  // question + CTA + link — still clears the limit. Otherwise drop it and go
  // straight to the question. (Never truncate the question to make room for a hook.)
  const withHook = hook ? `${hook}\n\n${input.question}${suffix}` : "";
  const primary = hook && withHook.length <= TWEET_LIMIT
    ? withHook
    : fit("", input.question, suffix, TWEET_LIMIT);

  return {
    primary,
    // Plain-text fallback: the same CTA, one ASCII line, question-first (no hook,
    // no arrow) — the barest version for when the formatted reply looks off.
    fallback: fit("", input.question, ` ${cta}: ${link}`, TWEET_LIMIT),
  };
}
