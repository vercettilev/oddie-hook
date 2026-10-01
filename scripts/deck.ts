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
  yellow: "#FCF604", yellowHi: "#FFFB3B", pink: "#FF2D78", pinkDeep: "#A3053F",
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

/* A FACE, IF THERE IS ONE ON DISK.
   The founder slide said "he" and never said who. An investor deck is the one
   place being subtle is simply being unclear: the reader wants a name, a face
   and a handle, and gets none of them from "two years in".
   The name and handle are set from the copy, so the slide is concrete with or
   without a picture. The picture is a file drop: put lev.jpg (or .png/.webp)
   in brand/ and it appears, circle cut, with the same hard offset every sticker
   on these slides carries. Nothing breaks when it is absent. */
function portrait(file: string, cx: number, cy: number, r: number): string {
  // Any of the usual spellings, because the failure mode is somebody dropping
  // lev.png next to code that only looks for lev.jpg and getting a slide with a
  // hole in it and no explanation.
  const stem = file.replace(/\.[^.]+$/, "");
  const src = [".jpg", ".jpeg", ".png", ".webp", ".heic", ".JPG", ".PNG"]
    .map((ext) => path.join(ROOT, "brand", stem + ext))
    .find((f) => existsSync(f));
  if (!src) return "";
  const png = path.join(shelf, `portrait-${stem}.png`);
  execFileSync("sips", ["-s", "format", "png", src, "--out", png], { stdio: "ignore" });
  const info = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", png]).toString();
  const iw = Number(/pixelWidth: (\d+)/.exec(info)?.[1] ?? 1);
  const ih = Number(/pixelHeight: (\d+)/.exec(info)?.[1] ?? 1);
  // Cover the circle and centre the crop, so a portrait or a landscape shot
  // both fill it without squashing.
  const k = Math.max((r * 2) / iw, (r * 2) / ih);
  const w = iw * k, h = ih * k;
  const uri = `data:image/png;base64,${readFileSync(png).toString("base64")}`;
  const id = `clip-${stem.replace(/[^a-z0-9]/gi, "")}`;
  return `<circle cx="${cx + 14}" cy="${cy + 16}" r="${r}" fill="${C.pink}"/>`
    + `<clipPath id="${id}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>`
    + `<image href="${uri}" x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" clip-path="url(#${id})"/>`
    + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.black}" stroke-width="8"/>`;
}

/** A file in brand/, decoded into something resvg will actually draw, with the
 *  size it really is. Null when it is not there, so every caller can fall back
 *  rather than leave a hole. */
function loadShot(file: string): { uri: string; w: number; h: number } | null {
  const stem = file.replace(/\.[^.]+$/, "");
  const src = [".png", ".jpg", ".jpeg", ".webp", ".PNG", ".JPG"]
    .map((ext) => path.join(ROOT, "brand", stem + ext))
    .find((f) => existsSync(f));
  if (!src) return null;
  const png = path.join(shelf, `shot-${stem}.png`);
  execFileSync("sips", ["-s", "format", "png", src, "--out", png], { stdio: "ignore" });
  const info = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", png]).toString();
  return {
    uri: `data:image/png;base64,${readFileSync(png).toString("base64")}`,
    w: Number(/pixelWidth: (\d+)/.exec(info)?.[1] ?? 1),
    h: Number(/pixelHeight: (\d+)/.exec(info)?.[1] ?? 1),
  };
}


/* THE DOORS, BY THEIR OWN MARKS. Paths from simple-icons 16.33.0 (CC0), the
   brands' current logos; colours from the same package's data. Each sits on a
   small tile the way its app icon does, because Kick's green on this deck's
   lime disappears: black tile, green mark for Kick; black tile, white mark
   for X; Telegram's own blue disc, which is its own tile. */
const LOGOS: Record<string, { d: string; fill: string; tile: string | null }> = {
  kick: { d: "M1.333 0h8v5.333H12V2.667h2.667V0h8v8H20v2.667h-2.667v2.666H20V16h2.667v8h-8v-2.667H12v-2.666H9.333V24h-8Z", fill: "#53FC19", tile: C.black },
  x: { d: "M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z", fill: C.cream, tile: C.black },
  telegram: { d: "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z", fill: "#26A5E4", tile: null },
};
type Door = "kick" | "x" | "telegram";
/** A door's mark, `size` square, top-left at x,y. */
function logo(name: Door, x: number, y: number, size: number, onDark = false): string {
  const l = LOGOS[name];
  const out: string[] = [];
  if (l.tile) {
    // On black a black tile is no tile, so it gets a hairline to stand on.
    const edge = onDark ? ` stroke="rgba(251,252,244,.28)" stroke-width="2"` : "";
    out.push(`<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${Math.round(size * 0.24)}" fill="${l.tile}"${edge}/>`);
    const inner = size * 0.6, o = (size - inner) / 2;
    out.push(`<path d="${l.d}" fill="${l.fill}" transform="translate(${x + o} ${y + o}) scale(${inner / 24})"/>`);
    return out.join("");
  }
  /* TELEGRAM IS ITS OWN TILE, a disc with the plane cut out of it. The cut
     showed the ground through (lime, or black), and at the tile's full size
     the disc read a size bigger than the other two marks. So a white disc
     goes under it and the whole mark is held to 86% of the tile. */
  const d = size * 0.86, o = (size - d) / 2;
  out.push(`<circle cx="${x + size / 2}" cy="${y + size / 2}" r="${d * 0.46}" fill="#FFFFFF"/>`);
  out.push(`<path d="${l.d}" fill="${l.fill}" transform="translate(${x + o} ${y + o}) scale(${d / 24})"/>`);
  return out.join("");
}

/* THE STEPS ARE DRAWN, NOT LISTED, and the slide they replaced is the reason.
   It carried four dated sentences in a column, which is a CLAIM about a machine
   on the one slide in the deck whose whole job is EVIDENCE. The machine's own
   artifacts are the evidence: the tweet as it was written, the card exactly as
   it was posted, and the account the money sits in. Each panel holds one, and
   the reader gets the whole loop at a glance instead of reading four lines and
   deciding whether to believe them. */
interface FlowStep {
  /** The pink line over the panel. A clock time where there is one. */
  tick: string;
  /** The quiet line under it, in plain words. */
  cap?: string;
  /** A real file in brand/, filling the panel. */
  img?: string;
  /** Somebody's real words, set as they were written. */
  quote?: string;
  by?: string;
  /** A drawn panel: one loud line, one quiet one, and a value to check. */
  head?: string;
  sub?: string;
  note?: string;
  /** Set on the gap BEFORE this panel: the only number this slide needs. */
  gapLabel?: string;
}

/** The row of panels, sized off the one real image in it so nothing is
 *  letterboxed and every panel shares a baseline. */
function flowRow(items: FlowStep[], top: number, accent: string, ink: string, onDark: boolean): { svg: string; bottom: number } {
  const GAP = 130, R = 22, INSET = 36;
  const pw = Math.round((W - PAD * 2 - GAP * (items.length - 1)) / items.length);
  const shot = items.map((it) => (it.img ? loadShot(it.img) : null));
  const real = shot.find((x) => x);
  const ph = real ? Math.round((pw * real.h) / real.w) : 300;
  // A drawn panel has to lift off its ground or it is a hole, and a stroke in
  // the ink colour is the only lift that works on all four of this deck's
  // grounds.
  // OPAQUE ON BOTH GROUNDS. A see-through fill let the pink offset behind the
  // panel show through on cream, and every drawn panel came out pink.
  const panelFill = onDark ? "#1C1F0E" : "#EEEFE3";
  const hair = onDark ? "rgba(251,252,244,.28)" : "rgba(11,13,4,.18)";
  const quiet = onDark ? "rgba(251,252,244,.60)" : "rgba(11,13,4,.60)";
  // Lime is the loud colour on black and invisible on cream, so a proof set on
  // a light ground lights its words in the deep pink instead.
  const hi = onDark ? C.yellow : C.pinkDeep;
  const out: string[] = [];
  let capBottom = top + ph;

  items.forEach((it, i) => {
    const x = PAD + i * (pw + GAP);
    const img = shot[i];
    out.push(`<rect x="${x + 14}" y="${top + 14}" width="${pw}" height="${ph}" rx="${R}" fill="${accent}"/>`);
    if (img) {
      const id = `fp${i}`;
      out.push(`<clipPath id="${id}"><rect x="${x}" y="${top}" width="${pw}" height="${ph}" rx="${R}"/></clipPath>`);
      out.push(`<image href="${img.uri}" x="${x}" y="${top}" width="${pw}" height="${ph}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/>`);
    } else {
      out.push(`<rect x="${x}" y="${top}" width="${pw}" height="${ph}" rx="${R}" fill="${panelFill}" stroke="${hair}" stroke-width="3"/>`);
      let ty = top + INSET + 26;
      /* THE ATTRIBUTION IS THE ACCOUNT'S NAME AND NOT ITS HANDLE, and the
         handle is the reason. Set in Fredoka, "@giga_g_chad" came out reading
         "@giga__g__chad": the underscore is a normal width (0.85 of an n,
         measured) but drawn heavy and low, and between round lowercase letters
         one bar reads as two, so a reader copied down an account that does not
         exist. Shortening it to "@gigachad" would be worse than ugly, because
         that is somebody else's handle. The name on the account is Giga Chad:
         true, no underscores, and it points nowhere wrong. Anton because a
         name is a label here and not running text. */
      if (it.by) {
        out.push(`<text x="${x + INSET}" y="${ty}" font-family="${DISPLAY}" font-size="32" fill="${quiet}">${esc(it.by.toUpperCase())}</text>`);
        ty += 52;
      }
      if (it.quote) {
        // The handle the tweet was aimed at is lit, because it is the whole
        // interface: a reader who takes nothing else from this slide should
        // still see that the product is summoned by typing its name.
        const lit = (l: string) => l.split(/(@\w+|!oddie)/)
          .map((p) => (/^(@\w+|!oddie)$/.test(p) ? `<tspan fill="${hi}">${esc(p)}</tspan>` : esc(p)))
          .join("");
        for (const l of wrapToWidth(`“${it.quote}”`, pw - INSET * 2, 30, 4, "meta").lines) {
          out.push(`<text x="${x + INSET}" y="${ty}" font-family="${BODY}" font-size="30" font-weight="600" fill="${ink}">${lit(l)}</text>`);
          ty += 42;
        }
      }
      // A panel with no quotation in it is a receipt, and a receipt is read
      // from the top and the bottom: the loud line sits a third of the way
      // down and the value a reader can check sits on the floor.
      if (it.head) {
        out.push(`<text x="${x + INSET}" y="${top + 110}" font-family="${DISPLAY}" font-size="66" fill="${hi}">${esc(it.head.toUpperCase())}</text>`);
      }
      if (it.sub) {
        out.push(`<text x="${x + INSET}" y="${top + 162}" font-family="${BODY}" font-size="30" font-weight="600" fill="${ink}" fill-opacity=".8">${esc(it.sub)}</text>`);
      }
      if (it.note) {
        out.push(`<text x="${x + INSET}" y="${top + ph - 34}" font-family="${BODY}" font-size="28" font-weight="700" fill="${accent}">${esc(it.note)}</text>`);
      }
    }

    out.push(`<text x="${x}" y="${top - 30}" font-family="${DISPLAY}" font-size="40" fill="${accent}">${esc(it.tick.toUpperCase())}</text>`);
    // Stacked, not clipped: a caption that outgrows its panel pushes the row
    // down and trips the overflow warning, rather than losing its second half
    // where nobody would notice.
    if (it.cap) {
      let cy = top + ph + 52;
      for (const l of wrapToWidth(it.cap, pw, 28, 2, "meta").lines) {
        out.push(`<text x="${x}" y="${cy}" font-family="${BODY}" font-size="28" font-weight="600" fill="${quiet}">${esc(l)}</text>`);
        cy += 36;
      }
      capBottom = Math.max(capBottom, cy - 36);
    }

    // DRAWN, NOT TYPED, for the same reason the steps row draws its arrow:
    // Anton has no arrow glyph and resvg puts a tofu box there without a word.
    if (i > 0) {
      const gx = x - GAP, gy = top + ph / 2;
      out.push(`<path d="M ${gx + 16} ${gy} h 44 m -16 -16 l 16 16 l -16 16" fill="none" stroke="${accent}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`);
      if (it.gapLabel) {
        out.push(`<text x="${gx + GAP / 2}" y="${top - 30}" text-anchor="middle" font-family="${DISPLAY}" font-size="36" fill="${hi}">${esc(it.gapLabel.toUpperCase())}</text>`);
      }
    }
  });
  return { svg: out.join(""), bottom: capBottom };
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
  rows?: { tag: string; text: string; logo?: Door }[];
  /** A quiet line under everything, for a caveat or a link a reader can check. */
  foot?: string;
  /** A short block set against the headline, on the right. */
  aside?: string[];
  /** Hold the text column at a sticker's width on a slide that has no art, so
   *  a bare slide reads as composed instead of merely wide. */
  narrow?: boolean;
  /** Markets that do not exist, drawn as the markets they are not: the same
   *  dashed outline this deck uses everywhere for a thing that has not
   *  happened. Solid is a receipt, dashed is a hole. */
  ghosts?: Array<string | { text: string; logo: Door }>;
  /** The steps, shown rather than told. */
  flow?: FlowStep[];
  /** The strip under the flow: the beat that lands after the pictures.
   *  DASHED UNTIL IT HAS HAPPENED. Everything solid on these slides is a thing
   *  that ran, so a promise must not be able to pass for a receipt, and `done`
   *  closes the stroke on the day it stops being one. `mark` is the single word
   *  in the sentence worth lighting. */
  rail?: { tag: string; text: string; mark?: string; done?: boolean };
  sticker?: string;
  stickerBox?: { x: number; y: number; w: number; h: number };
  /** The repeated band this deck's visual language uses along the bottom. */
  band?: string;
  /** The doors' marks in a row, under the body. */
  badges?: Door[];
  /** A named person, with a face when brand/<photo> exists. */
  who?: { name: string; handle: string; photo?: string };
  /** Where every outside figure on the slide came from, in one small line on
   *  the bottom edge. A sent-ahead deck is read by somebody who can check. */
  sources?: string;
  /** A 2x2 on the right; the text under the headline narrows beside it. */
  matrix?: Matrix;
}

/* THE COMPETITION IS DRAWN AS A 2x2 BECAUSE THE CLAIM IS A POSITION, not a
   feature list: who decides what gets a market, and where the market lives.
   Coordinates are 0..1 on each axis; the one `me` point carries the accent. */
interface Matrix {
  /** Axis ends: [left, right] along the bottom, [bottom, top] up the side. */
  x: [string, string];
  y: [string, string];
  points: Array<{ name: string; x: number; y: number; me?: boolean }>;
}

/** The 2x2, in a fixed box on the right of the slide. */
function matrixSvg(m: Matrix, box: { x: number; y: number; w: number; h: number }, ink: string, accent: string, onDark: boolean): string {
  const line = onDark ? "rgba(251,252,244,.35)" : "rgba(11,13,4,.28)";
  const quiet = onDark ? "rgba(251,252,244,.66)" : "rgba(11,13,4,.62)";
  const { x, y, w, h } = box;
  const out: string[] = [];
  out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="none" stroke="${line}" stroke-width="3"/>`);
  out.push(`<path d="M ${x + w / 2} ${y + 18} V ${y + h - 18} M ${x + 18} ${y + h / 2} H ${x + w - 18}" stroke="${line}" stroke-width="3" stroke-dasharray="12 10"/>`);
  /* THE AXIS NAMES SIT INSIDE THE FRAME, at the ends they describe: the
     vertical pair runs up the left edge, the horizontal pair along the floor.
     Set flat, "A DESK LISTS" and "IN THEIR APP" met in the bottom-left corner
     and printed over each other. */
  const lab = (t: string, lx: number, ly: number, anchor: string, up = false) =>
    `<text x="${lx}" y="${ly}" text-anchor="${anchor}"${up ? ` transform="rotate(-90 ${lx} ${ly})"` : ""} font-family="${BODY}" font-size="22" font-weight="700" letter-spacing="3" fill="${quiet}">${esc(t.toUpperCase())}</text>`;
  out.push(lab(m.y[0], x + 40, y + h - 70, "start", true));
  out.push(lab(m.y[1], x + 40, y + 26, "end", true));
  out.push(lab(m.x[0], x + 66, y + h - 24, "start"));
  out.push(lab(m.x[1], x + w - 26, y + h - 24, "end"));
  for (const p of m.points) {
    const px = x + 90 + p.x * (w - 150), py = y + h - 80 - p.y * (h - 150);
    // A label never runs off the frame: past the middle it hangs to the left.
    const left = p.x > 0.55;
    if (p.me) {
      out.push(`<circle cx="${px + 5}" cy="${py + 6}" r="24" fill="${ink}"/>`);
      out.push(`<circle cx="${px}" cy="${py}" r="24" fill="${accent}" stroke="${ink}" stroke-width="4"/>`);
      out.push(`<text x="${left ? px - 40 : px + 40}" y="${py + 16}" text-anchor="${left ? "end" : "start"}" font-family="${DISPLAY}" font-size="48" fill="${ink}">${esc(p.name.toUpperCase())}</text>`);
    } else {
      out.push(`<circle cx="${px}" cy="${py}" r="13" fill="${ink}" fill-opacity=".72"/>`);
      out.push(`<text x="${left ? px - 26 : px + 26}" y="${py + 10}" text-anchor="${left ? "end" : "start"}" font-family="${BODY}" font-size="30" font-weight="700" fill="${ink}" fill-opacity=".86">${esc(p.name)}</text>`);
    }
  }
  return out.join("");
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
  if (s.who) {
    const r = 205, cx = 1555, cy = 560;
    const face = s.who.photo ? portrait(s.who.photo, cx, cy, r) : "";
    parts.push(face);
    // The name sits under the face when there is one, and stands on its own
    // where the face would have been when there is not.
    const ny = face ? cy + r + 86 : cy - 20;
    parts.push(`<text x="${cx}" y="${ny}" text-anchor="middle" font-family="${DISPLAY}" font-size="64" fill="${s.ink}">${esc(s.who.name.toUpperCase())}</text>`);
    parts.push(`<text x="${cx}" y="${ny + 52}" text-anchor="middle" font-family="${BODY}" font-size="32" font-weight="700" fill="${accent}">${esc(s.who.handle)}</text>`);
  }

  // Slide number and section label, on one baseline.
  parts.push(`<text x="${PAD}" y="${PAD - 8}" font-family="${BODY}" font-size="26" font-weight="700" fill="${dim}" letter-spacing="6">${String(n).padStart(2, "0")} / ${total}</text>`);
  if (s.label) {
    parts.push(`<text x="${PAD + 200}" y="${PAD - 8}" font-family="${BODY}" font-size="26" font-weight="700" fill="${dim}" letter-spacing="10">${esc(s.label.toUpperCase())}</text>`);
  }

  if (s.aside?.length) {
    let ay = 300 - (s.aside.length - 1) * 26;
    for (const l of s.aside) {
      parts.push(`<text x="${W - PAD}" y="${ay}" text-anchor="end" font-family="${BODY}" font-size="40" font-weight="600" fill="${s.ink}" fill-opacity=".88">${esc(l)}</text>`);
      ay += 52;
    }
  }

  let y = 300;
  // A portrait takes the same right-hand column a sticker does, and forgetting
  // that ran the body text straight under the circle.
  const colW = s.sticker || s.who || s.narrow ? 1060 : W - PAD * 2;
  /* BESIDE A 2x2 THE HEADLINE KEEPS THE FULL WIDTH and only what sits under
     it narrows, because the matrix starts below the headline, not beside it. */
  const MATRIX_X = 1210;
  const bodyW = s.matrix ? MATRIX_X - PAD - 60 : colW;

  // The headline steps DOWN until it fits its column, so a copy edit can never
  // push a word off the slide silently. Same rule as the market card.
  /* A ONE-WORD HEADLINE IS NEVER WRAPPED. "$250,000" at 300px was wider than
     its column, and the wrapper did what it is built to do with a word that
     cannot fit: it split it. The slide went out reading "$250,00" over "0".
     A number is one object. It shrinks or it is wrong. */
  const oneWord = !/\s/.test(s.head.trim());
  /* A "\n" IN A HEADLINE IS A CHOSEN BREAK, kept as written: the wrapper is
     greedy, and at the close's size it set "EVERY ARGUMENT IS A" over a lone
     "MARKET.", splitting the one line the deck exists to say. */
  const forced = s.head.includes("\n") ? s.head.split("\n") : null;
  const maxLines = forced ? forced.length : oneWord ? 1 : 3;
  let fs = s.headSize ?? 150;
  const wrap = () => forced ?? (oneWord ? [s.head] : wrapToWidth(s.head, colW, fs, maxLines + 1, "display").lines);
  let lines = wrap();
  const tooWide = () => Math.max(...lines.map((l) => textWidth(l, fs, "display"))) > colW;
  while (fs > 48 && (lines.length > maxLines || tooWide())) {
    fs -= 4;
    lines = wrap();
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
  if (s.matrix) {
    parts.push(matrixSvg(s.matrix, { x: MATRIX_X, y: y - 20, w: W - PAD - MATRIX_X, h: H - 130 - (y - 20) }, s.ink, accent, onDark));
  }
  for (const b of s.body ?? []) {
    const wrapped = wrapToWidth(b, bodyW, 42, 4, "meta").lines;
    for (const l of wrapped) {
      parts.push(`<text x="${PAD}" y="${y}" font-family="${BODY}" font-size="42" font-weight="600" fill="${s.ink}" fill-opacity=".86">${esc(l)}</text>`);
      y += 58;
    }
    y += 22;
  }

  if (s.badges?.length) {
    const B = 64;
    s.badges.forEach((b, i) => parts.push(logo(b, PAD + i * (B + 20), y - 34, B, onDark)));
    y += B + 20;
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

  if (s.flow?.length) {
    const row = flowRow(s.flow, y + 30, accent, s.ink, onDark);
    parts.push(row.svg);
    y = row.bottom;
  }

  if (s.ghosts?.length) {
    y += 34;
    const h = 84, gap = 22;
    for (const g of s.ghosts) {
      const text = typeof g === "string" ? g : g.text;
      parts.push(`<rect x="${PAD}" y="${y}" width="${bodyW}" height="${h}" rx="18" fill="none" stroke="${accent}" stroke-width="3" stroke-dasharray="16 10" stroke-opacity=".85"/>`);
      parts.push(`<text x="${PAD + 34}" y="${y + h / 2 + 13}" font-family="${BODY}" font-size="34" font-weight="600" fill="${s.ink}" fill-opacity=".92">${esc(text)}</text>`);
      // Where the argument is happening, at the chip's far end.
      if (typeof g !== "string") parts.push(logo(g.logo, PAD + bodyW - 22 - 48, y + (h - 48) / 2, 48, onDark));
      y += h + gap;
    }
    // NOT `y -= gap`. A caption's y is its BASELINE, so leaving y on the last
    // chip's bottom edge drew the foot line straight through it: the sentence
    // and the dashes shared the same pixels and both were unreadable.
    y += 24;
  }

  if (s.rail) {
    y += 38;
    const h = 76;
    const dash = s.rail.done ? "" : ` stroke-dasharray="20 12"`;
    parts.push(`<rect x="${PAD}" y="${y}" width="${W - PAD * 2}" height="${h}" rx="20" fill="none" stroke="${accent}" stroke-width="4"${dash}/>`);
    const tag = s.rail.tag.toUpperCase();
    parts.push(`<text x="${PAD + 40}" y="${y + h / 2 + 14}" font-family="${DISPLAY}" font-size="40" fill="${accent}">${esc(tag)}</text>`);
    // THE ANSWER IS SET INSIDE THE SENTENCE, not beside it. Between the date
    // and the line, a lone "NO" reads as part of the date, which is the same
    // collision the duration had over the panels and worse here: a reader who
    // mis-parses that one has mis-read the outcome.
    const m = s.rail.mark;
    const body = m && s.rail.text.includes(m)
      ? s.rail.text.split(m).map(esc).join(`<tspan fill="${onDark ? C.yellow : C.pinkDeep}">${esc(m)}</tspan>`)
      : esc(s.rail.text);
    parts.push(`<text x="${PAD + 40 + textWidth(tag, 40, "display") + 36}" y="${y + h / 2 + 12}" font-family="${BODY}" font-size="32" font-weight="600" fill="${s.ink}" fill-opacity=".88">${body}</text>`);
    y += h;
  }

  if (s.rows?.length) {
    y += 6;
    // The text column aligns to the LONGEST tag on this slide, not to a fixed
    // 230: "30%" against that minimum left a hand's width of dead space before
    // every line, on the one slide a reader actually studies.
    const LOGO = 52, anyLogo = s.rows.some((r) => r.logo);
    const lead = anyLogo ? LOGO + 22 : 0;
    const tagCol = lead + Math.max(...s.rows.map((r) => textWidth(r.tag.toUpperCase(), 40, "display"))) + 40;
    for (const r of s.rows) {
      const tag = r.tag.toUpperCase();
      if (r.logo) parts.push(logo(r.logo, PAD, y - 40, LOGO, onDark));
      parts.push(`<text x="${PAD + lead}" y="${y}" font-family="${DISPLAY}" font-size="40" fill="${accent}">${esc(tag)}</text>`);
      const tx = PAD + tagCol;
      const wrapped = wrapToWidth(r.text, bodyW - (tx - PAD), 34, 4, "meta").lines;
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
    let bottom = y;
    for (const st of s.stats) {
      parts.push(`<text x="${x}" y="${y + 80}" font-family="${DISPLAY}" font-size="128" fill="${accent}">${esc(st.big)}</text>`);
      const wrapped = wrapToWidth(st.small, 400, 30, 3, "meta").lines;
      let yy = y + 132;
      for (const l of wrapped) {
        parts.push(`<text x="${x}" y="${yy}" font-family="${BODY}" font-size="30" font-weight="600" fill="${s.ink}" fill-opacity=".8">${esc(l)}</text>`);
        yy += 40;
      }
      x += 470;
      bottom = Math.max(bottom, yy - 40); // yy has already advanced past the last line
    }
    // Assigned AFTER the loop. Written inside it, every stat started lower than
    // the one before and the row came out as a staircase: y is the shared
    // baseline the row is drawn from, so nothing may move it mid-row.
    // `bottom` is the last caption's BASELINE, so whatever follows needs a
    // line of air or it is drawn through the captions (it was, on the model).
    y = bottom + (s.foot ? 48 : 0);
  }

  if (s.foot) {
    y += 14;
    for (const l of wrapToWidth(s.foot, bodyW, 28, 3, "meta").lines) {
      parts.push(`<text x="${PAD}" y="${y}" font-family="${BODY}" font-size="28" font-weight="600" fill="${s.ink}" fill-opacity=".62">${esc(l)}</text>`);
      y += 38;
    }
  }

  // The sources line owns the bottom edge, so the content has to stop above it.
  const floor = s.sources ? H - 110 : H - 70;
  if (y > floor) {
    // Not a silent truncation: a slide that ran past its own edge is a copy
    // problem, and the only way to find one in a PNG is to be told.
    console.warn(`  ! slide "${s.label || s.head}" runs ${Math.round(y - floor)}px past the bottom`);
  }
  if (s.sources) {
    for (const [i, l] of wrapToWidth(s.sources, W - PAD * 2, 22, 2, "meta").lines.entries()) {
      parts.push(`<text x="${PAD}" y="${H - 58 + i * 30}" font-family="${BODY}" font-size="22" font-weight="600" fill="${s.ink}" fill-opacity=".5">${esc(l)}</text>`);
    }
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

     yellow  black  yellow  BLACK  cream  yellow  black  cream  black  cream  PINK  yellow
     appendix: cream  yellow  black

   No two neighbours share a ground, every ground is used, and the highest
   chroma is spent once, on the ask, which is the only slide asking for
   anything. The closer returns to the cover's yellow so the deck shuts the way
   it opened.

   CREAM IS EARNED, NOT ALTERNATED, and the first cut got that wrong twice. It
   ran three cream slides, and one of them was the SOLUTION: the moment the
   product arrives was the quietest ground in the deck, which is a hierarchy
   error however good the slide looks on its own. A problem slide is dark and a
   turn is loud. Cream now falls only on the densest slides (market size,
   competition, the team, the proof), where a light ground actually buys the
   reader something.

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
  /* THE ORDER IS THE INVESTOR'S, NOT OURS (1 Oct 2026). The deck had no market
     size, no traction and no competition slide, the three an investor looks
     for first and reads as hidden when they are missing. It now runs problem,
     solution, proof, opportunity, team, ask, with three appendix slides for
     the questions after. Every outside figure carries its source on the slide;
     every estimate says it is one. */
  {
    /* THE COVER IS THE VISION, NOT THE INTEGRATIONS (Lev). The doors arrive on
       slide three, where they are the mechanism. The second line is the party
       test: what happens, in words anybody gets. */
    label: "", bg: Y, ink: I,
    head: "Every argument is a market.",
    body: ["The people’s prediction market.", "Tag Oddie under any claim, in any chat. It becomes a real-money market in seconds."],
    foot: "Lev, founder   ·   oddie.fun   ·   @oddiefun",
    sticker: "sticker-hero", stickerBox: { x: 1020, y: 340, w: 840, h: 680 },
  },
  {
    /* Each argument is the one native to its room, marked with that room. The
       BTC one is the market Kick actually opened on 29 Sep. */
    label: "The problem", bg: D, ink: L,
    head: "The bets people argue about every day are the ones nobody lists.", headSize: 98,
    ghosts: [
      { text: "does Adin Ross break Kick’s viewer record this month?", logo: "kick" },
      { text: "btc 88k by friday?", logo: "x" },
      { text: "is $ORE at 50m by the end of the month?", logo: "telegram" },
    ],
    foot: "$45.33B traded on Kalshi and Polymarket in August 2026, on markets each of them chose. Kick averaged over 900K viewers that month, every chat arguing.",
    sources: "Sources: The Block, 2 Sep 2026 (volume) · Polymarket docs (users cannot create markets) · Streams Charts, 2 Sep 2026 (Kick viewers)",
    /* NO STICKER: the headline, three rooms and a sourced foot need the full
       width, and beside the art the foot ran into the sources line. */
  },
  {
    /* "CALL IT", BECAUSE ON KICK NOBODY TAGS: they type !oddie. The doors are
       listed by what a person actually types in each. */
    label: "The solution", bg: Y, ink: I,
    head: "Call it in the chat and it is a live market on Solana in 24 seconds.", headSize: 100,
    body: ["It settles itself: 0 wrong in 25 oracle runs. Whoever opens it earns 2% of the pool."],
    rows: [
      { tag: "Kick", logo: "kick", text: "Type !oddie and a claim in a stream’s chat." },
      { tag: "X", logo: "x", text: "Tag @oddiefun under any claim." },
      { tag: "Telegram", logo: "telegram", text: "Reply to any message with @oddiefunbot." },
    ],
    sticker: "st-called", stickerBox: { x: 1300, y: 500, w: 560, h: 520 },
  },
  {
    /* WHAT IS ON IT HAPPENED: 29 September, the oddiefun channel, the claim
       typed in Turkish, the market created at 21:43:30 UTC as "BTC to $88k by
       Friday?". Lev typed it himself, so the slide says the chat called it,
       never that a stranger did.
       THE RESULT IS DASHED BECAUSE IT HAS NOT HAPPENED. The market closes on 2
       October; close the stroke (done: true) the day Oddie posts it. */
    label: "The product", bg: D, ink: L,
    head: "A streamer gets paid for arguments their chat was having anyway.", headSize: 100,
    flow: [
      {
        tick: "29 Sep, Kick chat",
        by: "oddiefun, live",
        quote: "!oddie BTC cumaya kadar 88k olur mu?",
        cap: "Typed in Turkish, live on stream.",
      },
      {
        tick: "21:43:30 UTC",
        by: "Oddie, in the chat",
        quote: "Market open: ‘BTC to $88k by Friday?’ Take YES or NO: app.oddie.fun/m/…",
        cap: "Opened in English, in the same chat.",
      },
      {
        tick: "The stream",
        head: "2%",
        sub: "of the pool, to the channel",
        cap: "Whichever side wins.",
      },
    ],
    rail: {
      tag: "2 Oct 23:59 UTC",
      mark: "in the chat",
      text: "The deadline hits. Oddie settles it and posts the result in the chat.",
    },
  },
  {
    /* BOTTOM-UP, AND THE BIG NUMBER IS THE SMALLEST. The headline is the
       1,000-room line because that is the arithmetic a reader can redo:
       1,000 x 10 markets a week x $300 x 52 = $156M of volume, 2% of it $3.1M.
       The SAM is the same sum over the 91,000 Kick channels that streamed to
       an audience in August, with X and Telegram left out. */
    label: "Market size", bg: L, ink: I,
    head: "1,000 of the 91,000 Kick channels with an audience, opening 10 markets a week, is a $3.1M business.", headSize: 92,
    stats: [
      { big: "$544B", small: "a year of prediction-market volume (TAM, Aug 2026 run rate)" },
      { big: "$284M", small: "2% of 10 markets a week in 91,000 Kick rooms (SAM, est.)" },
      { big: "$3.1M", small: "2% of 10 markets a week in 1,000 rooms (SOM, est.)" },
    ],
    foot: "Why now: a model writes and settles the rules in seconds, and a market costs $0.31 to open. Kalshi is valued at $22B for running that desk by hand.",
    sources: "Sources: The Block, 2 Sep 2026 (August volume) · Streamer.Guide on Streams Charts data, 27 Sep 2026 (91,000 Kick channels averaging 5+ viewers) · The Block (Kalshi $22B). Estimates assume $300 pools.",
  },
  {
    /* HONEST, BECAUSE THE READER CHECKS. Nothing here is growing yet and the
       slide says so in its own headline; what it shows instead is the speed of
       shipping and the demand the founder has already drawn once. */
    label: "Traction", bg: Y, ink: I,
    head: "Three doors went live on mainnet within three weeks. Outside money is the next proof.", headSize: 96,
    rows: [
      { tag: "8 Sep", text: "Mainnet. The market program goes live on Solana." },
      { tag: "20 Sep", logo: "x", text: "X. @oddiefun opens markets from tags." },
      { tag: "26 Sep", logo: "telegram", text: "Telegram. @oddiefunbot in groups and DMs." },
      { tag: "30 Sep", logo: "kick", text: "Kick. !oddie in a stream’s chat." },
    ],
    foot: "30 Sep 2026: 18 markets, 2 staking wallets, 1.82 SOL pooled, mostly founder tests. No metric is growing yet; the founder’s last product drew a 45,000 waitlist.",
    sticker: "st-cooking", stickerBox: { x: 1340, y: 560, w: 500, h: 440 },
  },
  {
    /* THE RATE, THE COST AND WHAT ONE ROOM IS WORTH. A rate with no volume
       leaves the reader to guess; the estimates are labelled as estimates and
       their one assumption is in the foot. LTV/CAC: $3,120 a year against the
       test's $500 over 3 rooms, about $167 a room. */
    label: "Business model", bg: D, ink: L,
    head: "Anyone opens a market. Oddie keeps 2% of every pool it settles.", headSize: 100,
    body: ["Free while open. At settlement 4% of the pool: 2% to whoever opened it, 2% to Oddie."],
    stats: [
      { big: "$0.31", small: "to open a market on Solana" },
      { big: "$3,120", small: "a year from one room (est.)" },
      { big: "19x", small: "LTV to CAC, $167 to win a room (est.)" },
    ],
    foot: "Estimates assume 10 markets a week per room at $300 pools. 100 rooms in 12 months is a $310K run rate; 1,000 rooms in 24 months is $3.1M.",
  },
  {
    /* TWO FUNDED RIVALS ALREADY LET ANYONE OPEN A MARKET ON X, so that is not
       the difference any more and the slide does not pretend it is. The
       difference is the room: a stream channel earns from every market its
       chat opens. */
    label: "Competition", bg: L, ink: I,
    head: "Others let anyone open a market on X. Only Oddie lives in live rooms and pays the room.", headSize: 92,
    rows: [
      { tag: "Desk", text: "Kalshi, Polymarket: their own team picks every market." },
      { tag: "Worm", text: "Anyone creates, 2.5% creator fee, UMA settlement. $4.5M pre-seed." },
      { tag: "Kash", text: "Markets from X posts via @kash_bot. $2M pre-seed." },
      { tag: "Oddie", text: "Kick streams, Telegram groups and X. The channel earns from every market its chat opens." },
    ],
    foot: "The moat is installed rooms with a payout history. A copy starts at zero rooms.",
    matrix: {
      x: ["In their app", "In the chat"],
      y: ["A desk lists", "Anyone opens"],
      points: [
        { name: "Kalshi", x: 0.06, y: 0.08 },
        { name: "Polymarket", x: 0.1, y: 0.26 },
        { name: "Worm", x: 0.2, y: 0.82 },
        { name: "Kash", x: 0.62, y: 0.68 },
        { name: "Oddie", x: 0.92, y: 0.92, me: true },
      ],
    },
    sources: "Sources: Polymarket docs · Solana Compass (Worm) · BeInCrypto (Kash)",
  },
  {
    label: "Go-to-market", bg: D, ink: L,
    head: "Every streamer is a room, and we sign rooms one DM at a time.", headSize: 100,
    steps: ["DM", "First stream", "First market", "Fourth stream"],
    rows: [
      { tag: "Who", text: "Kick crypto, trading and just-chatting channels with 50 to 2,000 viewers." },
      { tag: "How", text: "20 DMs a day. Join the first stream; the chat opens the first market." },
      { tag: "Seed", text: "$500 seeds both sides of early pools. Target: 3 rooms in 2 weeks." },
      { tag: "Pass", text: "Stakers reach 2% of chatters and the median pool hits $100." },
    ],
    foot: "The round pays creators to open markets and takes the test to 100 rooms.",
  },
  {
    /* NO PRONOUN. The founder is named and faced; the copy says what was built
       and what happened, which is the part a reader is buying. */
    label: "The team", bg: L, ink: I,
    head: "A solo founder who built all of Oddie, and grew the last product to a 45,000 waitlist.", headSize: 84,
    body: ["Built end to end: Solana program, oracle, three bots, app. 678 commits since 14 July."],
    who: { name: "Lev", handle: "@levvercetti", photo: "madlev.jpg" },
    stats: [
      { big: "45,000", small: "waitlist, last product" },
      { big: "600", small: "weekly beta users" },
    ],
    foot: "The last product lost its store when Chrome banned the category. Next hire: a growth co-founder for streamer and creator deals.",
    sources: "Source: Chrome Web Store policy update, prediction-market extensions banned from 1 Aug 2026",
  },
  {
    /* AN ALLOCATION IS NOT A MILESTONE, so the milestones sit under it: the
       round buys an answer, and this is what the answer looks like. */
    label: "The ask", bg: C.pinkField, ink: C.cream,
    head: "$100,000", headSize: 196,
    body: ["Buys the answer: do streamers and groups bring their rooms?"],
    rows: [
      { tag: "30%", text: "Streamers and creators, paid to open markets." },
      { tag: "60%", text: "Founder, twelve months full time." },
      { tag: "10%", text: "Infra." },
    ],
    foot: "Milestones: 10 outside rooms, 3 markets per room a week, one $1,000 pool, no room lost in 4 weeks. Next round: Q1 2027.",
    narrow: true,
  },
  {
    /* THE FRAME CLOSES ON THE COVER'S LINE, and the one number to remember is
       the speed: 24 seconds, snowflake arithmetic anyone can redo (appendix). */
    label: "", bg: Y, ink: I,
    head: "Every argument\nis a market.", headSize: 128,
    body: ["Try it: !oddie on Kick, @oddiefun on X, @oddiefunbot on Telegram.", "lev@oddie.fun   ·   oddie.fun"],
    stats: [{ big: "24 SEC", small: "from a chat line to a live market" }],
    sticker: "st-main", stickerBox: { x: 1200, y: 460, w: 660, h: 580 },
  },
  {
    /* APPENDIX A1. The machine running unattended, end to end. Both accounts
       on this market were Lev's, so it proves the loop, not demand. The 24
       seconds is snowflake arithmetic: 2099850003501969749 at 13:17:08.818Z,
       2099850105037926466 at 13:17:33.026Z. The card is the one that was
       posted, frozen in brand/. */
    label: "Appendix · Proof", bg: L, ink: I,
    head: "It runs itself.",
    aside: ["Nobody typed it in.", "Nobody closed it."],
    flow: [
      {
        tick: "13:17:08",
        by: "Giga Chad",
        quote: "$BULLSHIT hits a 1m market cap within 3 days. screenshot this. @oddiefun",
      },
      {
        tick: "13:17:33", gapLabel: "24 sec",
        img: "step-market.png",
      },
      {
        tick: "On chain",
        head: "Real SOL",
        sub: "held until the deadline",
        note: "562CXadj…SRE6rc1D7",
      },
    ],
    rail: {
      tag: "18 Sep 13:17 UTC",
      mark: "NO",
      text: "It read the price history, answered NO, and replied under the tweet.",
      done: true,
    },
  },
  {
    label: "Appendix · Roadmap", bg: Y, ink: I,
    head: "It goes wherever people argue.",
    rows: [
      { tag: "Now", text: "Kick, X and Telegram. Live, with real money in it." },
      { tag: "Next", text: "Twitch. The same engine, one more door." },
      { tag: "Then", text: "A streamer’s own game, settled from the screen." },
      { tag: "After", text: "Discord, and any app with one key." },
    ],
    foot: "Oracle backtest, 30 Aug 2026: 25 runs, 0 wrong, 38% settled with no human. The rest is the resolver network's job.",
    sticker: "st-rocket", stickerBox: { x: 1400, y: 580, w: 440, h: 440 },
  },
  {
    /* THE QUESTIONS A CAREFUL READER ASKS SECOND, answered before they are
       asked. Each row is a rule we checked and what we do about it. */
    label: "Appendix · Risks", bg: D, ink: L,
    head: "The risks we know, and the answer to each.", headSize: 110,
    rows: [
      { tag: "Law", text: "18+ only. Paid markets stay off in the US and Türkiye." },
      { tag: "Kick", text: "Its guidelines bar gambling with funds from other users. We get Kick’s written OK before scaling the door." },
      { tag: "X", text: "AI replies need X’s prior written approval. We apply before scaling the X door." },
      { tag: "Telegram", text: "Mini Apps must use TON. Oddie’s bot has no Mini App, which the rules exempt." },
      { tag: "Wallet", text: "Phantom warns on young domains. Its domain review is the fix." },
    ],
    sources: "Sources: Kick Community Guidelines, 19 Mar 2026 · X Automation Rules · Telegram Blockchain Guidelines",
  },
];
export { C, W, H, PAD, shelf };
