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
 * break that rule. It does not announce the refusal, it says how low the bar
 * actually is, so the person who went to the trouble of tagging us gets
 * something back and their next tag is one we can mint.
 *
 * TWO DESIGNS WERE WRONG BEFORE THIS ONE, in opposite directions.
 *
 * The first was a list: three requirements in body text, which is something a
 * reader has to hold in their head and match their own sentence against. It was
 * rejected for being unreadable, and it was.
 *
 * The second fixed that with a worked example - a real claim with the two spans
 * that make it a market underlined on the words themselves - and it taught
 * well. It was replaced anyway, because of what the example SAID. It was a
 * price with a date, which is exactly what every prediction market on the
 * internet already lists, so the one card that leaves this product was teaching
 * people to send us the shape our competitors are built around. oddie's markets
 * come out of arguments on X. No example we could pick was worth that risk, and
 * picking none is not the same as going back to the list.
 *
 * What is left is not a list and not a specimen: it is the whole rule in six
 * words, in display type, as the biggest object on the card. Two lines you pass
 * or fail rather than three you check yourself against. And because it answers
 * "what does it take" rather than "what did you get wrong", it pairs with every
 * line the reply might carry instead of hinging on one of them - which the
 * example version did, while the reply text is chosen at random.
 *
 * The failure stays oddie's, and the mascot is the one sweating between its own
 * two buttons. A card that reads as a correction of the tagger is the fastest
 * way to get the account muted, and a muted account ends the product.
 */
const W = 1000;
const H = 524;
const PAD_L = 70;

/** The cream deckle inside the tear. The landing's --cream: the seam is not a
 *  colour change, it is a piece of paper lifted off another piece of paper, and
 *  the strip of cream along the rip is the whole reason it reads that way. */
const CREAM = "#FBFCF4";

/** Where the lime ends and the black begins, before the tear displaces it. */
const SEAM_Y = 206;
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

/**
 * Above the tear, and the second half of a sentence the reply already started.
 *
 * The text of the post says "i couldn't make a market out of that one." The
 * card answers it. Saying the refusal again up here, which is what an earlier
 * pass did, spent the biggest type on the artboard restating a line the reader
 * has already read two inches higher up, and pushed everything that actually
 * teaches into the bottom third. So the card no longer states the problem at
 * all: X always puts the words above the picture, so the setup is guaranteed to
 * be there, and the card gets its whole surface for the answer.
 *
 * COULD carries the landing's marked-word treatment because it is the hinge
 * between the two halves. The reply's last word was couldn't.
 */
const SAID = ["THIS IS ALL IT TAKES."];
const MARK = "ALL";

/** The whole rule, as two phrases rather than three sentences.
 *  A list is something a reader has to match their own sentence against; two
 *  lines in display type are a stamp they either pass or do not. */
const RULE = ["A YES OR A NO.", "AND A DATE."];

/** The only ask on the card, and the string the reader has to retype. */
const ASK = `tag ${X_HANDLE} under one`;

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

  const headFS = fitDisplay(SAID, HEAD_R - PAD_L, [68, 62, 56, 50, 44]);
  const headBase = [172];

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

  const ruleFS = fitDisplay(RULE, W - PAD_L * 2, [96, 88, 80, 72, 64]);
  const ruleTop = 316;
  const ruleStep = Math.round(ruleFS * 1.02);
  const rules = RULE.map((line, i) => {
    // The second line steps in, the way the landing steps its headline stack.
    const x = PAD_L + (i === 1 ? 22 : 0);
    return `<text x="${x}" y="${ruleTop + i * ruleStep}" font-family="${DISPLAY}" font-size="${ruleFS}"
      fill="${i === 0 ? C.white : C.accent}">${esc(line)}</text>`;
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

  ${rules}

  <text x="${PAD_L}" y="486" font-family="${META}" font-size="28" font-weight="700"
        fill="${C.white}" fill-opacity="0.76">${esc(ASK)}</text>

  <!-- The one object that lives in both fields. Tilted off square and hung so
       the tear crosses it at the wrists: the ghost's head is on the lime and the
       two buttons it cannot choose between are on the black, which is also the
       only arrangement where the yellow YES button has a ground to read against. -->
  <g transform="rotate(-3 779 144)">
    <image href="${artHref()}" x="654" y="16" width="250" height="256"
           preserveAspectRatio="xMidYMid meet"/>
  </g>
</svg>`;
}
