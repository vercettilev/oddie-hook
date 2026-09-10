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
 *  colour change, it is a piece of paper lifted off another piece of paper. */
const CREAM = "#FBFCF4";

/** Where the lime ends and the black begins, before the tear displaces it.
 *  High, because the lime field now carries only the lockup: the sentence is
 *  the card and it takes the room. */
const SEAM_Y = 150;
const DECKLE = 12;
/** The teeth swing about half of this. 54 across 1440 on the landing is 1.9% of
 *  the width; 40 across 1000 is the same rip at this size. */
const TEAR_SCALE = 40;

const here = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(here, "../../assets/st-decide.png");

// resvg reads png/jpeg and silently drops webp - a webp <image> renders as a
// hole with no warning - so the sticker ships as an already-converted PNG.
let artCache: string | null = null;
function artHref(): string {
  if (artCache) return artCache;
  artCache = `data:image/png;base64,${readFileSync(ART).toString("base64")}`;
  return artCache;
}

/**
 * The whole rule, in one sentence.
 *
 * It was a headline plus two lines, and the headline was a pointer at the thing
 * underneath it: "this is all it takes" says nothing the two lines do not
 * already say by being short. One sentence carries both jobs and buys the space
 * back for type.
 *
 * Not a list, which is what the first version was and what got it rejected: a
 * list is three claims a reader has to check their own sentence against, one at
 * a time. This is one sentence they pass or fail.
 *
 * Broken where the sense breaks, not where the line runs out, so each row is a
 * phrase: the two halves of the rule, then the verdict on how small it is.
 */
const RULE = ["A YES OR NO", "AND A DATE", "IS ALL IT TAKES."];
/** The landing's marked-word treatment, on the word that does the work. */
const MARK = "ALL";

/** The only ask on the card, and the string the reader has to retype. */
const ASK = `tag ${X_HANDLE} under one`;

/** Largest size at which every line clears the budget. The copy is fixed, but a
 *  hand-placed size overflows silently the first time somebody adds a word. */
function fitDisplay(lines: readonly string[], maxW: number, sizes: readonly number[]): number {
  for (const fs of sizes) {
    if (lines.every((l) => textWidth(l, fs, "display") <= maxW)) return fs;
  }
  return sizes[sizes.length - 1];
}

export function renderTeachCard(): string {
  /* SIZED AGAINST THE BAND, NOT THE MARGIN. Fitting on width alone picked 104
     and the three lines then ran straight through the footer: Anton is narrow,
     so the widest line cleared the margin long before the block cleared the
     space under the seam. The ladder tops out at what three rows actually fit
     between the tear and the ask. */
  const fs = fitDisplay(RULE, W - PAD_L * 2 - 40, [84, 78, 72, 66]);
  const step = Math.round(fs * 0.98);
  const top = 252;

  // The marked word is painted OVER its own line rather than the line being cut
  // into runs: one run keeps the shaping and the advance widths identical to
  // what was measured, and the x comes off the run before it, so editing the
  // copy cannot leave the mark behind.
  const markRow = RULE.findIndex((l) => l.includes(MARK));
  const markLine = RULE[markRow] ?? "";
  const markX = PAD_L + textWidth(markLine.slice(0, markLine.indexOf(MARK)), fs, "display");
  const markW = textWidth(MARK, fs, "display");
  const markBase = top + markRow * step;

  const lines = RULE.map((line, i) => {
    // The last row is the verdict rather than a half of the rule, so it takes
    // the accent and steps in, the way the landing steps a headline stack.
    const x = PAD_L + (i === 2 ? 20 : 0);
    const fill = i === 2 ? C.accent : C.white;
    const base = `<text x="${x}" y="${top + i * step}" font-family="${DISPLAY}" font-size="${fs}"
      fill="${fill}">${esc(line)}</text>`;
    if (i !== markRow) return base;
    return `${base}
    <text x="${markX + (markRow === 2 ? 20 : 0)}" y="${markBase}" font-family="${DISPLAY}" font-size="${fs}"
      fill="${C.echo}">${esc(MARK)}</text>`;
  }).join("\n  ");

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT}">
  <defs>
    <!-- The seam. Not an image and not a clip-path: fractal noise displacing a
         rectangle, exactly as the landing builds it, so the page and the card
         tear off the same press. Only the rect's BOTTOM edge is ragged; it
         starts off-canvas on the other three sides. -->
    <filter id="tc_tear" filterUnits="userSpaceOnUse" x="-140" y="-140" width="1280" height="620">
      <feTurbulence type="fractalNoise" baseFrequency="0.011 0.02" numOctaves="2" seed="7" result="tc_n"/>
      <feDisplacementMap in="SourceGraphic" in2="tc_n" scale="${TEAR_SCALE}"
        xChannelSelector="R" yChannelSelector="G"/>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" fill="${C.ground}"/>
  <rect x="-80" y="-80" width="1160" height="${SEAM_Y + DECKLE + 80}" fill="${CREAM}" filter="url(#tc_tear)"/>
  <rect x="-80" y="-80" width="1160" height="${SEAM_Y + 80}" fill="${C.accent}" filter="url(#tc_tear)"/>

  ${logoMark(PAD_L, 26, 56)}
  <text x="${PAD_L + 77}" y="77" font-family="${DISPLAY}" font-size="44" fill="${C.echo}">oddie</text>
  <text x="${PAD_L + 74}" y="74" font-family="${DISPLAY}" font-size="44" fill="${C.ink}">oddie</text>

  ${lines}

  <text x="${PAD_L}" y="486" font-family="${META}" font-size="28" font-weight="700"
        fill="${C.white}" fill-opacity="0.76">${esc(ASK)}</text>

  <!-- The one object that lives in both fields, hung so the tear crosses it at
       the wrists: the ghost's head is on the lime and the two buttons it cannot
       choose between are on the black, which is also the only arrangement where
       the yellow YES button has a ground to read against. -->
  <g transform="rotate(-3 812 118)">
    <image href="${artHref()}" x="700" y="14" width="240" height="246"
           preserveAspectRatio="xMidYMid meet"/>
  </g>
</svg>`;
}
