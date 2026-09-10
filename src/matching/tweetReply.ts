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

export const TWEET_LIMIT = 280;

// Deterministic, not random. This module's own header calls these "pure
// functions with no I/O": the same input has to keep producing the same
// tweet, today and inside whatever automated listener eventually calls them,
// or a retry silently rewrites what was already posted and a test can't pin
// an exact string. Math.random() would work exactly once and then break both
// of those. Hashing the permalink instead means the variety is real (two
// different markets read differently) without giving up determinism (the
// SAME market always reads the same way, forever).
export function pick<T>(pool: readonly T[], seed: string): T {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return pool[h % pool.length];
}

// The pre-market voice: a dare, not a joke at anyone's expense. The one rule
// buildVerdict() below earns the hard way ("sarcasm targets the certainty,
// never the person") applies HERE with an extra edge, because pre-market we
// do not yet know who is right. Mocking a claim that turns out to be correct
// reads worse than mocking nothing at all, so every line below needles the
// CONFIDENCE of an unproven claim ("you sound sure", "we'll see"), never the
// person who made it and never a specific side.
export const QUOTE_LEAD_POOL = [
  "this deserves a market.",
  "prove it, then.",
  "talk is cheap. odds aren't.",
  "confident? let's see.",
  "someone's about to be wrong.",
] as const;

/**
 * Same voice, same rule, for the line that actually asks someone in.
 *
 * Every one of these used to promise free points, which the product handed out
 * and which cost nothing to spend. It is real SOL now, so all five lines were
 * advertising something that no longer exists, on the single most-seen surface
 * oddie has: they go out under somebody else's tweet, to people who have never
 * heard of us, and the first thing they said was a lie.
 *
 * The replacement rule is the mirror of the old one. The old CTAs had to name a
 * number because a free grant is only real if you say how much. These must NOT
 * name one, because the amount is the reader's own and any figure here would
 * either anchor them or read as a minimum we do not charge. What cannot get
 * softer with the wordplay now is that the money is theirs and the market is
 * real.
 */
// ONE CLAUSE PER ENTRY, no internal full stop.
//
// buildTweetReply capitalises the first character (a reply's CTA starts its own
// line) and nothing else, so an entry with a sentence break inside it ships as
// "Talk is free. the market isn't" and reads as a typo in every reply that
// draws it. Two entries did exactly that in production. Commas instead; the
// test below refuses a period.
export const CTA_POOL: readonly (() => string)[] = [
  () => `pick a side, real SOL on it`,
  () => `put SOL behind that`,
  () => `talk is free, the market isn't`,
  () => `back it, or watch someone else`,
  () => `pick a side, winners split the pool`,
];

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

/**
 * WHAT WE SAY WHEN WE CANNOT PRICE IT.
 *
 * The alternative was silence, and silence has a real argument behind it: a
 * public "I can't make a market out of that" lands under somebody else's post
 * and is exactly how an account gets muted. Losing the ability to reply on X
 * would cost oddie its only distribution channel, so this is the most dangerous
 * sentence the product can write.
 *
 * It survives on three rules.
 *
 * NO LINK. A reply that pairs an @-mention with a URL is the shape X's spam
 * rules are written about, and it is also the difference between $0.015 and
 * $0.200 a post. The one place where the safe choice and the cheap choice are
 * the same choice.
 *
 * ONE SENTENCE, PLAIN WORDS, AND THEN IT STOPS. Two earlier passes failed in
 * opposite directions and the second was the more instructive. The first was
 * jargon ("not one i can call") and taught nobody. The second overcorrected
 * into three clauses that explained the product, named the fault and pointed at
 * the picture, which is a paragraph under someone else's post, and a paragraph
 * is a lecture however plain its words are.
 *
 * What is left says the only thing text has to say. The picture rides directly
 * under it carrying the rest, and it can do a thing sentences cannot: underline
 * the two spans of a real claim on the words themselves.
 *
 * Three of them rather than one string, because X's automation policy names
 * "duplicative or substantially similar posts" as manipulation. Three
 * paraphrases of one sentence do not make that go away, and nothing about this
 * reply pretends otherwise; the per-handle cap in the sweep is what actually
 * bounds it.
 *
 * THE FAILURE IS OURS. The line is written as oddie not finding a side, never
 * as the person having tagged the wrong thing. The sticker that rides with it
 * is the ghost stuck between YES and NO for the same reason: every other one in
 * the set either celebrates or mocks, and mockery under a stranger's post is
 * the mute-bait this whole comment exists to avoid.
 */
const CANNOT_PRICE = [
  "i couldn't make a market out of that one.",
  "no market in that one, and i looked.",
  "that one didn't have a market in it.",
];

/** Deterministic per tweet, so the same post never gets two different answers,
 *  and a timeline seeing several refusals does not see one canned string. */
export function buildRefusalReply(tweetId: string): string {
  return pick(CANNOT_PRICE, tweetId);
}

export function buildTweetReply(input: TweetReplyInput): TweetReply {
  const link = input.permalink;
  // Same voice and the same pool as the quote builder below, capitalised: a
  // reply's CTA is the start of its own line with nothing above it, where the
  // quote's sits under a lowercase framing line and stays lowercase to match.
  const rawCta = pick(CTA_POOL, input.permalink)();
  const cta = rawCta.charAt(0).toUpperCase() + rawCta.slice(1);
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

/**
 * The QUOTE-tweet variant: same market, same rules, but written to be posted as
 * a quote of the original rather than buried in a reply. Because it shows up in
 * the poster's own timeline with no parent tweet visible, it opens with a
 * standalone framing line (the hook when one fits, else one picked from
 * QUOTE_LEAD_POOL) instead of diving straight into the question. Lowercase,
 * casual: the voice of someone sharing, not answering.
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
  // Two picks, two pools, seeded off the same permalink with different
  // suffixes so a market's lead and CTA don't trivially move together.
  const lead = pick(QUOTE_LEAD_POOL, input.permalink);
  const cta = pick(CTA_POOL, `${input.permalink}:cta`)();
  const suffix = `\n\n${cta} ↓\n${link}`;
  const hook = (input.hook ?? "").trim();

  // The framing line is ALWAYS present: it is what makes the quote stand on its
  // own (the reply, by contrast, dives straight into the question). The hook, when
  // one is supplied and the whole quote still fits, rides one line above the
  // framing as a tight two-beat opener ("Argentina's year? / prove it, then.").
  // If it wouldn't fit, drop the hook; the framing stays.
  const base = `${lead}\n\n${input.question}${suffix}`;
  const withHook = hook ? `${hook}\n${lead}\n\n${input.question}${suffix}` : "";
  const primary = hook && withHook.length <= TWEET_LIMIT
    ? withHook
    : base.length <= TWEET_LIMIT
      ? base
      // Only a very long question reaches here; keep the framing + CTA + link and
      // trim the QUESTION to fit, exactly as the reply builder does.
      : fit(`${lead}\n\n`, input.question, suffix, TWEET_LIMIT);

  return {
    primary,
    // Plain-text fallback: the framing line + question + CTA on one ASCII line,
    // no hook, no arrows: the barest version for when the formatted quote looks off.
    fallback: fit(`${lead} `, input.question, ` ${cta}: ${link}`, TWEET_LIMIT),
  };
}
