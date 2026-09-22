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
import type { PriceClaim } from "../price/index.js";
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
  /** Set when the claim is about a token's price or market cap. The model says
   *  WHAT was claimed; it is never asked which token that ticker is, because a
   *  hallucinated mint is a plausible string that moves money to the wrong
   *  answer. Identity is resolved from live liquidity in src/price. */
  price_claim: PriceClaim | null;
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

- question: a neutral, unambiguous YES/NO question derived from the EXACT claim in dispute — the specific falsifiable assertion, not a vibe paraphrase. Name the concrete subject, threshold, and (if the text implies one) the timeframe. A reader who never saw the tweet must be able to answer it. Leave "" when unresolvable. TWO THINGS A QUESTION MUST NOT DO, both observed in production. Do not name a token by its CONTRACT OR MINT ADDRESS when a ticker exists: write "$ORE", never "the Solana token at mint address oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp", which is unreadable and tells a bettor nothing. And never leave a number without its UNIT: "reach 90" is unanswerable -- 90 dollars, 90 cents, a 90m market cap? Write the unit every time, e.g. "a $90m market cap" or "$0.90".
- resolution_criteria: 1–3 sentences stating exactly what evidence settles YES vs NO, and the specific source to check (e.g. "the final score on the Premier League site", "the official announcement on the @company X account", "the BTC/USD close on CoinMarketCap"). Name a source a stranger could go verify, and prefer one whose page can simply be opened and read: a public article, an official results page, a documentation page, a plain API endpoint. Sites that refuse automated readers (Reuters, Coinbase, DexScreener, Binance, CoinGecko's web pages) cannot be checked later, however respectable they are. Leave "" when unresolvable.
- price_claim: fill this ONLY when the claim is about the PRICE or MARKET CAP of a token named by its ticker (e.g. "$BULLSHIT hits 4m this month", "$WIF stays under a dollar all week", "$BONK does 2x by Friday"). Otherwise return null. Give: symbol (the ticker WITHOUT the $), metric ("mc" for market cap, "price" for unit price), op (">=", ">", "<=", "<"), target (the number in PLAIN USD — "4m" is 4000000, "50 cents" is 0.5), and mode ("touch" if reaching the level at ANY moment counts, which is what "hits"/"does"/"gets to" mean; "at-close" if only the value on the deadline counts, which is what "will be above X on <date>" means; "always" if the claim is that it holds the whole time, which is what "stays under"/"holds above" mean). NEVER guess a contract or mint address — you are not asked for one and must not invent one. ALWAYS write resolution_criteria as you normally would, even when you fill price_claim. If the ticker turns out to name a token we can price on-chain, your criteria are replaced by ones written from that token; if it does not — a major asset like BTC or ETH, a stock, a ticker shared by several coins — yours are the only rule the market has, and without them there is no market at all. Write the question and the close_time as normal too.
- close_time: the claim's natural deadline in ISO 8601 (e.g. "2026-08-01T23:59:00Z"), computed RELATIVE TO the current date/time given in the user message. It must be in the FUTURE — never output a past date, and get the YEAR right by anchoring to the current date provided ("tonight" = later today, "this week" = within 7 days of now, etc.). If the text states or clearly implies a deadline, use it. If not, BIAS TOWARD THE SHORTEST REASONABLE WINDOW the claim supports, and set close_time_inferred true — a market that resolves soon brings the person back for the result; one that resolves in months kills the loop. Concretely: hours to a few days for anything time-sensitive (a game, a launch, a price move, "today/this week"); a week or two only when the claim genuinely needs it; do NOT infer months. Reserve far-out deadlines for claims that explicitly carry one ("by end of year", "in 2027", "before the election"). When unsure between a shorter and a longer window, choose the shorter. Use null only when no timeframe is possible at all (which usually also means unresolvable). NEVER output a close_time earlier than the current date/time in the user message: relative words take their meaning from THAT date and not from your own sense of the present, so if the user message says 2026-09-12 then "this year" ends 2026-12-31, "by year end" is 2026-12-31 and "next year" is 2027. Before you answer, compare the year you wrote against the year in the user message; if it is smaller, you got it wrong.
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
- hook: a VERY short, punchy teaser for the tweet reply. Max ~28 characters. IT MUST NAME THE SUBJECT. A hook that drops it is worthless however punchy it sounds: "Hits 90 this week?" shipped to production and the only thing a reader could ask was WHAT hits 90. If the claim is about a token, the ticker IS the subject and goes first. Good: "$ORE to $1m?", "PSG or not?", "BTC to 100k by Friday?". Bad, because no subject: "Hits 90 this week?", "Will it double?", "Over or under?". Never put a contract or mint address in a hook -- it is 32+ characters of noise and it is not what anybody calls the thing.

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
    price_claim: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        symbol: { type: "string" },
        metric: { type: "string", enum: ["mc", "price"] },
        op: { type: "string", enum: [">=", ">", "<=", "<"] },
        target: { type: "number" },
        mode: { type: "string", enum: ["touch", "at-close", "always"] },
      },
      required: ["symbol", "metric", "op", "target", "mode"],
    },
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
    "price_claim",
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
/* THE MODEL HAS A YEAR OF ITS OWN, AND IT IS NOT THIS ONE.
   Measured against the live prompt: "I don't think it will hit 100k this year",
   asked on 2026-09-12 with that date in the message, came back three times out
   of three with close_time 2025-12-31 — the training-prior year, not the one it
   was handed. The route refuses a past deadline (server.ts: "close_time must be
   in the future") and the chain refuses it again, so the tag dies after three
   retries with nothing on screen to explain it.
   The rule now in the system prompt fixed all eight measured cases, but a
   prompt is a request and this is a correctness question, so the answer is
   checked. One corrective turn, quoting the model its own date: it keeps
   ownership of the deadline and we do no guessing. */
async function callEngine(messages: unknown[]): Promise<Record<string, unknown>> {
  const res = await fetch(messagesUrl(), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2500,
      thinking: { type: "adaptive" },
      // The system prompt is ~1.5k tokens and identical on every call, which is
      // exactly what the cache is for: mentions arrive in bursts under a hot
      // take, and consecutive extractions inside the window read it at about a
      // tenth of the price. Nothing before it varies, so the prefix is stable.
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      // The model has no clock — give it one, or it dates undated claims ("tonight",
      // "this week") to its training-prior year and every inferred close lands in
      // the past. All relative deadlines are computed from this.
      messages,
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
  return JSON.parse(json) as Record<string, unknown>;
}

const inThePast = (v: Record<string, unknown>): boolean => {
  const t = typeof v.close_time === "string" ? Date.parse(v.close_time) : NaN;
  return Number.isFinite(t) && t <= Date.now();
};

export async function extractClaim(text: string): Promise<Extraction> {
  if (!extractEnabled()) throw new Error(`extraction unavailable — set ${API_KEY_ENV}`);
  const now = new Date();
  const first = [{
    role: "user",
    content: `Current date and time (UTC): ${now.toISOString()}\n\nArgument to convert:\n\n${text}`,
  }];
  let v = await callEngine(first);
  if (inThePast(v)) {
    const said = String(v.close_time);
    const second = await callEngine([
      ...first,
      { role: "assistant", content: JSON.stringify(v) },
      {
        role: "user",
        content: `close_time ${said} is in the PAST. The current date is ${now.toISOString()}, so the current year is `
          + `${now.getUTCFullYear()}. Recompute the deadline relative to that date so it falls in the future, keep every `
          + `other field as you judged it, and return the object again.`,
      },
    ]);
    // Only if the retry actually repaired it. A second past date means we could
    // not pin a future deadline, and rule 3 already calls that unresolvable.
    v = inThePast(second) ? { ...second, close_time: null, resolvability: "unresolvable",
      reason: "we could not pin a deadline in the future for this one" } : second;
  }
  return normalize(v);
}

/** Trust the schema, but never let a malformed field become a live market: clamp
 *  every value into the contract, and force the unresolvable INVARIANT (empty
 *  question/criteria) so a "refuse" can never leak a half-built market. */

/* ------------------------------------------------------------ THE BACKSTOPS
 * SYSTEM above already forbids both of these in words. Words are a request to
 * a model; these are checks. Measured 2026-09-20, from one real tweet.
 *
 * @troxqt posted "Don't think $ORE will hit 90 by the end of this week". The
 * model graded it publishable and then wrote, as the market's ONLY rule:
 * "...either $90 unit price or 90M market cap... Ambiguity over whether '90'
 * means unit price or market cap must be clarified before this can settle."
 * It opened with a seven-day clock and real money invited under a stranger's
 * tweet. The refusal instruction and the criteria it wrote never met, because
 * nothing in this file or downstream ever reads what the criteria SAY.
 *
 * The same answer also carried a 44-character mint address in the QUESTION,
 * which SYSTEM forbids outright ("NEVER guess a contract or mint address").
 * The question is the market's identity: it is the card in a stranger's
 * timeline and the headline on the page. An address there is not a market.
 */

/** The shape of a rule that postpones its own decision. Sentence shapes, not
 *  words: "ambiguous" alone is legitimate ("resolves NO if the announcement is
 *  ambiguous"). What is never legitimate is a rule whose own text says the
 *  rule is not finished. */
const UNSETTLEABLE: RegExp[] = [
  /\b(must|needs?\s+to|has\s+to|would\s+need\s+to|should)\s+(first\s+)?be\s+(clarified|confirmed|decided|determined|resolved|agreed|specified|established)\b/i,
  /\bbefore\s+(this|it|that|the\s+\w+)\s+can\s+(be\s+)?(settle|settled|resolve|resolved)\b/i,
  /\b(cannot|can'?t|could\s+not|couldn'?t|unable\s+to|no\s+way\s+to)\s+(be\s+)?(settle|settled|resolve|resolved|determine|determined|verif(?:y|ied))\b/i,
  /\b(manual|human|operator|admin(?:istrator)?)\s+(review|judg(?:e)?ment|decision|interpretation|discretion|input)\b/i,
  /\b(to\s+be\s+(determined|decided|confirmed|clarified)|TBD)\b/i,
  /\b(poster|author|tweeter|claimant)('s)?\s+(intended|intent|meant|meaning)\b/i,
  /\beither\b[^.]{0,80}\b(unit\s+price|price)\b[^.]{0,80}\bor\b[^.]{0,80}\b(market\s*cap|mcap|fdv)\b/i,
  /\beither\b[^.]{0,80}\b(market\s*cap|mcap|fdv)\b[^.]{0,80}\bor\b[^.]{0,80}\b(unit\s+price|price)\b/i,
];

/** The rule that says it is not a rule. Exported so extraction and market
 *  creation share one definition and cannot drift apart. */
export function unsettleablePhrase(text: string): string | null {
  for (const re of UNSETTLEABLE) {
    const m = text.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

/* Base58 as Solana writes it: no 0, O, I or l. An address is 32-44 of them,
 * and no English word is. Checked against the QUESTION only — criteria are
 * exactly where an address belongs, and criteriaSentence() puts one there. */
const ADDRESS_IN_TEXT = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

/** An address where the market's name should be. */
export function addressInQuestion(question: string): string | null {
  const m = question.match(ADDRESS_IN_TEXT);
  return m ? m[0] : null;
}

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
  const price_claim = parsePriceClaim(v.price_claim);

  // Appropriateness gate: separate from resolvability, either one blocks. Fail
  // closed on a non-true value.
  const appropriate = v.appropriate === true;

  // Invariant: a resolvable grade needs a question, and a refusal carries none.
  if (resolvability !== "unresolvable" && !question) resolvability = "unresolvable";
  // BACKSTOP 1. A rule that postpones its own decision is not a rule, whatever
  // grade the model put beside it. Checked on the criteria AND the question,
  // because the hedge lands in whichever the model was writing at the time.
  const hedge = unsettleablePhrase(resolution_criteria) ?? unsettleablePhrase(question);
  // BACKSTOP 2. An address is an identifier, not a name. It belongs in the
  // criteria, where a machine reads it, never in the line a person reads.
  const address = addressInQuestion(question);
  if (hedge || address) resolvability = "unresolvable";
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
    : hedge
      ? `the rule it wrote cannot settle itself (“${hedge}”)`
      : address
        ? "the question came out as an address instead of a name"
        : (str(v.reason).slice(0, 240) || "no reason given");

  // The teaser rides only on a live market; a blocked claim carries nothing.
  const hook = blocked ? "" : str(v.hook).slice(0, 40);

  return {
    question,
    resolution_criteria,
    price_claim: blocked ? null : price_claim,
    close_time,
    close_time_inferred: Boolean(v.close_time_inferred),
    category,
    resolvability,
    appropriate,
    reason,
    hook,
  };
}

/**
 * A price claim, or nothing. Every field is re-checked here rather than trusted
 * from the schema: structured output guarantees the SHAPE, not that the numbers
 * mean anything, and this one decides which token a market settles against.
 *
 * The ticker is deliberately narrow. A symbol with punctuation or spaces in it
 * is not a ticker, it is the model having improvised, and the safe answer to
 * that is no price market rather than a lookup on a made-up string.
 */
function parsePriceClaim(raw: unknown): PriceClaim | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const symbol = String(v.symbol ?? "").replace(/^\$/, "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,16}$/.test(symbol)) return null;
  const metric = v.metric === "price" ? "price" : v.metric === "mc" ? "mc" : null;
  if (!metric) return null;
  const op = v.op === ">=" || v.op === ">" || v.op === "<=" || v.op === "<" ? v.op : null;
  if (!op) return null;
  const target = typeof v.target === "number" ? v.target : Number(v.target);
  if (!Number.isFinite(target) || target <= 0) return null;
  const mode = v.mode === "touch" || v.mode === "at-close" || v.mode === "always" ? v.mode : null;
  if (!mode) return null;
  return { symbol, metric, op, target, mode };
}

type ExtractFn = typeof extractClaim;
let extractImpl: ExtractFn = extractClaim;
/** Test seam: swap the network call, keep the normalize/invariant path honest. */
export function _setExtract(fn: ExtractFn | null): void {
  extractImpl = fn ?? extractClaim;
}
export const runExtract: ExtractFn = (text) => extractImpl(text);
