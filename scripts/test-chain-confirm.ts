/**
 * Confirmation by polling: a stake is called confirmed the moment the cluster
 * says so, rejected when it landed with an error, and unknown only after the
 * blockhash expired or the wait ran out, with one last look through history
 * first. In memory, no network: the deps are scripted.
 */
import assert from "node:assert/strict";
import { confirmByPolling, type ConfirmDeps, type ConfirmOutcome } from "../src/chain/oddieChain.js";

let checks = 0;
const ok = (cond: unknown, what: string) => { assert.ok(cond, what); checks++; };
const eq = <T>(a: T, b: T, what: string) => { assert.deepEqual(a, b, what); checks++; };

type Status = { err: unknown; confirmationStatus?: string | null } | null;

/** A scripted chain: `answers` are returned to successive status polls (the
 *  last one repeats), `history` answers the searchTransactionHistory look. */
function scripted(answers: Status[], opts: { history?: Status; heights?: number[] } = {}) {
  let polls = 0, historyLooks = 0, slept = 0, heightReads = 0, clock = 0;
  const deps: ConfirmDeps = {
    status: async (_sig, searchHistory) => {
      if (searchHistory) { historyLooks++; return opts.history ?? null; }
      const a = answers[Math.min(polls, answers.length - 1)] ?? null;
      polls++;
      return a;
    },
    blockHeight: async () => { const h = opts.heights ?? [0]; return h[Math.min(heightReads++, h.length - 1)]; },
    sleep: async (ms) => { slept += ms; clock += ms; },
    now: () => clock,
  };
  return { deps, stats: () => ({ polls, historyLooks, slept, heightReads }) };
}

const run = (answers: Status[], o: Parameters<typeof scripted>[1] = {}, lastValid = 100, opts = {}) => {
  const s = scripted(answers, o);
  return confirmByPolling("sig", lastValid, s.deps, { pollMs: 100, timeoutMs: 1000, heightEvery: 3, ...opts }).then((out) => ({ out, ...s.stats() }));
};

/* confirmed on the third poll: two sleeps, no history look */
{
  const r = await run([null, { err: null, confirmationStatus: "processed" }, { err: null, confirmationStatus: "confirmed" }]);
  eq(r.out, { state: "confirmed" } as ConfirmOutcome, "confirmed once the cluster says confirmed");
  eq(r.polls, 3, "three polls");
  eq(r.slept, 200, "slept between polls only");
  eq(r.historyLooks, 0, "no history look on a clean confirm");
}

/* finalized counts as confirmed */
{
  const r = await run([{ err: null, confirmationStatus: "finalized" }]);
  eq(r.out, { state: "confirmed" } as ConfirmOutcome, "finalized is confirmed");
  eq(r.polls, 1, "first poll answers");
}

/* "processed" alone is not an answer: keep polling */
{
  const r = await run([{ err: null, confirmationStatus: "processed" }, { err: null, confirmationStatus: "processed" }, { err: null, confirmationStatus: "confirmed" }]);
  eq(r.out, { state: "confirmed" } as ConfirmOutcome, "processed then confirmed");
  eq(r.polls, 3, "waited through processed");
}

/* landed with an error: rejected, with the error carried */
{
  const r = await run([null, { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" }]);
  eq(r.out, { state: "rejected", err: { InstructionError: [0, "Custom"] } } as ConfirmOutcome, "an on-chain error is a rejection");
}

/* blockhash expired, history still finds it: confirmed */
{
  const r = await run([null], { history: { err: null, confirmationStatus: "finalized" }, heights: [101] });
  eq(r.out, { state: "confirmed" } as ConfirmOutcome, "history look rescues an aged-out status");
  eq(r.historyLooks, 1, "one history look");
  eq(r.heightReads, 1, "height read at the third poll");
  eq(r.polls, 4, "polls 0..3, height checked at poll 3");
}

/* blockhash expired, nowhere to be found: unknown/expired, never rejected */
{
  const r = await run([null], { heights: [101] });
  eq(r.out, { state: "unknown", reason: "expired" } as ConfirmOutcome, "expired and absent is unknown, not failed");
}

/* height still valid: keeps going until the wait runs out, then history */
{
  const r = await run([null], { heights: [50] });
  eq(r.out, { state: "unknown", reason: "timeout" } as ConfirmOutcome, "timeout is unknown");
  ok(r.slept >= 1000, "waited the whole timeout");
  eq(r.historyLooks, 1, "one history look at timeout");
}

/* height is only read every `heightEvery` polls, never on the first */
{
  const s = scripted([null, null, null, null, null, { err: null, confirmationStatus: "confirmed" }], { heights: [10] });
  const out = await confirmByPolling("sig", 100, s.deps, { pollMs: 10, timeoutMs: 10_000, heightEvery: 2 });
  eq(out, { state: "confirmed" } as ConfirmOutcome, "confirmed on the sixth poll");
  eq(s.stats().heightReads, 2, "height read at polls 2 and 4, and a confirm returns before the height is read");
}

console.log(`test-chain-confirm: ${checks} checks passed`);
