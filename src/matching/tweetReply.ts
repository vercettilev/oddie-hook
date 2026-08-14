// The post generators for "tweet mode" and for resolutions.
//
// WHICH SHAPE TO POST, AND WHY — read from X's published For You code
// (13 Aug 2026 release), because the three shapes are not interchangeable:
//
//   REPLY   penalised three separate ways. `OONRetweetReplyFilter` drops
//           replies outright for any viewer who does not follow the author;
//           `EnableOonRescoreForInNetworkRepliesRetweets` discounts them by
//           0.75 even for viewers who DO; and the +15 mutual-follow reply
//           boost is explicitly gated on `in_reply_to_tweet_id.is_none()`, so
//           a reply can never earn it. A reply therefore cannot travel. Its
//           only audience is the people already reading that thread, which
//           means it has to be worth reading WITHOUT a click — the question
//           and the number belong in the text, not behind the link.
//
//   QUOTE   is an original post as far as ranking is concerned: it passes the
//           reply filter, takes no reply discount, and IS boost-eligible. This
//           is the shape to reach for when reach is the goal.
//
//   VERDICT the same as a quote, plus the one thing the other two lack: an
//           outcome. Posted against the claim that started it, it carries a
//           protagonist, a number and a result.
//
// The 280-char limit and the ASCII fallback apply to all three.
//
// These are pure functions with no I/O: the manual workflow calls them today,
// and the same functions drop into an automated listener later.
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

import { STARTING_PREDICTIONS } from "../store/economy.js";

export const TWEET_LIMIT = 280;

// What a new arrival actually gets, read from the economy rather than restated.
// It used to be a local 50 with a comment claiming "one call costs 50"; the
// real numbers are 5 predictions to start and 1 per call, so every reply and
// quote the product has ever posted promised ten times what it hands over.
// A number in public copy has to come from the place that pays it.
export const FREE_POINTS = STARTING_PREDICTIONS;

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
  // The odds go IN the reply now. A reply cannot reach anyone who does not
  // already follow us (see the header), so its readers are the people in this
  // thread and its whole job is to be worth reading where it stands. The old
  // copy left the number to the link's card on the grounds that the card shows
  // it — true, but only for the fraction who click, and a reply that needs a
  // click to make its point is a reply that made no point. Omitted when the
  // caller has no live price rather than invented.
  const yes = Number.isFinite(input.yesPct) ? Math.max(1, Math.min(99, Math.round(input.yesPct as number))) : null;
  const odds = yes === null ? "" : `\n\nmarket says ${yes}% yes. you?`;
  const suffix = `${odds}\n\n${cta} ↓\n${link}`;
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

// The default framing line for a quote — used when no hook is supplied. It has to
// stand on its own in the poster's timeline (there's no tweet above it to answer),
// so it states WHY this is being posted rather than answering anything.
const QUOTE_LEAD = "this deserves a market.";

/**
 * The QUOTE-tweet variant: same market, same rules, but written to be posted as
 * a quote of the original rather than buried in a reply. Because it shows up in
 * the poster's own timeline with no parent tweet visible, it opens with a
 * standalone framing line (the hook when one fits, else "this deserves a
 * market.") instead of diving straight into the question. Lowercase, casual —
 * the voice of someone sharing, not answering.
 */
/* ------------------------------------------------------------- verdicts --
 * Resolution as content: the post you can only make because the call was
 * recorded when nobody knew the answer. It has what an open market never has —
 * a protagonist, a number, and an outcome — and it is posted as an ORIGINAL
 * post (quoting the claim that started it), so it is boost-eligible rather
 * than filtered.
 *
 * THE ONE VOICE RULE, and it is a safety rule before it is a style one:
 *
 *   Sarcasm is aimed at the CERTAINTY, never at the person.
 *
 * The published weights make this arithmetic, not manners. A reply is worth
 * +5; a mute is −58.8 and a report is −234. One person who feels mocked costs
 * more than eleven people who reply. So a WIN is loud and names its hero, and
 * a LOSS is dry, factual and jab-free: the tone that makes people want to be
 * featured is also the tone that does not get the account muted. Nobody is
 * ever the punchline of their own losing call.
 */

export interface VerdictInput {
  /** The caller, @-less. */
  handle: string;
  side: "yes" | "no";
  /** The price they took, 1-99. */
  entryPct: number;
  /** How it actually settled. */
  outcome: "yes" | "no";
  question: string;
  permalink: string;
  /** The post that started it. When present the operator quotes it, and the
   *  claim shows above the verdict instead of being described in it. */
  sourceUrl?: string | null;
}

/** How unlikely their side looked when they took it. 4× or better is where a
 *  call stops being an opinion and starts being a story. */
const LONGSHOT_MULT = 4;

export interface Verdict extends TweetReply {
  won: boolean;
  /** True when the call was a genuine longshot — the operator's cue that this
   *  one is worth a post at all on a quiet day. */
  longshot: boolean;
}

export function buildVerdict(v: VerdictInput): Verdict {
  const won = v.side === v.outcome;
  const pct = Math.max(1, Math.min(99, Math.round(v.entryPct)));
  const mult = 100 / pct;
  const longshot = won && mult >= LONGSHOT_MULT;
  const side = v.side.toUpperCase();
  const at = `@${v.handle.replace(/^@+/, "")}`;

  // The lead, in three registers, because a win is not one story. What the
  // sarcasm is aimed at is the market's certainty — a number — in every case.
  //
  //   longshot   they took a price almost nobody took, and it landed
  //   contrarian they were against the crowd but not wildly so
  //   favourite  they were WITH the crowd; the odds are no story, so the line
  //              credits the only thing that was actually hard (calling it
  //              before the fact) rather than inflating a 70% shot into drama
  //
  // A loss gets one plain register and no adjective about the caller.
  const lead = !won
    ? `${at} called ${side} at ${pct}%. it resolved ${v.outcome.toUpperCase()}.`
    : longshot
      ? `the market gave it ${pct}%. ${at} took it anyway.`
      : pct < 50
        ? `${at} took ${side} at ${pct}%. the market disagreed. the market was wrong.`
        : `${at} called ${side} at ${pct}% and it landed. before the fact, which is the only part that counts.`;

  // The claim itself. When the operator is quoting the source tweet, the claim
  // is already sitting above this post and repeating it wastes the 280; with
  // no source there is nothing on screen saying what was called, so the
  // question goes in.
  const claim = v.sourceUrl ? "" : `\n\n${v.question}`;

  // The close. On a win it states the receipt; on a loss it says the only
  // honest thing that is also kind — the call is on the record either way,
  // which is the product's whole promise and costs the loser nothing.
  const close = won
    ? "receipts, not takes."
    : "called it in public, scored in public. that's the deal.";

  const suffix = `${claim}\n\n${close}\n${v.permalink}`;
  const primary = fit("", lead, suffix, TWEET_LIMIT);

  return {
    primary,
    fallback: fit("", lead, ` ${close} ${v.permalink}`, TWEET_LIMIT),
    won,
    longshot,
  };
}

export function buildTweetQuote(input: TweetReplyInput): TweetReply {
  const link = input.permalink;
  const cta = `pick a side with ${FREE_POINTS} free points`;
  const suffix = `\n\n${cta} ↓\n${link}`;
  const hook = (input.hook ?? "").trim();

  // The framing line is ALWAYS present — it is what makes the quote stand on its
  // own (the reply, by contrast, dives straight into the question). The hook, when
  // one is supplied and the whole quote still fits, rides one line above the
  // framing as a tight two-beat opener ("Argentina's year? / this deserves a
  // market."). If it wouldn't fit, drop the hook; the framing stays.
  const base = `${QUOTE_LEAD}\n\n${input.question}${suffix}`;
  const withHook = hook ? `${hook}\n${QUOTE_LEAD}\n\n${input.question}${suffix}` : "";
  const primary = hook && withHook.length <= TWEET_LIMIT
    ? withHook
    : base.length <= TWEET_LIMIT
      ? base
      // Only a very long question reaches here; keep the framing + CTA + link and
      // trim the QUESTION to fit, exactly as the reply builder does.
      : fit(`${QUOTE_LEAD}\n\n`, input.question, suffix, TWEET_LIMIT);

  return {
    primary,
    // Plain-text fallback: the framing line + question + CTA on one ASCII line,
    // no hook, no arrows — for when the formatted quote looks off.
    fallback: fit(`${QUOTE_LEAD} `, input.question, ` ${cta}: ${link}`, TWEET_LIMIT),
  };
}
