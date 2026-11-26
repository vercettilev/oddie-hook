// The day's screen budget (src/games/screenBudget.ts): what one look costs, the
// day's cap, said once and kept across a deploy, a fresh budget the next UTC day,
// and the two paid readers counting what they spend.
//
// Run with: npm run test-screen-budget

import { readFileSync } from "node:fs";
import {
  _resetScreenBudget, configureScreenBudget, costOf, recordScreenSpend, screenBudgetSpent, screenDailyUsd, screenSpentToday,
  SCREEN_DAILY_USD_DEFAULT,
} from "../src/games/screenBudget.js";
import { askScreen } from "../src/games/screen.js";
import { readFrame } from "../src/games/frames.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

console.log("what one look costs, at list price");
{
  check("Haiku 4.5, the reader: $1 in, $5 out a million", near(costOf("claude-haiku-4-5-20251001", { input_tokens: 1000, output_tokens: 100 }), 0.0015));
  check("Opus 4.8, the confirmer: $5 in, $25 out a million", near(costOf("claude-opus-4-8", { input_tokens: 1000, output_tokens: 100 }), 0.0075));
  check("a model not in the table is counted at the dearest price, never free", near(costOf("some-new-model", { input_tokens: 1000, output_tokens: 100 }), 0.0075));
  check("cache writes at 1.25x the input price, reads at 0.1x",
    near(costOf("claude-haiku-4-5-20251001", { cache_creation_input_tokens: 1000, cache_read_input_tokens: 1000 }), 0.00135));
  check("no usage, or nonsense in it, costs nothing", costOf("claude-opus-4-8", undefined) === 0
    && costOf("claude-opus-4-8", { input_tokens: -5, output_tokens: Number.NaN }) === 0);
  const before = process.env.SCREEN_DAILY_USD;
  delete process.env.SCREEN_DAILY_USD;
  check("the day's cap is $3 unless SCREEN_DAILY_USD says otherwise", screenDailyUsd() === 3 && SCREEN_DAILY_USD_DEFAULT === 3);
  process.env.SCREEN_DAILY_USD = "abc";
  check("...and a value that is no positive number is the default", screenDailyUsd() === 3);
  if (before === undefined) delete process.env.SCREEN_DAILY_USD; else process.env.SCREEN_DAILY_USD = before;
}

console.log("\nthe day's cap");
{
  const before = process.env.SCREEN_DAILY_USD;
  process.env.SCREEN_DAILY_USD = "0.01";
  const store = new Map<string, string>();
  const alerts: Array<{ title: string; text: string; link?: [string, string] }> = [];
  const logs: string[] = [];
  configureScreenBudget({
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => { store.set(k, v); },
    alert: (a) => alerts.push(a),
    log: (l) => logs.push(l),
  });
  _resetScreenBudget();
  const now = Date.UTC(2026, 10, 27, 10, 0, 0);
  const look = { input_tokens: 2000, output_tokens: 100 }; // $0.0025 on Haiku
  check("a fresh day has spent nothing", (await screenSpentToday(now)) === 0 && !(await screenBudgetSpent(now)));
  await recordScreenSpend("claude-haiku-4-5-20251001", look, now);
  check("...a look is counted, and under the cap reading goes on", near(await screenSpentToday(now), 0.0025) && !(await screenBudgetSpent(now)));
  for (let i = 0; i < 3; i++) await recordScreenSpend("claude-haiku-4-5-20251001", look, now + i);
  check("at the cap it stops", await screenBudgetSpent(now));
  check("...and the operator hears it once, with what still works and where the balance is",
    alerts.length === 1 && alerts[0].title === "Oddie's screen budget for today is used" && /until 00:00 UTC/.test(alerts[0].text)
    && /!call yes or !call no/.test(alerts[0].text) && alerts[0].link?.[1] === "https://console.anthropic.com/settings/billing", JSON.stringify(alerts));
  check("...logged too", logs.includes("screen budget spent for the day"));
  const kept = JSON.parse(store.get("screen_spend:2026-11-27") ?? "{}") as { usd?: number; alerted?: boolean };
  check("the crossing is written down at once", (kept.usd ?? 0) >= 0.01 && kept.alerted === true, JSON.stringify(kept));
  await recordScreenSpend("claude-haiku-4-5-20251001", look, now + 10);
  check("more looks after it do not mail again", alerts.length === 1);
  _resetScreenBudget();
  check("a deploy does not hand the day a fresh budget: the spend comes back from the store", await screenBudgetSpent(now + 20));
  await recordScreenSpend("claude-haiku-4-5-20251001", look, now + 30);
  check("...nor a second mail", alerts.length === 1);
  const tomorrow = now + 24 * 60 * 60_000;
  check("the next UTC day starts at nothing", (await screenSpentToday(tomorrow)) === 0 && !(await screenBudgetSpent(tomorrow)));
  configureScreenBudget({});
  _resetScreenBudget();
  if (before === undefined) delete process.env.SCREEN_DAILY_USD; else process.env.SCREEN_DAILY_USD = before;
}

console.log("\nthe two paid readers count what they spend");
{
  const realFetch = globalThis.fetch;
  const keyBefore = process.env.INFERENCE_API_KEY;
  process.env.INFERENCE_API_KEY = keyBefore ?? "test-key-not-real";
  _resetScreenBudget();
  const answer = (text: string, usage: Record<string, number>) => (async () => new Response(JSON.stringify({ content: [{ type: "text", text }], usage }),
    { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  globalThis.fetch = answer('{"answer":"unclear","sure":0.2,"seen":"lobby"}', { input_tokens: 1500, output_tokens: 40 });
  await askScreen(Buffer.from("jpeg"), "will I win this match?", "nova").catch(() => null);
  await new Promise((r) => setTimeout(r, 20));
  check("the screen reader's look is counted from the answer's own usage", near(await screenSpentToday(), 0.0017), String(await screenSpentToday()));
  globalThis.fetch = answer('{"game":"cs2","screen":"other"}', { input_tokens: 1000, output_tokens: 60 });
  await readFrame(Buffer.from("jpeg")).catch(() => null);
  await new Promise((r) => setTimeout(r, 20));
  check("...and so is the match picture's", near(await screenSpentToday(), 0.0017 + 0.0013), String(await screenSpentToday()));
  globalThis.fetch = realFetch;
  if (keyBefore === undefined) delete process.env.INFERENCE_API_KEY; else process.env.INFERENCE_API_KEY = keyBefore;
  _resetScreenBudget();
}

console.log("\nwired at boot");
{
  const server = readFileSync("src/server.ts", "utf8");
  check("the day's spend is kept in bot_state, and its crossing mailed to the operator",
    /configureScreenBudget\(\{\s*get: \(k\) => botStateGet\(k\),\s*set: \(k, v\) => botStateSet\(k, v\),\s*alert: \(a\) => reportAlert\(a\),/.test(server));
  const screenCalls = readFileSync("src/live/screenCalls.ts", "utf8");
  const frameCalls = readFileSync("src/live/frameCalls.ts", "utf8");
  check("...and both readers ask it before they look", /\(await screenBudgetSpent\(now\)\)/.test(screenCalls) && /if \(await screenBudgetSpent\(now\)\)/.test(frameCalls));
}

if (failures) { console.error(`\n${failures} screen budget check(s) failed`); process.exit(1); }
console.log("\nall screen budget checks passed.");
