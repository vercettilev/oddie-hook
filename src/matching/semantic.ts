// Stage two of matching: an LLM referee over a lexically-pruned candidate list.
//
// The lexical matcher's ceiling is measured, not theoretical: of the first six
// real tweets, three were obvious-to-a-human matches with ZERO word overlap
// ("Mbappé: until I see a trophy we are not the strongest" → the France World
// Cup market). Real Twitter language does not use market-question words; the
// missing ingredient is entity knowledge, and that is what the referee buys.
//
// The safety contract, in order of precedence:
//   1. A confident lexical match short-circuits — no LLM call, no new failure
//      mode for everything that already worked. Logged as matched:"lexical".
//   2. The referee only ever sees candidates that survived the CORRECTNESS
//      gates (hard disqualifiers, family pruning). It cannot pick a market the
//      structural rules rejected, because it never sees one.
//   3. The referee has, and is told to prefer, a "none" option. A wrong card is
//      worse than silence, and the prompt says so in those words.
//   4. Any failure — no API key, timeout, malformed reply — degrades to exactly
//      the pre-semantic behaviour: silence. Never a block, never a public error.

import { Market } from "../venues/types.js";
import { candidateMarkets, disqualified, matchTweet, MatchResult } from "./matcher.js";
import { categorize, categorizeText } from "./categorize.js";
import { validReplyLine } from "../card/tweetCopy.js";

// Entity linking over ~18 short candidates is small-model work. Haiku 4.5 is
// the cheapest current Claude and comfortably reliable at it; at roughly
// 1.2k input + 60 output tokens a call it costs ~$0.0015 and answers in about
// a second. The key comes from the environment and only the environment.
const MODEL = "claude-haiku-4-5-20251001";
const API_KEY_ENV = "ANTHROPIC_API_KEY";
const TIMEOUT_MS = 6_000; // /hook's budget is 1-3s typical; this is the hard stop
const CANDIDATES_MAX = 18;
const LEXICAL_SLOTS = 12; // scored candidates; the rest is category/volume fill

export const semanticEnabled = (): boolean => Boolean(process.env[API_KEY_ENV]);
export const SEMANTIC_KEY_ENV = API_KEY_ENV;

export interface SemanticMatch {
  market: Market;
  score: number;
  /** Which stage produced the answer — Week-1 data segments on this. */
  via: "lexical" | "semantic";
  /** The referee's one-line justification; null for lexical. The audit trail. */
  reason: string | null;
}

/**
 * The candidate list the referee sees: lexical hits first (they earned their
 * spot with overlap), then the biggest markets in the tweet's own category,
 * then the biggest overall — because a zero-overlap tweet ("Mbappé…") is by
 * definition invisible to scoring, and the market it means is almost always a
 * headline market. Every entrant passes the structural disqualifiers.
 */
export function buildCandidates(tweetText: string, markets: Market[]): MatchResult[] {
  const scored = candidateMarkets(tweetText, markets, LEXICAL_SLOTS);
  const seen = new Set(scored.map((c) => `${c.market.venue}:${c.market.venueId}`));
  const out = [...scored];

  const cat = categorizeText(tweetText);
  const byVolume = [...markets].sort((a, b) => b.volumeUsd - a.volumeUsd);
  const fill = (pool: Market[]) => {
    for (const m of pool) {
      if (out.length >= CANDIDATES_MAX) return;
      const key = `${m.venue}:${m.venueId}`;
      if (seen.has(key) || disqualified(tweetText, m)) continue;
      seen.add(key);
      out.push({ market: m, score: 0 });
    }
  };
  if (cat !== "Other") fill(byVolume.filter((m) => categorize(m) === cat));
  fill(byVolume);
  return out;
}

interface Verdict {
  pick: number | null;
  reason: string;
}

const SYSTEM = `You match tweets to prediction markets for a betting product. You are given one tweet and a numbered list of live markets. Answer with JSON only: {"pick": <number or null>, "reason": "<one short sentence>"}.

Rules, in order:
- A WRONG CARD IS WORSE THAN SILENCE. When unsure, pick null.
- Pick a market only if a reasonable human would say the tweet's claim or subject is CLEARLY about that market's question. Entity knowledge is exactly what you are for: a tweet about Mbappé is about France; a club is about its league; a CEO is about their company.
- The tweet must carry a stance, prediction, hope, fear or hot take that the market's question prices. Plain news reports, announcements, nostalgia and throwback posts with no forward-looking angle: null.
- Never pick a market about a DIFFERENT event, date, threshold or person than the tweet implies, however close. Related-but-different is null.
- At most one pick.`;

function candidateLines(cands: MatchResult[]): string {
  return cands
    .map((c, i) => {
      const m = c.market;
      const vol = m.volumeUsd >= 1e6 ? `$${(m.volumeUsd / 1e6).toFixed(1)}M` : `$${Math.round(m.volumeUsd / 1e3)}K`;
      return `${i + 1}. ${m.question} [${categorize(m)}, yes ${m.yesPct}%, ${vol}]`;
    })
    .join("\n");
}

/** One round trip to the referee. Throws on anything unusable; the caller
 *  treats every throw identically — as silence. */
export async function referee(tweetText: string, cands: MatchResult[]): Promise<Verdict> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env[API_KEY_ENV]!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 150,
      system: SYSTEM,
      messages: [{ role: "user", content: `Tweet: ${tweetText}\n\nMarkets:\n${candidateLines(cands)}` }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`referee ${res.status}`);
  const body = (await res.json()) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  usageTotal.calls++;
  usageTotal.inputTokens += body.usage?.input_tokens ?? 0;
  usageTotal.outputTokens += body.usage?.output_tokens ?? 0;
  const text = body.content?.find((b) => b.type === "text")?.text ?? "";
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error("referee returned no JSON");
  const v = JSON.parse(json) as { pick?: unknown; reason?: unknown };
  const pick =
    typeof v.pick === "number" && Number.isInteger(v.pick) && v.pick >= 1 && v.pick <= cands.length
      ? v.pick
      : null;
  return { pick, reason: typeof v.reason === "string" ? v.reason.slice(0, 200) : "" };
}

/** Cumulative token spend across referee calls — the eval's cost line. */
const usageTotal = { calls: 0, inputTokens: 0, outputTokens: 0 };
export function semanticUsage(): { calls: number; inputTokens: number; outputTokens: number } {
  return { ...usageTotal };
}

type RefereeFn = typeof referee;
let refereeImpl: RefereeFn = referee;
/** Test seam: swap the network call, keep every branch around it honest. */
export function _setReferee(fn: RefereeFn | null): void {
  refereeImpl = fn ?? referee;
}

/* ------------------------------------------------------------- reply copy --
 * The tweet copy's job changed the day it met a real thread: lines generated
 * from the market alone read as an ad pasted over a conversation (measured:
 * 200 impressions, 0 clicks). A reply has to answer the PERSON, with the
 * market as its evidence. That needs the tweet, so it's LLM work — same Haiku,
 * one small extra call per matched /hook request — and every line it writes
 * still has to pass the mechanical trust rules (validReplyLine) before anyone
 * sees it: no invented numbers, no hype, no CTA, one emoji max.
 */

const REPLY_SYSTEM = `You write short reply-tweet options for a thread. You are given the tweet someone posted and one live prediction market related to it. Write 3 reply lines. Answer with JSON only: {"variants": ["...", "...", "..."]}.

Rules:
- You are REPLYING to the person, in the thread's register — the market number is your evidence, never your headline. Sound like a person, not a brand.
- Three different angles: one that leans into their take, one that pushes back on it, one that just states the odds dryly.
- Lowercase-friendly, short (under 160 chars).
- NO emoji. (At most one variant of the three may carry a single 👇 or 👀 mid-thought if it truly earns it — never tacked on the end, and never more than one variant.)
- State the odds as FACT and react to the tweet's claim. NEVER characterize the price: no "undervalued", "overvalued", "mispriced", "good value", "the market is wrong/sleeping" — whether the market is right is the reader's question, not your verdict.
- Use ONLY facts you were given: what they said, the market question, the percentage, the payout, the volume, the time left. Never invent an event, stat, date or name.
- Never tell them which side to take. Never "check out", "claim", "sign up", or any app-speak.`;

/** One generation pass; the caller retries once if the validator thins the
 *  set below three. The validator never loosens — the model just rolls again. */
export async function replyCopy(tweetText: string, m: Market): Promise<string[] | null> {
  const first = await replyCopyOnce(tweetText, m);
  let lines: string[];
  if (first && first.length >= 3) lines = first.slice(0, 3);
  else {
    const second = await replyCopyOnce(tweetText, m);
    lines = [...new Set([...(first ?? []), ...(second ?? [])])].slice(0, 3);
    if (lines.length < 2) return null;
  }
  // Emoji is the exception, never the default: the first line that carries one
  // keeps it, every later one loses it. Mechanical, so the prompt can't drift.
  let seen = false;
  return lines.map((l) => {
    if (!/\p{Extended_Pictographic}/u.test(l)) return l;
    if (!seen) { seen = true; return l; }
    return l.replace(/\s*\p{Extended_Pictographic}/gu, "").replace(/\s{2,}/g, " ").trim();
  });
}

async function replyCopyOnce(tweetText: string, m: Market): Promise<string[] | null> {
  if (!semanticEnabled()) return null;
  const yes = Math.max(1, Math.min(99, Math.round(m.yesPct)));
  const facts = [
    `question: ${m.question}`,
    `yes: ${yes}% (pays ${(100 / yes) >= 10 ? Math.round(100 / yes) : Math.round(1000 / yes) / 10}×)`,
    `no: ${100 - yes}% (pays ${(100 / (100 - yes)) >= 10 ? Math.round(100 / (100 - yes)) : Math.round(1000 / (100 - yes)) / 10}×)`,
    `volume: ${m.volumeUsd >= 1e6 ? `$${(m.volumeUsd / 1e6).toFixed(1)}M` : `$${Math.round(m.volumeUsd / 1e3)}K`}`,
  ].join("\n");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env[API_KEY_ENV]!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: REPLY_SYSTEM,
        messages: [{ role: "user", content: `Tweet: ${tweetText}\n\nMarket:\n${facts}` }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`reply ${res.status}`);
    const body = (await res.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    usageTotal.calls++;
    usageTotal.inputTokens += body.usage?.input_tokens ?? 0;
    usageTotal.outputTokens += body.usage?.output_tokens ?? 0;
    const text = body.content?.find((b) => b.type === "text")?.text ?? "";
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    const v = JSON.parse(json) as { variants?: unknown };
    if (!Array.isArray(v.variants)) return null;
    const lines = v.variants
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter((x) => validReplyLine(x, m, tweetText))
      .slice(0, 3);
    return lines.length ? lines : null;
  } catch (err) {
    console.error("[reply-copy] unavailable:", (err as Error).message);
    return null;
  }
}

/**
 * The full pipeline. Lexical first (unchanged, threshold and all); the referee
 * only for tweets lexical could not answer; silence for everything else.
 */
export async function matchSemantic(tweetText: string, markets: Market[]): Promise<SemanticMatch | null> {
  const lex = matchTweet(tweetText, markets);
  if (lex) return { market: lex.market, score: lex.score, via: "lexical", reason: null };

  if (!semanticEnabled()) return null;
  const cands = buildCandidates(tweetText, markets);
  if (cands.length === 0) return null;

  try {
    const verdict = await refereeImpl(tweetText, cands);
    if (verdict.pick === null) return null;
    const chosen = cands[verdict.pick - 1];
    if (!chosen) return null; // a pick outside the list is a hallucination, and silence
    return { market: chosen.market, score: chosen.score, via: "semantic", reason: verdict.reason };
  } catch (err) {
    // The pre-semantic behaviour for this tweet was silence; fail back to it.
    console.error("[semantic] referee unavailable:", (err as Error).message);
    return null;
  }
}
