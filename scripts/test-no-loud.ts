// THE BANNED SHAPE MUST NOT COME BACK.
//
// On 2026-01-15 X revoked API access for apps that reward users for posting on
// X. Kaito, Cookie, Wallchain, Bantr and Xeet lost it in one sweep and Kaito
// sunset Yaps. Those companies lost a product line; oddie would lose the
// product, because the whole loop needs the mentions endpoint to read tags and
// POST /2/tweets to answer them.
//
// The machinery that paid for posting was deleted. Several comments across the
// repo still DESCRIBE it, deliberately, so the reasoning survives — and a
// comment is exactly how somebody reintroduces a mechanic in good faith. This
// asserts on code, not prose.
//
// Run with: npm run test-no-loud

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
};

/** Source with block and line comments removed: prose about the mechanic is
 *  allowed and wanted, the mechanic itself is not. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

console.log("\nthe share-to-earn shape stays deleted\n");

const files = walk(path.join(ROOT, "src"));
const BANNED: [string, string][] = [
  ["loud_post", "the table and the award that paid for an approved post about oddie"],
  ["loudMultiplier", "the score multiplier moved by posting"],
  ["loudMultiplierOf", "the function behind it"],
  ["ODDIES_PER", "the per-event payout map the loud routes returned"],
  ["awardLoud", "the weekly Loudest award"],
  ["loudStatusFor", "the multiplier's read path"],
  ["submitLoudPost", "the player-facing post submission"],
  ["api/admin/loud", "the three routes that paid for posts"],
];

for (const [needle, what] of BANNED) {
  const hits = files.filter((p) => code(readFileSync(p, "utf8")).includes(needle));
  check(`no ${needle} in src/ — ${what}`, hits.length === 0,
    hits.map((p) => path.relative(ROOT, p)).join(", "));
}

// SEASON_POINTS is the ledger's vocabulary and the one place a new earn event
// would be declared. These three are the ones that paid for posting.
const marketsSrc = code(readFileSync(path.join(ROOT, "src/store/markets.ts"), "utf8"));
const block = marketsSrc.slice(marketsSrc.indexOf("SEASON_POINTS = {"));
const decl = block.slice(0, block.indexOf("}"));
for (const key of ["shared", "loud", "loud_post"]) {
  check(`SEASON_POINTS has no "${key}" event`, !new RegExp(`\\b${key}\\s*:`).test(decl));
}

/* THE LINK CHECK, in the same file because it is the same failure: something
   that only breaks on deploy. NO test in this repo imports server.ts — the four
   that mention it read it as text — so a name server.ts imports from markets.ts
   and markets.ts no longer exports is a GREEN suite and an exit-1 crash at
   boot, before a single line runs. */
const serverSrc = readFileSync(path.join(ROOT, "src/server.ts"), "utf8");
/* EVERY import block, not the first one. server.ts pulls from markets.js in
   more than one place, and the first draft matched only the leading one: I
   proved the test was worthless by stripping `export` from mentionCandidates,
   which server.ts imports, and watching this file report all checks passed. A
   test that cannot fail is the thing it is written to prevent. */
const blocks = [...serverSrc.matchAll(/import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*"\.\/store\/markets\.js"/g)];
check("server.ts's markets.js imports were found", blocks.length > 0, `${blocks.length} block(s)`);
{
  const m = [null, blocks.map((b) => b[1]).join(",")] as [null, string];
  // `type Foo` in an import list is one specifier, not two, and the prefix is
  // not part of the name.
  const names = m[1]
    .split(",")
    .map((x) => x.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
  /* Three ways markets.ts exports a name, and the first draft of this test only
     knew the first. It reported CALL_COST and CommunityMarket missing when both
     are exported perfectly well -- a link test that cries wolf gets muted, so
     the false positives had to go before it was worth having. */
  const exported = new Set<string>([
    ...[...marketsSrc.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)].map((x) => x[1]),
    // export { a, b as c } — with or without a `from`, and with `type` members
    ...[...marketsSrc.matchAll(/export\s*\{([^}]+)\}/g)].flatMap((x) =>
      x[1].split(",").map((p) => {
        const t = p.trim().replace(/^type\s+/, "");
        const as = t.split(/\s+as\s+/);
        return (as[1] ?? as[0]).trim();
      }).filter(Boolean)),
  ]);
  const missing = names.filter((n) => !exported.has(n));
  check(`all ${names.length} names server.ts imports are exported by markets.ts`,
    missing.length === 0, missing.join(", "));
}

/* ONE WORD, ONE MEANING. "points" meant three different things in this repo at
   once: the opener unit in genesis prose, settled-bet weight on /board, and a
   spendable play-money balance in the ledger. The genesis page contradicted
   ITSELF for weeks -- prose saying "Genesis points", its own board header
   saying "People" fifty lines below. No test in this repo asserts on HTML copy,
   which is exactly why nobody noticed. These two lines pin the separation the
   rename exists to create. */
console.log("\none word, one meaning\n");
{
  const genesis = readFileSync(path.join(ROOT, "public/genesis.html"), "utf8");
  const withoutComments = genesis.replace(/<!--[\s\S]*?-->/g, "");
  /* COPY ONLY. The first draft of this matched `cursor:pointer` in the
     stylesheet and reported the page still talked about points, which is the
     false-positive that gets a test muted. Styles and scripts come out, and the
     needle is the WORD, not the substring. */
  const copy = withoutComments
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "");
  check("public/genesis.html says nothing about points",
    !/\bpoints?\b/i.test(copy),
    (copy.match(/[^\n]*\bpoints?\b[^\n]*/i) ?? [""])[0].trim().slice(0, 70));
  const board = readFileSync(path.join(ROOT, "public/app/board.html"), "utf8");
  check("public/app/board.html still has its Points column", board.includes("Points"));
  check("the opener unit is named on the genesis board",
    withoutComments.includes("<span>Takers</span>"));
}

console.log(failures === 0 ? "\nall shape checks passed.\n" : `\n${failures} shape check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
