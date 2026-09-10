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
 * break that rule. It does not announce the refusal, it shows the sentence that
 * would have worked, so the person who already went to the trouble of tagging
 * us gets something back and their next tag is one we can mint.
 *
 * TWO THINGS THE FIRST VERSION GOT WRONG, both fixed here.
 *
 * It was not understandable. It set out three abstract requirements and left
 * the reader to match a sentence of their own against them. A list asks you to
 * hold three rules in your head and do the work; this one puts ONE real claim
 * on the card and underlines the two spans that make it a market. The rule sits
 * on top of the words that satisfy it, so there is nothing left to match.
 *
 * It did not look like the product. The landing shouts in Anton caps and tears
 * its fields apart with paper seams; the card whispered in rounded lowercase on
 * a flat field. So the shell is the landing's own: chartreuse above the tear
 * for what just happened, black below it for what to do instead. The seam
 * carries the turn, which is why no word on the card has to say "but".
 *
 * The failure stays oddie's, stated first person and without an apology: "I
 * couldn't", never "that wasn't" and never "you should have". Same reason the
 * mascot is the one sweating between its own two buttons. A card that reads as
 * a correction of the tagger is the fastest way to get the account muted, and a
 * muted account ends the product.
 */

const W = 1000;
const H = 524;
const PAD_L = 70;

/** The cream deckle inside the tear. The landing's --cream: the seam is not a
 *  colour change, it is a piece of paper lifted off another piece of paper, and
 *  the strip of cream along the rip is the whole reason it reads that way. */
const CREAM = "#FBFCF4";

/** Where the lime ends and the black begins, before the tear displaces it. */
const SEAM_Y = 232;
/** The cream showing below the lime teeth. The landing uses 9px at 1440 wide;
 *  a touch more here because this artboard is 1000 and X downscales it again. */
const DECKLE = 13;
/** The teeth swing about half of this. 54 across 1440 on the landing is 1.9% of
 *  the width; 40 across 1000 is the same rip at this size. An earlier pass at
 *  26 read as a wobbly divider rule rather than as paper. */
const TEAR_SCALE = 40;

/** The headline's right edge. The mascot's box starts at 636 but its ink does
 *  not, so the measure runs a little past that. */
const HEAD_R = 618;

const here = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(here, "../../assets/st-decide.png");

// resvg reads png/jpeg and silently drops webp - a webp <image> renders as a
// hole with no warning - so the sticker ships as an already-converted PNG.
// Embedded once per process; the SVG is thrown away after each raster.
let artCache: string | null = null;
function artHref(): string {
  if (artCache) return artCache;
  artCache = `data:image/png;base64,${readFileSync(ART).toString("base64")}`;
  return artCache;
}

/* ------------------------------------------------------------------ copy -- */

/** Above the tear. Split where the sense splits, long line then short, so the
 *  two lines make a staircase instead of a paragraph. MARK gets the landing's
 *  marked-word treatment. */
const SAID = ["I COULDN'T MAKE A MARKET", "OUT OF THAT ONE."];
const MARK = "MARKET";

/** Below the tear, and the turn the seam already made.
 *
 * "I could", not "I can price". Pricing is our word for it and it is dead
 * weight to a stranger, where the plain echo of the headline's "I couldn't"
 * needs nothing explained and no vocabulary the reader does not already have. */
const KICKER = "HERE'S ONE I COULD.";

/**
 * The specimen.
 *
 * A price rather than a fixture or a release date, and that is a durability
 * decision as much as a teaching one: a dated real-world event makes the card
 * wrong the week it resolves, and this asset sits in a reply queue for months.
 * "Dec 31" reads as this year whatever year it is.
 *
 * It is labelled as an example by the kicker above it, so it is not read as a
 * call oddie is making. Nothing on this card is a forecast.
 */
const CLAIM = "SOL closes above $200 on Dec 31";

/**
 * The two spans that made it a market, and the rule each one satisfies.
 *
 * "a yes or a no" sits under the threshold rather than under the whole line,
 * because the threshold is the thing that creates the yes and the no, and that
 * is exactly the part people leave out when they tag us.
 */
const MARKS: ReadonlyArray<{ span: string; label: string }> = [
  { span: "above $200", label: "a yes or a no" },
  { span: "on Dec 31", label: "a deadline" },
];

/** The only ask on the card, and the string the reader has to retype. */
const ASK = `tag ${X_HANDLE} under a line like that`;

/* ----------------------------------------------------------------- type ---- */

/** Nunito, and only Nunito, for anything whose pixel width this card has to
 *  know. textWidth's "meta" mode reads real advance widths off the shipped TTF;
 *  the faceless legacy mode is a deliberately generous approximation, fine for
 *  keeping a line inside a budget and nowhere near good enough to land a 6px
 *  underline under two exact words. The two modes are never mixed. */
function metaW(s: string, fs: number): number {
  return textWidth(s, fs, "meta");
}

/** Largest size at which every line of a display block clears the budget. The
 *  copy is fixed, but it is the kind of copy that gets edited in a hurry, and a
 *  hand-placed headline overflows silently the first time someone adds a word. */
function fitDisplay(lines: readonly string[], maxW: number, sizes: readonly number[]): number {
  for (const fs of sizes) {
    if (lines.every((l) => textWidth(l, fs, "display") <= maxW)) return fs;
  }
  return sizes[sizes.length - 1];
}

export function renderTeachCard(): string {
  /* --- above the tear ----------------------------------------------------- */

  const headFS = fitDisplay(SAID, HEAD_R - PAD_L, [54, 50, 46, 42, 38]);
  const headBase = [150, 150 + Math.round(headFS * 1.02)];

  // The marked word is painted OVER its own line rather than the line being cut
  // into three runs: one run keeps the shaping and the advance widths identical
  // to what was measured. Its x comes off the run that precedes it, so editing
  // the copy cannot leave the mark behind.
  const markAt = SAID.findIndex((l) => l.includes(MARK));
  const markLine = SAID[markAt] ?? "";
  const markX = PAD_L + textWidth(markLine.slice(0, markLine.indexOf(MARK)), headFS, "display");
  const markW = textWidth(MARK, headFS, "display");
  const markBase = headBase[markAt] ?? headBase[0];

  const said = SAID.map((line, i) => {
    // Line two is nudged in: the landing sets each headline line as its own
    // fit-width block precisely so the stack can step rather than align.
    const x = PAD_L + (i === 1 ? 18 : 0);
    const base = `<text x="${x}" y="${headBase[i]}" font-family="${DISPLAY}" font-size="${headFS}"
        fill="${C.ink}">${esc(line)}</text>`;
    if (i !== markAt) return base;
    // Pink on chartreuse measures 2.40:1 and falls apart unmodified, so the
    // marked word carries a real ink stroke rather than the landing's
    // eight-shadow hack, which resvg would draw as eight offset copies.
    return `${base}
      <text x="${markX}" y="${markBase}" font-family="${DISPLAY}" font-size="${headFS}"
        fill="${C.echo}" stroke="${C.ink}" stroke-width="${Math.round(headFS * 0.08)}"
        stroke-linejoin="round" paint-order="stroke">${esc(MARK)}</text>`;
  }).join("\n  ");

  // The rule under the marked word overshoots to the right, and that overshoot
  // is the whole trick: a rule stopping level with the word reads as a
  // text-decoration, one running past it reads as a pen.
  const ulY = markBase + Math.round(headFS * 0.13);
  const ulH = Math.max(6, Math.round(headFS * 0.1));
  const underline = `<g transform="rotate(-0.9 ${(markX + markW / 2).toFixed(1)} ${ulY})">
    <rect x="${(markX - 3).toFixed(1)}" y="${ulY}" width="${(markW + 10).toFixed(1)}" height="${ulH}" fill="${C.ink}"/>
  </g>`;

  /* --- below the tear ----------------------------------------------------- */

  const kickFS = fitDisplay([KICKER], 520, [34, 31, 28]);

  // Step the claim down until it holds ONE line. Wrapping it would cost the one
  // property that makes it teach: a sentence you take in with a single sweep and
  // can retype from memory.
  let claimFS = 58;
  while (claimFS > 34 && metaW(CLAIM, claimFS) > W - PAD_L * 2) claimFS -= 2;
  const claimBase = 392;

  const underY = claimBase + 16;
  const stemBottom = underY + 17;
  const labelFS = 26;
  const labelBase = stemBottom + Math.round(0.72 * labelFS);

  const marks = MARKS.map(({ span, label }, i) => {
    const at = CLAIM.indexOf(span);
    // A span missing from the claim would silently place its mark at the left
    // edge of the line. Drop it instead: nothing here draws a coordinate it
    // cannot justify.
    if (at < 0) return "";
    const x = PAD_L + metaW(CLAIM.slice(0, at), claimFS);
    const w = metaW(span, claimFS);
    const cx = x + w / 2;
    // Labels alternate their tilt by a degree and a half. Nothing in this brand
    // rests at zero, and a hand-set annotation is where that reads as intent
    // rather than as a rendering accident.
    const rot = i % 2 === 0 ? -1.6 : 1.6;
    return `<rect x="${Math.round(x)}" y="${underY}" width="${Math.round(w)}" height="6" rx="3" fill="${C.echo}"/>
  <rect x="${Math.round(cx - 2)}" y="${underY + 6}" width="4" height="11" fill="${C.echo}"/>
  <text x="${Math.round(cx)}" y="${labelBase}" font-family="${META}" font-size="${labelFS}" font-weight="700"
        letter-spacing="0.6" fill="${C.echo}" text-anchor="middle"
        transform="rotate(${rot} ${Math.round(cx)} ${labelBase})">${esc(label)}</text>`;
  }).join("\n  ");

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT}">
  <defs>
    <!-- The seam. Not an image and not a clip-path: fractal noise displacing a
         rectangle, exactly as the landing builds it, so the page and the card
         tear off the same press. The rect starts 80px off-canvas left, right and
         top, so only its BOTTOM edge is ragged. The y frequency is deliberately
         slow - the cream is a second copy of this same rect sitting 13px lower,
         and if the noise field turned over inside those 13px the deckle would
         vanish in patches. -->
    <filter id="tc_tear" filterUnits="userSpaceOnUse" x="-140" y="-140" width="1280" height="620">
      <feTurbulence type="fractalNoise" baseFrequency="0.011 0.02" numOctaves="2" seed="7" result="tc_n"/>
      <feDisplacementMap in="SourceGraphic" in2="tc_n" scale="${TEAR_SCALE}"
        xChannelSelector="R" yChannelSelector="G"/>
    </filter>
  </defs>

  <!-- Ground two is the whole card; ground one is torn off the top of it. -->
  <rect width="${W}" height="${H}" fill="${C.ground}"/>
  <rect x="-80" y="-80" width="1160" height="${SEAM_Y + DECKLE + 80}" fill="${CREAM}" filter="url(#tc_tear)"/>
  <rect x="-80" y="-80" width="1160" height="${SEAM_Y + 80}" fill="${C.accent}" filter="url(#tc_tear)"/>

  ${logoMark(PAD_L, 26, 56)}
  <text x="${PAD_L + 77}" y="77" font-family="${DISPLAY}" font-size="44" fill="${C.echo}">oddie</text>
  <text x="${PAD_L + 74}" y="74" font-family="${DISPLAY}" font-size="44" fill="${C.ink}">oddie</text>

  ${said}
  ${underline}

  <text x="${PAD_L}" y="300" font-family="${DISPLAY}" font-size="${kickFS}" fill="${C.accent}">${esc(KICKER)}</text>

  <text x="${PAD_L}" y="${claimBase}" font-family="${META}" font-size="${claimFS}" font-weight="700"
        fill="${C.white}">${esc(CLAIM)}</text>
  ${marks}

  <text x="${PAD_L}" y="496" font-family="${META}" font-size="28" font-weight="700"
        fill="${C.white}" fill-opacity="0.76">${esc(ASK)}</text>

  <!-- The one object that lives in both fields. Tilted off square and hung so
       the tear crosses it at the wrists: the ghost's head is on the lime and the
       two buttons it cannot choose between are on the black, which is also the
       only arrangement where the yellow YES button has a ground to read against. -->
  <g transform="rotate(-3 782 190)">
    <image href="${artHref()}" x="646" y="40" width="272" height="278"
           preserveAspectRatio="xMidYMid meet"/>
  </g>
</svg>`;
}
