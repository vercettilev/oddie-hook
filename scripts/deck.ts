/**
 * The deck, drawn from the same brand the product is drawn from.
 *
 * WHY IT IS GENERATED AND NOT DESIGNED IN A TOOL. Every number and every claim
 * on these slides is one this repo can be asked about, and a deck that lives in
 * a design file drifts from the product the first time the product changes: the
 * one we replaced still said "fund the gas, flip the switch" about a thing that
 * had been live for days. Here the palette, the type and the stickers are the
 * same files the site serves, so a slide cannot quietly stop being true about
 * its own colours, and the copy sits next to the code that backs it.
 *
 * macOS only: the stickers ship as .webp and resvg does not read webp (it
 * renders a silent empty rectangle, which is how that was found), so `sips`
 * converts what each slide needs on the way in.
 *
 *   npm run deck    ->  brand/oddie-deck-v2.pdf
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { textWidth, wrapToWidth } from "../src/card/renderCard.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const FONT_DIR = path.join(ROOT, "assets/fonts");
const FONTS = ["Fredoka_600SemiBold.ttf", "Fredoka_700Bold.ttf", "Nunito_700Bold.ttf", "Anton.ttf"]
  .map((f) => path.join(FONT_DIR, f));

const W = 1920, H = 1080, PAD = 120;
const C = {
  ink: "#0B0D04", black: "#020302", cream: "#FBFCF4",
  yellow: "#D7DC1F", yellowHi: "#E7EC4E", pink: "#FF2D78", pinkDeep: "#A3053F",
  pinkField: "#E13774",
};
const DISPLAY = "Anton", BODY = "Fredoka";

/* THE LIGATURE TRAP, AND IT IS NOT THEORETICAL HERE: this deck shipped a slide
   reading "approved frst. By law." and another reading "Confdence costs
   nothing." resvg applies the font's fi/fl/ff ligature and then draws a glyph
   that is missing its second letter, silently, so the word simply loses a
   character and the slide still looks finished.
   A zero-width non-joiner between the pair stops the substitution. It is
   invisible, it costs nothing in any other face, and it goes in the escaper so
   no caller can forget it. */
const ZWNJ = "\u200c";
const esc = (s: string) =>
  s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!))
   .replace(/f(?=[fil])/gi, (m) => m + ZWNJ);

/** Stickers are webp on disk; resvg needs something it can actually decode. */
const shelf = mkdtempSync(path.join(tmpdir(), "oddie-deck-"));
const stickerCache = new Map<string, string>();
function sticker(name: string): string {
  const hit = stickerCache.get(name);
  if (hit) return hit;
  const src = path.join(ROOT, "public/brand", `${name}.webp`);
  if (!existsSync(src)) throw new Error(`no such sticker: ${name}`);
  const out = path.join(shelf, `${name}.png`);
  execFileSync("sips", ["-s", "format", "png", src, "--out", out], { stdio: "ignore" });
  const uri = `data:image/png;base64,${readFileSync(out).toString("base64")}`;
  stickerCache.set(name, uri);
  return uri;
}
/** Intrinsic size, so a sticker is never stretched. */
function stickerSize(name: string): { w: number; h: number } {
  const out = path.join(shelf, `${name}.png`);
  sticker(name);
  const info = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", out]).toString();
  const w = Number(/pixelWidth: (\d+)/.exec(info)?.[1] ?? 1);
  const h = Number(/pixelHeight: (\d+)/.exec(info)?.[1] ?? 1);
  return { w, h };
}
/** Fit inside a box without distortion, anchored bottom-right of that box. */
function placeSticker(name: string, box: { x: number; y: number; w: number; h: number }): string {
  const s = stickerSize(name);
  const k = Math.min(box.w / s.w, box.h / s.h);
  const w = s.w * k, h = s.h * k;
  return `<image href="${sticker(name)}" x="${Math.round(box.x + box.w - w)}" y="${Math.round(box.y + box.h - h)}" width="${Math.round(w)}" height="${Math.round(h)}"/>`;
}

interface Slide {
  label: string;
  bg: string;
  ink: string;
  /** The one line that has to survive if the reader looks at nothing else. */
  head: string;
  headSize?: number;
  body?: string[];
  stats?: { big: string; small: string }[];
  steps?: string[];
  /** A labelled row: the stage in display caps, the sentence in body case. */
  rows?: { tag: string; text: string }[];
  sticker?: string;
  stickerBox?: { x: number; y: number; w: number; h: number };
  /** The repeated band this deck's visual language uses along the bottom. */
  band?: string;
}

function render(s: Slide, n: number, total: number): string {
  // Which grounds are dark decides the muted ink, and pink counts as dark: it
  // is the app's own field colour and it carries cream type, not ink.
  const onDark = s.bg === C.black || s.bg === C.pinkField;
  const dim = onDark ? "rgba(251,252,244,.62)" : "rgba(11,13,4,.62)";
  // Pink numbers on a pink field are no numbers at all. The accent flips to the
  // one colour that is always the other side of this palette from the ground.
  const accent = s.bg === C.pinkField ? C.yellow : C.pink;
  const parts: string[] = [`<rect width="${W}" height="${H}" fill="${s.bg}"/>`];

  if (s.sticker && s.stickerBox) parts.push(placeSticker(s.sticker, s.stickerBox));

  // Slide number and section label, on one baseline.
  parts.push(`<text x="${PAD}" y="${PAD - 8}" font-family="${BODY}" font-size="26" font-weight="700" fill="${dim}" letter-spacing="6">${String(n).padStart(2, "0")} / ${total}</text>`);
  if (s.label) {
    parts.push(`<text x="${PAD + 200}" y="${PAD - 8}" font-family="${BODY}" font-size="26" font-weight="700" fill="${dim}" letter-spacing="10">${esc(s.label.toUpperCase())}</text>`);
  }

  let y = 300;
  const colW = s.sticker ? 1060 : W - PAD * 2;

  // The headline steps DOWN until it fits its column, so a copy edit can never
  // push a word off the slide silently. Same rule as the market card.
  /* A ONE-WORD HEADLINE IS NEVER WRAPPED. "$250,000" at 300px was wider than
     its column, and the wrapper did what it is built to do with a word that
     cannot fit: it split it. The slide went out reading "$250,00" over "0".
     A number is one object. It shrinks or it is wrong. */
  const oneWord = !/\s/.test(s.head.trim());
  const maxLines = oneWord ? 1 : 3;
  let fs = s.headSize ?? 150;
  let lines = wrapToWidth(s.head, colW, fs, maxLines + 1, "display").lines;
  const tooWide = () => Math.max(...lines.map((l) => textWidth(l, fs, "display"))) > colW;
  while (fs > 48 && (lines.length > maxLines || tooWide())) {
    fs -= 4;
    lines = oneWord
      ? [s.head]
      : wrapToWidth(s.head, colW, fs, maxLines + 1, "display").lines;
  }
  const lh = Math.round(fs * 1.02);
  /* THE HEADLINE IS CENTRED ON 300 BUT IT MAY NOT CLIMB PAST THE HEADER, and a
     three-line head did: its cap height reached above the slide number and drew
     straight through "09 / 11  ROADMAP", which then could not be read at all.
     Anton's caps stand about 0.74em over the baseline, so this is the highest
     that first baseline can sit and still leave the label alone. */
  const headFloor = PAD - 8 + 56 + fs * 0.78;
  y = Math.max(headFloor, 300 - (lines.length - 1) * lh * 0.5);
  for (const l of lines) {
    parts.push(`<text x="${PAD}" y="${y}" font-family="${DISPLAY}" font-size="${fs}" fill="${s.ink}">${esc(l.toUpperCase())}</text>`);
    y += lh;
  }

  y += 44;
  for (const b of s.body ?? []) {
    const wrapped = wrapToWidth(b, colW, 42, 4, "meta").lines;
    for (const l of wrapped) {
      parts.push(`<text x="${PAD}" y="${y}" font-family="${BODY}" font-size="42" font-weight="600" fill="${s.ink}" fill-opacity=".86">${esc(l)}</text>`);
      y += 58;
    }
    y += 22;
  }

  if (s.steps?.length) {
    y += 8;
    let x = PAD;
    for (let i = 0; i < s.steps.length; i++) {
      const t = s.steps[i].toUpperCase();
      const w = textWidth(t, 56, "display");
      parts.push(`<text x="${x}" y="${y}" font-family="${DISPLAY}" font-size="56" fill="${s.ink}">${esc(t)}</text>`);
      x += w + 40;
      if (i < s.steps.length - 1) {
        // DRAWN, NOT TYPED. Anton has no arrow glyph and resvg renders a missing
        // one as a tofu box, silently: the slide looked finished and shipped a
        // rectangle. The market card draws its arrow the same way.
        const ay = y - 14;
        parts.push(`<path d="M ${x} ${ay} h 30 m -11 -11 l 11 11 l -11 11" fill="none" stroke="${accent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`);
        x += 62;
      }
    }
    y += 70;
  }

  if (s.rows?.length) {
    y += 6;
    for (const r of s.rows) {
      const tag = r.tag.toUpperCase();
      parts.push(`<text x="${PAD}" y="${y}" font-family="${DISPLAY}" font-size="40" fill="${accent}">${esc(tag)}</text>`);
      const tx = PAD + Math.max(textWidth(tag, 40, "display") + 30, 230);
      const wrapped = wrapToWidth(r.text, colW - (tx - PAD), 34, 4, "meta").lines;
      let yy = y;
      for (const l of wrapped) {
        parts.push(`<text x="${tx}" y="${yy}" font-family="${BODY}" font-size="34" font-weight="600" fill="${s.ink}" fill-opacity=".86">${esc(l)}</text>`);
        yy += 46;
      }
      y = yy + 22;
    }
  }

  if (s.stats?.length) {
    y += 10;
    let x = PAD;
    for (const st of s.stats) {
      parts.push(`<text x="${x}" y="${y + 80}" font-family="${DISPLAY}" font-size="128" fill="${accent}">${esc(st.big)}</text>`);
      const wrapped = wrapToWidth(st.small, 400, 30, 3, "meta").lines;
      let yy = y + 132;
      for (const l of wrapped) {
        parts.push(`<text x="${x}" y="${yy}" font-family="${BODY}" font-size="30" font-weight="600" fill="${s.ink}" fill-opacity=".8">${esc(l)}</text>`);
        yy += 40;
      }
      x += 470;
    }
  }

  if (y > H - 70) {
    // Not a silent truncation: a slide that ran past its own edge is a copy
    // problem, and the only way to find one in a PNG is to be told.
    console.warn(`  ! slide "${s.label || s.head}" runs ${Math.round(y - (H - 70))}px past the bottom`);
  }

  if (s.band) {
    const t = `${s.band.toUpperCase()}   `;
    const one = textWidth(t, 64, "display");
    const reps = Math.ceil(W / one) + 1;
    parts.push(`<text x="${PAD}" y="${H - 64}" font-family="${DISPLAY}" font-size="64" fill="${s.ink}" fill-opacity=".14">${esc(t.repeat(reps))}</text>`);
  }

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`;
}

export function slidePng(s: Slide, n: number, total: number): Buffer {
  return new Resvg(render(s, n, total), {
    fitTo: { mode: "width", value: W },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: BODY },
  }).render().asPng();
}

/* THE COPY. Every claim here is one the repo can be asked about, and nothing
   that has not happened is written in the past tense: the autonomous settle is
   named with its date rather than claimed as a track record. */
/* THE GROUNDS ARE A SEQUENCE, NOT A DEFAULT, and the first cut of this deck
   proved why it matters: nine of eleven slides came out black because black was
   what I reached for each time, and eleven slides of one colour read as one
   long slide. The brand runs on four grounds and the landing page moves through
   all of them. So does this:

     yellow  black  YELLOW  black  cream  yellow  black  cream  black  PINK  yellow

   No two neighbours share a ground, every ground is used, and the highest
   chroma is spent once, on the ask, which is the only slide asking for
   anything. The closer returns to the cover's yellow so the deck shuts the way
   it opened.

   CREAM IS EARNED, NOT ALTERNATED, and the first cut got that wrong twice. It
   ran three cream slides, and one of them was the SOLUTION: the moment the
   product arrives was the quietest ground in the deck, which is a hierarchy
   error however good the slide looks on its own. A problem slide is dark and a
   turn is loud. Cream now falls only on the two densest slides, the founder and
   the moat, where a light ground actually buys the reader something.

   Two worries that did NOT survive checking, recorded so they are not raised
   again: cream against a viewer's own white chrome (every PDF viewer surrounds
   a page in grey, so the edge holds), and the stickers' white outline
   disappearing on cream (their black line carries them; measured at full size). */
/* SHORT, LOUD, AND WITHOUT A WORD ANYBODY HAS TO LOOK UP.
   The first cut explained itself: two or three paragraphs a slide, and words
   like settlement, on-chain, regulated exchange and unit economics doing the
   explaining. A deck is read in about eight minutes by somebody who is not
   going to ask what a term means, they are going to skim past it.
   So every slide is one idea, a headline, and at most a line under it. The
   grounds alternate lime and black the way the brand itself does, and the one
   pink is spent on the only slide that asks for anything. */
const D = C.black, L = C.cream;
const Y = C.yellow, I = C.ink;
export const SLIDES: Slide[] = [
  {
    label: "", bg: Y, ink: I,
    head: "The people\u2019s prediction market.",
    body: ["oddie.fun   @oddiefun"],
    sticker: "sticker-hero", stickerBox: { x: 1020, y: 340, w: 840, h: 680 },
    band: "no listing desk.",
  },
  {
    label: "The problem", bg: D, ink: L,
    head: "Being right pays. Just not where you argue.",
    body: ["The loudest wins the thread. Nobody pays out."],
    sticker: "crowd-strip", stickerBox: { x: 0, y: 740, w: 1920, h: 340 },
  },
  {
    label: "The solution", bg: Y, ink: I,
    head: "Tag it. It\u2019s a market.",
    steps: ["Tag", "Pick a side", "Get paid"],
    body: ["No referee. The deadline hits and it pays."],
    sticker: "st-tag", stickerBox: { x: 1200, y: 520, w: 660, h: 500 },
  },
  {
    label: "Why now", bg: D, ink: L,
    head: "None of it happened in a thread.",
    stats: [
      { big: "$22B", small: "what Kalshi is worth" },
      { big: "$40B", small: "traded in one month" },
      { big: "0", small: "of it inside a thread" },
    ],
  },
  {
    label: "Why they can\u2019t", bg: Y, ink: I,
    head: "They have to ask permission. We don\u2019t.",
    body: ["Every market they open is approved first. By law."],
    sticker: "st-judge", stickerBox: { x: 1280, y: 540, w: 560, h: 480 },
  },
  {
    label: "The founder", bg: D, ink: L,
    head: "Two years in. Now he can build it.",
    body: ["Chrome banned his last one. Nobody can switch this one off."],
    stats: [
      { big: "45K", small: "signed up for Poppin" },
      { big: "600", small: "in the beta" },
      { big: "20K", small: "posts written" },
    ],
  },
  {
    label: "The money", bg: Y, ink: I,
    head: "4% when it is over. Nothing before.",
    body: ["Half of it goes to whoever opened the market."],
    sticker: "st-riding", stickerBox: { x: 1260, y: 540, w: 600, h: 480 },
  },
  {
    label: "How it spreads", bg: D, ink: L,
    head: "Bring the room, own the room.",
    body: ["Open a market and keep 2% of it. Forever."],
    sticker: "genesis-ticket", stickerBox: { x: 1300, y: 480, w: 560, h: 560 },
  },
  {
    label: "Where it goes", bg: Y, ink: I,
    head: "Every argument is a market.",
    rows: [
      { tag: "Now", text: "X. Live, with real money in it." },
      { tag: "Next", text: "Telegram. Built and tested." },
      { tag: "Then", text: "Discord." },
      { tag: "After", text: "Any app, with one key." },
    ],
    sticker: "st-rocket", stickerBox: { x: 1360, y: 560, w: 500, h: 460 },
  },
  {
    label: "The ask", bg: C.pinkField, ink: C.cream,
    head: "$250,000", headSize: 260,
    body: ["38 cents opens a market. This buys a lot of them."],
    sticker: "genesis-podium", stickerBox: { x: 1380, y: 520, w: 460, h: 500 },
  },
  {
    label: "", bg: D, ink: L,
    head: "Be right. Be early. Be oddie.",
    body: ["lev@oddie.fun"],
    sticker: "st-main", stickerBox: { x: 1200, y: 460, w: 660, h: 580 },
    band: "be oddie.",
  },
];
export { C, W, H, PAD, shelf };
