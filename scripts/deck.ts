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

const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));

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
  let fs = s.headSize ?? 118;
  let lines = wrapToWidth(s.head, colW, fs, 4, "display").lines;
  while (fs > 48 && (lines.length > 3 || Math.max(...lines.map((l) => textWidth(l, fs, "display"))) > colW)) {
    fs -= 4;
    lines = wrapToWidth(s.head, colW, fs, 4, "display").lines;
  }
  const lh = Math.round(fs * 1.02);
  /* THE HEADLINE IS CENTRED ON 300 BUT IT MAY NOT CLIMB PAST THE HEADER, and a
     three-line head did: its cap height reached above the slide number and drew
     straight through "09 / 11  ROADMAP", which then could not be read at all.
     Anton's caps stand about 0.74em over the baseline, so this is the highest
     that first baseline can sit and still leave the label alone. */
  const headFloor = PAD - 8 + 44 + fs * 0.74;
  y = Math.max(headFloor, 300 - (lines.length - 1) * lh * 0.5);
  for (const l of lines) {
    parts.push(`<text x="${PAD}" y="${y}" font-family="${DISPLAY}" font-size="${fs}" fill="${s.ink}">${esc(l.toUpperCase())}</text>`);
    y += lh;
  }

  y += 44;
  for (const b of s.body ?? []) {
    const wrapped = wrapToWidth(b, colW, 36, 6, "meta").lines;
    for (const l of wrapped) {
      parts.push(`<text x="${PAD}" y="${y}" font-family="${BODY}" font-size="36" font-weight="600" fill="${s.ink}" fill-opacity=".86">${esc(l)}</text>`);
      y += 50;
    }
    y += 18;
  }

  if (s.steps?.length) {
    y += 8;
    let x = PAD;
    for (let i = 0; i < s.steps.length; i++) {
      const t = s.steps[i].toUpperCase();
      const w = textWidth(t, 44, "display");
      parts.push(`<text x="${x}" y="${y}" font-family="${DISPLAY}" font-size="44" fill="${s.ink}">${esc(t)}</text>`);
      x += w + 34;
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
      parts.push(`<text x="${x}" y="${y + 60}" font-family="${DISPLAY}" font-size="96" fill="${accent}">${esc(st.big)}</text>`);
      const wrapped = wrapToWidth(st.small, 380, 28, 3, "meta").lines;
      let yy = y + 108;
      for (const l of wrapped) {
        parts.push(`<text x="${x}" y="${yy}" font-family="${BODY}" font-size="28" font-weight="600" fill="${s.ink}" fill-opacity=".8">${esc(l)}</text>`);
        yy += 38;
      }
      x += 440;
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
const D = C.black, L = C.cream;
export const SLIDES: Slide[] = [
  {
    label: "", bg: C.yellow, ink: C.ink,
    head: "The people\u2019s prediction market.",
    body: ["Tag a claim on X. It opens in seconds.", "oddie.fun   @oddiefun"],
    sticker: "sticker-hero", stickerBox: { x: 1090, y: 380, w: 760, h: 620 },
    band: "no listing desk.",
  },
  {
    label: "The problem", bg: D, ink: L,
    head: "Being right pays. Just not where you argue.",
    body: [
      "Polymarket and Kalshi pay the right call. The thread still crowns the loudest.",
      "Confidence costs nothing where it is spent, because nobody keeps the receipts.",
    ],
    sticker: "crowd-strip", stickerBox: { x: 0, y: 760, w: 1920, h: 320 },
  },
  {
    label: "The solution", bg: C.yellow, ink: C.ink,
    head: "You argue. Oddie makes it a market.",
    steps: ["Tag", "Tap a side", "Oddie settles"],
    body: ["Seconds, not a listing process. And the settling is not a person: a coin market resolves from on-chain price history, with no operator and no model call."],
    sticker: "st-tag", stickerBox: { x: 1240, y: 560, w: 600, h: 460 },
  },
  {
    label: "Why now", bg: D, ink: L,
    head: "That zero is the whole company.",
    body: ["Every market on those apps is approved by a team before it exists, and Kalshi has no choice: approval is what makes it a legal exchange. The argument in your replies will never clear a desk."],
    stats: [
      { big: "$22B", small: "Kalshi\u2019s closed round, May 2026" },
      { big: "$40B+", small: "traded in one month across two apps" },
      { big: "0", small: "of it traded inside a thread" },
    ],
  },
  {
    label: "The founder", bg: C.cream, ink: C.ink,
    head: "Two years in. Now he can build it.",
    body: ["Lev spent two years on Poppin, a Chrome extension that put a prediction market on any website, and made Polymarket\u2019s builders program. Chrome banned the category days before launch. Oddie is the bigger idea he wanted all along, built where no company can switch it off."],
    stats: [
      { big: "45K+", small: "signed up for Poppin" },
      { big: "600+", small: "in the beta" },
      { big: "20K+", small: "posts written" },
    ],
  },
  {
    label: "Business model", bg: C.yellow, ink: C.ink,
    head: "4% of the pool. Once.",
    body: [
      "2% to whoever opened it. That is distribution.  2% to Oddie, at settlement.",
      "Nothing is taken while a market is open, so an unresolved market costs its participants nothing. Both rates are frozen per market when it opens, so changing them never reprices a pool that is already live.",
    ],
    sticker: "st-riding", stickerBox: { x: 1300, y: 580, w: 540, h: 440 },
  },
  {
    label: "Go to market", bg: D, ink: L,
    head: "The board ranks who brings people.",
    body: [
      "Connect X, get 5 tickets. One ticket opens one market. A spent ticket comes back when a new person bets on a market you opened.",
      "You score when someone new puts money in, not when you are right. So the people who rank are the people who bring the room, and they keep 2% of every pool they opened.",
    ],
    sticker: "genesis-ticket", stickerBox: { x: 1320, y: 520, w: 520, h: 520 },
  },
  {
    label: "The moat", bg: C.cream, ink: C.ink,
    head: "There is no desk to copy.",
    body: [
      "Their approval step is not a feature they chose. Kalshi is a regulated exchange; Polymarket curates. Neither can open a market on a tweet posted ten seconds ago.",
      "And every tag settles on chain under a handle. Give it a year and every account is a public track record, right and wrong both. Code copies. Records do not.",
    ],
    sticker: "st-called", stickerBox: { x: 1340, y: 560, w: 500, h: 460 },
  },
  {
    label: "Roadmap", bg: D, ink: L,
    head: "One market engine. Every surface is a door in.",
    // The stage words are labels, so they are set as labels. They were prose in
    // all caps, where Fredoka sets "IV" tight enough that LIVE reads as LNE.
    rows: [
      { tag: "Live", text: "X and Solana mainnet. Real money, and a tag becomes a market with no human in the loop. First fully autonomous settlement scheduled 18 September." },
      { tag: "Next", text: "Telegram. The bot is built and tested." },
      { tag: "Then", text: "Discord. Same engine, new crowd." },
      { tag: "Everywhere", text: "Partners. Any app opens markets with one key." },
    ],
    sticker: "st-rocket", stickerBox: { x: 1360, y: 560, w: 480, h: 440 },
  },
  {
    label: "The ask", bg: C.pinkField, ink: C.cream,
    head: "$250,000", headSize: 240,
    body: [
      "30% TEAM, first hires so shipping never stops.      30% CREATORS, puts Oddie in every feed.",
      "30% RUNWAY, founder, counsel, compliance.      10% INFRA, measured not estimated.",
      "What one tag costs us: $0.04 when nobody bets, $0.38 when somebody does, $0.00 for a second tag on the same post. The difference is Solana rent for the market account, spent only on a market that actually takes money.",
    ],
    sticker: "genesis-podium", stickerBox: { x: 1360, y: 520, w: 480, h: 500 },
  },
  {
    label: "", bg: C.yellow, ink: C.ink,
    head: "Be right. Be early. Be oddie.",
    body: ["oddie.fun   @oddiefun   lev@oddie.fun"],
    sticker: "st-main", stickerBox: { x: 1240, y: 480, w: 600, h: 540 },
    band: "be oddie.",
  },
];
export { C, W, H, PAD, shelf };
