/**
 * Where inference goes, and under whose key. One seam, three call sites.
 *
 * This exists for the hackathon's Inference Markets track, where routing our
 * model calls through UsePod is a commitment we made when we entered. It is
 * also just correct: three files were each hardcoding the same host, the same
 * auth header and the same model id, which is three places to edit and two
 * places to forget.
 *
 * WHAT USEPOD ACTUALLY IS, because the marketing sentence is misleading.
 *
 * UsePod is an inference marketplace for OPEN-WEIGHT models (Deepseek, Llama,
 * Qwen). "Anthropic compatible" describes the request SHAPE, not the catalogue:
 * there is no Claude behind it. So this is not the base-URL swap it is often
 * described as. Pointing us at UsePod changes the model doing the grading, and
 * the grader is the quality gate for every market this product opens. That is
 * a measurement job (run the matcher corpus against the candidate, compare),
 * not a config change, and it is why `INFERENCE_MODEL` is a separate variable
 * from the base URL rather than being inferred from it.
 *
 * Their live endpoint answers on the OpenAI shape (`/v1/models` with a Bearer
 * token, verified 2026-08-25). The Anthropic-compatible surface is claimed but
 * their docs host returns 404, so it is UNVERIFIED. `INFERENCE_AUTH` exists to
 * cover both without a code change when somebody has a key to test with.
 *
 * Default behaviour with nothing set is byte-identical to what shipped before
 * this file existed: api.anthropic.com, x-api-key, claude-opus-4-8.
 */

export const API_KEY_ENV = "ANTHROPIC_API_KEY";

/** The model doing the grading. See the note above before changing it. */
export const MODEL = process.env.INFERENCE_MODEL ?? "claude-opus-4-8";

/** Origin only, no path. Defaults to Anthropic's. */
const BASE = (process.env.INFERENCE_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");

/** `x-api-key` (Anthropic's own) or `bearer` (what UsePod answered to). */
const AUTH = (process.env.INFERENCE_AUTH ?? "x-api-key").toLowerCase() === "bearer" ? "bearer" : "x-api-key";

/** The key. One variable whichever host it is for, so a switch is a value change. */
const KEY = () => process.env.INFERENCE_API_KEY ?? process.env[API_KEY_ENV];

export const inferenceEnabled = (): boolean => Boolean(KEY());

export const messagesUrl = (): string => `${BASE}/v1/messages`;

export function authHeaders(): Record<string, string> {
  const key = KEY();
  if (!key) throw new Error(`inference unavailable: set ${API_KEY_ENV}`);
  return {
    ...(AUTH === "bearer" ? { authorization: `Bearer ${key}` } : { "x-api-key": key }),
    // Harmless on a host that ignores it, required by the one that does not.
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
}

/** What is actually configured, for the boot line and the admin status route. */
export function inferenceProvider(): { host: string; model: string; auth: string; anthropic: boolean } {
  return { host: BASE, model: MODEL, auth: AUTH, anthropic: BASE === "https://api.anthropic.com" };
}
