// Is this claim already a market?
//
// THE OLD CHECK WAS KEYED ON THE SOURCE POST, which is a different question. It
// stopped one tweet becoming two markets and it could never stop two tweets
// becoming two markets about the same thing. That is exactly what happened on
// the live board: Saylor's post and @Bitcoin's post, both "will BTC reach 100k
// before the end of 2026", both open, both taking money into separate pools.
// Splitting one crowd across two identical markets is worse than an empty
// board: each pool looks thinner than the interest actually is, and whichever
// one a person finds second is the one they wrongly read as dead.
//
// THE GATES ARE CHEAPEST-FIRST AND THE MODEL IS LAST, the same order the oracle
// uses, and for the same reason: most pairs are settled by arithmetic.
//
//   1. deadline    different day, different bet, stop.
//   2. numbers     the numeric tokens must match EXACTLY. "$100,000" and
//                  "$150,000" are one word apart and are never the same market.
//   3. overlap     a lexical floor, to keep the model off unrelated pairs.
//   4. the judge   "same bet?" asked once, of a model, because "BTC" and "ETH"
//                  are also one word apart and no threshold tells those two
//                  cases apart.
//
// Gate 4 is a CONFIRMATION, never a licence: a pair it likes still had to pass
// 1 to 3, and if it is unavailable the answer is "not a duplicate" and a second
// market opens. Wrongly merging two different bets sends somebody's money to a
// question they did not take a side on; wrongly opening a twin is untidy. Those
// are not the same cost, so the failure leans to the untidy one.

import { tokenize } from "./matcher.js";
import { messagesUrl, authHeaders, inferenceEnabled, MODEL } from "../inference.js";
import type { PriceCheck } from "../price/index.js";

export interface OpenMarketRow {
  slug: string;
  question: string;
  closesAt: string | null;
  priceCheck?: PriceCheck | null;
}

/** Same stemmer the matcher uses, kept local so a change there is a change here
 *  only on purpose. */
const stem = (t: string): string => {
  const s = t.replace(/(?:ing|es|s)$/, "");
  if (s.length < 3) return t;
  return s.replace(/(\w)\1$/, "$1");
};

const words = (q: string) => new Set(tokenize(q).map(stem));
const numbers = (q: string) => new Set(tokenize(q).filter((t) => /^\d/.test(t)));

const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
};

const sameDay = (a: string | null, b: string | null) => {
  if (!a || !b) return false;
  return a.slice(0, 10) === b.slice(0, 10);
};

/** Measured on the pair that prompted this: "trade at or above $100,000" against
 *  "reach $100,000", same deadline, scores 0.77. The floor sits well below that
 *  because gate 4 is what actually decides; this only keeps the model off pairs
 *  that share nothing. */
export const MIN_OVERLAP = 0.5;

/** A price market's identity is structural and needs no words at all. */
export function samePriceBet(a: PriceCheck, b: PriceCheck): boolean {
  return a.chain === b.chain && a.mint === b.mint && a.metric === b.metric
    && a.op === b.op && a.target === b.target && a.mode === b.mode
    && sameDay(a.to, b.to);
}

export interface Contender {
  row: OpenMarketRow;
  overlap: number;
  /** True when no model is needed: the two are the same price bet. */
  certain: boolean;
}

/**
 * Gates 1 to 3, pure and offline. Returns what is worth asking about, best
 * first, so the caller can stop at the first `certain` one.
 */
export function contenders(
  candidate: { question: string; closesAt: string | null; priceCheck?: PriceCheck | null },
  open: OpenMarketRow[],
): Contender[] {
  const mine = words(candidate.question);
  const myNums = numbers(candidate.question);
  const out: Contender[] = [];
  for (const row of open) {
    if (candidate.priceCheck && row.priceCheck) {
      if (samePriceBet(candidate.priceCheck, row.priceCheck)) out.push({ row, overlap: 1, certain: true });
      // Two price markets that are not the same bet are not the same market,
      // whatever their wording says. The structure is the whole meaning.
      continue;
    }
    if (!sameDay(candidate.closesAt, row.closesAt)) continue;
    const theirNums = numbers(row.question);
    if (myNums.size !== theirNums.size) continue;
    let numsMatch = true;
    for (const n of myNums) if (!theirNums.has(n)) { numsMatch = false; break; }
    if (!numsMatch) continue;
    const overlap = jaccard(mine, words(row.question));
    if (overlap < MIN_OVERLAP) continue;
    out.push({ row, overlap, certain: false });
  }
  return out.sort((a, b) => Number(b.certain) - Number(a.certain) || b.overlap - a.overlap);
}

const SYSTEM = `Two prediction market questions are given. Answer whether a person who bet YES on one would, on any outcome, be paid exactly when a YES on the other is paid.

Say "same" ONLY when the subject, the threshold, the direction and the deadline are all the same and only the wording differs. Different asset, different number, different direction, or a condition present in one and absent in the other all mean "different", however similar the sentences look.

When unsure, answer "different". A wrong "same" sends somebody's stake to a question they did not take a side on.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { verdict: { type: "string", enum: ["same", "different"] }, reason: { type: "string" } },
  required: ["verdict", "reason"],
} as const;

type JudgeFn = (a: string, b: string) => Promise<boolean>;

const liveJudge: JudgeFn = async (a, b) => {
  if (!inferenceEnabled()) return false;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30_000);
  try {
    const r = await fetch(messagesUrl(), {
      method: "POST",
      headers: authHeaders(),
      signal: ctl.signal,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: SYSTEM,
        tools: [{ name: "answer", description: "Answer whether the two questions are the same bet.", input_schema: SCHEMA }],
        tool_choice: { type: "tool", name: "answer" },
        messages: [{ role: "user", content: `A: ${a}\n\nB: ${b}` }],
      }),
    });
    if (!r.ok) return false;
    const body = (await r.json()) as any;
    const use = (body?.content ?? []).find((c: any) => c?.type === "tool_use");
    return use?.input?.verdict === "same";
  } catch {
    return false; // unreachable judge means "open it", never "merge it"
  } finally {
    clearTimeout(t);
  }
};

let judge: JudgeFn = liveJudge;
export function _setSameBetJudge(fn: JudgeFn | null): void {
  judge = fn ?? liveJudge;
}

/** The market this claim already is, or null. Never throws. */
export async function findDuplicate(
  candidate: { question: string; closesAt: string | null; priceCheck?: PriceCheck | null },
  open: OpenMarketRow[],
): Promise<OpenMarketRow | null> {
  const list = contenders(candidate, open);
  for (const c of list) {
    if (c.certain) return c.row;
    const same = await judge(candidate.question, c.row.question).catch(() => false);
    if (same) return c.row;
  }
  return null;
}
