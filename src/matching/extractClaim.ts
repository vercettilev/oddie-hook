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

const MODEL = "claude-opus-4-8";
const API_KEY_ENV = "ANTHROPIC_API_KEY";
const TIMEOUT_MS = 45_000; // interactive admin paste; opus + thinking is slow but not latency-critical

export const extractEnabled = (): boolean => Boolean(process.env[API_KEY_ENV]);
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
  /** One line: why this grade — the human-readable gate explanation. */
  reason: string;
}

const SYSTEM = `You convert an argument (a tweet, or a few tweets of a disagreement) into a clean, resolvable YES/NO prediction market — or you refuse. You are the quality gate for a real-money-style betting product: a market that resolves wrong poisons the accuracy record, which is the whole moat. So your bias is PRECISION OVER RECALL. When unsure, grade DOWN.

Return ONLY the structured object. Fields:

- question: a neutral, unambiguous YES/NO question derived from the EXACT claim in dispute — the specific falsifiable assertion, not a vibe paraphrase. Name the concrete subject, threshold, and (if the text implies one) the timeframe. A reader who never saw the tweet must be able to answer it. Leave "" when unresolvable.
- resolution_criteria: 1–3 sentences stating exactly what evidence settles YES vs NO, and the specific source to check (e.g. "the final score on the Premier League site", "the official announcement on the @company X account", "the BTC/USD close on Coinbase"). Name a source a stranger could go verify. Leave "" when unresolvable.
- close_time: the claim's natural deadline in ISO 8601 (e.g. "2026-08-01T23:59:00Z"). If the text states or clearly implies a deadline, use it. If not, pick a sensible one and set close_time_inferred true. Use null only when no timeframe is possible at all (which usually also means unresolvable).
- close_time_inferred: true if you chose the deadline rather than reading it from the text.
- category: one of Crypto, Sports, Politics, Culture, Tech — the single best fit. There is no "Other". If nothing fits, that is itself a sign the claim may not be a clean market.
- resolvability: one of clean | fuzzy | unresolvable.
    - clean: a specific, verifiable outcome with a bounded timeframe and a nameable public source. Only clean markets are eligible for auto-publish, so hold this bar HIGH.
    - fuzzy: a real prediction, but the wording, threshold, timeframe, or source needs a human to tighten before it is safe. Produce the market, but flagged.
    - unresolvable: subjective taste ("X is the GOAT", "this album is better"), no verifiable outcome, no bounded timeframe, or a private matter no public source can settle. REFUSE — leave question and resolution_criteria empty.
- reason: one short sentence explaining the grade in plain language (this is shown to the operator, and to a bettor as the refusal explanation).

Rules, in order:
1. ERR TOWARD fuzzy/unresolvable when unsure. A market we never made costs nothing; a market we resolve wrong is unrecoverable.
2. A claim of pure taste, opinion, or aesthetics is unresolvable no matter how strongly stated. "Best", "overrated", "mid", "GOAT", "should", "deserves" with no measurable proxy → unresolvable.
3. No bounded timeframe and none can be reasonably inferred → unresolvable.
4. Private/unverifiable matters (someone's private relationship, undisclosed internal numbers, unfalsifiable claims about intent) → unresolvable.
5. The question must be about the SAME event, threshold, person and date the argument is actually about — never a related-but-different one.`;

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
    reason: { type: "string" },
  },
  required: [
    "question",
    "resolution_criteria",
    "close_time",
    "close_time_inferred",
    "category",
    "resolvability",
    "reason",
  ],
} as const;

/** One round trip to the engine. Throws on anything unusable — no key, timeout,
 *  malformed reply — so the caller can report a single clean "unavailable". */
export async function extractClaim(text: string): Promise<Extraction> {
  if (!extractEnabled()) throw new Error(`extraction unavailable — set ${API_KEY_ENV}`);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env[API_KEY_ENV]!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2500,
      thinking: { type: "adaptive" },
      system: SYSTEM,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: `Argument to convert:\n\n${text}` }],
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
  let close_time = typeof v.close_time === "string" && v.close_time.trim() ? v.close_time.trim() : null;

  // Invariant: a resolvable grade needs a question, and a refusal carries none.
  if (resolvability !== "unresolvable" && !question) resolvability = "unresolvable";
  if (resolvability === "unresolvable") {
    question = "";
    resolution_criteria = "";
  }

  return {
    question,
    resolution_criteria,
    close_time,
    close_time_inferred: Boolean(v.close_time_inferred),
    category,
    resolvability,
    reason: str(v.reason).slice(0, 240) || "no reason given",
  };
}

type ExtractFn = typeof extractClaim;
let extractImpl: ExtractFn = extractClaim;
/** Test seam: swap the network call, keep the normalize/invariant path honest. */
export function _setExtract(fn: ExtractFn | null): void {
  extractImpl = fn ?? extractClaim;
}
export const runExtract: ExtractFn = (text) => extractImpl(text);
