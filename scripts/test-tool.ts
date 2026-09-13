// The operator console's one worklist, guarded structurally.
//
// The console used to be five sections and is now one, because the mention
// loop took the other four: the bot opens markets and answers tags on its own,
// and what is left for a person is deciding an outcome and paying people. The
// verdict queue and its dismiss state went with market_call, the play-money
// table nothing has written since real SOL arrived.
//
// What this pins is the shape of the section that survived. There is no pure
// function to lift and run (loadCommunity is fetch+DOM, not a calculation), so
// the assertions read the source: resolved and retired history collapse out of
// the live worklist, a market past its close sorts to the top and is named for
// the action it needs, and the money on the card comes from the chain rather
// than from the dead table that printed four zeros over a funded market.
//
// Run with: npm run test-tool

import { readFileSync } from "node:fs";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

const bodyOf = (src: string, fnStart: string): string => {
  const from = src.indexOf(fnStart);
  if (from < 0) return "";
  // Balance braces from the function's opening one rather than assuming a
  // fixed nesting depth — both functions below contain their own nested
  // blocks, so "the next line starting with a lone }" is not reliable.
  const open = src.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(from, i + 1); }
  }
  return "";
};

const tool = readFileSync(new URL("../public/tool.html", import.meta.url), "utf8");

console.log("\nmarkets: the worklist is what still needs a decision");
{
  const fn = bodyOf(tool, "async function loadCommunity");
  check("loadCommunity is where the test thinks it is", fn.length > 0);

  // Retired is not live. The public list filters on both, and this one checked
  // only resolvedOutcome, so a board cleanup left five markets counted and
  // listed as live over an app that was serving two.
  check("live excludes BOTH resolved and retired",
    /!m\.resolvedOutcome && !m\.retiredAt/.test(fn), fn.slice(0, 400));
  check("retired and resolved each collapse into a details.rec",
    /details class="rec"/.test(fn) && /retired\.map/.test(fn) && /resolved\.map/.test(fn));
  check("the collapsed lists have no open attribute (closed by default)",
    !/<details class="rec"[^>]*\bopen\b/.test(fn));

  // The one question this page answers is "has it closed", so a market past
  // its close has to be findable without reading every row.
  check("closed-and-unsettled sorts to the top", /live\.sort\(/.test(fn) && /closedAt/.test(fn));
  check("a past close is named for the action it needs",
    /ready to settle/.test(fn) && /settle this market/.test(fn));

  // The money. yesTokens/noTokens are SUM(market_call.tokens) and read zero
  // forever; the pool has to come off the chain, and an unreadable pool must
  // say so rather than print a zero nobody measured.
  check("the card reads the chain pool, not the play-money columns",
    /m\.poolSol/.test(fn) && !/m\.yesTokens/.test(fn), (fn.match(/m\.(yes|no)Tokens/g) ?? []).join(" "));
  check("an unreadable pool is stated, never rendered as zero",
    /m\.unreadable/.test(fn) && /could not read the pool/.test(fn));

  // Per-row on-chain copy is only informative when chain is ENABLED; off, it
  // is the same word on every row that the banner above already said once.
  const idx = fn.lastIndexOf("not on chain yet");
  const declStart = fn.lastIndexOf("const money", idx);
  check("the not-yet-minted line exists", declStart > 0);
  check("...and is reached through a chainEnabled check, not unconditionally",
    /chainEnabled/.test(fn.slice(declStart, fn.indexOf(";", idx) + 1)));
}

// The server has to send what the card reads.
{
  const srv = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const route = srv.slice(srv.indexOf('app.get("/api/community/list"'),
                          srv.indexOf('app.get("/api/community/market/:slug"'));
  check("the admin list reads the chain for the whole page, batched",
    /readMarkets\(/.test(route) && /stakerCounts\(/.test(route), route.slice(0, 200));
  check("...and sends poolSol, bettors and unreadable",
    /poolSol/.test(route) && /bettors/.test(route) && /unreadable/.test(route));
}

console.log(failures === 0 ? "\nall tool checks passed.\n" : `\n${failures} tool check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
