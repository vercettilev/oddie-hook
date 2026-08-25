import { Market } from "../venues/types.js";
import { X_HANDLE } from "../brand.js";
import { displayTitle } from "../title.js";
import { logoMark } from "./logoMark.js";

// The card IS Oddie talking. Logo language: chunky black rounded outline,
// white fill, brand chartreuse (#D7DC1F), the two ghost eyes as the one playful
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

// These are the LIVE APP's tokens, deliberately: the card is the app's face on
// X, and for a while it was not wearing the app's colours. The landing and the
// feed moved to the chartreuse sampled off the Oddie mark (--accent #D7DC1F, a
// yellow-green); the cards stayed on the mint-lime that shipped before it
// (#B6F05F) because the value lived here as a literal with nothing tying it to
// the stylesheets. The two greens are close enough to survive a glance and far
// enough apart to read as two products when a share card and the page it opens
// sit on one screen. Every value below now matches a token in feed.html by
// name; keep them in step.
export const C = {
  accent: "#D7DC1F", // --accent: brand chartreuse, sampled off the mark
  ink: "#000000",
  number: "#141414", // the hero number's fill; near-black so it reads on accent and white alike
  white: "#FFFFFF",
  muted: "#6B7A88",
  pill: "#F7F9DC", // --wash
  barBg: "#E7EDF2",
  // The darker olive the live app falls back to for small accent-on-white text
  // (its --acc-deep token) — bare accent reads fine as a big hero fill or a
  // large kicker, but loses contrast at caption sizes.
  accentDeep: "#5A6109",
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

export interface Wrapped {
  lines: string[];
  overflow: boolean;
}

/** Greedy wrap to a pixel budget. Long single words are hard-broken. Exported:
 *  renderProfileCard.ts reuses this for badge-medallion labels rather than
 *  hand-rolling a second wrap implementation. */
export function wrapToWidth(text: string, maxW: number, fs: number, maxLines: number): Wrapped {
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

/**
 * A zero-width non-joiner after every f that could start a ligature.
 *
 * The bundled Fredoka subsets carry the GSUB ligature table but not the
 * ligature glyphs, so resvg substitutes fi/fl/ff into a glyph that is not
 * there and the second letter simply disappears. Cards were shipping "fnal
 * fxes flght proft" and had been for as long as the renderer has existed. It
 * hides well: the words stay readable-ish at a glance, and it only bites the
 * subset of questions containing an f before an i or an l, which is most of
 * them ("first", "final", "confirm", "profit", "inflation", "flip").
 *
 * Every SVG-level fix was tried and resvg ignores all of them:
 * font-variant-ligatures as an attribute and as a style, font-feature-settings
 * both ways, and a nonzero letter-spacing. U+200C is what the shaper actually
 * honours, and it is the standard character for exactly this. It is invisible,
 * has zero advance width (so textWidth's per-character estimate stays right),
 * and browsers rendering /card/*.svg treat it the same way.
 */
function noLigatures(s: string): string {
  return s.replace(/f(?=[fil])/g, "f\u200C");
}

/** Escape for SVG text, and suppress the ligatures the bundled fonts cannot draw. */
export function esc(s: string): string {
  return noLigatures(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
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

// --- Brand lockup -----------------------------------------------------------
//
// Mark + wordmark + the X handle, shared by all three cards (market, position,
// profile) so they can never drift apart. The handle is ON the image because
// the image outlives its link: the moment a card is screenshotted and reposted
// — the best thing that can happen to it — every URL around it is gone, and
// the pixels are the only address it still carries.

const HANDLE_FS = 26;
const HANDLE_GAP = 16;
const WORDMARK_END = 140 + textWidth("oddie", 46);
/** Right edge of the whole lockup — the collision budget for anything that
 *  sits on the top line (the volume pill). */
export const LOCKUP_RIGHT = WORDMARK_END + HANDLE_GAP + textWidth(X_HANDLE, HANDLE_FS);

export function brandLockup(): string {
  return `${logoMark(52, 62, 68)}
  <text x="140" y="112" font-size="46" font-weight="600" fill="${C.ink}">oddie</text>
  <text x="${Math.round(WORDMARK_END + HANDLE_GAP)}" y="112" font-family="${META}" font-size="${HANDLE_FS}" font-weight="700" fill="${C.muted}">${X_HANDLE}</text>`;
}

/** Volume pill, dropped down to just the money if the full string would reach
 *  the lockup. Community markets have no venue volume — their pill speaks
 *  "% yes" language: the countdown (and "community" if it fits).
 *
 *  Exported: the personal call card (renderPositionCard.ts) shares this EXACT
 *  logic rather than reimplementing it, so a community-market position never
 *  again drifts into showing "$0 in play" — a dollar figure that was never
 *  real for a market with no venue volume. Narrowed to the three fields this
 *  actually reads (not the full Market) so a caller with a partial shape —
 *  ShareCall, not a live venue Market — can pass it directly. Geometry (PAD_R,
 *  the wordmark position) is identical between the two cards, so the returned
 *  x/w need no adjustment at the call site. */
export function volumePill(m: { venue: Market["venue"]; closesAt: string | null; volumeUsd: number }): { text: string; w: number; x: number } {
  const candidates = m.venue === "community"
    ? [`community${timeLeft(m.closesAt)}`, timeLeft(m.closesAt).replace(/^ · /, "") || "community"]
    : [money(m.volumeUsd) + " in play" + timeLeft(m.closesAt), money(m.volumeUsd) + " in play"];
  for (const text of candidates) {
    const w = Math.round(textWidth(text, 21) + 44);
    const x = PAD_R - w;
    if (x >= LOCKUP_RIGHT + 24) return { text, w, x };
  }
  const text = m.venue === "community" ? "community" : money(m.volumeUsd);
  const w = Math.round(textWidth(text, 21) + 44);
  return { text, w, x: PAD_R - w };
}

// --- Voice: the dare ---------------------------------------------------------
//
// "the dare" was already this corner's name in the comment above where it's
// drawn (see the invitation/offer/badge block below). The intent was always
// there, the words weren't: "call it" and "too close to call" were two fixed
// literals baked into every single card, forever, the exact shape src/matching/
// tweetReply.ts's QUOTE_LEAD/CTA were in before they became pools. Same fix,
// same rule: needle the market's uncertainty, never a person, never a side.
// Pre-resolution we do not yet know who's right, and a card mocking a claim
// that turns out true reads worse than a flat one.
//
// pick() is deliberately a small local copy of tweetReply.ts's, not an import
// from it: renderCard.ts has no dependency on src/matching/ today and one
// five-line hash function isn't reason enough to start one. Same contract
// either way (deterministic, no Math.random()), because this card is
// re-rendered from scratch on every request (see the /card/:slug.svg route)
// and has to draw identically each time or a re-share of the same market
// would look like a different market.
export function pick<T>(pool: readonly T[], seed: string): T {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return pool[h % pool.length];
}

// Right-anchored against a fixed arrow position (see arrowX below), so length
// has real headroom to its left before it could ever crowd the hero number,
// but these stay in "call it"'s weight class on purpose: three words, card-
// button register, not a sentence.
export const INVITE_POOL = ["call it", "prove it", "your move", "pick a side", "make it real"] as const;

// The badge only ever appears on a genuinely split market (40-60%), which is
// the one moment the card can be honestly uncertain rather than performing it.
// Self-sizing pill (badgeW is computed from the chosen text), so length is
// freer here than the invite line.
export const BADGE_POOL = [
  "too close to call", "dead even. pick a side", "nobody's sure. are you?",
  "50/50 isn't an opinion", "coin flip. break the tie",
] as const;

// --- The card ---------------------------------------------------------------

/**
 * The share card. `unpriced` is the honest state of a market nobody has staked
 * in yet.
 *
 * Without it the card drew the seeded 50 as a hero number with "yes pays 2x"
 * beside it, which reads as a price. It is not one: an empty vault has no
 * price at all, and a card posted to X the second a market opens was
 * announcing even odds that nobody set, on the one surface where we cannot
 * take it back. Unpriced markets now say so and invite the first stake, which
 * is also the better ask.
 */
export function renderCard(m: Market, opts: { unpriced?: boolean } = {}): string {
  const unpriced = opts.unpriced === true;
  const yes = Math.max(0, Math.min(100, Math.round(m.yesPct)));
  const no = 100 - yes;

  const q = layoutQuestion(displayTitle(m.question));
  const firstBaseline = Q_TOP + CAP * q.fs;
  const questionTspans = q.lines
    .map((l, i) => `<tspan x="${PAD_L}" y="${Math.round(firstBaseline + i * q.lineH)}">${esc(l)}</tspan>`)
    .join("");

  const pill = volumePill(m);

  // Hero number. It only shrinks if three digits would crowd the bar; at the
  // sizes we ship (1%..100%) it never does, so the brand size is stable.
  const heroText = unpriced ? "open" : `${yes}%`;
  let heroFS = HERO_FS_MAX;
  while (heroFS > 96 && PAD_L + textWidth(heroText, heroFS) > HERO_RIGHT_LIMIT) heroFS -= 6;

  // The kicker sits ABOVE the number, not on its baseline: at 150px the number's
  // left sidebearing is nowhere near a 34px word, and the two used to touch.
  const heroCapTop = HERO_BASE - CAP * heroFS;
  const kickerBaseline = Math.round(heroCapTop - 14);

  // The right zone is the CLICK TRIGGER, not a second infographic. The old
  // mini-bar duplicated the giant number and did no work; in its place:
  //   - the OFFER: what being right on the underdog side pays ("no pays 4.5x")
  //   - the INVITATION: one of INVITE_POOL + a drawn arrow (drawn, not typed:
  //     the bundled fonts have no U+2192 and resvg renders missing glyphs as
  //     tofu)
  //   - a tension badge, from BADGE_POOL, when the market is genuinely split
  //     (40-60%)
  const udSide = yes <= 50 ? "yes" : "no";
  const udPct = udSide === "yes" ? yes : no;
  const mRaw = 100 / Math.max(1, udPct);
  const mult = mRaw >= 10 ? Math.round(mRaw) : Math.round(mRaw * 10) / 10;
  // An unpriced market has no underdog and therefore no multiple to quote.
  // What it has is a vacancy, so the offer becomes the ask.
  const offerText = unpriced ? "first in sets the line" : `${udSide} pays ${mult}\u00d7`;
  const OFFER_FS = unpriced ? 30 : 40;
  const balanced = !unpriced && yes >= 40 && yes <= 60;
  // One seed per market (venue + the venue's own id), NOT the question text:
  // the question can be re-normalised by displayTitle or re-extracted with
  // slightly different wording without this becoming a different market, and
  // the card's voice shouldn't flicker when that happens.
  const voiceSeed = `${m.venue}:${m.venueId}`;
  const badgeText = pick(BADGE_POOL, voiceSeed);
  const badgeW = Math.round(textWidth(badgeText, 20) + 40);
  const inviteText = pick(INVITE_POOL, `${voiceSeed}:invite`);
  const inviteW = Math.round(textWidth(inviteText, 23));
  const arrowX = PAD_R - 30; // drawn arrow sits right of the invite text

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT}">
  <rect width="${W}" height="${H}" fill="${C.white}"/>

  <!-- the speech-bubble card: chunky rounded black outline, like the logo -->
  <rect x="26" y="26" width="948" height="472" rx="46" fill="${C.white}" stroke="${C.ink}" stroke-width="13"/>

  <!-- oddie mark + wordmark + handle, as a lockup -->
  ${brandLockup()}

  <!-- volume pill (no venue named) -->
  <rect x="${pill.x}" y="72" width="${pill.w}" height="48" rx="24" fill="${C.pill}"/>
  <text x="${pill.x + pill.w / 2}" y="103" font-family="${META}" font-size="21" font-weight="700"
        fill="${C.muted}" text-anchor="middle">${esc(pill.text)}</text>

  <!-- the take -->
  <text font-size="${q.fs}" font-weight="600" fill="${C.ink}">${questionTspans}</text>

  <!-- hero number: near-black with a thin white outline, matching the feed. On the
       card's white ground the outline is invisible, so it reads as a solid black
       number; the same treatment over the feed's blue fill shows the white halo. -->
  <text x="${PAD_L}" y="${kickerBaseline}" font-size="${KICKER_FS}" font-weight="600" fill="${C.accent}">${unpriced ? "no price yet" : "yes"}</text>
  <text x="${PAD_L}" y="${HERO_BASE}" font-size="${heroFS}" font-weight="700" fill="${C.number}"
        stroke="${C.white}" stroke-width="9" paint-order="stroke" stroke-linejoin="round">${heroText}</text>

  <!-- the dare: badge (when split), the offer, and the invitation -->
  ${balanced ? `<rect x="${PAD_R - badgeW}" y="346" width="${badgeW}" height="40" rx="20" fill="${C.white}" stroke="${C.ink}" stroke-width="3"/>
  <text x="${PAD_R - badgeW / 2}" y="372" font-family="${META}" font-size="20" font-weight="800"
        fill="${C.ink}" text-anchor="middle">${esc(badgeText)}</text>` : ""}
  <text x="${PAD_R}" y="${OFFER_BASE}" font-size="${OFFER_FS}" font-weight="600" fill="${C.accent}"
        stroke="${C.ink}" stroke-width="2.5" paint-order="stroke" stroke-linejoin="round"
        text-anchor="end">${esc(offerText)}</text>
  <text x="${arrowX - 12}" y="${HERO_BASE}" font-family="${META}" font-size="23" font-weight="800"
        fill="${C.ink}" text-anchor="end">${esc(inviteText)}</text>
  <path d="M ${arrowX - 2} ${HERO_BASE - 8} h 24 m -9 -9 l 9 9 l -9 9" stroke="${C.ink}" stroke-width="4"
        fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}
