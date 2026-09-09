import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { C, DISPLAY, FONT, META, esc, textWidth } from "./renderCard.js";
import { logoMark } from "./logoMark.js";
import { X_HANDLE } from "../brand.js";

/**
 * The card that goes under a tag we could not price.
 *
 * Silence was the old answer and it was the safe one: a public "I can't make a
 * market out of that" is a reply that helps nobody. This card is the reason to
 * break that rule. It does not say no, it says WHAT A YES LOOKS LIKE, so the
 * person who already went to the trouble of tagging us gets the recipe instead
 * of nothing, and the next tag from that handle is one we can actually mint.
 *
 * That is also why the mascot is the one sweating between the two buttons
 * rather than any of the stickers that point at the reader. The failure is
 * oddie's, drawn as oddie's. A card that mocks the tagger is the single fastest
 * way to get an account muted, and a muted account is the end of the product.
 */

const W = 1000;
const H = 524;
const PAD_L = 70;

const here = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(here, "../../assets/st-decide.png");

// resvg reads png/jpeg, not webp, so the sticker ships as a PNG beside the
// archetype art. Embedded once per process; it is ~350KB and the SVG is thrown
// away after each raster.
let artCache: string | null = null;
function artHref(): string {
  if (artCache) return artCache;
  artCache = `data:image/png;base64,${readFileSync(ART).toString("base64")}`;
  return artCache;
}

const HEAD = "what i can price";
const HEAD_FS = 76;

/** The recipe, in the order a claim gets rejected for missing them. */
const RULES = [
  "a claim with a yes or a no",
  "a date it settles by",
  "an answer somebody can check",
];
const RULE_FS = 30;

/** A drawn tick. The bundled subsets have no U+2713 and resvg renders a
 *  missing glyph as tofu, so every mark on every card here is a path. */
function tick(x: number, y: number, s: number, fill: string): string {
  return `<path d="M${x} ${y + s * 0.52} l${s * 0.34} ${s * 0.34} l${s * 0.62} -${s * 0.86}"
    fill="none" stroke="${fill}" stroke-width="${Math.round(s * 0.26)}"
    stroke-linecap="round" stroke-linejoin="round"/>`;
}

export function renderTeachCard(): string {
  const headTop = 196;
  const ruleTop = 300;
  const ruleStep = 52;

  const rules = RULES.map((r, i) => {
    const y = ruleTop + i * ruleStep;
    return `${tick(PAD_L + 2, y - 20, 26, C.ink)}
    <text x="${PAD_L + 48}" y="${y}" font-family="${META}" font-size="${RULE_FS}" font-weight="700"
          fill="${C.ink}">${esc(r)}</text>`;
  }).join("\n  ");

  const foot = `tag ${X_HANDLE} on one of those`;
  const footFS = 26;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT}">
  <rect width="${W}" height="${H}" fill="${C.accent}"/>

  ${logoMark(PAD_L, 62, 64)}
  <text x="${PAD_L + 85}" y="115" font-family="${DISPLAY}" font-size="46" fill="${C.echo}">oddie</text>
  <text x="${PAD_L + 82}" y="112" font-family="${DISPLAY}" font-size="46" fill="${C.ink}">oddie</text>

  <text x="${PAD_L}" y="${headTop}" font-size="${HEAD_FS}" font-weight="700" fill="${C.ink}">${esc(HEAD)}</text>

  ${rules}

  <text x="${PAD_L}" y="${H - 58}" font-family="${META}" font-size="${footFS}" font-weight="700"
        fill="${C.ink}" fill-opacity="0.68">${esc(foot)}</text>

  <!-- The mascot caught between the two buttons. Sized off the artboard height
       and hung off the right edge so it reads as leaning into the frame. -->
  <image href="${artHref()}" x="${W - 366}" y="82" width="352" height="359"
         preserveAspectRatio="xMidYMid meet"/>
</svg>`;
}

/** The width the footer needs, exported only so a layout test can assert the
 *  line clears the mascot rather than sliding under it. */
export function teachFooterWidth(): number {
  return textWidth(`tag ${X_HANDLE} on one of those`, 26);
}
