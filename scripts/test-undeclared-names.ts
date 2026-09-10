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
 * Run with: npm run test-undeclared-names
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsFiles(p));
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

const files = jsFiles("public").sort();
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

console.log("\nundeclared names in shipped browser files\n");
check("there are browser files to check at all", files.length > 0, "public/ has no .js");

// One tsc run for the whole set: the compiler start-up dominates, and a
// per-file loop turned a two-second check into twenty.
let out = "";
try {
  execFileSync("npx", [
    "tsc", "--allowJs", "--checkJs", "--noEmit",
    "--target", "es2022", "--lib", "es2022,dom,dom.iterable",
    "--skipLibCheck", ...files,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  // tsc exits non-zero whenever it reports anything, and it reports plenty in
  // files that were never typed. The exit code is not the signal; TS2304 is.
  out = String((e as { stdout?: string }).stdout ?? "") + String((e as { stderr?: string }).stderr ?? "");
}

const undeclared = out.split("\n").filter((l) => l.includes("error TS2304"));
for (const f of files) {
  const hits = undeclared.filter((l) => l.startsWith(f + "("));
  check(`${f} reads only names it declares`, hits.length === 0, hits.join("\n      "));
}

console.log(failures === 0 ? "\nall undeclared-name checks passed.\n" : `\n${failures} undeclared-name check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
