/**
 * Genesis profile archetypes.
 *
 * The card that greets a freshly connected account assigns a TYPE, and the one
 * hard requirement (Lev's, stated as "irrelevant sacma sapan bir sey cikmasin")
 * is that the assignment must never read as random. So the order here is
 * rules first, model last:
 *
 *   - Every archetype has a DETERMINISTIC signal computed from fields the
 *     OAuth user read already paid for (bio, created_at, tweet_count,
 *     follower counts, the pinned tweet's text). Same input, same type.
 *   - The reason the type fired is part of the return value and is printed on
 *     the card, because a label you can't justify is a horoscope.
 *   - The LLM is allowed in EXACTLY one place: when no rule fires, it may
 *     rescue the profile out of the fallback into a content type, from a
 *     closed set, with a one-line reason. A malformed or out-of-set answer is
 *     discarded and the honest fallback ships instead.
 *
 * Headlines use only numbers we were given (join year, post count, rate).
 * Nothing here invents a metric.
 */

// There is deliberately NO fallback type. Lev's rule: somebody connects their
// profile and the card says who they ARE, never "unscored" — a mirror that
// shrugs is a broken product. Honesty is kept a different way: every type's
// headline carries the real number or signal that earned it.
export type Archetype =
  | "prophet" | "loudest" | "lurker" | "doubter"
  | "maxi" | "judge" | "rookie" | "og" | "main";

export interface ProfileSignals {
  handle: string;
  bio: string;
  /** ISO date the account was created (X's created_at). */
  createdAt: string;
  tweetCount: number;
  followers: number;
  following: number;
  /** Text of the pinned tweet, when there is one. */
  pinnedText: string | null;
}

export interface ArchetypeResult {
  archetype: Archetype;
  /** The card's big line, in the type's own voice, real numbers filled in. */
  headline: string;
  /** The one-line justification printed small under the label. */
  reason: string;
  /** Derived numbers, exposed so the card and any test can audit them. */
  derived: { joinYear: number; ageYears: number; postsPerDay: number };
  /** What decided it: a content signal, the account's age, or the rate pivot.
   *  The LLM refiner is only allowed to second-guess "rate". */
  via: "content" | "age" | "rate";
}

/** Sticker asset for each type, all shipped in public/brand. */
export const ARCHETYPE_ART: Record<Archetype, string> = {
  prophet: "/brand/arch-prophet.webp",
  loudest: "/brand/arch-loudest.webp",
  lurker: "/brand/arch-lurker.webp",
  doubter: "/brand/arch-doubter.webp",
  maxi: "/brand/arch-maxi.webp",
  judge: "/brand/arch-judge.webp",
  rookie: "/brand/arch-rookie.webp",
  og: "/brand/arch-og.webp",
  main: "/brand/arch-main.webp",
};

export const ARCHETYPE_LABEL: Record<Archetype, string> = {
  prophet: "THE PROPHET", loudest: "THE LOUDEST", lurker: "THE LURKER",
  doubter: "THE DOUBTER", maxi: "THE MAXI", judge: "THE JUDGE",
  rookie: "THE ROOKIE", og: "THE OG", main: "THE MAIN CHARACTER",
};

/* ------------------------------------------------------------- signals -- */

// A prophecy is either a claim WITH a date ("will" alone catches half of X, a
// bare year catches birthday posts — both together is a dated record), or one
// of the idioms whose entire meaning is "write this down and check me later".
const PREDICTION = /\b(will|won't|gonna|hits?|flips?|reaches|crosses|before|by)\b/i;
const YEAR = /\b20(2[5-9]|3\d)\b/;
const PROPHECY_IDIOM = /(calling it now|mark my words|screenshot this|remind me in|prediction:|you heard it here first)/i;

// One-conviction bios. The conviction word may sit alone ("maxi", "never
// selling"), ride a ticker, or wear the cashtag uniform.
const MAXI = /\b(btc|bitcoin|sol|solana|eth|ethereum)\b.{0,40}\b(maxi|only|forever|believer)\b|\bmaxi\b|never selling|\$(btc|sol|eth|bitcoin)\b|laser eyes|\bhodl\b|og holder/i;

// Verdict-industry bios: people whose stated job is grading everyone else.
// "opinions/views are my own" is the most common disclaimer on X and is the
// opposite of handing out verdicts, so it is excluded before matching.
const DISCLAIMER = /\b(opinions?|views?|takes?)\s+(are\s+)?(my|our)\s+own\b/i;
const JUDGE = /\b(takes?|verdicts?|ratings?|reviews?|rankings?|tier list|critic|commentary|analyst|judge|calling out|i rate)\b/i;

// Contrarian language, bio or pinned.
const DOUBT = /\b(fade|overrated|cope|contrarian|skeptic|sceptic|doubt|wrong about|not gonna happen|no way|unpopular opinion|devil's advocate|prove me wrong|not convinced|bearish on everything|disagree)\b/i;

const dayMs = 86_400_000;

export function classifyArchetype(p: ProfileSignals): ArchetypeResult {
  const created = new Date(p.createdAt);
  const joinYear = created.getUTCFullYear();
  const ageYears = Math.max(0, (Date.now() - created.getTime()) / (365.25 * dayMs));
  const postsPerDay = ageYears > 0 ? p.tweetCount / (ageYears * 365.25) : p.tweetCount;
  const derived = {
    joinYear,
    ageYears: Math.round(ageYears * 10) / 10,
    postsPerDay: Math.round(postsPerDay * 10) / 10,
  };
  const out = (archetype: Archetype, headline: string, reason: string,
    via: ArchetypeResult["via"]): ArchetypeResult =>
    ({ archetype, headline, reason, derived, via });

  const pinned = p.pinnedText ?? "";

  // Content rules outrank rate rules: what somebody chose to pin or write in
  // a bio is a stronger identity claim than how often they post. A dated
  // prediction counts from the bio too — "btc 1m by 2030" in a bio is the
  // same act as pinning it.
  const prophetic = (t: string) =>
    !!t && ((PREDICTION.test(t) && YEAR.test(t)) || PROPHECY_IDIOM.test(t));
  if (prophetic(pinned) || prophetic(p.bio)) {
    return out("prophet",
      `Calling the future since ${joinYear}. Nobody wrote it down.`,
      "You put a date on a claim.", "content");
  }
  if (MAXI.test(p.bio)) {
    return out("maxi",
      `One conviction since ${joinYear}. Never priced it.`,
      "The bio holds exactly one belief.", "content");
  }
  if (JUDGE.test(p.bio.replace(DISCLAIMER, ""))) {
    return out("judge",
      "Everyone gets your verdict. Who checks yours?",
      "The bio hands out verdicts.", "content");
  }
  if (DOUBT.test(p.bio) || DOUBT.test(pinned)) {
    return out("doubter",
      "You call BS for a living. Put it on paper.",
      "Contrarian language, on the record.", "content");
  }

  // Identity-shape rules, between content and rate. MAIN before OG: fame is
  // the rarer and more personal fact. The 10x ratio is Lev's number ("1'e 10");
  // the 1,000-follower floor keeps "40 followers, 3 following" from cosplaying
  // as celebrity — ten times nothing is still nothing.
  if (p.followers >= 1000 && p.following > 0 && p.followers / p.following >= 10) {
    const kat = Math.round(p.followers / p.following);
    return out("main",
      "Everyone watches you talk. Nobody keeps score.",
      `Followed ${kat}x more than you follow.`, "content");
  }
  if (ageYears >= 10) {
    return out("og",
      `Here since ${joinYear}. Seen everything. Wrote down nothing.`,
      `Account since ${joinYear}.`, "age");
  }

  // Age beats rate for genuinely new accounts: their loudest fact IS the
  // clean slate.
  if (ageYears < 1) {
    return out("rookie",
      "Clean record. Keep it that way, in writing.",
      "Account under a year old.", "age");
  }

  // The rate pivot. Everyone left lands on whichever of the two universal
  // dimensions describes them more: talking or watching. There is no third
  // bucket on purpose — a mirror that shrugs is a broken product — and the
  // headline always carries the account's own numbers, so the label cannot
  // outrun the evidence. More-than-every-other-day is the fulcrum: past it
  // you are the noise, under it you are the audience.
  if (derived.postsPerDay >= 1.7) {
    const k = derived.postsPerDay >= 2 ? String(Math.round(derived.postsPerDay)) : derived.postsPerDay.toFixed(1);
    return out("loudest",
      `${k} posts a day. Not one on paper.`,
      `You post ${k} times a day. Never once had to be right.`, "rate");
  }
  return out("lurker",
    `${Math.floor(ageYears)} years here. ${p.tweetCount.toLocaleString("en-US")} posts. Make the next one count.`,
    "More watching than talking.", "rate");
}

/* ---------------------------------------------------------- LLM rescue -- */

const CONTENT_TYPES: Archetype[] = ["prophet", "maxi", "judge", "doubter"];

/**
 * Optional second pass, ONLY for rate-pivot assignments (via: "rate") where
 * the profile actually carries some language to read. The judge function is
 * injected (the server owns the inference client); it must answer with one of
 * the content types and a short reason. Anything else — unknown type, empty
 * reason, a thrown error — keeps the deterministic assignment, because a
 * wrong costume is worse than a plain one. Content and age assignments are
 * never second-guessed.
 */
export async function refineArchetype(
  base: ArchetypeResult,
  p: ProfileSignals,
  judge: (bio: string, pinned: string | null) => Promise<{ archetype: string; reason: string } | null>,
): Promise<ArchetypeResult> {
  if (base.via !== "rate") return base;
  if ((p.bio ?? "").trim().length < 12 && !(p.pinnedText ?? "").trim()) return base;
  try {
    const v = await judge(p.bio, p.pinnedText);
    if (!v) return base;
    const t = v.archetype?.toLowerCase?.() as Archetype;
    if (!CONTENT_TYPES.includes(t)) return base;
    const reason = (v.reason ?? "").trim();
    if (reason.length < 8 || reason.length > 90) return base;
    // The refined type keeps its standard headline: the model supplies the
    // justification, never the promise.
    return withForcedType(t, { ...base, reason });
  } catch {
    return base;
  }
}

function withForcedType(t: Archetype, base: ArchetypeResult): ArchetypeResult {
  const y = base.derived.joinYear;
  const head: Record<string, string> = {
    prophet: `Calling the future since ${y}. Nobody wrote it down.`,
    maxi: `One conviction since ${y}. Never priced it.`,
    judge: "Everyone gets your verdict. Who checks yours?",
    doubter: "You call BS for a living. Put it on paper.",
  };
  return { ...base, archetype: t, headline: head[t] ?? base.headline };
}
