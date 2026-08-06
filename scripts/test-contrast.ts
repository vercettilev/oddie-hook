// A static guard against ONE specific, repeated bug.
//
// Three separate times now, a new component has been written with a
// theme-FIXED light background and a theme-ADAPTIVE text colour in the same
// rule. Both tokens are individually correct; together they render near-white
// text on a near-white chip in dark mode — measured contrast ratios of 1.06,
// against a 4.5 requirement. It has been shipped and caught by eye once, and
// caught by measurement twice, which is two times too many for a mistake this
// mechanical.
//
// The pairing is always the same shape: a background that does not respond to
// the theme, plus a foreground that does. So this greps the stylesheet for
// exactly that shape and fails. It cannot catch every contrast problem — it
// is not a renderer and does not compute ratios — but it makes THIS class of
// error impossible to reintroduce silently, which is what kept happening.
//
// Run with: npm run test-contrast

import { readFileSync } from "node:fs";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

const html = readFileSync(new URL("../public/feed.html", import.meta.url), "utf8");
const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
check("the stylesheet was found and read", style.length > 1000, `${style.length} chars`);

/**
 * Backgrounds that DO NOT change between light and dark — measured from the
 * live stylesheet, not assumed:
 *   --wash   #F3FBDA in both themes
 *   --bar    #E7EDF2 in both themes
 * --card-surface is deliberately NOT here: it flips (#FBFDF6 -> #211D2A), so
 * pairing it with adaptive text is correct and flagging it was a false alarm.
 * Its own trap is the opposite one, covered by the second check below.
 */
const FIXED_BG = ["--wash", "--bar"];
/** Foregrounds that DO change: --on-ground #000 -> #F3EFF6, --muted-g likewise. */
const ADAPTIVE_FG = ["--on-ground", "--muted-g"];

// Split into individual rules so a background in one rule and a colour in an
// unrelated one can't produce a false positive.
// Comments are stripped FIRST. Splitting on "}" leaves any comment that
// preceded a rule glued to its selector, which both mangles the reported name
// and breaks the dark-override lookup below (".rankmove" never matches
// "/* … */ .rankmove").
const cssNoComments = style.replace(/\/\*[\s\S]*?\*\//g, "");
const rules = cssNoComments.split("}").map((r) => r.trim()).filter(Boolean);

/**
 * Selectors that a `:root[data-theme="dark"] …` rule gives an explicit
 * background to. Pairing a fixed background with adaptive text is FINE when
 * dark mode overrides that background — .rankmove does exactly this — and
 * flagging it would train people to ignore the check.
 */
const darkOverridden = new Set<string>();
for (const rule of rules) {
  const head = rule.slice(0, rule.indexOf("{"));
  if (!/:root\[data-theme=["']?dark["']?\]/.test(head)) continue;
  if (!/background(-color)?\s*:/.test(rule.slice(rule.indexOf("{") + 1))) continue;
  for (const sel of head.split(",")) {
    const leaf = sel.replace(/:root\[data-theme=["']?dark["']?\]/, "").trim();
    if (leaf) darkOverridden.add(leaf);
  }
}

console.log("\ntheme-fixed background + theme-adaptive text in the same rule");
{
  const offenders: string[] = [];
  for (const rule of rules) {
    const body = rule.slice(rule.indexOf("{") + 1);
    if (!body) continue;
    const bgHit = FIXED_BG.find((t) => new RegExp(`background(-color)?\\s*:[^;]*var\\(\\s*${t}\\s*\\)`).test(body));
    if (!bgHit) continue;
    const fgHit = ADAPTIVE_FG.find((t) => new RegExp(`(^|;)\\s*color\\s*:[^;]*var\\(\\s*${t}\\s*\\)`).test(body));
    if (!fgHit) continue;
    const selector = rule.slice(0, rule.indexOf("{")).replace(/\s+/g, " ").trim().slice(0, 90);
    // A dark-mode background override makes the pairing safe.
    const leaf = selector.split(",").map((x) => x.trim()).find((x) => darkOverridden.has(x));
    if (leaf) continue;
    offenders.push(`${selector}  →  background uses ${bgHit}, color uses ${fgHit}`);
  }
  check(
    "no rule pairs a theme-fixed background with theme-adaptive text",
    offenders.length === 0,
    offenders.length
      ? offenders.join("\n      ") +
        "\n      Fix: use a TRANSLUCENT fill (e.g. rgba(127,127,127,.10)) so the" +
        "\n      background adapts with the text, or hardcode BOTH for one theme."
      : "",
  );
}

console.log("\ntheme-fixed background on a PARENT, adaptive text on a descendant");
{
  // The hole the first check left. It requires both halves in ONE rule, which
  // was a deliberate choice to avoid false positives — and it is exactly how
  // the fourth instance hid:
  //
  //   .standing.pending            { background: var(--wash) }
  //   .standing.pending .standing-tier { color: var(--on-ground) }
  //
  // Same pairing, same invisible heading, two rules. So: collect the selectors
  // that take a fixed background, then look for any rule whose selector is a
  // DESCENDANT of one of them and which sets adaptive text.
  const fixedBgSelectors: string[] = [];
  for (const rule of rules) {
    const body = rule.slice(rule.indexOf("{") + 1);
    if (!body) continue;
    if (!FIXED_BG.some((t) => new RegExp(`background(-color)?\\s*:[^;]*var\\(\\s*${t}\\s*\\)`).test(body))) continue;
    for (const sel of rule.slice(0, rule.indexOf("{")).split(",")) {
      const leaf = sel.replace(/\s+/g, " ").trim();
      if (leaf && !darkOverridden.has(leaf)) fixedBgSelectors.push(leaf);
    }
  }

  const offenders: string[] = [];
  for (const rule of rules) {
    const body = rule.slice(rule.indexOf("{") + 1);
    if (!body) continue;
    const fgHit = ADAPTIVE_FG.find((t) => new RegExp(`(^|;)\\s*color\\s*:[^;]*var\\(\\s*${t}\\s*\\)`).test(body));
    if (!fgHit) continue;
    for (const sel of rule.slice(0, rule.indexOf("{")).split(",")) {
      const leaf = sel.replace(/\s+/g, " ").trim();
      // A descendant selector starts with the ancestor and then keeps going.
      const parent = fixedBgSelectors.find((p) => leaf.startsWith(p + " "));
      if (parent) offenders.push(`${leaf}  →  inherits ${parent}'s fixed background, sets ${fgHit}`);
    }
  }
  check(
    "no rule sets adaptive text inside an element with a theme-fixed background",
    offenders.length === 0,
    offenders.length
      ? [...new Set(offenders)].join("\n      ") +
        "\n      Fix: give the PARENT a translucent fill so both adapt together."
      : "",
  );
}

console.log("\ntheme-fixed light background + a hardcoded LIGHT ink in the dark override");
{
  // The third variant. The first two paired a fixed-light background with an
  // ADAPTIVE token, which is what the checks above look for. This one paired it
  // with a hardcoded light hex inside a dark override:
  //
  //   .mchip-sourced                        { background: var(--bar); color: #5b6672 }
  //   :root[data-theme=dark] .mchip-sourced { color: #9aa6b2 }
  //
  // --bar is #E7EDF2 in both themes, so the dark rule painted light grey on
  // light grey — 2.31:1, measured in the browser. No var() involved anywhere,
  // so nothing above it fired.
  const fixedBgSelectors = new Set<string>();
  for (const rule of rules) {
    const body = rule.slice(rule.indexOf("{") + 1);
    if (!body) continue;
    if (!FIXED_BG.some((t) => new RegExp(`background(-color)?\\s*:[^;]*var\\(\\s*${t}\\s*\\)`).test(body))) continue;
    for (const sel of rule.slice(0, rule.indexOf("{")).split(",")) {
      const leaf = sel.replace(/\s+/g, " ").trim();
      if (leaf) fixedBgSelectors.add(leaf);
    }
  }

  /** Rough luminance of a #rgb/#rrggbb, enough to tell "light ink" from dark. */
  const isLight = (hex: string): boolean => {
    let h = hex.replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.45;
  };

  const offenders: string[] = [];
  for (const rule of rules) {
    const head = rule.slice(0, rule.indexOf("{"));
    if (!/:root\[data-theme=["']?dark["']?\]/.test(head)) continue;
    const body = rule.slice(rule.indexOf("{") + 1);
    const col = /(^|;)\s*color\s*:\s*(#[0-9a-fA-F]{3,8})/.exec(body);
    if (!col || !isLight(col[2])) continue;
    // Does this dark rule ALSO give it a background? Then it is self-consistent.
    if (/background(-color)?\s*:/.test(body)) continue;
    for (const sel of head.split(",")) {
      const leaf = sel.replace(/:root\[data-theme=["']?dark["']?\]/, "").replace(/\s+/g, " ").trim();
      if (fixedBgSelectors.has(leaf)) offenders.push(`${leaf}  →  ${col[2]} ink over a theme-fixed light background`);
    }
  }
  check(
    "no dark override puts light ink on a background that stays light",
    offenders.length === 0,
    offenders.length ? [...new Set(offenders)].join("\n      ") : "",
  );
}

// --card-surface in particular is a trap: it is a LIGHT surface token whose
// value flips dark, so hardcoded dark ink on it disappears in dark mode. The
// real market card's YES/NO tiles are literal #fff for exactly this reason.
console.log("\nhardcoded dark ink on a theme-flipping surface");
{
  const offenders: string[] = [];
  for (const rule of rules) {
    const body = rule.slice(rule.indexOf("{") + 1);
    if (!/background(-color)?\s*:[^;]*var\(\s*--card-surface\s*\)/.test(body)) continue;
    if (!/(^|;)\s*color\s*:\s*#(101010|000|000000|17250a)/i.test(body)) continue;
    offenders.push(rule.slice(0, rule.indexOf("{")).replace(/\s+/g, " ").trim().slice(0, 90));
  }
  check("no rule puts hardcoded dark ink on var(--card-surface)", offenders.length === 0, offenders.join("\n      "));
}

console.log(failures === 0 ? "\nall contrast checks passed.\n" : `\n${failures} contrast check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
