// The claim-extraction engine: turn an argument (a tweet, or a short thread of
// them) into a clean, resolvable YES/NO market — or REFUSE, in plain language,
// when there is nothing a settlement can ever check.
//
// This is the product's quality gate. A market that resolves wrong poisons the
// accuracy record, and the accuracy record is the moat — so the whole module is
// tuned for PRECISION OVER RECALL. When the model is unsure whether a claim is
// truly checkable, it is told to grade DOWN (fuzzy over clean, unresolvable over
// fuzzy). A market we never made costs nothing; a market we resolve wrong costs
// the one thing we cannot rebuy.
//
// Entity/judgment work of this weight is not small-model work (the referee in
// semantic.ts is — this is not). It runs on the strongest current Claude, with
// adaptive thinking on, and structured output so the shape is guaranteed rather
// than hoped for. The key comes from the environment and only the environment;
// with no key the engine is simply unavailable (the /tool UI says so).

import { messagesUrl, authHeaders, inferenceEnabled, API_KEY_ENV, MODEL } from "../inference.js";
const TIMEOUT_MS = 45_000; // interactive admin paste; opus + thinking is slow but not latency-critical

export const extractEnabled = (): boolean => inferenceEnabled();
export const EXTRACT_KEY_ENV = API_KEY_ENV;

/** The five real chips a market can land in. "Other" is deliberately excluded —
 *  a claim we can't place in one of these is a signal it may not be a clean
 *  market. ("Community" is a feed concept, not a subject category.) */
export const EXTRACT_CATEGORIES = ["Crypto", "Sports", "Politics", "Culture", "Tech"] as const;
export type ExtractCategory = (typeof EXTRACT_CATEGORIES)[number];

export type Resolvability = "clean" | "fuzzy" | "unresolvable";

export interface Extraction {
  /** Neutral, unambiguous YES/NO question drawn from the EXACT disputed claim —
   *  the specific falsifiable assertion, not a vibe paraphrase. Empty when
   *  unresolvable. */
  question: string;
  /** 1–3 sentences: exactly what evidence resolves YES vs NO, and the source to
   *  check. Empty when unresolvable. */
  resolution_criteria: string;
  /** The claim's natural deadline as ISO 8601, or null when none is stated. */
  close_time: string | null;
  /** True when close_time was inferred (the claim named no explicit deadline). */
  close_time_inferred: boolean;
  category: ExtractCategory;
  resolvability: Resolvability;
  /** The appropriateness gate, separate from resolvability: false = the subject
   *  is off-limits for a market (private individual, real-person harm/health,
   *  harassment). A claim can be resolvable AND inappropriate — both block it. */
  appropriate: boolean;
  /** One line: why this grade — the human-readable gate explanation. When the
   *  claim is blocked, this explains the block (resolvability OR appropriateness). */
  reason: string;
  /** A very short, scroll-stopping teaser for the tweet reply (e.g. "PSG or
   *  not?"). Optional — the reply omits it when it doesn't fit. Empty when the
   *  claim is blocked. */
  hook: string;
}

const SYSTEM = `You convert an argument (a tweet, or a few tweets of a disagreement) into a clean, resolvable YES/NO prediction market — or you refuse. You are the quality gate for a real-money-style betting product: a market that resolves wrong poisons the accuracy record, which is the whole moat. So your bias is PRECISION OVER RECALL. When unsure, grade DOWN.

Return ONLY the structured object. Fields:

- question: a neutral, unambiguous YES/NO question derived from the EXACT claim in dispute — the specific falsifiable assertion, not a vibe paraphrase. Name the concrete subject, threshold, and (if the text implies one) the timeframe. A reader who never saw the tweet must be able to answer it. Leave "" when unresolvable.
- resolution_criteria: 1–3 sentences stating exactly what evidence settles YES vs NO, and the specific source to check (e.g. "the final score on the Premier League site", "the official announcement on the @company X account", "the BTC/USD close on Coinbase"). Name a source a stranger could go verify. Leave "" when unresolvable.
- close_time: the claim's natural deadline in ISO 8601 (e.g. "2026-08-01T23:59:00Z"), computed RELATIVE TO the current date/time given in the user message. It must be in the FUTURE — never output a past date, and get the YEAR right by anchoring to the current date provided ("tonight" = later today, "this week" = within 7 days of now, etc.). If the text states or clearly implies a deadline, use it. If not, BIAS TOWARD THE SHORTEST REASONABLE WINDOW the claim supports, and set close_time_inferred true — a market that resolves soon brings the person back for the result; one that resolves in months kills the loop. Concretely: hours to a few days for anything time-sensitive (a game, a launch, a price move, "today/this week"); a week or two only when the claim genuinely needs it; do NOT infer months. Reserve far-out deadlines for claims that explicitly carry one ("by end of year", "in 2027", "before the election"). When unsure between a shorter and a longer window, choose the shorter. Use null only when no timeframe is possible at all (which usually also means unresolvable).
- close_time_inferred: true if you chose the deadline rather than reading it from the text.
- category: one of Crypto, Sports, Politics, Culture, Tech — the single best fit. There is no "Other". If nothing fits, that is itself a sign the claim may not be a clean market.
- resolvability: one of clean | fuzzy | unresolvable.
    - clean: a specific, verifiable outcome with a bounded timeframe and a nameable public source. Only clean markets are eligible for auto-publish, so hold this bar HIGH.
    - fuzzy: a real prediction, but the wording, threshold, timeframe, or source needs a human to tighten before it is safe. Produce the market, but flagged.
    - unresolvable: subjective taste ("X is the GOAT", "this album is better"), no verifiable outcome, no bounded timeframe, or a private matter no public source can settle. REFUSE — leave question and resolution_criteria empty.
- appropriate: true if the SUBJECT is acceptable for a public prediction market; false if it is not. This is a SEPARATE judgment from resolvability — a claim can be perfectly resolvable and still inappropriate. Set false and refuse (empty question and criteria) when the claim is:
    - about an identifiable PRIVATE individual (a named non-public-figure — a normal person, not a politician/CEO/celebrity/athlete/public official acting in public life);
    - about the DEATH, serious harm, injury, illness, or health outcome of a real, identifiable person (e.g. "will <person> die/get cancer/relapse before X");
    - primarily an INSULT, slur, or HARASSMENT dressed up as a question ("will everyone finally admit <person> is a <slur>").
  Public figures' clearly public/professional outcomes are fine (elections, sports results, a CEO's company hitting a number). When unsure whether someone is public or the subject crosses a line, set appropriate false.
- appropriate_reason: when appropriate is false, one plain-language sentence a bettor can read explaining why we won't make this market. Empty when appropriate is true.
- reason: one short sentence explaining the resolvability grade in plain language.
- hook: a VERY short, punchy teaser for the tweet reply — a few words that make someone stop scrolling, phrased as a mini-question or tease. Max ~28 characters. Examples: "PSG or not?", "BTC to 100k?", "Arsenal's year?", "Fed cut coming?". Do NOT restate the full question; it is a tease above it. Leave "" if nothing crisp fits or the claim is blocked.

Rules, in order:
1. ERR TOWARD fuzzy/unresolvable when unsure. A market we never made costs nothing; a market we resolve wrong is unrecoverable.
2. A claim of pure taste, opinion, or aesthetics is unresolvable no matter how strongly stated. "Best", "overrated", "mid", "GOAT", "should", "deserves" with no measurable proxy → unresolvable.
3. No bounded timeframe and none can be reasonably inferred → unresolvable.
4. Private/unverifiable matters (someone's private relationship, undisclosed internal numbers, unfalsifiable claims about intent) → unresolvable.
5. The question must be about the SAME event, threshold, person and date the argument is actually about — never a related-but-different one.
6. The appropriateness gate runs ALONGSIDE resolvability, never instead of it. Judge both. If the subject crosses a line above, set appropriate false and refuse even if the claim is otherwise cleanly resolvable.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    question: { type: "string" },
    resolution_criteria: { type: "string" },
    close_time: { type: ["string", "null"] },
    close_time_inferred: { type: "boolean" },
    category: { type: "string", enum: EXTRACT_CATEGORIES as unknown as string[] },
    resolvability: { type: "string", enum: ["clean", "fuzzy", "unresolvable"] },
    appropriate: { type: "boolean" },
    appropriate_reason: { type: "string" },
    reason: { type: "string" },
    hook: { type: "string" },
  },
  required: [
    "question",
    "resolution_criteria",
    "close_time",
    "close_time_inferred",
    "category",
    "resolvability",
    "appropriate",
    "appropriate_reason",
    "reason",
    "hook",
  ],
} as const;

/** One round trip to the engine. Throws on anything unusable — no key, timeout,
 *  malformed reply — so the caller can report a single clean "unavailable". */
export async function extractClaim(text: string): Promise<Extraction> {
  if (!extractEnabled()) throw new Error(`extraction unavailable — set ${API_KEY_ENV}`);
  const res = await fetch(messagesUrl(), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2500,
      thinking: { type: "adaptive" },
      system: SYSTEM,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      // The model has no clock — give it one, or it dates undated claims ("tonight",
      // "this week") to its training-prior year and every inferred close lands in
      // the past. All relative deadlines are computed from this.
      messages: [{ role: "user", content: `Current date and time (UTC): ${new Date().toISOString()}\n\nArgument to convert:\n\n${text}` }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`extract ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`);
  }
  const body = (await res.json()) as { content?: { type: string; text?: string }[] };
  // With output_config the text block is guaranteed valid JSON; still find it by
  // type (a thinking block precedes it) and fall back to a brace-scan defensively.
  const raw = body.content?.find((b) => b.type === "text")?.text ?? "";
  const json = raw.trim().startsWith("{") ? raw : raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error("extract returned no JSON");
  const v = JSON.parse(json) as Record<string, unknown>;
  return normalize(v);
}

/** Trust the schema, but never let a malformed field become a live market: clamp
 *  every value into the contract, and force the unresolvable INVARIANT (empty
 *  question/criteria) so a "refuse" can never leak a half-built market. */
function normalize(v: Record<string, unknown>): Extraction {
  const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");
  const category = (EXTRACT_CATEGORIES as readonly string[]).includes(String(v.category))
    ? (v.category as ExtractCategory)
    : "Culture"; // safest generic bucket if the model returned something off-list
  let resolvability: Resolvability =
    v.resolvability === "clean" || v.resolvability === "fuzzy" || v.resolvability === "unresolvable"
      ? v.resolvability
      : "unresolvable"; // unknown grade fails closed

  let question = str(v.question).slice(0, 180); // 180 = the on-chain question limit
  let resolution_criteria = str(v.resolution_criteria).slice(0, 600);
  const close_time = typeof v.close_time === "string" && v.close_time.trim() ? v.close_time.trim() : null;

  // Appropriateness gate: separate from resolvability, either one blocks. Fail
  // closed on a non-true value.
  const appropriate = v.appropriate === true;

  // Invariant: a resolvable grade needs a question, and a refusal carries none.
  if (resolvability !== "unresolvable" && !question) resolvability = "unresolvable";
  // Blocked when unresolvable OR inappropriate → carry no half-built market.
  const blocked = resolvability === "unresolvable" || !appropriate;
  if (blocked) {
    question = "";
    resolution_criteria = "";
  }

  // The reason a bettor sees: the appropriateness reason takes precedence when the
  // block is on subject grounds, else the resolvability reason.
  const reason = !appropriate
    ? (str(v.appropriate_reason) || "this subject isn’t appropriate for a market")
    : (str(v.reason).slice(0, 240) || "no reason given");

  // The teaser rides only on a live market; a blocked claim carries nothing.
  const hook = blocked ? "" : str(v.hook).slice(0, 40);

  return {
    question,
    resolution_criteria,
    close_time,
    close_time_inferred: Boolean(v.close_time_inferred),
    category,
    resolvability,
    appropriate,
    reason,
    hook,
  };
}

type ExtractFn = typeof extractClaim;
let extractImpl: ExtractFn = extractClaim;
/** Test seam: swap the network call, keep the normalize/invariant path honest. */
export function _setExtract(fn: ExtractFn | null): void {
  extractImpl = fn ?? extractClaim;
}
export const runExtract: ExtractFn = (text) => extractImpl(text);
