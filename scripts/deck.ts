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

/** A screenshot, fitted inside its box and given the hard offset every other
 *  object on these slides has. Returns "" when the file is not there yet, so
 *  the slide falls back to its sticker rather than to a hole. */
function placeShot(file: string, box: { x: number; y: number; w: number; h: number }, bg: string): string {
  const stem = file.replace(/\.[^.]+$/, "");
  const src = [".png", ".jpg", ".jpeg", ".webp", ".PNG", ".JPG"]
    .map((ext) => path.join(ROOT, "brand", stem + ext))
    .find((f) => existsSync(f));
  if (!src) return "";
  const png = path.join(shelf, `shot-${stem}.png`);
  execFileSync("sips", ["-s", "format", "png", src, "--out", png], { stdio: "ignore" });
  const info = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", png]).toString();
  const iw = Number(/pixelWidth: (\d+)/.exec(info)?.[1] ?? 1);
  const ih = Number(/pixelHeight: (\d+)/.exec(info)?.[1] ?? 1);
  const k = Math.min(box.w / iw, box.h / ih);
  const w = Math.round(iw * k), h = Math.round(ih * k);
  const x = Math.round(box.x + box.w - w), y = Math.round(box.y + box.h - h);
  const uri = `data:image/png;base64,${readFileSync(png).toString("base64")}`;
  const off = 14;
  return `<rect x="${x + off}" y="${y + off}" width="${w}" height="${h}" rx="18" fill="${C.pink}"/>`
    + `<image href="${uri}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" clip-path="inset(0 round 18)"/>`
    + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="none" stroke="${C.black}" stroke-width="6"/>`;
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
  /** A real screenshot, framed. Shown instead of the slide's sticker when the
   *  file is there, because a photograph of the thing happening outranks any
   *  drawing of it. */
  shot?: string;
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

  if (s.shot && s.stickerBox) {
    const framed = placeShot(s.shot, s.stickerBox, s.bg);
    if (framed) parts.push(framed);
    else if (s.sticker) parts.push(placeSticker(s.sticker, s.stickerBox));
  } else if (s.sticker && s.stickerBox) {
    parts.push(placeSticker(s.sticker, s.stickerBox));
  }
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

  let y = 300;
  // A portrait takes the same right-hand column a sticker does, and forgetting
  // that ran the body text straight under the circle.
  const colW = s.sticker || s.who ? 1060 : W - PAD * 2;

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
      { big: "600", small: "made it into the beta" },
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
       reader itself. The claim is that it is automatic, so say that.
       AND A DATED LIST TELLS, IT DOES NOT SHOW. The artifact is the thread on
       X: the tag, the bot opening the market, and the bot returning with the
       result and a Solana link. Drop that screenshot in as brand/thread.png
       and it takes the slide; until then the sticker holds the space. */
    label: "It works", bg: D, ink: L,
    head: "It runs itself.",
    shot: "thread.png",
    /* THE LAST TWO LINES HAVE NOT HAPPENED YET, so they are written as what
       they are: a dated commitment with a public link under it. That is a
       stronger thing to hand an investor than a past-tense claim, because it is
       falsifiable and they can go and check it themselves tomorrow. When it
       fires, the tense changes and brand/thread.png takes the right half. */
    rows: [
      { tag: "15 Sep", text: "A tag on X. The market opened in seconds, unattended." },
      { tag: "15 Sep", text: "Real SOL went into the pool, on Solana mainnet." },
      { tag: "18 Sep", text: "It settles itself from on-chain price history. No operator, no model call." },
      { tag: "18 Sep", text: "The bot answers the original tweet with the receipt." },
    ],
    // A nineteen-digit tweet id set in Fredoka is not a link anybody follows: its
    // underscores read as doubled and nobody types that off a PDF. The thread is
    // findable from the handle and the date, which is the part that matters.
    foot: "The last two are scheduled, not yet run. The thread is public: @giga_g_chad on X, 15 September.",
    sticker: "st-called", stickerBox: { x: 1090, y: 240, w: 760, h: 790 },
  },
  {
    label: "Why now", bg: Y, ink: I,
    head: "None of it happened in a thread.",
    stats: [
      { big: "$22B", small: "what Kalshi is worth" },
      { big: "$40B", small: "traded in one month" },
      { big: "0", small: "of it inside a thread" },
    ],
  },
  {
    label: "The money", bg: D, ink: L,
    head: "4% when it is over. Nothing before.",
    body: ["Half of it goes to whoever opened the market."],
    sticker: "st-riding", stickerBox: { x: 1260, y: 540, w: 600, h: 480 },
  },
  {
    label: "How it spreads", bg: Y, ink: I,
    head: "Bring the room, own the room.",
    body: ["Open a market and keep 2% of it. Forever."],
    sticker: "genesis-ticket", stickerBox: { x: 1300, y: 480, w: 560, h: 560 },
  },
  {
    /* PRESENT TENSE, because the old version was entirely future: "give it a
       year and every account is a track record" is a moat in year two of a
       company in week one, and an investor discounts that to nothing. The
       record starts on the first settled call, and the first one is dated on
       slide five. */
    label: "The moat", bg: D, ink: L,
    head: "Every call already has a name on it.",
    body: ["It settles on chain under your handle, right or wrong. That record is the product, and a clone starts at zero."],
    sticker: "arch-judge", stickerBox: { x: 1320, y: 540, w: 520, h: 480 },
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
    sticker: "st-rocket", stickerBox: { x: 1400, y: 580, w: 440, h: 440 },
  },
  {
    label: "The ask", bg: C.pinkField, ink: C.cream,
    head: "$100,000", headSize: 220,
    body: ["The product is built and live. This is for reach."],
    rows: [
      { tag: "30%", text: "Creators. Pays the people who bring the room." },
      { tag: "30%", text: "Team. So shipping never stops." },
      { tag: "30%", text: "Runway. Founder, counsel, compliance." },
      { tag: "10%", text: "Infra. Measured, not estimated." },
    ],
    sticker: "genesis-podium", stickerBox: { x: 1440, y: 580, w: 400, h: 440 },
  },
  {
    label: "", bg: Y, ink: I,
    head: "Be right. Be early. Be oddie.",
    body: ["lev@oddie.fun"],
    sticker: "st-main", stickerBox: { x: 1200, y: 460, w: 660, h: 580 },
  },
];
export { C, W, H, PAD, shelf };
