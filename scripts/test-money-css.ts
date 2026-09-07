/**
 * A SHELL THAT CAN OPEN THE MONEY SHEET MUST CARRY ITS STYLESHEET.
 *
 * public/chain.js builds the stake and claim sheets out of .cdim / .csheet, and
 * every rule for those lives in public/app/money.css -- including .cdim's
 * position:fixed. A page that loads chain.js without the stylesheet still opens
 * the sheet, and it opens as RAW HTML: no overlay, no dialog, the amount chips
 * as bare browser controls, and every reopen stacking down the page instead of
 * covering it.
 *
 * That shipped. markets.html, the app's front door, whose cards call
 * OddieChain.openStake from their YES/NO buttons, loaded chain.js and not
 * money.css. Nothing caught it: both files are fine on their own, both are
 * served, and the pairing between them existed only in whoever remembered it.
 *
 * Cheap to assert, so it is asserted: if a shell references chain.js it must
 * reference money.css, and the file has to exist.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const appDir = path.join(root, "public/app");

let failures = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (ok) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
};

console.log("\nthe money sheet's stylesheet travels with chain.js\n");

const css = path.join(appDir, "money.css");
check("public/app/money.css exists", existsSync(css));

// The sheet's own scaffolding, so a rename of either class is caught here
// rather than by somebody meeting an unstyled dialog with their wallet open.
const cssText = existsSync(css) ? readFileSync(css, "utf8") : "";
check("it styles .cdim, which is what makes the sheet an overlay",
  /\.cdim\s*\{/.test(cssText) && /position\s*:\s*fixed/.test(cssText));
check("it styles .csheet, the dialog itself", /\.csheet/.test(cssText));

const shells = readdirSync(appDir).filter((f) => f.endsWith(".html"));
check("there are app shells to check", shells.length > 0, `found ${shells.length}`);

for (const f of shells) {
  const html = readFileSync(path.join(appDir, f), "utf8");
  const usesChain = html.includes("/chain.js");
  if (!usesChain) {
    console.log(`  ·  ${f} does not load chain.js, so it cannot open a sheet`);
    continue;
  }
  check(`${f} loads chain.js AND money.css`, html.includes("/app/money.css"),
    "it can open the money sheet and would render it unstyled");
}

// The other direction is not a bug, only waste, so it is reported not failed.
for (const f of shells) {
  const html = readFileSync(path.join(appDir, f), "utf8");
  if (html.includes("/app/money.css") && !html.includes("/chain.js")) {
    console.log(`  ·  ${f} loads money.css but never chain.js (harmless, unused)`);
  }
}

console.log(failures === 0
  ? "\nall money-stylesheet checks passed.\n"
  : `\n${failures} money-stylesheet check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
