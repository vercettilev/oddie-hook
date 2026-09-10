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

/* HIDDEN HAS TO MEAN HIDDEN.
   chain.js hides elements by setting the `hidden` attribute, and every
   `display:` in this stylesheet outranks the UA rule that would honour it. The
   partner rule was forgotten twice -- the custom amount field sat open before
   anybody chose "Other", and the collapsed side buttons carried on being drawn
   under the confirm line that replaced them. Both times the sheet looked
   plausible and did the wrong thing, which is the hardest kind of wrong to
   notice. The blanket rule at the foot of the file closes it; this makes sure
   nobody removes it. */
check("[hidden] beats every display: in the file",
  /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/.test(cssText),
  "money.css must end with a blanket [hidden]{display:none !important}");

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

/* ---------------------------------- the money control is attached first ---- */
// A dead confirm button is the worst bug this sheet can have, because it is the
// one the user cannot tell from a slow network: the page looks right and does
// nothing. It has happened once, and the cause was an OPTIONAL feature sitting
// above the handler and throwing, so the assignment under it never ran.
//
// The invariant is ordering: whatever is attached first cannot be taken down by
// what is attached after it, so the button that moves money goes first and the
// seat offer, which is an extra, goes last. Asserted on the source because the
// two lines are hundreds apart and nothing else makes their order look load-bearing.
{
  const js = readFileSync("public/chain.js", "utf8");
  const handlerAt = js.indexOf("stakeBtn.onclick = async");
  const seatAt = js.indexOf("void seatsP.then");
  check("the stake sheet attaches its confirm handler", handlerAt > 0);
  check("the seat offer is attached AFTER it, so an extra cannot kill the button",
    seatAt > handlerAt, `handler at ${handlerAt}, seat at ${seatAt}`);
  check("...and the seat block is wrapped, so a throw there is contained",
    /try \{[\s\S]{0,400}void seatsP\.then/.test(js));
}

console.log(failures === 0
  ? "\nall money-stylesheet checks passed.\n"
  : `\n${failures} money-stylesheet check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
