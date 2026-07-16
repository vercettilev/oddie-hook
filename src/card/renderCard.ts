import { Market } from "../venues/types.js";
import { logoMark } from "./logoMark.js";

// The card IS Oddie talking. Logo language: chunky black rounded outline,
// white fill, brand lime (#B6F05F), the two ghost eyes as the one playful
// signature. Super simple: one hero number, one colour, lots of air.
// No venue named — just Oddie brand + normalized volume as the trust signal.
//
// Layout is measured, not hand-placed. The card is posted to X with whatever
// question a live venue happens to be running, from "Who will the next Pope
// be?" to a 110-character Fed question, and with a percentage that is one, two
// or three digits wide. Fixed coordinates collide on that range. So: text is
// wrapped to a width budget, the question's type size steps down until the
// block fits its band, and the hero number, its kicker and the yes/no bar are
// positioned relative to each other rather than to magic numbers.

export const C = {
  accent: "#B6F05F", // brand lime (the var kept its name; the value is Oddie green)
  ink: "#000000",
  number: "#141414", // the hero number's fill; near-black so it reads on lime and white alike
  white: "#FFFFFF",
  muted: "#6B7A88",
  pill: "#F3FBDA",
  barBg: "#E7EDF2",
};

export const FONT = "'Fredoka', 'Trebuchet MS', sans-serif";
export const META = "'Nunito', system-ui, sans-serif";

// --- Geometry ---------------------------------------------------------------

const W = 1000;
const H = 524;

const PAD_L = 70;
const PAD_R = 932;
const CONTENT_W = PAD_R - PAD_L;

/** The question lives strictly between these two y values, caps to descenders. */
const Q_TOP = 156;
const Q_BOTTOM = 305;

const HERO_BASE = 462;
const HERO_FS_MAX = 150;
const HERO_RIGHT_LIMIT = 520; // keep the number clear of the bar

const KICKER_FS = 34;
/** The offer's baseline: above the invitation (which shares HERO_BASE), below
 *  the tension badge. The old mini-bar geometry (BAR_*) retired with the bar. */
const OFFER_BASE = 428;

/** Fractions of the em box. Rounded up rather than down: overestimating width
 *  costs a little air, underestimating overflows the card. */
const CAP = 0.72;
const DESC = 0.22;

// --- Text measurement -------------------------------------------------------

const NARROW = new Set("ijltIf.,:;'!|()[]/\\-".split(""));
const WIDE = new Set("mwMW%@".split(""));
const UPPER = /[A-Z]/;
const DIGIT = /[0-9]/;

function charEm(ch: string): number {
  if (ch === " ") return 0.28;
  if (NARROW.has(ch)) return 0.32;
  if (WIDE.has(ch)) return 0.95;
  if (DIGIT.test(ch)) return 0.6;
  if (UPPER.test(ch)) return 0.7;
  return 0.55;
}

/** Approximate advance width. The real font is not available to us here, so this
 *  is deliberately generous; every consumer adds its own margin on top. */
export function textWidth(s: string, fs: number): number {
  let em = 0;
  for (const ch of s) em += charEm(ch);
  return em * fs;
}

interface Wrapped {
  lines: string[];
  overflow: boolean;
}

/** Greedy wrap to a pixel budget. Long single words are hard-broken. */
function wrapToWidth(text: string, maxW: number, fs: number, maxLines: number): Wrapped {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";

  for (let i = 0; i < words.length; i++) {
    let w = words[i];

    // A word wider than the whole line can never fit; split it.
    while (textWidth(w, fs) > maxW) {
      let cut = w.length - 1;
      while (cut > 1 && textWidth(w.slice(0, cut), fs) > maxW) cut--;
      if (cur) {
        lines.push(cur);
        cur = "";
        if (lines.length === maxLines) return { lines, overflow: true };
      }
      lines.push(w.slice(0, cut));
      if (lines.length === maxLines) return { lines, overflow: true };
      w = w.slice(cut);
    }

    const candidate = cur ? `${cur} ${w}` : w;
    if (textWidth(candidate, fs) <= maxW) {
      cur = candidate;
      continue;
    }

    lines.push(cur);
    cur = w;
    if (lines.length === maxLines) return { lines, overflow: true };
  }

  if (cur) lines.push(cur);
  return { lines, overflow: false };
}

/** Trim a line until it plus an ellipsis fits. */
function ellipsize(line: string, maxW: number, fs: number): string {
  if (textWidth(line, fs) <= maxW) return line;
  let s = line;
  while (s.length > 1 && textWidth(s + "…", fs) > maxW) s = s.slice(0, -1);
  return s.trimEnd() + "…";
}

/**
 * Largest type size at which the question fits the band, both across (three
 * lines of CONTENT_W) and down (Q_TOP..Q_BOTTOM). Falls back to the smallest
 * size with an ellipsis rather than letting the text run into the hero number.
 */
export function layoutQuestion(question: string): { fs: number; lineH: number; lines: string[] } {
  const MAX_LINES = 3;
  const budget = CONTENT_W - 12; // a little slack for font-metric drift

  for (const fs of [58, 52, 46, 42, 38]) {
    const lineH = Math.round(fs * 1.22);
    const { lines, overflow } = wrapToWidth(question, budget, fs, MAX_LINES);
    if (overflow) continue;
    const height = CAP * fs + (lines.length - 1) * lineH + DESC * fs;
    if (Q_TOP + height <= Q_BOTTOM) return { fs, lineH, lines };
  }

  const fs = 38;
  const lineH = Math.round(fs * 1.22);
  const { lines } = wrapToWidth(question, budget, fs, MAX_LINES);
  lines[lines.length - 1] = ellipsize(lines[lines.length - 1] + " …", budget, fs);
  return { fs, lineH, lines };
}

// --- Small pieces -----------------------------------------------------------

export function esc(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}

export function money(n: number): string {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

function timeLeft(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return " · closing";
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  return d > 0 ? ` · ${d}d left` : ` · ${h}h left`;
}

/** One eye: black disc + white highlight, matching the logo. */
export function eye(cx: number, cy: number, r: number): string {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${C.ink}"/>
    <circle cx="${cx - r * 0.32}" cy="${cy - r * 0.34}" r="${r * 0.32}" fill="${C.white}"/>`;
}

const WORDMARK_RIGHT = 140 + textWidth("oddie", 46);

/** Volume pill, dropped down to just the money if the full string would reach
 *  the wordmark. Community markets have no venue volume — their pill speaks
 *  "% yes" language: the countdown (and "community" if it fits). */
function volumePill(m: Market): { text: string; w: number; x: number } {
  const candidates = m.venue === "community"
    ? [`community${timeLeft(m.closesAt)}`, timeLeft(m.closesAt).replace(/^ · /, "") || "community"]
    : [money(m.volumeUsd) + " in play" + timeLeft(m.closesAt), money(m.volumeUsd) + " in play"];
  for (const text of candidates) {
    const w = Math.round(textWidth(text, 21) + 44);
    const x = PAD_R - w;
    if (x >= WORDMARK_RIGHT + 24) return { text, w, x };
  }
  const text = m.venue === "community" ? "community" : money(m.volumeUsd);
  const w = Math.round(textWidth(text, 21) + 44);
  return { text, w, x: PAD_R - w };
}

// --- The card ---------------------------------------------------------------

export function renderCard(m: Market): string {
  const yes = Math.max(0, Math.min(100, Math.round(m.yesPct)));
  const no = 100 - yes;

  const q = layoutQuestion(m.question);
  const firstBaseline = Q_TOP + CAP * q.fs;
  const questionTspans = q.lines
    .map((l, i) => `<tspan x="${PAD_L}" y="${Math.round(firstBaseline + i * q.lineH)}">${esc(l)}</tspan>`)
    .join("");

  const pill = volumePill(m);

  // Hero number. It only shrinks if three digits would crowd the bar; at the
  // sizes we ship (1%..100%) it never does, so the brand size is stable.
  const heroText = `${yes}%`;
  let heroFS = HERO_FS_MAX;
  while (heroFS > 96 && PAD_L + textWidth(heroText, heroFS) > HERO_RIGHT_LIMIT) heroFS -= 6;

  // The kicker sits ABOVE the number, not on its baseline: at 150px the number's
  // left sidebearing is nowhere near a 34px word, and the two used to touch.
  const heroCapTop = HERO_BASE - CAP * heroFS;
  const kickerBaseline = Math.round(heroCapTop - 14);

  // The right zone is the CLICK TRIGGER, not a second infographic. The old
  // mini-bar duplicated the giant number and did no work; in its place:
  //   - the OFFER: what being right on the underdog side pays ("no pays 4.5x")
  //   - the INVITATION: "call it" + a drawn arrow (drawn, not typed — the
  //     bundled fonts have no U+2192 and resvg renders missing glyphs as tofu)
  //   - a tension badge when the market is genuinely split (40-60%)
  const udSide = yes <= 50 ? "yes" : "no";
  const udPct = udSide === "yes" ? yes : no;
  const mRaw = 100 / Math.max(1, udPct);
  const mult = mRaw >= 10 ? Math.round(mRaw) : Math.round(mRaw * 10) / 10;
  const offerText = `${udSide} pays ${mult}\u00d7`;
  const OFFER_FS = 40;
  const balanced = yes >= 40 && yes <= 60;
  const badgeText = "too close to call";
  const badgeW = Math.round(textWidth(badgeText, 20) + 40);
  const inviteText = "call it";
  const inviteW = Math.round(textWidth(inviteText, 23));
  const arrowX = PAD_R - 30; // drawn arrow sits right of the invite text

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT}">
  <rect width="${W}" height="${H}" fill="${C.white}"/>

  <!-- the speech-bubble card: chunky rounded black outline, like the logo -->
  <rect x="26" y="26" width="948" height="472" rx="46" fill="${C.white}" stroke="${C.ink}" stroke-width="13"/>

  <!-- oddie mark + wordmark, as a lockup -->
  ${logoMark(52, 62, 68)}
  <text x="140" y="112" font-size="46" font-weight="600" fill="${C.ink}">oddie</text>

  <!-- volume pill (no venue named) -->
  <rect x="${pill.x}" y="72" width="${pill.w}" height="48" rx="24" fill="${C.pill}"/>
  <text x="${pill.x + pill.w / 2}" y="103" font-family="${META}" font-size="21" font-weight="700"
        fill="${C.muted}" text-anchor="middle">${esc(pill.text)}</text>

  <!-- the take -->
  <text font-size="${q.fs}" font-weight="600" fill="${C.ink}">${questionTspans}</text>

  <!-- hero number: near-black with a thin white outline, matching the feed. On the
       card's white ground the outline is invisible, so it reads as a solid black
       number; the same treatment over the feed's blue fill shows the white halo. -->
  <text x="${PAD_L}" y="${kickerBaseline}" font-size="${KICKER_FS}" font-weight="600" fill="${C.accent}">yes</text>
  <text x="${PAD_L}" y="${HERO_BASE}" font-size="${heroFS}" font-weight="700" fill="${C.number}"
        stroke="${C.white}" stroke-width="9" paint-order="stroke" stroke-linejoin="round">${heroText}</text>

  <!-- the dare: badge (when split), the offer, and the invitation -->
  ${balanced ? `<rect x="${PAD_R - badgeW}" y="346" width="${badgeW}" height="40" rx="20" fill="${C.white}" stroke="${C.ink}" stroke-width="3"/>
  <text x="${PAD_R - badgeW / 2}" y="372" font-family="${META}" font-size="20" font-weight="800"
        fill="${C.ink}" text-anchor="middle">${badgeText}</text>` : ""}
  <text x="${PAD_R}" y="${OFFER_BASE}" font-size="${OFFER_FS}" font-weight="600" fill="${C.accent}"
        stroke="${C.ink}" stroke-width="2.5" paint-order="stroke" stroke-linejoin="round"
        text-anchor="end">${offerText}</text>
  <text x="${arrowX - 12}" y="${HERO_BASE}" font-family="${META}" font-size="23" font-weight="800"
        fill="${C.ink}" text-anchor="end">${inviteText}</text>
  <path d="M ${arrowX - 2} ${HERO_BASE - 8} h 24 m -9 -9 l 9 9 l -9 9" stroke="${C.ink}" stroke-width="4"
        fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}
