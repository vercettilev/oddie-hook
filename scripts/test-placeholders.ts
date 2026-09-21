/**
 * EVERY SLOT THE SERVER WRITES INTO HAS TO EXIST IN THE PAGE.
 *
 * The server renders its dynamic bits by string replacement:
 *
 *     LANDING_HTML.replace("<!--PROOF-->", proof)
 *
 * If the slot is later deleted from the HTML, .replace() finds nothing and
 * returns the string unchanged. No throw, no log, no visible difference,
 * because the value is usually empty until the day it is not. The page simply
 * stops carrying something the server still believes it renders.
 *
 * This has happened TWICE in this repo. public/landing.html:1110 records the
 * first one, with NET_CHIP: "Yer tutucu HTML'den cikarilmisti ama onu arayan
 * .replace() hala server.ts'te duruyordu: mantik dogru calisiyor ve hicbir
 * yere basmiyordu." The second was LIVE_CARDS and LIVE_MODE, deleted from the
 * page in e169921 with the builder left standing, so on the day the 15th
 * market opened the server would have rendered six real market cards and
 * thrown all six at a slot that was not in the document.
 *
 * The class of bug is invisible to types, to tsc and to every other test here,
 * because both sides are just strings. So it gets its own check: for each
 * .replace("<!--NAME-->") in the server, some file under public/ must contain
 * that exact comment.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

let failures = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (ok) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
};

console.log("\nserver placeholders exist in the pages they target\n");

const serverRaw = readFileSync(path.join(root, "src/server.ts"), "utf8");
// COMMENTS ARE NOT CALLS. The first run of this check failed on <!--NAME-->,
// which exists only inside a doc-comment in server.ts explaining this very
// test. A scan that counts prose as code is the same mistake it is meant to
// catch, one level up, so the comments come out before anything is matched.
const server = serverRaw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// Every public/*.html, plus the app shells: the server reads shells from both
// places, so a slot may legitimately live in either.
const htmlFiles: string[] = [];
for (const dir of ["public", "public/app"]) {
  const abs = path.join(root, dir);
  for (const f of readdirSync(abs)) {
    if (f.endsWith(".html")) htmlFiles.push(path.join(abs, f));
  }
}
const haystack = htmlFiles.map((f) => readFileSync(f, "utf8")).join("\n");

// The replacement targets, taken from the source rather than a hand-kept list:
// a list that has to be updated by hand is the same failure one level up.
const names = [...server.matchAll(/\.replace\(\s*"<!--([A-Z_]+)-->"/g)].map((m) => m[1]);
const unique = [...new Set(names)];

/* THE SCAN IS PROVED AGAINST A SAMPLE, NOT AGAINST PRODUCTION.
   It used to assert that the server replaces at least one placeholder, on the
   reasoning that a scanner finding nothing might be a broken scanner. That was
   right until the answer legitimately became zero: both slots were removed
   with their code, and a correct scanner reporting the truth failed the suite.
   So the scanner now proves itself on a string this file owns, and zero
   placeholders in the real source is an ordinary pass. */
const SAMPLE = 'x.replace("<!--SAMPLE_SLOT-->", y)';
check("the scan finds a placeholder it is given (the scan works)",
  [...SAMPLE.matchAll(/\.replace\(\s*"<!--([A-Z_]+)-->"/g)].map((m) => m[1])[0] === "SAMPLE_SLOT");
console.log(`  – ${unique.length} placeholder(s) in src/server.ts`);

for (const name of unique) {
  const slot = `<!--${name}-->`;
  const where = htmlFiles.filter((f) => readFileSync(f, "utf8").includes(slot));
  check(`<!--${name}--> exists in a page the server serves`, haystack.includes(slot),
    where.length ? "" : `no file under public/ contains ${slot}, so the .replace() is a no-op`);
}

// And the other direction, which is the cheaper half of the same mistake: a
// slot sitting in a page that nothing fills renders as a literal HTML comment
// forever, which is harmless but means somebody's feature is silently absent.
const inPages = [...haystack.matchAll(/<!--([A-Z_]{3,})-->/g)].map((m) => m[1]);
for (const name of [...new Set(inPages)]) {
  check(`<!--${name}--> in a page is actually filled by the server`,
    server.includes(`"<!--${name}-->"`),
    `the slot exists but no .replace() targets it`);
}

console.log(failures === 0
  ? "\nall placeholder checks passed.\n"
  : `\n${failures} placeholder check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
