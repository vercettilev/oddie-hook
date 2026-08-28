// The pipeline. A market goes in; a side comes out, or nobody does.
//
// Every gate below is a separate reason to REFUSE, and they are all ANDed. That
// arrangement is the design, not caution for its own sake: a market that
// abstains costs a person a few minutes; a market settled wrong costs somebody
// their stake and costs oddie the accuracy record, which is the only thing here
// that cannot be rebought.
//
// THE ORDER MATTERS AND IT IS CHEAPEST-FIRST. The two code gates run before a
// token is spent, because a market with no criteria and a market that has not
// closed yet are facts, not judgments, and no amount of searching changes them.
//
// WHY IT DOES NOT TRUST community_market.resolvability. That column looks like
// exactly the gate this file wants, and using it would be wrong. It is an INPUT:
// /api/v1/markets lets a caller post a market without ever sending it (which is
// why it is NULL on every production row today), and /api/community/create
// writes through whatever the caller did send. A field an outside caller can
// set to "clean" is not an admissibility check, it is a suggestion. So the
// oracle re-derives admissibility here, at resolve time, from the criteria
// themselves and from a judgment it makes itself.
//
// WHAT CONFIDENCE IS FOR. Low confidence stops a settlement. High confidence
// never causes one. A model's estimate of its own reliability is worth
// something as a veto and nothing as a licence, so it is wired in one
// direction only.

import { auditCitations, auditSupports, type AuditResult } from "./audit.js";
import { runPropose, type Proposal, type Side } from "./verdict.js";
import { messagesUrl, authHeaders, MODEL } from "../inference.js";

const VERIFY_TIMEOUT_MS = 60_000;

/** What a blind second read came back with. `outcome: null` means we never got
 *  one, which is a different fact from a read that disagreed. */
export interface SecondRead {
  outcome: Side | null;
  why: string;
}
/** Shorter than this and there is nothing to check against. The empty-criteria
 *  case is real: markets opened through the agent API often carry none. */
const MIN_CRITERIA_CHARS = 25;

export interface OracleInput {
  slug: string;
  question: string;
  criteria: string | null;
  closeTime: string | null;
}

export interface OracleDecision {
  slug: string;
  /** The side to settle on, or null for "a person needs to look at this". */
  settle: "yes" | "no" | null;
  /** Plain language, written to be read by whoever picks this up. */
  reason: string;
  /** Which gate stopped it, for counting patterns across many markets. */
  gate:
    | "settled"
    | "no-criteria"
    | "not-closed"
    | "proposer-abstained"
    | "not-checkable"
    | "low-confidence"
    | "citations-failed"
    | "evidence-not-audited"
    | "second-opinion-unavailable"
    | "second-opinion-disagreed"
    | "error";
  proposal?: Proposal;
  audit?: AuditResult;
  secondOpinion?: Side | null;
}

const VERIFY_SYSTEM = `You are given a prediction market's question, its resolution criteria, and a set of quotations that have already been fetched and confirmed to appear on the pages they are attributed to.

Decide the outcome from those quotations ALONE. Do not use anything you remember about the subject: your training data predates this market's close, so your memory of it is not evidence. If the quotations do not settle the criteria as written, answer "undetermined" — that is a normal answer and it is often the right one.

A quotation dated before the market closed can show an event happened early. It can never show that an event failed to happen by a deadline that had not yet passed.

A quotation showing a CURRENT value never establishes what that value was at an earlier moment. A live price, a table as it stands today, a count as of now: if the criteria ask about a specific past date and the quotation only shows the present, that is "undetermined".`;

const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: { type: "string", enum: ["yes", "no", "undetermined"] },
    reason: { type: "string" },
  },
  required: ["outcome", "reason"],
} as const;

/**
 * A second read of the same evidence, by a model that has NOT been told what the
 * first one concluded.
 *
 * The blindness is the entire value. Show it the first verdict and it reviews a
 * sentence instead of the evidence, agrees at a rate that has nothing to do with
 * whether the evidence is any good, and the pipeline gains a step that only
 * looks like a check. So it receives the audited quotes and nothing else: no
 * outcome, no confidence, no reasoning.
 */
export async function secondOpinion(
  m: { question: string; criteria: string; closeTime: string | null },
  evidence: Array<{ url: string; quote: string; datedAt: string | null }>,
): Promise<SecondRead> {
  if (evidence.length === 0) return { outcome: "undetermined", why: "there was nothing to read" };
  const lines = evidence
    .map((e, i) => `[${i + 1}] ${e.url}${e.datedAt ? ` (dated ${e.datedAt})` : ""}\n"${e.quote}"`)
    .join("\n\n");

  const res = await fetch(messagesUrl(), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: MODEL,
      // Thinking is billed against this, and a long evidence list plus adaptive
      // thinking used to exhaust it: the response came back with a thinking
      // block and NO text block, which read as the second model disagreeing when
      // it had simply been cut off.
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: VERIFY_SYSTEM,
      output_config: { format: { type: "json_schema", schema: VERIFY_SCHEMA } },
      messages: [
        {
          role: "user",
          content: `QUESTION\n${m.question}\n\nRESOLUTION CRITERIA\n${m.criteria}\n\nMARKET CLOSED\n${m.closeTime ?? "no stated close time"}\n\nCONFIRMED QUOTATIONS\n${lines}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
  });
  // A second read we could NOT OBTAIN is reported as that, never as a second
  // read that disagreed. Both stop the settlement, and collapsing them was a
  // lie the operator could not see through: during a rate limit or an outage
  // every market printed "a blind second read of the same evidence said
  // undetermined", so a whole board of API failures read as a whole board of
  // weak evidence, and a rejected request shape would have said it forever.
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { outcome: null, why: `the second read could not be obtained (${res.status}${detail ? ` ${detail.slice(0, 120)}` : ""})` };
  }
  const body = (await res.json()) as { content?: { type: string; text?: string }[]; stop_reason?: string };
  const raw = body.content?.find((b) => b.type === "text")?.text ?? "";
  const json = raw.trim().startsWith("{") ? raw : raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) {
    return { outcome: null, why: `the second read returned no answer${body.stop_reason ? ` (${body.stop_reason})` : ""}` };
  }
  try {
    const v = JSON.parse(json) as { outcome?: string; reason?: string };
    const outcome: Side = v.outcome === "yes" || v.outcome === "no" ? v.outcome : "undetermined";
    return { outcome, why: typeof v.reason === "string" ? v.reason.slice(0, 300) : "" };
  } catch {
    return { outcome: null, why: "the second read returned unparseable output" };
  }
}

type SecondFn = typeof secondOpinion;
let secondImpl: SecondFn = secondOpinion;
export function _setSecondOpinion(fn: SecondFn | null): void {
  secondImpl = fn ?? secondOpinion;
}

/** Run one market through every gate. Never throws: a thrown error IS an
 *  abstention, and a scheduled run must not die on one bad market. */
export async function decide(m: OracleInput, now = new Date()): Promise<OracleDecision> {
  const base = { slug: m.slug };
  const criteria = (m.criteria ?? "").trim();

  // Code gate 1. Nothing to check against. This is not the model being unsure,
  // it is the market never having been given a rule, and searching cannot
  // invent one.
  if (criteria.length < MIN_CRITERIA_CHARS) {
    return { ...base, settle: null, gate: "no-criteria", reason: "this market carries no resolution criteria to check" };
  }

  // Code gate 2. Settling before the close is settling a question that is still
  // open. The program permits early resolution deliberately (an operator
  // sometimes must), but an unattended oracle is exactly who should not.
  if (m.closeTime && new Date(m.closeTime) > now) {
    return { ...base, settle: null, gate: "not-closed", reason: `still open until ${m.closeTime}` };
  }

  // Whether inference is reachable at all is checked by the proposer itself and
  // reported to the operator by scripts/oracle.ts before the run starts. It was
  // briefly checked HERE too, which quietly made the proposer's test seam
  // decorative: every test that swapped the proposer still stopped at a gate the
  // swap could not reach, so the rules below went unexercised while the suite
  // stayed green. One check, at the boundary it describes.
  let proposal: Proposal;
  try {
    proposal = await runPropose({ question: m.question, criteria, closeTime: m.closeTime });
  } catch (e) {
    return { ...base, settle: null, gate: "error", reason: (e as Error).message };
  }

  if (!proposal.checkable) {
    return { ...base, settle: null, gate: "not-checkable", proposal, reason: `criteria are not checkable: ${proposal.reasoning}` };
  }
  if (proposal.dropped > 0) {
    // Part of the evidence was never checked, so "one unverifiable citation
    // discards the verdict" would be enforced only over the part we looked at.
    return {
      ...base, settle: null, gate: "evidence-not-audited", proposal,
      reason: `${proposal.dropped} citation(s) beyond the audit limit were never checked`,
    };
  }
  if (proposal.outcome === "undetermined") {
    return { ...base, settle: null, gate: "proposer-abstained", proposal, reason: proposal.reasoning || "no conclusion reached" };
  }

  // The audit runs BEFORE confidence is consulted, so a citation that failed
  // against its own page is reported as that, rather than being swallowed by a
  // low-confidence abstention that happens to reach the same decision. Same
  // outcome, very different news.
  const audit = await auditCitations(proposal.citations, m.closeTime ? new Date(m.closeTime) : null);
  const support = auditSupports(proposal.outcome, audit);
  if (!support.ok) {
    return { ...base, settle: null, gate: "citations-failed", proposal, audit, reason: support.why };
  }

  if (proposal.confidence === "low") {
    return { ...base, settle: null, gate: "low-confidence", proposal, audit, reason: "the proposer was not confident" };
  }

  // "undated" belongs here. Leaving it out handed the second reader an EMPTY
  // list for any YES resting on undated pages, which it correctly answered
  // "undetermined" to without making a call, and the market was then refused
  // with "a blind second read of the same evidence said undetermined" about
  // evidence it was never shown. Every such YES failed, deterministically, for
  // a reason that was not true.
  const usable = audit.citations.filter((c) => c.status === "verified" || c.status === "stale" || c.status === "undated");

  let second: SecondRead;
  try {
    second = await secondImpl(
      { question: m.question, criteria, closeTime: m.closeTime },
      usable.map((c) => ({ url: c.url, quote: c.quote, datedAt: c.datedAt })),
    );
  } catch (e) {
    // This function promises never to throw, and it is called in a loop over a
    // whole board. An unwrapped rejection here (a socket error, the timeout
    // firing, a 200 with a non-JSON body) killed the process at whichever
    // market it happened on, so the rest were never evaluated and, under
    // --apply, nothing settled at all.
    second = { outcome: null, why: `the second read failed: ${(e as Error).message}` };
  }

  if (second.outcome === null) {
    return { ...base, settle: null, gate: "second-opinion-unavailable", proposal, audit, secondOpinion: null, reason: second.why };
  }
  if (second.outcome !== proposal.outcome) {
    return {
      ...base, settle: null, gate: "second-opinion-disagreed", proposal, audit, secondOpinion: second.outcome,
      reason: `a blind second read of the same evidence said ${second.outcome}${second.why ? `: ${second.why}` : ""}`,
    };
  }

  return {
    ...base,
    settle: proposal.outcome,
    gate: "settled",
    proposal,
    audit,
    secondOpinion: second.outcome,
    reason: `${support.why}, and a blind second read agreed`,
  };
}
