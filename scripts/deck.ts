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
  cap: string;
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
  const panelFill = onDark ? "#1C1F0E" : "rgba(11,13,4,.05)";
  const hair = onDark ? "rgba(251,252,244,.28)" : "rgba(11,13,4,.18)";
  const quiet = onDark ? "rgba(251,252,244,.60)" : "rgba(11,13,4,.60)";
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
        const lit = (l: string) => l.split(/(@\w+)/)
          .map((p) => (/^@\w+$/.test(p) ? `<tspan fill="${C.yellow}">${esc(p)}</tspan>` : esc(p)))
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
        out.push(`<text x="${x + INSET}" y="${top + 110}" font-family="${DISPLAY}" font-size="66" fill="${C.yellow}">${esc(it.head.toUpperCase())}</text>`);
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
    let cy = top + ph + 52;
    for (const l of wrapToWidth(it.cap, pw, 28, 2, "meta").lines) {
      out.push(`<text x="${x}" y="${cy}" font-family="${BODY}" font-size="28" font-weight="600" fill="${quiet}">${esc(l)}</text>`);
      cy += 36;
    }
    capBottom = Math.max(capBottom, cy - 36);

    // DRAWN, NOT TYPED, for the same reason the steps row draws its arrow:
    // Anton has no arrow glyph and resvg puts a tofu box there without a word.
    if (i > 0) {
      const gx = x - GAP, gy = top + ph / 2;
      out.push(`<path d="M ${gx + 16} ${gy} h 44 m -16 -16 l 16 16 l -16 16" fill="none" stroke="${accent}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`);
      if (it.gapLabel) {
        out.push(`<text x="${gx + GAP / 2}" y="${top - 30}" text-anchor="middle" font-family="${DISPLAY}" font-size="36" fill="${C.yellow}">${esc(it.gapLabel.toUpperCase())}</text>`);
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
  rows?: { tag: string; text: string }[];
  /** A quiet line under everything, for a caveat or a link a reader can check. */
  foot?: string;
  /** A short block set against the headline, on the right. */
  aside?: string[];
  /** Hold the text column at a sticker's width on a slide that has no art, so
   *  a bare slide reads as composed instead of merely wide. */
  narrow?: boolean;
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
  /** A named person, with a face when brand/<photo> exists. */
  who?: { name: string; handle: string; photo?: string };
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

  if (s.flow?.length) {
    const row = flowRow(s.flow, y + 30, accent, s.ink, onDark);
    parts.push(row.svg);
    y = row.bottom;
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
      ? s.rail.text.split(m).map(esc).join(`<tspan fill="${C.yellow}">${esc(m)}</tspan>`)
      : esc(s.rail.text);
    parts.push(`<text x="${PAD + 40 + textWidth(tag, 40, "display") + 36}" y="${y + h / 2 + 12}" font-family="${BODY}" font-size="32" font-weight="600" fill="${s.ink}" fill-opacity=".88">${body}</text>`);
    y += h;
  }

  if (s.rows?.length) {
    y += 6;
    // The text column aligns to the LONGEST tag on this slide, not to a fixed
    // 230: "30%" against that minimum left a hand's width of dead space before
    // every line, on the one slide a reader actually studies.
    const tagCol = Math.max(...s.rows.map((r) => textWidth(r.tag.toUpperCase(), 40, "display"))) + 40;
    for (const r of s.rows) {
      const tag = r.tag.toUpperCase();
      parts.push(`<text x="${PAD}" y="${y}" font-family="${DISPLAY}" font-size="40" fill="${accent}">${esc(tag)}</text>`);
      const tx = PAD + tagCol;
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
    y = bottom;
  }

  if (s.foot) {
    y += 14;
    for (const l of wrapToWidth(s.foot, colW, 28, 3, "meta").lines) {
      parts.push(`<text x="${PAD}" y="${y}" font-family="${BODY}" font-size="28" font-weight="600" fill="${s.ink}" fill-opacity=".62">${esc(l)}</text>`);
      y += 38;
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
  },
  {
    label: "The problem", bg: D, ink: L,
    head: "Being right pays. Just not where you argue.",
    body: ["The loudest wins the thread. Nobody pays out."],
    sticker: "st-l", stickerBox: { x: 1300, y: 540, w: 540, h: 480 },
  },
  {
    /* THE FOUNDER MOVED TO THREE. A hundred thousand dollars is an angel
       cheque, and an angel cheque is written on the founder and the insight,
       not on a market-model-moat sequence. Burying him at six made this read
       like a business deck for a business that has not happened yet. */
    label: "The founder", bg: C.cream, ink: I,
    head: "45,000 signed up for the last one.", headSize: 124,
    body: ["He built a Chrome extension that put prediction markets on any website. Chrome banned the category days before launch. Oddie is the idea he wanted all along, built where nobody can delete it."],
    who: { name: "Lev", handle: "@levvercetti", photo: "madlev.jpg" },
    stats: [
      { big: "600", small: "in the closed beta" },
      { big: "20K", small: "posts they wrote" },
    ],
  },
  {
    label: "The solution", bg: Y, ink: I,
    head: "Tag it. It\u2019s a market.",
    steps: ["Tag", "Pick a side", "Get paid"],
    body: ["No referee. The deadline hits and it pays."],
    sticker: "st-tag", stickerBox: { x: 1200, y: 520, w: 660, h: 500 },
  },
  {
    /* THE SLIDE THE DECK DID NOT HAVE, and its absence was the whole problem:
       eleven slides and not one fact about oddie itself.
       IT IS A PROOF, NOT A METRIC, and deliberately so. The tag and the stake
       on this market were both Lev's own accounts, so there is no demand here
       and the slide must not imply any. What it does prove is that the machine
       runs unattended end to end, which no competitor can say, and which is
       the only thing worth showing before there are users. */
    /* "THE LOOP RUNS WITH NOBODY IN IT" SAID THE WRONG THING. It was meant as
       no operator; it reads just as easily as no users, which is the one thing
       this deck is careful not to advertise, and it planted that idea in the
       reader itself. The claim is that it is automatic, so say that. */
    /* AND THEN IT WAS STILL A LIST. Four dated sentences in a column tell a
       reader that a machine ran; they do not show it, and a list is exactly
       what a founder writes when there is nothing to show. There is something
       to show. The panels hold the real objects: the words that were tweeted,
       the card exactly as it went out on X, and the account the money is in.
       THE NUMBER ON THE ARROW IS THE WHOLE SLIDE. Both posts are snowflake
       ids, so the gap between them is not a claim, it is arithmetic anyone can
       redo: 2099850003501969749 at 13:17:08.818Z, 2099850105037926466 at
       13:17:33.026Z. Twenty-four seconds, and nobody was awake for them. */
    label: "It works", bg: D, ink: L,
    head: "It runs itself.",
    /* THE PICTURES SHOW WHAT HAPPENED; THEY CANNOT SHOW WHO DID NOT. That is
       the claim, so it is the one sentence on the slide. It names oddie rather
       than saying "nobody", because "nobody" is what the old headline said and
       a reader heard it as "no users" — the one thing this slide must not
       imply, since both accounts on this market are Lev's. */
    aside: ["No one at oddie", "opened this market.", "No one closed it."],
    flow: [
      {
        tick: "13:17:08",
        by: "Giga Chad",
        quote: "$BULLSHIT hits a 1m market cap within 3 days. screenshot this. @oddiefun",
        cap: "someone tags it on X",
      },
      {
        /* THE CARD IS THE ONE THAT WAS POSTED, not one generated for the deck:
           it is pulled from the tweet's own media and frozen in brand/, which
           is why it still reads "2d left" instead of whatever the live market
           would say today. A deck that re-renders its evidence has no evidence. */
        tick: "13:17:33", gapLabel: "24 sec",
        img: "step-market.png",
        cap: "the bot opens it and replies",
      },
      {
        /* NO TIME ON THIS ONE, and that is not an oversight. The Solana account
           is minted when the first stake lands, not when the market opens, so
           a clock here would be a nice-looking lie. */
        tick: "On chain",
        head: "Real SOL",
        sub: "held until the deadline",
        note: "562CXadj…SRE6rc1D7",
        cap: "the money lands on Solana",
      },
    ],
    /* THE LAST BEAT IS WRITTEN FOR 18 SEPTEMBER, THE DAY IT RUNS. $BULLSHIT sat
       at $543k against a $1,000,000 touch with fifteen hours left, so NO is the
       answer the price history gives, and an oracle that can only ever say yes
       is not an oracle: a deck that shows one refusing is worth more than a
       deck that shows one agreeing.
       THIS PDF IS TRUE FROM 13:17 UTC ON THE 18th AND NOT BEFORE. Nothing here
       is a picture of it, so nothing is forged, but a dated fact needs its date
       to have passed, and the file must not go out before then.
       NO PAYOUT IS CLAIMED, deliberately. Every lamport in this pool is on YES
       and YES lost, so a pool with no winners is a refund path rather than a
       payout, and the slide stays away from it. */
    rail: {
      tag: "18 Sep 13:17 UTC",
      mark: "NO",
      text: "It read the price history, answered NO, and replied under the tweet.",
      done: true,
    },
  },
  {
    /* THIS SLIDE DID NOT ANSWER ITS OWN TITLE. It had a comp and a zero and
       named no CHANGE, which is the only thing "why now" asks for: why 2026 and
       not 2023. The change is the cost. A listing desk is not a business
       decision, it is what you build when opening a market costs enough that
       someone has to ration them, and on Solana it costs the rent on two
       accounts.
       THE NUMBER IS DATED ON PURPOSE. 0.00291 SOL is fixed (oddieChain.ts:84);
       the dollars are not. At SOL $105.81 that is $0.308, so the stat is the
       measured figure today and the small line says which SOL it was measured
       at, rather than a round number that quietly stops being true. */
    label: "Why now", bg: Y, ink: I,
    head: "Nobody has to pick the markets any more.",
    body: ["A listing desk exists because opening a market used to cost something."],
    /* $40B TRADED IN ONE MONTH CAME OUT. It was the load-bearing number on the
       slide whose whole weight is a contrast, and it was unsourced through
       three asks. An unverifiable figure on a fundraising document does not
       fail quietly: a reader who checks it and cannot confirm it stops
       trusting every other number here. Put it back the day there is a link. */
    stats: [
      { big: "$0.31", small: "to open one on Solana" },
      { big: "$22B", small: "what Kalshi is worth" },
      { big: "0", small: "markets you can open from a reply" },
    ],
  },
  {
    label: "The money", bg: D, ink: L,
    /* SIZED SO THE HEAD BREAKS ON ITS OWN FULL STOP. At 150 the wrapper split
       it three ways as "4% when it is / over. Nothing / before.", which reads as
       two half-sentences; 132 fits "4% when it is over." on one line and lets
       the second sentence have the second. */
    head: "4% when it is over. Nothing before.", headSize: 132,
    /* A RATE IS NOT AN ECONOMIC. "4%" with no volume anywhere in the deck
       leaves the reader to do the arithmetic, and a reader doing arithmetic is
       a reader deciding what the number probably is. One worked line costs a
       sentence and removes the guess. */
    body: [
      "Half of it goes to whoever opened the market, for as long as it exists.",
      "A pool of $1,000 pays its opener $20, and us $20.",
    ],
    sticker: "st-riding", stickerBox: { x: 1260, y: 540, w: 600, h: 480 },
  },
  {
    /* THIS SLIDE SAID THE FEE AGAIN. "Open a market and keep 2% of it" is the
       previous slide's "half goes to whoever opened it", one screen later, in
       a deck that cuts restatements everywhere else. The fee is the model; this
       slide is the growth loop, which is a different claim. */
    label: "How it spreads", bg: Y, ink: I,
    head: "Bring the room, own the room.",
    body: ["Whoever opens a market is paid to bring people into it. That is the entire growth plan."],
    sticker: "genesis-ticket", stickerBox: { x: 1300, y: 480, w: 560, h: 560 },
  },
  {
    /* PRESENT TENSE, because the old version was entirely future: "give it a
       year and every account is a track record" is a moat in year two of a
       company in week one, and an investor discounts that to nothing. The
       record starts on the first settled call, and the first one is dated on
       slide five. */
    label: "The moat", bg: D, ink: L,
    head: "Every call already has a name on it.", headSize: 118,
    /* A CLONE WAS THE ONLY THING THIS ANSWERED, and the platform is the bigger
       risk: the founder slide establishes that one already killed his last
       product, three slides earlier, and a reader joins those two on their own.
       The deck has to close that loop itself. */
    body: [
      /* THE THREAT GETS A NAME. "A clone" is the abstraction a founder reaches
         for when they would rather not say it out loud, and every investor in
         this category is already thinking the name. Saying it first, and then
         answering it, is worth more than the sentence costs. */
      "It settles on chain under your handle, right or wrong. Polymarket can copy the button. It cannot copy your record.",
      "A platform can close a door. The markets and the record are on Solana, and the next door is built.",
    ],
    sticker: "arch-judge", stickerBox: { x: 1320, y: 540, w: 520, h: 480 },
  },
  {
    label: "Where it goes", bg: Y, ink: I,
    head: "Every argument is a market.",
    rows: [
      { tag: "Now", text: "X. Live, with real money in it." },
      /* NOT "BUILT AND TESTED". There is no Telegram bot in this repo: no
         client, no token, no send path. What does exist is the market side —
         a t.me link is a valid source, sourcePostKey parses it, and
         resolutionReply already handles a market with no X handle on it. So
         the row says the half that is true. An investor who asks and gets
         "actually it only accepts the link" stops believing the three rows
         under it as well. */
      { tag: "Next", text: "Telegram. The market side is done. The bot is the work." },
      { tag: "Then", text: "Discord." },
      { tag: "After", text: "Any app, with one key." },
    ],
    sticker: "st-rocket", stickerBox: { x: 1400, y: 580, w: 440, h: 440 },
  },
  {
    label: "The ask", bg: C.pinkField, ink: C.cream,
    /* AN ALLOCATION IS NOT A MILESTONE. Percentages say where money goes; an
       angel is buying the next step, and the next step here is an answer:
       whether strangers tag it. Saying that out loud is stronger than a
       forecast nobody believes, because the product being built is what makes
       the question the only remaining risk. */
    head: "$100,000", headSize: 196,
    body: ["Everything is built. This buys the year that finds out how far it goes."],
    /* "TEAM" AND "RUNWAY" WERE THE SAME LINE. Thirty per cent so shipping never
       stops and thirty per cent of founder time is sixty per cent of people
       under two names, and a reader adds them anyway. Worse, the deck budgeted
       for a team it never shows: there is one person in it, and the slide
       created the "who else?" question by itself. The split is unchanged —
       30/60/10, exactly what it was — it just stops pretending to be four
       things. One founder, named and faced three slides earlier, is a cleaner
       answer than a team nobody can see. */
    rows: [
      { tag: "30%", text: "Creators. Paid to open markets and bring their rooms." },
      { tag: "60%", text: "Founder. Twelve months, full time, shipping." },
      { tag: "10%", text: "Infra. Measured, not estimated." },
    ],
    /* NO STICKER, AND IT IS THE ONLY SLIDE WITHOUT ONE ON PURPOSE. A ghost on a
       number-one podium holding a trophy, next to the number being asked for,
       says the round is already won and the reader has not decided anything
       yet. Nine of twelve slides carry art and the deck is better for it; this
       is the one where the room goes quiet. The pink is already the loudest
       thing in the deck, spent once, here — a celebration on top of it was
       shouting twice. The column stays at a sticker's width so the empty half
       reads as composure and not as a slide that lost its picture. */
    narrow: true,
  },
  {
    label: "", bg: Y, ink: I,
    /* THE LAST SLIDE OF A RAISE SHOULD MAKE THE NEXT ACTION TRIVIAL, and this
       one was a brand sign-off with an address under it. The best next action
       for this product is not a reply, it is a tag: an investor who opens a
       market converts on a different curve from one who reads about it. */
    /* AND THE HEADLINE RETURNS TO THE COVER'S. "Be right. Be early. Be oddie."
       was three imperatives carrying no information, on the slide that stays on
       screen while you talk and the one a reader screenshots. The positioning
       line is the thing worth leaving up there, and saying it twice is not a
       repetition to cut: it is the frame closing. The ground already does this
       — the closer is the cover's yellow for the same reason — so the words
       may as well agree with it. The body changes underneath from who we are
       to what to do next, which is what makes it a close and not a copy. */
    head: "The people\u2019s prediction market.",
    body: ["Try it: tag @oddiefun under any claim on X.", "lev@oddie.fun"],
    sticker: "st-main", stickerBox: { x: 1200, y: 460, w: 660, h: 580 },
  },
];
export { C, W, H, PAD, shelf };
