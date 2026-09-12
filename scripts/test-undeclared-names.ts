/**
 * NO BROWSER FILE MAY READ A NAME THAT WAS NEVER DECLARED.
 *
 * This is the failure that hides best in this codebase, and it has now cost a
 * live market. `void seatsP.then(...)` sat in the middle of the stake sheet
 * referencing a promise that existed nowhere in the file. It parses. `node
 * --check` passes it. tsc never looked, because tsc does not read public/. So
 * the sheet opened, drew the odds, drew the payout line, drew the confirm
 * button with the right side and the right amount, threw a ReferenceError on
 * that one line, and never reached the assignment three lines below it that
 * attaches the click handler. The button did nothing. Nothing was disabled,
 * nothing was logged anywhere a person would look, and the only trace was one
 * line in a console nobody had open.
 *
 * The check is tsc's own "Cannot find name" (TS2304) with checkJs on, run over
 * the shipped browser files against the DOM lib. Only TS2304 is read: these
 * files are plain JS and were never written to satisfy a type checker, so every
 * other diagnostic is noise. An undeclared identifier is not noise. It is
 * always a bug, and it is always the kind that survives every other test here.
 *
 * THE .js FILES ARE THE SMALLER HALF. you.html, market.html, markets.html,
 * board.html, who.html, landing.html, genesis.html and tool.html keep nearly
 * all of their behaviour in one inline <script>, and for a long time this check
 * could not see a line of it -- the walker collected `.js` and stopped, so the
 * five standalone files were checked and the several thousand lines that
 * actually run the app were not. The sheet that lost the market IS one of those
 * inline blocks. So each page's inline blocks are now concatenated into a temp
 * .js file that joins the same tsc run, and every TS2304 found in one is
 * reported against the .html it came from, at the .html's own line number: a
 * line number in a copy nobody can open points at nothing.
 *
 * Concatenating a page's blocks is not a shortcut. The browser runs every
 * classic inline block of a page in ONE shared global scope, so a name that
 * block 2 reads and block 1 declared is declared -- checking the blocks apart
 * would invent undeclared names that are nothing of the kind.
 *
 * Still one tsc run for everything. The compiler start-up dominates, and a
 * per-file loop turned a two-second check into twenty.
 *
 * Run with: npm run test-undeclared-names
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { filesUnder, inlineBlocks } from "./inline-blocks.js";

const jsFiles = filesUnder("public", ".js").sort();
const htmlFiles = filesUnder("public", ".html").sort();

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

console.log("\nundeclared names in shipped browser files\n");
check("there are browser files to check at all", jsFiles.length > 0, "public/ has no .js");
check("there are pages to check at all", htmlFiles.length > 0, "public/ has no .html");

/** A page's inline blocks joined into one file, with the table that turns a
 *  line of that file back into a line of the .html. */
function pageScript(html: string): { code: string; lineOf: number[] } {
  const lines: string[] = [];
  const lineOf: number[] = [];               // parallel to lines; 0 = ours, not theirs
  for (const b of inlineBlocks(html)) {
    for (const [i, line] of b.code.split("\n").entries()) {
      lines.push(line);
      lineOf.push(b.line + i);
    }
    // Separate <script>s to the browser, so the last token of one must not run
    // into the first token of the next. A bare `;` is always a valid statement.
    lines.push(";");
    lineOf.push(0);
  }
  return { code: lines.join("\n"), lineOf };
}

/** Every name public/**\/*.js publishes with `window.X = ...`.
 *
 *  These are real globals -- a classic <script src> sets them before the inline
 *  block that reads them runs -- but tsc does not read a property assignment as
 *  a declaration, so to the checker every BARE use of one is an undeclared
 *  name. Measured: with no declaration, `OddieChain.init` in an inline block is
 *  a TS2304 while `window.OddieChain.init` is not, which is the only reason the
 *  pages got away with it -- they happen to go through `window.` everywhere.
 *  Declaring them is not silencing the check. The list is derived, never typed
 *  out, so it cannot claim a global that public/ does not actually set, and a
 *  name that is set NOWHERE stays exactly what this check exists to catch. */
function publishedGlobals(files: string[]): string[] {
  const names = new Set<string>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) names.add(m[1]!);
  }
  return [...names].sort();
}

const scratch = mkdtempSync(join(tmpdir(), "oddie-undeclared-"));
type Page = { html: string; lineOf: number[] };
const pages = new Map<string, Page>();       // temp file BASENAME -> page it came from
const tempFiles: string[] = [];
let pagesWithoutScript = 0;

try {
  for (const f of htmlFiles) {
    const { code, lineOf } = pageScript(readFileSync(f, "utf8"));
    if (!code.trim()) { pagesWithoutScript++; continue; }
    const base = f.replace(/[^A-Za-z0-9]+/g, "_") + ".js";
    writeFileSync(join(scratch, base), code);
    tempFiles.push(join(scratch, base));
    pages.set(base, { html: f, lineOf });
  }

  const globals = publishedGlobals(jsFiles);
  const globalsFile = join(scratch, "oddie-globals.d.ts");
  writeFileSync(globalsFile, globals.map((n) => `declare var ${n}: any;`).join("\n") + "\n");

  let out = "";
  try {
    execFileSync("npx", [
      "tsc", "--allowJs", "--checkJs", "--noEmit",
      "--target", "es2022", "--lib", "es2022,dom,dom.iterable",
      "--skipLibCheck", globalsFile, ...jsFiles, ...tempFiles,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    // tsc exits non-zero whenever it reports anything, and it reports plenty in
    // files that were never typed. The exit code is not the signal; TS2304 is.
    out = String((e as { stdout?: string }).stdout ?? "") + String((e as { stderr?: string }).stderr ?? "");
  }

  const undeclared = out.split("\n").filter((l) => l.includes("error TS2304"));

  for (const f of jsFiles) {
    const hits = undeclared.filter((l) => l.startsWith(f + "("));
    check(`${f} reads only names it declares`, hits.length === 0, hits.join("\n      "));
  }

  // tsc prints the temp files at a path relative to cwd, which is neither the
  // path we wrote nor one worth showing anyone. The basename is what survives.
  for (const [base, page] of pages) {
    const hits: string[] = [];
    for (const l of undeclared) {
      const m = /^(.+?)\((\d+),(\d+)\): (.*)$/.exec(l);
      if (!m || basename(m[1]!) !== base) continue;
      const htmlLine = page.lineOf[Number(m[2]) - 1] ?? 0;
      hits.push(`${page.html}(${htmlLine || "?"},${m[3]}): ${m[4]}`);
    }
    check(`${page.html} reads only names it declares`, hits.length === 0, hits.join("\n      "));
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${jsFiles.length} script file(s), ${pages.size} page(s) with inline script` +
  (pagesWithoutScript ? `, ${pagesWithoutScript} page(s) with none` : ""));
console.log(failures === 0 ? "\nall undeclared-name checks passed.\n" : `\n${failures} undeclared-name check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
