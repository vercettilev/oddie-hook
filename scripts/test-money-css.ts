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

/** A <script> TAG, not a mention. This was `html.includes("/chain.js")`, so a
 *  COMMENT naming the file counted as loading it, and the first comment that
 *  pointed a reader at public/chain.js turned a passing shell into a failure
 *  with a message about stylesheets. A test that cannot tell a reference from a
 *  load gets worked around instead of read. */
const loadsChain = (html: string): boolean =>
  /<script[^>]+src=["'][^"']*\/chain\.js/i.test(html);

const shells = readdirSync(appDir).filter((f) => f.endsWith(".html"));
check("there are app shells to check", shells.length > 0, `found ${shells.length}`);

for (const f of shells) {
  const html = readFileSync(path.join(appDir, f), "utf8");
  // A <script> TAG, not a mention. This read `html.includes("/chain.js")`, so a
  // COMMENT naming the file counted as loading it, and the first comment that
  // pointed a reader at public/chain.js turned a passing shell into a failure
  // with a message about stylesheets. A test that cannot tell a reference from
  // a load will eventually be worked around instead of read.
  if (!loadsChain(html)) {
    console.log(`  ·  ${f} does not load chain.js, so it cannot open a sheet`);
    continue;
  }
  check(`${f} loads chain.js AND money.css`, html.includes("/app/money.css"),
    "it can open the money sheet and would render it unstyled");
}

// The other direction is not a bug, only waste, so it is reported not failed.
for (const f of shells) {
  const html = readFileSync(path.join(appDir, f), "utf8");
  if (html.includes("/app/money.css") && !loadsChain(html)) {
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

/* ------------------------------------------- share goes where it says ------ */
// navigator.share exists on desktop Safari and Chrome, where it offers AirDrop,
// Messages, Notes, Freeform and Reminders. A button reading POST YOUR CALL
// opened that menu, and X was not in it. The rule that came out of it:
//   a control naming ONE destination goes straight there, always;
//   a control saying only "Share" may use the OS sheet, but only on a device
//   where that sheet is any good, which is a coarse pointer, not the mere
//   presence of the API.
{
  const chain = readFileSync("public/chain.js", "utf8");
  // Comments may name it; a call may not.
  const calls = (l: string) => /(?<!\/\/.*)navigator\.share\s*\(/.test(l) || /if\s*\(\s*navigator\.share/.test(l);
  const chainCalls = chain.split("\n").filter((l) => calls(l) && !l.trim().startsWith("*") && !l.trim().startsWith("//"));
  check("the post-your-call button never hands off to the OS share sheet",
    chainCalls.length === 0, chainCalls.join(" | "));

  for (const f of ["public/app/market.html", "public/app/who.html"]) {
    const src = readFileSync(f, "utf8");
    const uses = src.includes("navigator.share");
    const guarded = /navigator\.share\s*&&\s*matchMedia\("\(pointer:coarse\)"\)\.matches/.test(src);
    check(`${f} offers the OS sheet only on a touch device`, !uses || guarded);
    check(`...and still falls through to the X composer`,
      !uses || /x\.com\/intent\/tweet/.test(src));
  }
}

/* ------------------------------- text that survived a palette migration ---- */
// markets.html carries TWO card palettes: an early dark one whose text comes
// from the --fg-* ramp (white at three opacities) and a later cream one that
// re-colours each rule to ink. When the card went cream, one rule was missed,
// and the market's actual question rendered as white at 50% on cream - about
// 1.01:1, which is not faint, it is invisible. It shipped, and it took a phone
// screenshot to find, because on a big screen nobody reads the small line under
// a headline they can already read.
//
// The check is the shape of the mistake, not the instance: the card is cream,
// so no rule that paints text ON the card may take its colour from the ramp
// built for the dark one.
{
  const src = readFileSync("public/app/markets.html", "utf8");
  const creamCard = /\.card\{background:var\(--cream\)/.test(src);
  check("markets.html still draws its cards on cream", creamCard);

  // Rules after the cream .card declaration are the ones that land on it.
  const from = src.indexOf(".card{background:var(--cream)");
  const after = from > 0 ? src.slice(from) : "";
  const onCream = [...after.matchAll(/^(\.card[^{]*|\.pool[^{]*)\{([^}]*)\}/gm)]
    .filter((m) => /color:\s*var\(--fg/.test(m[2]));
  check("...and no text on a cream card is coloured from the dark card's ramp",
    onCream.length === 0, onCream.map((m) => m[1].trim()).join(" | "));

  // The same class is reused for a number-plus-label row and for a sentence.
  // Only the first one wants to be a flex container.
  const quiet = after.match(/\.pool--quiet\{([^}]*)\}/)?.[1] ?? "";
  check("the sentence variant of .pool is not laid out as a flex row",
    /display:\s*block/.test(quiet), quiet);
}

/* ------------------------- a render that owns a container must be awaited -- */
// loadMarkets ASSIGNS view.innerHTML when its fetch resolves. The first change
// that needed to put something beside the list appended the X ask and then
// watched it vanish a moment later, silently: no error, nothing in the console,
// the element simply overwritten by the render it was racing. It was only found
// by reading the live DOM on a phone-width browser.
{
  const src = readFileSync("public/app/markets.html", "utf8");
  check("loadMarkets hands back its promise, so anything can be drawn after it",
    /function loadMarkets\(\)\s*\{(?:\s*\/\*[\s\S]*?\*\/)?\s*return fetch\(/.test(src));
  check("...and the X ask waits for it rather than racing it",
    /loadMarkets\(\);?[\s\S]{0,200}?\.then\(xgate\)/.test(src) || /listed\.then\(xgate\)/.test(src));
  // Appended, never assigned: an assignment here would wipe the list it is
  // supposed to sit under, which is the same collision in the other direction.
  check("the X ask is appended under the markets, not written over them",
    /view\.appendChild\(/.test(src) && !/view\.innerHTML\s*=\s*'<div class="gate"/.test(src));
}

/* ------------------------------------- rent is spent on intent, not looks --- */
// Minting a market costs the admin wallet 0.0029 SOL of rent, and it used to
// fire the moment the stake sheet OPENED - before an amount, before a wallet,
// before any signature. A tap on a card is not a decision, and with the app
// public that made every idle look at a market cost real money. The mint now
// waits for an explicit amount, which is the first action in this sheet that
// cannot happen by accident.
{
  const js = readFileSync("public/chain.js", "utf8");
  // The semicolon is the point: `function ensureOnChain(slug) {` is the
  // definition and matched the loose pattern, so the first version of this
  // check counted two and failed against correct code.
  const calls = [...js.matchAll(/ensureOnChain\(slug\);/g)].length;
  check("the mint is fired from exactly one place", calls === 1, String(calls));

  const chipAt = js.indexOf("chips.forEach((c) => c.onclick");
  const mintAt = js.indexOf("ensureOnChain(slug);");
  const sideAt = js.indexOf("sideBtns.forEach((b) => b.onclick");
  check("...and that place is the amount handler, not the side handler",
    chipAt > 0 && mintAt > chipAt && (sideAt < 0 || mintAt > sideAt),
    `chips@${chipAt} mint@${mintAt} sides@${sideAt}`);

  // Free warm-ups are a different thing and must NOT move with it: fetching a
  // library from a CDN costs nothing and only ever saves a wait.
  check("the free web3 warm-up still runs as soon as a side exists",
    /if \(side\) \{[\s\S]{0,900}?loadWeb3\(\)/.test(js));
}

console.log(failures === 0
  ? "\nall money-stylesheet checks passed.\n"
  : `\n${failures} money-stylesheet check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
