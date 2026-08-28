// What proposeVerdict actually puts on the wire, and what it does with what
// comes back.
//
// This function had NO coverage at all. test-oracle.ts swaps it out wholesale
// and checks the rules downstream of it, which means the request shape, the
// pause_turn loop, every error path and the whole normalize step were shipped
// unexecuted. An untested transport fails the same way a hard market does: the
// pipeline abstains, the run looks tidy, and nothing says the reason was our
// own bug.
//
// It runs against a REAL local HTTP server rather than a stubbed fetch, because
// half of what is worth checking here is what leaves the process: the tools
// array, the headers, the resumed turn. A stubbed fetch would let a body that
// no server would accept pass quietly.
//
// What it CANNOT prove is whether Anthropic accepts the shape. Nothing without
// an API key can. See scripts/test-oracle-live.ts.
//
// Run with: npm run test-oracle-wire
if (process.env.DATABASE_URL) { console.error("refusing to run against a database"); process.exit(1); }

import http from "node:http";
import type { AddressInfo } from "node:net";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.error(`  ✗ ${n}`); if (d) console.error(`      ${d}`); }
};

// ---------------------------------------------------------------------------
// A local stand-in for the Messages API. It records every request it is sent
// and answers from a queue, so a test can hand back a pause_turn first and a
// tool call second and see whether the loop did the right thing in between.
// ---------------------------------------------------------------------------
interface Sent { headers: http.IncomingHttpHeaders; body: Record<string, unknown>; path: string }
const sent: Sent[] = [];
let queue: Array<{ status: number; body: unknown }> = [];

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw); } catch { /* recorded as empty, which a test can assert on */ }
    sent.push({ headers: req.headers, body, path: req.url ?? "" });
    const next = queue.shift() ?? { status: 500, body: { error: { message: "the test queued no reply" } } };
    res.writeHead(next.status, { "content-type": "application/json" });
    res.end(JSON.stringify(next.body));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;

// BASE and the auth mode are module constants read at import time, so the
// environment has to be right BEFORE the module is pulled in. Hence the dynamic
// import: a top-level one would have already frozen the real host.
process.env.INFERENCE_BASE_URL = `http://127.0.0.1:${port}`;
process.env.ANTHROPIC_API_KEY = "test-key-not-real";
const { proposeVerdict, oracleAvailable, _setAvailability } = await import("../src/oracle/verdict.js");

// ---------------------------------------------------------------------------
// Canned replies, shaped the way the Messages API documents this turn: the
// server-side search runs inside the response, then the model calls our tool.
// ---------------------------------------------------------------------------
const toolCall = (input: unknown) => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-4-8",
  stop_reason: "tool_use",
  content: [
    { type: "thinking", thinking: "" },
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "arsenal chelsea result" } },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://a.test/1", title: "Result", page_age: "1 day ago" }] },
    { type: "text", text: "Found it." },
    { type: "tool_use", id: "toolu_1", name: "record_verdict", input },
  ],
});
const paused = {
  id: "msg_0", type: "message", role: "assistant", model: "claude-opus-4-8",
  stop_reason: "pause_turn",
  content: [
    { type: "server_tool_use", id: "srvtoolu_0", name: "web_search", input: { query: "arsenal chelsea" } },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_0", content: [{ type: "web_search_result", url: "https://a.test/0", title: "Partial" }] },
  ],
};
const GOOD = {
  outcome: "yes", confidence: "high", checkable: true,
  citations: [{ url: "https://a.test/1", quote: "Arsenal beat Chelsea 3-1" }],
  reasoning: "the league site reports the result",
};
const reset = (...replies: Array<{ status: number; body: unknown }>) => { sent.length = 0; queue = replies; };
const ok = (body: unknown) => ({ status: 200, body });

const MARKET = {
  question: "Did Arsenal beat Chelsea?",
  criteria: "Resolves YES if the Premier League site shows Arsenal beat Chelsea before 20 Aug 2026.",
  closeTime: "2026-08-20T23:59:00Z",
};

console.log("\nthe host guard is real, and it is what the seam below steps around");
{
  // Still the LIVE guard here: the base url is a local server, which is exactly
  // the situation the guard exists for.
  const a = oracleAvailable();
  check("a non-Anthropic host is refused", !a.ok, a.why);
  let threw = "";
  await proposeVerdict(MARKET).catch((e) => { threw = (e as Error).message; });
  check("...and proposeVerdict refuses to run at all", threw.includes("web search"), threw);
  check("nothing was sent", sent.length === 0);
}
_setAvailability(() => ({ ok: true, why: "test" }));

console.log("\nwhat leaves the process");
{
  reset(ok(toolCall(GOOD)));
  await proposeVerdict(MARKET);
  const req = sent[0];
  const body = req.body as Record<string, any>;

  check("posts to /v1/messages", req.path === "/v1/messages", req.path);
  check("sends the key as x-api-key", req.headers["x-api-key"] === "test-key-not-real");
  check("sends anthropic-version", Boolean(req.headers["anthropic-version"]));

  const tools = (body.tools ?? []) as Array<Record<string, any>>;
  const web = tools.find((t) => t.name === "web_search");
  const verdict = tools.find((t) => t.name === "record_verdict");
  check("declares the server-side web search tool", web?.type === "web_search_20260209", JSON.stringify(web));
  check("caps how many searches it may run", typeof web?.max_uses === "number");
  check("declares record_verdict", Boolean(verdict));
  // strict is what makes the tool payload's shape a guarantee rather than a
  // hope, which is why normalize below can be about MEANING and not parsing.
  check("record_verdict is strict", verdict?.strict === true);
  check("...and closed to extra properties", verdict?.input_schema?.additionalProperties === false);
  check("adaptive thinking is on", body.thinking?.type === "adaptive");
  check("no budget_tokens (removed on this model family)", body.thinking?.budget_tokens === undefined);

  const user = String(body.messages?.[0]?.content ?? "");
  // The model has no clock. Without one it dates a market to its training year.
  check("hands the model a clock", /Current date and time \(UTC\): \d{4}-/.test(user), user.slice(0, 80));
  check("tells it when the market closed", user.includes(MARKET.closeTime), user.slice(0, 200));
  check("carries the criteria, not just the question", user.includes(MARKET.criteria));
  check("the system prompt demands verbatim quotes", String(body.system).includes("character-for-character"));
}

console.log("\na tool call comes back as a proposal");
{
  reset(ok(toolCall(GOOD)));
  const p = await proposeVerdict(MARKET);
  check("outcome read", p.outcome === "yes");
  check("confidence read", p.confidence === "high");
  check("citation read", p.citations[0]?.url === "https://a.test/1" && p.citations[0]?.quote === "Arsenal beat Chelsea 3-1");
  check("one request was enough", sent.length === 1);
}

console.log("\npause_turn resumes instead of giving up");
{
  reset(ok(paused), ok(toolCall(GOOD)));
  const p = await proposeVerdict(MARKET);
  check("the verdict still arrives", p.outcome === "yes");
  check("it took two requests", sent.length === 2, String(sent.length));
  const second = sent[1].body as Record<string, any>;
  check("the paused turn was handed back", second.messages?.[1]?.role === "assistant");
  // The server-side search blocks are part of that turn. Dropping them loses the
  // work the pause was protecting.
  const echoed = JSON.stringify(second.messages?.[1]?.content ?? []);
  check("...including its server-tool blocks", echoed.includes("server_tool_use") && echoed.includes("web_search_tool_result"), echoed.slice(0, 160));
}

console.log("\nit stops rather than looping forever");
{
  reset(ok(paused), ok(paused), ok(paused), ok(paused), ok(paused), ok(paused));
  const p = await proposeVerdict(MARKET);
  check("an endless pause ends as undetermined", p.outcome === "undetermined");
  check("and is bounded", sent.length <= 4, `${sent.length} requests`);
}

console.log("\nfinishing without a verdict is an abstention, not a crash");
{
  reset(ok({ id: "m", type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "I could not find a source for this." }] }));
  const p = await proposeVerdict(MARKET);
  check("undetermined", p.outcome === "undetermined");
  check("low confidence", p.confidence === "low");
  check("what it said is kept as the reason", p.reasoning.includes("could not find"), p.reasoning);
  check("no citations invented", p.citations.length === 0);
}

console.log("\na broken request throws with the reason attached");
{
  reset({ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "tools.1: strict is not supported here" } } });
  let msg = "";
  await proposeVerdict(MARKET).catch((e) => { msg = (e as Error).message; });
  check("the status is in the message", msg.includes("400"), msg);
  // Without this, the one failure that would tell us the shape is wrong reads as
  // an ordinary abstention.
  check("the API's own explanation survives", msg.includes("strict is not supported"), msg);
}

console.log("\nnormalize clamps MEANING, not just shape");
{
  reset(ok(toolCall({ ...GOOD, outcome: "maybe" })));
  check("an unknown side is an abstention, never a coin flip", (await proposeVerdict(MARKET)).outcome === "undetermined");

  reset(ok(toolCall({ ...GOOD, confidence: "extremely high" })));
  check("an unknown confidence falls to low", (await proposeVerdict(MARKET)).confidence === "low");

  reset(ok(toolCall({ ...GOOD, checkable: "sort of" })));
  // Only an explicit false blames the question; anything else means we do not
  // get to excuse ourselves with "the criteria were bad".
  check("a non-boolean checkable stays true", (await proposeVerdict(MARKET)).checkable === true);

  reset(ok(toolCall({ ...GOOD, citations: [{ url: "https://a.test/1" }, { quote: "no url here at all" }, { url: "  ", quote: "  " }] })));
  check("half-built citations are dropped", (await proposeVerdict(MARKET)).citations.length === 0);

  reset(ok(toolCall({ ...GOOD, citations: Array.from({ length: 30 }, (_, i) => ({ url: `https://a.test/${i}`, quote: `quote number ${i} here` })) })));
  check("a flood of citations is capped", (await proposeVerdict(MARKET)).citations.length === 8);

  reset(ok(toolCall({ outcome: "no" })));
  const bare = await proposeVerdict(MARKET);
  check("missing fields do not throw", bare.outcome === "no" && bare.citations.length === 0 && bare.reasoning === "");
}

_setAvailability(null);
server.close();
console.log(failures === 0 ? "\nall wire checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
