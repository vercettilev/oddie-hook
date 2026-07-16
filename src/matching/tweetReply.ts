// The reply generator for "tweet mode": once a market is confirmed (a venue
// match auto-accepted, a closest match the operator approved, or a Community
// market just created), turn it into one ready-to-paste X reply, under the
// 280-char limit, plus an ASCII fallback.
//
// This is deliberately a pure function with no I/O: the manual-post workflow
// calls it today, and the same function drops straight into an automated
// listener later. Nothing here knows how the market was confirmed or how the
// reply gets posted — it only shapes text.

export const TWEET_LIMIT = 280;

export interface TweetReplyInput {
  question: string;
  yesPct: number; // 0-100
  permalink: string; // canonical /m/{slug} URL
  /** "existing" = a live venue market with real odds; "new" = a just-created
   *  Community market with no pool yet, so we quote starting odds + a deadline. */
  kind: "existing" | "new";
  closesAt?: string | null; // ISO; used only for "new"
}

export interface TweetReply {
  primary: string;
  fallback: string;
}

/** "2026-08-01T…" -> "Aug 1" (or "Jan 1 2027" when it's not this year). Kept
 *  tiny and dependency-free; a bad/missing date just yields "" and the caller's
 *  template omits the clause. Uses a fixed reference year so it's deterministic
 *  in tests (Date.now is avoided elsewhere in this codebase for the same reason). */
function shortDate(iso: string | null | undefined, thisYear: number): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const base = `${mon} ${d.getUTCDate()}`;
  return d.getUTCFullYear() === thisYear ? base : `${base} ${d.getUTCFullYear()}`;
}

/** Assemble prefix + question + suffix so the whole thing fits `limit`, trimming
 *  the QUESTION (never the odds or the link) with an ellipsis when it's too long.
 *  The link and odds are the payload; the question is the part that can give. */
function fit(prefix: string, question: string, suffix: string, limit: number): string {
  const room = limit - prefix.length - suffix.length;
  if (room <= 1) return (prefix + suffix).slice(0, limit); // pathological: no room for the question
  const q = question.length <= room ? question : question.slice(0, room - 1).trimEnd() + "…";
  return prefix + q + suffix;
}

export function buildTweetReply(input: TweetReplyInput, thisYear = 2026): TweetReply {
  const yes = Math.max(0, Math.min(100, Math.round(input.yesPct)));
  const no = 100 - yes;
  const link = input.permalink;

  if (input.kind === "new") {
    const date = shortDate(input.closesAt, thisYear);
    const closes = date ? `, closes ${date}` : "";
    return {
      primary: fit("just made the market. ", input.question, ` — ${yes}% yes${closes}. play free, no wallet ↓ ${link}`, TWEET_LIMIT),
      fallback: fit("", input.question, ` - ${yes}% yes${closes}. play free, no wallet: ${link}`, TWEET_LIMIT),
    };
  }
  return {
    primary: fit("found the market. ", input.question, ` — ${yes}% yes · ${no}% no. play free, no wallet ↓ ${link}`, TWEET_LIMIT),
    fallback: fit("", input.question, ` - ${yes}% yes / ${no}% no. play free, no wallet: ${link}`, TWEET_LIMIT),
  };
}
