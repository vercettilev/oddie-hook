// The operator console's two worklists, guarded structurally.
//
// Both sections used to render EVERY item they ever held, at full card size,
// forever — a settled verdict from weeks ago took the same space as one
// waiting to be posted, and a resolved market repeated "on-chain: skipped" on
// every row when the banner above already said on-chain was off for the whole
// page. The console became unmanageable exactly there: the actual worklist (a
// handful of items) was buried in an unbounded scroll of finished ones.
//
// The fix has no pure function to lift and run (loadMentions/loadCommunity are
// fetch+DOM, not calculations), so this pins the SHAPE of the fix in the
// source instead: pending/live render in full, sent/resolved collapse into a
// closed-by-default <details>, and the redundant per-row on-chain text is
// gated on chain actually being enabled.
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

console.log("\nverdicts: pending and sent are two different renders");
{
  const fn = bodyOf(tool, "async function loadMentions");
  check("loadMentions is where the test thinks it is", fn.length > 0);
  check("splits on mentionedAt rather than rendering one list",
    /if \(!m\.mentionedAt\)/.test(fn) || /!m\.mentionedAt/.test(fn), fn.slice(0, 200));
  check("sent items collapse into a details.rec, not a full card list",
    /sentHtml/.test(fn) && /<details class="rec"/.test(fn));
  check("the collapsed list has no open attribute (closed by default)",
    !/<details class="rec"[^>]*\bopen\b/.test(fn));
  check("the section title carries a live count, not a static label",
    /count\.textContent/.test(fn));
}

console.log("\nlive markets: resolved history is not the live worklist");
{
  const fn = bodyOf(tool, "async function loadCommunity");
  check("loadCommunity is where the test thinks it is", fn.length > 0);
  check("splits items on resolvedOutcome into live vs resolved",
    /filter\(\(m\) => !m\.resolvedOutcome\)/.test(fn) && /filter\(\(m\) => m\.resolvedOutcome\)/.test(fn));
  check("resolved markets collapse into a details.rec",
    /details class="rec"/.test(fn) && /resolved\.map/.test(fn));
  check("the collapsed list has no open attribute (closed by default)",
    !/<details class="rec"[^>]*\bopen\b/.test(fn));
  // The bug this guards: "on-chain: skipped" used to print on every live row
  // unconditionally. It may still appear, but ONLY inside the statement that
  // gates it on chainEnabled — the one case where it can differ row to row.
  // The string also appears once in the comment explaining this, ABOVE the
  // code (the whole point of that comment) — lastIndexOf, not indexOf, to
  // land on the code's own occurrence rather than the prose describing it.
  // Bounded by the enclosing `const minted = …;` rather than a fixed
  // character window, since the real gate sits a four-line comment away.
  const skippedIdx = fn.lastIndexOf("on-chain: skipped");
  const declStart = fn.lastIndexOf("const minted", skippedIdx);
  const declEnd = fn.indexOf(";", skippedIdx);
  check("'on-chain: skipped' appears at all (chain-off row copy still exists)", declStart > 0);
  const stmt = fn.slice(declStart, declEnd + 1);
  check("...and is reached through a chainEnabled check, not unconditionally",
    /chainEnabled/.test(stmt), stmt.replace(/\s+/g, " "));
}

console.log("\nverdicts: dismiss is a real third state, not \"mark sent\" in disguise");
{
  // Trigger: 18 pending verdicts turned out to be the operator's own repeated
  // test calls from weeks earlier (the same market called 5 times while
  // dogfooding), sitting in the "N to post" count forever because
  // mentionCandidates had no way to remove a row except mentioned_at, which
  // means "this actually went out on X" and feeds the 24h-return read. Using
  // it to mean "I'm not posting this" would have logged a post that never
  // happened.
  const fn = bodyOf(tool, "async function loadMentions");
  check("the pending card renders a dismiss control, separate from mark sent",
    /mdismiss/.test(fn));
  check("dismiss is styled below button weight (class=\"quiet\", not \"ghost\")",
    /class="quiet mdismiss"/.test(fn), (fn.match(/.{0,40}mdismiss.{0,10}/g) ?? []).join(" | "));
  check("dismiss calls its own endpoint, not /sent",
    /\/api\/mentions\/\$\{b\.dataset\.id\}\/dismiss/.test(fn));

  const srv = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  check("the server exposes a distinct /dismiss route", /"\/api\/mentions\/:id\/dismiss"/.test(srv));

  const store = readFileSync(new URL("../src/store/markets.ts", import.meta.url), "utf8");
  const dismissFn = bodyOf(store, "export async function dismissMention");
  check("dismissMention is where the test thinks it is", dismissFn.length > 0);
  check("...and refuses to touch a row that already went out (guards on mentioned_at IS NULL)",
    /mentioned_at\s+IS\s+NULL/i.test(dismissFn), dismissFn);
  check("dismissed rows are excluded from the worklist query",
    /dismissed_at\s+IS\s+NULL/i.test(bodyOf(store, "export async function mentionCandidates")));
}

console.log(failures === 0 ? "\nall tool checks passed.\n" : `\n${failures} tool check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
