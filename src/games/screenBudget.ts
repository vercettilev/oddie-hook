/**
 * THE DAY'S SCREEN BUDGET (Lev, 26 Nov: "günlük ekran okuma tavanı"). Every
 * look at a stream is a paid model call (src/games/screen.ts readScreen,
 * src/games/frames.ts readFrame). Auto-reload on the Anthropic balance stays
 * off on purpose, so a runaway can never bill more than what is there; this is
 * the second ceiling: past SCREEN_DAILY_USD (default 3) in a UTC day, no
 * picture is read until the next one, and the operator hears it once. Open
 * calls stay open; the streamer or a mod settles them by hand.
 *
 * Counted from each answer's own usage at the model's list price, and kept in
 * bot_state (configureScreenBudget, wired at boot) so a deploy does not hand
 * the day a fresh budget. A model missing from the table is counted at the
 * dearest price in it, never as free.
 */

/** Anthropic list prices, US$ per million tokens (cached 3 Nov 2026). */
const PRICES: Array<[RegExp, { input: number; output: number }]> = [
  [/^claude-haiku-4-5/, { input: 1, output: 5 }],
  [/^claude-haiku-5-5/, { input: 0.1, output: 0.5 }],
  [/^claude-sonnet-4-6/, { input: 3, output: 15 }],
  [/^claude-sonnet-5(?:-5)?(?:$|-)/, { input: 2, output: 10 }],
  [/^claude-opus-5-5/, { input: 4, output: 20 }],
  [/^claude-opus-(?:5|4-[678])(?:$|-)/, { input: 5, output: 25 }],
];
const DEAREST = { input: 5, output: 25 };

export const SCREEN_DAILY_USD_DEFAULT = 3;
/** The day's cap, US$: SCREEN_DAILY_USD on Railway, or 3. */
export function screenDailyUsd(): number {
  const n = Number(process.env.SCREEN_DAILY_USD ?? SCREEN_DAILY_USD_DEFAULT);
  return Number.isFinite(n) && n > 0 ? n : SCREEN_DAILY_USD_DEFAULT;
}

export interface Usage { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }

/** What one answer cost, US$, at the model's list price. */
export function costOf(model: string, usage: Usage | undefined): number {
  if (!usage) return 0;
  const p = PRICES.find(([re]) => re.test(model))?.[1] ?? DEAREST;
  const n = (v: number | undefined) => (Number.isFinite(v) && (v as number) > 0 ? (v as number) : 0);
  return (n(usage.input_tokens) * p.input + n(usage.cache_creation_input_tokens) * p.input * 1.25
    + n(usage.cache_read_input_tokens) * p.input * 0.1 + n(usage.output_tokens) * p.output) / 1_000_000;
}

export interface ScreenBudgetConfig {
  get?(key: string): Promise<string | null>;
  set?(key: string, value: string): Promise<void>;
  alert?(a: { title: string; text: string; link?: [string, string] }): void;
  log?(line: string, extra?: Record<string, unknown>): void;
}

/** How often the day's spend is written down between crossings, at most. */
const SAVE_EVERY_MS = 15_000;
const keyOf = (day: string) => `screen_spend:${day}`;
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

let cfg: ScreenBudgetConfig = {};
let s = { day: "", base: 0, delta: 0, alerted: false, loaded: false, savedAt: 0 };

/** Wired at boot (src/server.ts): where the day's spend is kept, and who hears it is used. */
export function configureScreenBudget(c: ScreenBudgetConfig): void { cfg = c; }
/** Test seam: a new process, with the same store. */
export function _resetScreenBudget(): void { s = { day: "", base: 0, delta: 0, alerted: false, loaded: false, savedAt: 0 }; }

function roll(now: number): void {
  const day = dayOf(now);
  if (s.day !== day) s = { day, base: 0, delta: 0, alerted: false, loaded: false, savedAt: 0 };
}

async function load(): Promise<void> {
  if (s.loaded) return;
  s.loaded = true;
  const raw = cfg.get ? await cfg.get(keyOf(s.day)).catch(() => null) : null;
  if (!raw) return;
  try {
    const v = JSON.parse(raw) as { usd?: number; alerted?: boolean };
    if (Number.isFinite(v.usd) && (v.usd as number) > 0) s.base = v.usd as number;
    if (v.alerted) s.alerted = true;
  } catch { /* a row that does not read is a fresh day */ }
}

async function save(now: number): Promise<void> {
  s.savedAt = now;
  await cfg.set?.(keyOf(s.day), JSON.stringify({ usd: Number((s.base + s.delta).toFixed(5)), alerted: s.alerted })).catch(() => {});
}

/** The day's spend so far, US$ (read from the store once a day per process). */
export async function screenSpentToday(now = Date.now()): Promise<number> {
  roll(now);
  await load();
  return s.base + s.delta;
}

/** True once the day's cap is reached: nothing more is read until 00:00 UTC. */
export async function screenBudgetSpent(now = Date.now()): Promise<boolean> {
  return (await screenSpentToday(now)) >= screenDailyUsd();
}

/** One answer's cost, added to the day; the crossing is said once and written at once. */
export async function recordScreenSpend(model: string, usage: Usage | undefined, now = Date.now()): Promise<void> {
  roll(now);
  const c = costOf(model, usage);
  if (!(c > 0)) return;
  s.delta += c;
  await load();
  const total = s.base + s.delta;
  const cap = screenDailyUsd();
  if (total >= cap && !s.alerted) {
    s.alerted = true;
    await save(now);
    cfg.log?.("screen budget spent for the day", { usd: Number(total.toFixed(4)), cap });
    cfg.alert?.({
      title: "Oddie's screen budget for today is used",
      text: `Oddie has read streams for $${total.toFixed(2)} today (UTC), the day's cap (SCREEN_DAILY_USD, $${cap}). `
        + "No stream is read again until 00:00 UTC: open calls stay open, and the streamer or a mod can settle one with !call yes or !call no.",
      link: ["The Anthropic balance", "https://console.anthropic.com/settings/billing"],
    });
    return;
  }
  if (now - s.savedAt >= SAVE_EVERY_MS) await save(now);
}
