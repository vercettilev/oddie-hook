import { C, FONT, META, textWidth, esc } from "./renderCard.js";
import { logoMark } from "./logoMark.js";
import { X_HANDLE } from "../brand.js";

// The unfurl image: what X, iMessage and Slack show when anyone posts a bare
// oddie.fun link. Every other card here is drawn per market; this one is the
// product's own face, and it is the single most-seen brand asset we have,
// because it renders on every share of the root link whether or not the sharer
// ever opens the app.
//
// It used to be a hand-made PNG checked into public/. That asset was cut before
// the rebrand and then never moved: it kept shipping the retired mint-lime, an
// older mascot drawing, and the line "get the market" long after the palette
// became the chartreuse the app actually uses and the headline became "turn
// arguments into markets". Nothing pointed at the drift, because a static file
// has no relationship to the tokens it was drawn from — the app moved and the
// picture could not follow.
//
// So it is drawn here, from the same C palette, the same bundled faces and the
// same logoMark as every other card. Changing the brand colour now changes this
// image, which is the property the PNG could never have.

const W = 1000;
const H = 524;

const PAD_L = 70;
/** The headline's width budget. Everything right of this belongs to the chips. */
const COL_R = 566;
const CONTENT_W = COL_R - PAD_L;

const HEAD = ["start markets.", "earn when they spread."];
const HEAD_FS_MAX = 82;
const CAP = 0.72;

/** The mechanic, stated in the two words the product is about. */
const SUB = [`tag ${X_HANDLE} on X.`, "being loud pays."];
const SUB_FS = 26;

/** A chip: the yes/no pair is the fastest way to say "prediction market"
 *  without a sentence. Tilted a few degrees each so the pair reads as drawn
 *  rather than as a form, which is the register the logo is in. */
function chip(o: {
  x: number; y: number; w: number; h: number; rot: number;
  label: string; pct: string; fill: string; stroke: string; labelFill: string; pctFill: string;
}): string {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const labelFS = 26;
  const pctFS = 52;
  const gap = 16;
  // Label and number share one baseline, centred as a unit so the chip's
  // padding stays even whatever the digits are (a 9% chip and a 68% chip).
  const inner = textWidth(o.label, labelFS) + gap + textWidth(o.pct, pctFS);
  const left = cx - inner / 2;
  const base = cy + (CAP * pctFS) / 2;
  return `<g transform="rotate(${o.rot} ${cx} ${cy})">
    <rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" rx="${Math.round(o.h * 0.3)}"
          fill="${o.fill}" stroke="${o.stroke}" stroke-width="8"/>
    <text x="${Math.round(left)}" y="${Math.round(base)}" font-family="${META}" font-size="${labelFS}"
          font-weight="700" fill="${o.labelFill}">${esc(o.label)}</text>
    <text x="${Math.round(left + textWidth(o.label, labelFS) + gap)}" y="${Math.round(base)}"
          font-size="${pctFS}" font-weight="700" fill="${o.pctFill}">${esc(o.pct)}</text>
  </g>`;
}

export function renderBanner(): string {
  // Same measured-not-placed rule as the market card: step the headline down
  // until the longest line clears its column, so a copy edit can never push a
  // word off the image silently.
  let fs = HEAD_FS_MAX;
  while (fs > 40 && Math.max(...HEAD.map((l) => textWidth(l, fs))) > CONTENT_W) fs -= 2;
  const lineH = Math.round(fs * 1.04);
  // Chosen so the gap under the lockup and the margin under the last sub line
  // come out within ~10px of each other at the shipped copy length; the block
  // hangs off this one number, so a longer headline moves down as a unit.
  const headTop = 216;
  const headTspans = HEAD
    .map((l, i) => `<tspan x="${PAD_L}" y="${headTop + Math.round(CAP * fs) + i * lineH}">${esc(l)}</tspan>`)
    .join("");

  const subTop = headTop + Math.round(CAP * fs) + (HEAD.length - 1) * lineH + 54;
  const subTspans = SUB
    .map((l, i) => `<tspan x="${PAD_L}" y="${subTop + i * Math.round(SUB_FS * 1.35)}">${esc(l)}</tspan>`)
    .join("");

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT}">
  <rect width="${W}" height="${H}" fill="${C.accent}"/>

  <!-- Mark and wordmark only. brandLockup() also sets the handle, in C.muted —
       a blue-grey tuned for white grounds that goes murky on the accent — and
       the handle is doing better work down in the sub line, where it is an
       instruction ("tag @oddiefun on X") rather than a credit. -->
  ${logoMark(PAD_L, 62, 64)}
  <text x="${PAD_L + 85}" y="115" font-size="46" font-weight="600" fill="${C.echo}">oddie</text>
  <text x="${PAD_L + 82}" y="112" font-size="46" font-weight="600" fill="${C.ink}">oddie</text>

  <text font-size="${fs}" font-weight="700" fill="${C.ink}">${headTspans}</text>
  <text font-family="${META}" font-size="${SUB_FS}" font-weight="700" fill="${C.ink}"
        fill-opacity="0.72">${subTspans}</text>

  ${chip({ x: 618, y: 148, w: 292, h: 104, rot: -4, label: "yes", pct: "68%",
           fill: C.white, stroke: C.ink, labelFill: C.muted, pctFill: C.ink })}
  ${chip({ x: 646, y: 292, w: 268, h: 96, rot: 3, label: "no", pct: "32%",
           fill: C.ink, stroke: C.ink, labelFill: C.white, pctFill: C.accent })}
</svg>`;
}
