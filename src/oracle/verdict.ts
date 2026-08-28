// The proposer: read a settled-by-now market, go and look, come back with a
// side and the words that justify it.
//
// This is judgment, and it is treated as judgment everywhere downstream. It
// proposes; audit.ts checks whether its citations exist; oracle.ts decides
// whether anything happens. Nothing here settles a market and nothing here is
// believed on its own.
//
// WHY IT SEARCHES INSTEAD OF ANSWERING. A model asked "did Arsenal win on
// Saturday" answers from a training prior, fluently, about a Saturday in a
// different year. Every market this thing touches closed after the model was
// built, so the prior is not merely unhelpful, it is confidently wrong. The
// verdict must rest on what was found NOW, which is why the tool is mandatory
// and why the quote requirement is character-for-character: a quote it did not
// copy is a quote audit.ts will not find.
//
// WHY IT REQUIRES ANTHROPIC'S HOST. Web search is a SERVER-side tool: it runs
// at Anthropic and comes back inside the same response. Point INFERENCE_BASE_URL
// at an OpenAI-shaped marketplace and the tool is simply not there — the model
// would answer from its prior and the whole discipline above quietly evaporates
// while every log line still looks healthy. So the oracle refuses to run at all
// rather than run blind. This is the one place in the codebase where the
// inference seam is deliberately not honoured, and that is the reason.

import { messagesUrl, authHeaders, inferenceProvider, API_KEY_ENV, MODEL } from "../inference.js";
import type { Citation } from "./audit.js";

const TIMEOUT_MS = 180_000; // searching is slow and this runs on a schedule, not in a request
const MAX_ROUNDS = 5; // pause_turn and a deferred search each cost a round; a loop that will not finish is an abstain

export type Side = "yes" | "no" | "undetermined";
export type Confidence = "low" | "medium" | "high";

export interface Proposal {
  outcome: Side;
  confidence: Confidence;
  /** The proposer's own read on whether the criteria are checkable AT ALL. Kept
   *  separate from the outcome: "I could not check this" and "I checked and the
   *  answer is no" are different answers that a single field would merge. */
  checkable: boolean;
  citations: Citation[];
  reasoning: string;
}

/** Available only against Anthropic, and only with a key. See the header. */
export function oracleAvailable(): { ok: boolean; why: string } {
  const p = inferenceProvider();
  if (!p.anthropic) {
    return { ok: false, why: `the oracle needs Anthropic's web search; INFERENCE_BASE_URL points at ${p.host}` };
  }
  try { authHeaders(); } catch { return { ok: false, why: `no key: set ${API_KEY_ENV}` }; }
  return { ok: true, why: `${p.model} with web search` };
}

const VERDICT_TOOL = {
  name: "record_verdict",
  description: "Record the final verdict. Call this exactly once, after searching, as the last thing you do.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      outcome: {
        type: "string",
        enum: ["yes", "no", "undetermined"],
        description: "undetermined whenever the evidence is missing, conflicting, or does not actually address the criteria",
      },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      checkable: {
        type: "boolean",
        description: "false when the resolution criteria are too vague, subjective, or sourceless to check at all, regardless of what you found",
      },
      citations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            url: { type: "string", description: "the exact page you are quoting" },
            quote: {
              type: "string",
              description: "a SHORT span copied CHARACTER-FOR-CHARACTER from that page's visible text, 5 to 25 words",
            },
          },
          required: ["url", "quote"],
        },
      },
      reasoning: { type: "string", description: "two or three sentences: what you looked for, what you found, how it meets the criteria" },
    },
    required: ["outcome", "confidence", "checkable", "citations", "reasoning"],
  },
} as const;

const SYSTEM = `You settle prediction markets by finding evidence. Real money pays out on your answer, so being unsure and saying so is a correct, valued outcome; being confidently wrong is the only unrecoverable one.

Procedure, in order:
1. Read the resolution criteria. They name what evidence settles YES vs NO and the source to check. That named source is where you look first.
2. Search for it. You know nothing about what happened after your training data ends, and every market you see closed after that, so ANY answer you produce from memory is wrong by construction. Search, and only then answer.
3. Quote what you found. Every citation must contain a SHORT span (5 to 25 words) copied character-for-character out of the page's visible text, and the URL must be the page that span is on. Do not paraphrase inside a quote, do not clean it up, do not stitch two sentences together. Your quotes are re-fetched and checked against the live page by code afterwards; a quote that is not found there discards the whole verdict.
4. Decide.

Rules:
- outcome "undetermined" is the right answer whenever the sources disagree, the evidence does not actually address the criteria, or you could not find the named source. Reach for it freely.
- Answer the criteria as WRITTEN, including its threshold, date and source. Not a related question, not the spirit of it.
- A YES needs evidence that the thing happened. A NO needs evidence that it did not, published AFTER the deadline — a page written before the deadline cannot tell you a deadline was missed. If all you have is that you found no report of the event, that is "undetermined", not "no".
- checkable false means the criteria themselves cannot be checked by anyone: subjective wording, no threshold, no nameable source. That is a judgment about the QUESTION, and you make it whether or not you happened to find something.
- A page showing a CURRENT value tells you nothing about what that value was at an earlier moment. A live price ticker, a league table today, a follower count now: quoting one of those to settle a question about a past date is not evidence, and the right answer there is "undetermined" unless you find a source that states the value AS OF the date the criteria name.
- Never cite a page you did not open through search. Never construct a URL.`;

interface Block { type: string; id?: string; name?: string; input?: unknown; text?: string; tool_use_id?: string; content?: unknown }

/**
 * Server tools this response CALLED but whose result it does not carry.
 *
 * This is the shape of a DEFERRED search, and it is the one response the API
 * documents as having no marker of its own: "detect it by finding a
 * server_tool_use id with no matching result block. There is no other marker."
 * It happens when the model asks for a search and calls our tool in the same
 * parallel group, and it matters enormously here, because the verdict in that
 * response was written BEFORE the search ran. Pair by id, never by position.
 */
function deferredServerTools(blocks: Block[]): string[] {
  const answered = new Set(
    blocks.filter((b) => b.type.endsWith("_tool_result") && b.tool_use_id).map((b) => b.tool_use_id as string),
  );
  return blocks.filter((b) => b.type === "server_tool_use" && b.id && !answered.has(b.id)).map((b) => b.id as string);
}

/** How many search RESULTS a response actually carried. A search that errors
 *  returns a single object where the list would be, and a search that matched
 *  nothing returns an empty list. Both are zero results and both count as such,
 *  which is the point: neither one fed the verdict anything. */
function searchResultsIn(blocks: Block[]): number {
  let n = 0;
  for (const b of blocks) if (b.type === "web_search_tool_result" && Array.isArray(b.content)) n += b.content.length;
  return n;
}

/** Search failures, by the API's own error_code. These arrive inside a 200, not
 *  as a thrown status, so nothing else in the stack would notice them. */
function searchErrorsIn(blocks: Block[]): string[] {
  return blocks
    .filter((b) => b.type === "web_search_tool_result" && b.content !== undefined && !Array.isArray(b.content))
    .map((b) => String((b.content as { error_code?: string }).error_code ?? "unknown"));
}

/**
 * A verdict that no search result ever fed is a verdict from the model's prior.
 *
 * Here that is not merely weak, it is wrong by construction: every market this
 * touches closed after the model was built, so its memory of the outcome is a
 * memory of a different year. The system prompt says so, and a prompt is a
 * request. This is the check.
 *
 * The citations are kept rather than cleared, because a verdict with confident
 * citations and no searches behind them is the most useful thing an operator
 * could be shown about what went wrong.
 */
function grounded(p: Proposal, results: number, errors: string[]): Proposal {
  if (p.outcome === "undetermined" || results > 0) return p;
  const why = errors.length
    ? `every search failed (${[...new Set(errors)].join(", ")})`
    : "no search returned anything";
  return { ...p, outcome: "undetermined", confidence: "low", reasoning: `${why}, so this verdict rested on nothing` };
}

/**
 * One proposal for one market. Throws only on a broken request; a model that
 * declines to conclude comes back as an honest undetermined.
 */
export async function proposeVerdict(m: {
  question: string;
  criteria: string;
  closeTime: string | null;
}): Promise<Proposal> {
  const avail = availability();
  if (!avail.ok) throw new Error(avail.why);

  const closed = m.closeTime ? `The market closed at ${m.closeTime} (UTC).` : "The market has no stated close time.";
  const messages: Array<{ role: string; content: unknown }> = [
    {
      role: "user",
      content: `Current date and time (UTC): ${new Date().toISOString()}
${closed}

QUESTION
${m.question}

RESOLUTION CRITERIA
${m.criteria}

Search for the evidence, then call record_verdict exactly once.`,
    },
  ];

  let assistantBlocks: Block[] = [];
  let results = 0;
  const errors: string[] = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await fetch(messagesUrl(), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        thinking: { type: "adaptive" },
        system: SYSTEM,
        // allowed_callers "direct" is deliberate and not a default. Left off,
        // _20260209 routes the search THROUGH code execution (dynamic
        // filtering), which drags three things into a request that settles
        // money: the response grows code-execution blocks whose exact shape the
        // docs never show end to end, the request stops being ZDR-eligible, and
        // it lands next to the one documented rule that could reject us
        // outright ("tools with strict: true are not supported with
        // programmatic calling"). We want a plain search. Asking for one
        // removes all three at once.
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8, allowed_callers: ["direct"] }, VERDICT_TOOL],
        messages,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`verdict ${res.status}${detail ? ` ${detail.slice(0, 300)}` : ""}`);
    }
    const body = (await res.json()) as { content?: Block[]; stop_reason?: string };
    assistantBlocks = body.content ?? [];
    results += searchResultsIn(assistantBlocks);
    errors.push(...searchErrorsIn(assistantBlocks));

    const call = assistantBlocks.find((b) => b.type === "tool_use" && b.name === "record_verdict");
    const deferred = deferredServerTools(assistantBlocks);

    if (call && deferred.length === 0) return grounded(normalize(call.input as Record<string, unknown>), results, errors);

    if (call && deferred.length > 0) {
      // The verdict and the search request left in the same breath, so the
      // search had not run when the verdict was written. Taking it would be
      // taking an answer from memory while the whole file is arranged to
      // prevent exactly that, and it would look identical to a good one.
      //
      // The reply must contain ONLY tool_result blocks: a trailing text block
      // is a documented 400. The same tools go back too, or the deferred search
      // has nothing to run against.
      messages.push({ role: "assistant", content: assistantBlocks });
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: call.id,
          content: "Not recorded. You called this in the same turn as your search, so it was written before any results existed. The search results follow. Read them, then call record_verdict again.",
        }],
      });
      continue;
    }

    // pause_turn means the server-side loop is mid-flight: hand the partial turn
    // straight back, unmodified, and let it continue. Unmodified matters:
    // encrypted_content on every search result and the signature on every
    // thinking block are validated on the way back in.
    if (body.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: assistantBlocks });
  }

  // It searched and never concluded. That is an abstention, not an error: the
  // pipeline treats it exactly like an explicit undetermined, which is what it is.
  const said = assistantBlocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ").trim();
  return {
    outcome: "undetermined",
    confidence: "low",
    checkable: true,
    citations: [],
    reasoning: said.slice(0, 400) || "the proposer finished without recording a verdict",
  };
}

/** Clamp the tool payload into the contract. `strict: true` already guarantees
 *  the shape; this guarantees the MEANING — an unknown side is not a coin flip,
 *  it is an abstention. */
function normalize(v: Record<string, unknown>): Proposal {
  const outcome: Side = v.outcome === "yes" || v.outcome === "no" ? v.outcome : "undetermined";
  const confidence: Confidence = v.confidence === "high" || v.confidence === "medium" ? v.confidence : "low";
  const raw = Array.isArray(v.citations) ? v.citations : [];
  const citations: Citation[] = raw
    .map((c) => c as Record<string, unknown>)
    .filter((c) => typeof c?.url === "string" && typeof c?.quote === "string")
    .map((c) => ({ url: String(c.url).trim(), quote: String(c.quote).trim() }))
    .filter((c) => c.url && c.quote)
    .slice(0, 8);
  return {
    outcome,
    confidence,
    checkable: v.checkable !== false, // unknown means we do not get to blame the question
    citations,
    reasoning: typeof v.reasoning === "string" ? v.reasoning.trim().slice(0, 800) : "",
  };
}

/** Test seam for the host guard ONLY. The guard above is real and is the thing
 *  standing between the oracle and a host with no web search; this exists so the
 *  transport underneath it can be exercised against a local server, which is the
 *  only way to test the request shape, the pause_turn loop and the parsing
 *  without an API key. Same pattern as the other seams in this codebase, and
 *  like them it is called from tests and nowhere else. */
let availability: () => { ok: boolean; why: string } = oracleAvailable;
export function _setAvailability(fn: (() => { ok: boolean; why: string }) | null): void {
  availability = fn ?? oracleAvailable;
}

type ProposeFn = typeof proposeVerdict;
let proposeImpl: ProposeFn = proposeVerdict;
/** Test seam: exercise the pipeline's rules without the network deciding them. */
export function _setProposer(fn: ProposeFn | null): void {
  proposeImpl = fn ?? proposeVerdict;
}
export const runPropose: ProposeFn = (m) => proposeImpl(m);
