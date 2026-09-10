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
// sit on one screen. Every value below matches a token in the :root that all
// app shells share (public/app/market.html), and scripts/test-card-layout.ts
// holds them in step.
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
  // The hard offset under the wordmark. Same pink as the app's NO side and the
  // landing headline's echo, which is where the treatment comes from.
  echo: "#FF2D78",
  /** The app's near-black. The card ground, and the ink on every lime slab. */
  ground: "#0C0D0B",
  // The landing and genesis pages drop every card on this darker pink at a hard
  // offset (--pink-deep, .step and .tw both use it). Bright echo stays for small
  // chips; a full card frame needs the deeper one or the offset glares.
  pinkDeep: "#A3053F",
};

export const FONT = "'Fredoka', 'Trebuchet MS', sans-serif";
// The landing's --display face. Loud/identity type wears this; the wordmark
// on every card uses it so the logo is one shape everywhere, like the site.
export const DISPLAY = "'Anton', 'Arial Narrow', 'Helvetica Neue', sans-serif";
export const META = "'Nunito', system-ui, sans-serif";

// --- Geometry ---------------------------------------------------------------

const W = 1000;
const H = 524;

const PAD_L = 70;
const PAD_R = 932;
const CONTENT_W = PAD_R - PAD_L;

/** The question lives strictly between these two y values, caps to descenders.
 *  It sits lower than it used to because the voice line now speaks above it. */
const Q_TOP = 212;
const Q_BOTTOM = 366;
/** The question is indented past the lime quote rule at x68. */
const QUOTE_X = 96;

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

// Real advance widths (em) measured from the shipped TTFs, so pill widths and
// wrap points are right for each face. ASCII 32-126; anything else falls back.
const EM_DISPLAY: Record<string, number> = {" ":0.2344,"!":0.229,"\"":0.4287,"#":0.5464,"$":0.4619,"%":1.0566,"&":0.52,"'":0.2139,"(":0.291,")":0.291,"*":0.4521,"+":0.3555,",":0.2363,"-":0.311,".":0.2285,"/":0.4053,"0":0.4941,"1":0.3306,"2":0.4941,"3":0.4941,"4":0.4941,"5":0.4941,"6":0.4941,"7":0.4941,"8":0.4941,"9":0.4941,":":0.2417,";":0.2451,"<":0.3213,"=":0.311,">":0.3213,"?":0.4922,"@":0.8643,"A":0.4854,"B":0.4785,"C":0.4741,"D":0.4932,"E":0.4116,"F":0.3989,"G":0.4849,"H":0.499,"I":0.2266,"J":0.4663,"K":0.4722,"L":0.3975,"M":0.7461,"N":0.498,"O":0.4863,"P":0.4722,"Q":0.4937,"R":0.4766,"S":0.4614,"T":0.3955,"U":0.4736,"V":0.4692,"W":0.7119,"X":0.4839,"Y":0.4463,"Z":0.4102,"[":0.3179,"\\":0.4053,"]":0.3179,"^":0.4736,"_":0.3652,"`":0.3174,"a":0.4834,"b":0.5015,"c":0.4912,"d":0.498,"e":0.4883,"f":0.2803,"g":0.5039,"h":0.5054,"i":0.2432,"j":0.2627,"k":0.4907,"l":0.248,"m":0.7583,"n":0.4985,"o":0.4966,"p":0.5015,"q":0.498,"r":0.3467,"s":0.4746,"t":0.3052,"u":0.499,"v":0.4609,"w":0.6963,"x":0.459,"y":0.4609,"z":0.3857,"{":0.3398,"|":0.2163,"}":0.3403,"~":0.4927};
const EM_META: Record<string, number> = {" ":0.271,"!":0.248,"\"":0.448,"#":0.6,"$":0.6,"%":0.945,"&":0.726,"'":0.243,"(":0.358,")":0.358,"*":0.453,"+":0.6,",":0.248,"-":0.434,".":0.248,"/":0.313,"0":0.6,"1":0.6,"2":0.6,"3":0.6,"4":0.6,"5":0.6,"6":0.6,"7":0.6,"8":0.6,"9":0.6,":":0.248,";":0.248,"<":0.6,"=":0.6,">":0.6,"?":0.459,"@":0.95,"A":0.744,"B":0.688,"C":0.68,"D":0.762,"E":0.597,"F":0.562,"G":0.736,"H":0.773,"I":0.282,"J":0.354,"K":0.665,"L":0.562,"M":0.868,"N":0.748,"O":0.785,"P":0.652,"Q":0.785,"R":0.686,"S":0.631,"T":0.621,"U":0.738,"V":0.713,"W":1.113,"X":0.672,"Y":0.618,"Z":0.605,"[":0.354,"\\":0.313,"]":0.354,"^":0.6,"_":0.5,"`":0.377,"a":0.547,"b":0.6,"c":0.472,"d":0.6,"e":0.542,"f":0.364,"g":0.604,"h":0.585,"i":0.255,"j":0.259,"k":0.536,"l":0.319,"m":0.877,"n":0.585,"o":0.576,"p":0.6,"q":0.6,"r":0.392,"s":0.488,"t":0.384,"u":0.579,"v":0.527,"w":0.853,"x":0.546,"y":0.526,"z":0.474,"{":0.391,"|":0.288,"}":0.391,"~":0.6};

/** Which measured face to use. Omit for the legacy rough approximation, which the
 *  market and position cards are tuned against; pass a face for the accurate
 *  per-glyph tables (the Genesis card and the wordmark use these). */
export type Face = "display" | "meta";
const EM: Record<Face, Record<string, number>> = { display: EM_DISPLAY, meta: EM_META };


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
export function textWidth(s: string, fs: number, face?: Face): number {
  let em = 0;
  if (face) {
    const t = EM[face];
    // 0.5 em is a safe fallback for the rare glyph outside ASCII 32-126.
    for (const ch of s) em += t[ch] ?? 0.5;
  } else {
    for (const ch of s) em += charEm(ch);
  }
  return em * fs;
}

export interface Wrapped {
  lines: string[];
  overflow: boolean;
}

/** Greedy wrap to a pixel budget. Long single words are hard-broken. Exported:
 *  renderProfileCard.ts reuses this for badge-medallion labels rather than
 *  hand-rolling a second wrap implementation. */
export function wrapToWidth(text: string, maxW: number, fs: number, maxLines: number, face?: Face): Wrapped {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";

  for (let i = 0; i < words.length; i++) {
    let w = words[i];

    // A word wider than the whole line can never fit; split it.
    while (textWidth(w, fs, face) > maxW) {
      let cut = w.length - 1;
      while (cut > 1 && textWidth(w.slice(0, cut), fs, face) > maxW) cut--;
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
    if (textWidth(candidate, fs, face) <= maxW) {
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
/**
 * The claim, measured down until it fits its band.
 *
 * The ladder gained two low rungs that also ALLOW A FOURTH LINE. Three lines at
 * 38px was the floor, so a genuinely long question ellipsized, and a market's
 * question is the one thing on this card a stranger can have an opinion about.
 * Cutting it to fit the layout is cutting the only reason to tap.
 */
export function layoutQuestion(question: string): { fs: number; lineH: number; lines: string[] } {
  const budget = (PAD_R - QUOTE_X) - 12; // a little slack for font-metric drift

  for (const [fs, maxLines, lh] of [
    [54, 3, 1.22], [48, 3, 1.22], [42, 3, 1.20], [38, 3, 1.20], [34, 4, 1.18], [30, 4, 1.18],
  ] as const) {
    const lineH = Math.round(fs * lh);
    const { lines, overflow } = wrapToWidth(question, budget, fs, maxLines);
    if (overflow) continue;
    const height = CAP * fs + (lines.length - 1) * lineH + DESC * fs;
    if (Q_TOP + height <= Q_BOTTOM) return { fs, lineH, lines };
  }

  const fs = 30;
  const lineH = Math.round(fs * 1.18);
  const { lines } = wrapToWidth(question, budget, fs, 4);
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
const WORDMARK_END = 140 + textWidth("oddie", 46, "display");
/** Right edge of the whole lockup — the collision budget for anything that
 *  sits on the top line (the volume pill). */
export const LOCKUP_RIGHT = WORDMARK_END + HANDLE_GAP + textWidth(X_HANDLE, HANDLE_FS, "meta");

export function brandLockup(onDark = false): string {
  // The wordmark carries the same hard pink offset the landing headline and both
  // app headers wear: a displaced copy underneath, not a blur. Drawn first so it
  // sits behind. 2px at 46px matches the 2px the web wordmarks use at ~21px only
  // in spirit; measured against the card's 2x raster, 3px is what reads.
  return `${logoMark(52, 62, 68)}
  <text x="143" y="115" font-family="${DISPLAY}" font-size="46" fill="${C.echo}">oddie</text>
  <text x="140" y="112" font-family="${DISPLAY}" font-size="46" fill="${onDark ? C.white : C.ink}">oddie</text>
  <text x="${Math.round(WORDMARK_END + HANDLE_GAP)}" y="112" font-family="${META}" font-size="${HANDLE_FS}" font-weight="700"
        fill="${onDark ? C.white : C.muted}"${onDark ? ` fill-opacity="0.62"` : ""}>${X_HANDLE}</text>`;
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
/**
 * ODDIE TALKING BACK.
 *
 * The card is a REPLY, sitting directly under somebody's confident claim, so it
 * opens with a line of oddie's own voice before it quotes them. That is the
 * whole design: lime is oddie (his frame, his voice, his money), white is the
 * human (the claim, quoted).
 *
 * THE RULE THAT MAKES A LINE SAFE: it must be true beside ANY claim, because
 * nothing here reads the question. So no line may agree, disagree, judge the
 * topic, or imply an outcome. Each one is about the ACT of saying something
 * publicly, never about what was said. Same discipline INVITE_POOL already
 * follows, and the same reason: one bad pairing on X is public forever.
 */
export const VOICE_ANY = [
  "confidence is free. this isn't.",
  "someone here is wrong.",
  "big words. open market.",
  "put a number on it.",
  "we can settle this.",
  "easy to say. harder to back.",
] as const;

/**
 * The settled state. oddie is answering its OWN earlier reply, in the thread
 * where the argument happened, so this is the only pool that gets to gloat.
 *
 * Same safety rule as the others and it matters more here: nothing reads the
 * question, and the card sits under a real person's tweet. No line may say who
 * was right, name anybody, or imply the claimer lost. The market settled; that
 * is a fact about the market. Whether a PERSON won is a private matter and it
 * belongs in the app, not under their tweet.
 */
export const VOICE_SETTLED = [
  "that's the answer.",
  "settled. the pool has spoken.",
  "and there it is.",
  "market's closed. money moved.",
  "the line held. or it didn't.",
] as const;

/** Only when nobody has staked yet, so these may point at the vacancy. */
export const VOICE_UNPRICED = [
  "nobody has paid for that yet.",
  "empty pool. first word counts.",
  "still free to be first.",
  "the line is yours to set.",
] as const;

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
/**
 * How many confirmed wallets a market needs before the SHARE CARD names them.
 *
 * Higher than the in-app list's three (public/app/markets.html, market.html) and
 * deliberately so: the same figure is doing two different jobs. Beside a pool,
 * to somebody already inside, the count is a COMPOSITION fact - 0.2 SOL across
 * three wallets is a different object from 0.2 SOL from one - and three is
 * enough to be that. Beside a payout multiple, on a timeline, to somebody who
 * has never heard of oddie, it is a CREDIBILITY claim about the product itself,
 * and a credibility claim needs a bigger number than a composition fact.
 *
 * Five rather than three because three is quote-tweetable as dead and five is
 * not obviously so, and the tail this gate buys insurance against is being
 * screenshotted as empty. Not ten, because a gate that cannot fire for months
 * teaches nothing and rots, and this repo has shipped dead fields before.
 *
 * Five is reasoned, not measured. Move it on evidence: the first single-digit
 * count that gets dunked on raises it, and a median peak below five across
 * closed markets means the branch is decoration and the slot should carry the
 * pool instead, which the image is genuinely missing on X.
 */
export const MIN_HEADS_CARD = 5;

export function renderCard(
  m: Market,
  opts: { unpriced?: boolean; settled?: "yes" | "no"; stakers?: number } = {},
): string {
  const settled = opts.settled;
  // A settled market has an answer, so it is never unpriced and never invites a
  // stake. The two states cannot both be true and settled wins.
  const unpriced = !settled && opts.unpriced === true;
  const yes = Math.max(0, Math.min(100, Math.round(m.yesPct)));
  const no = 100 - yes;

  const q = layoutQuestion(displayTitle(m.question));

  const pillRaw = volumePill(m);
  // A settled market has no time left to report. volumePill counts down from
  // close_time and would say "closing" forever on a market that is already
  // decided, which is the one word a result card must not carry.
  const pill = settled
    ? { text: "community · settled", w: Math.round(textWidth("community · settled", 20) + 40), x: 0 }
    : pillRaw;
  if (settled) pill.x = PAD_R - pill.w;

  // ODDIE SPEAKS FIRST. One line, always exactly one, stepped down rather than
  // wrapped: a two-line voice line stops being an interjection and starts being
  // a paragraph, and the pool is short enough that 44 nearly always wins.
  const voiceSeed = `${m.venue}:${m.venueId}`;
  const voicePool = settled ? VOICE_SETTLED : unpriced ? [...VOICE_ANY, ...VOICE_UNPRICED] : VOICE_ANY;
  const voiceText = pick(voicePool, `${voiceSeed}:voice`);
  let voiceFS = 44;
  while (voiceFS > 32 && textWidth(voiceText, voiceFS) > CONTENT_W - 4) voiceFS -= 6;

  // The quote rule's height is MEASURED off the question block. A fixed height
  // hangs below a short question and reads as broken rather than as airy.
  const firstBaseline = Q_TOP + CAP * q.fs;
  const qHeight = CAP * q.fs + (q.lines.length - 1) * q.lineH + DESC * q.fs;

  const heroText = settled ? settled.toUpperCase() : unpriced ? "open" : `${yes}%`;
  const udSide = yes <= 50 ? "yes" : "no";
  const udPct = udSide === "yes" ? yes : no;
  const mRaw = 100 / Math.max(1, udPct);
  const mult = mRaw >= 10 ? Math.round(mRaw) : Math.round(mRaw * 10) / 10;
  /* HOW MANY PEOPLE MADE THAT NUMBER.
     The card's hero is a percentage and it travels on X with nothing beside it,
     so a split one wallet paid a few cents to draw looks exactly like a split
     forty people argued into place. Measured: two wallets can put any figure on
     this card for about 0.011 SOL, and that is true today, with no change to
     the program. A percentage presented as consensus, on the one surface that
     leaves the product, is the number worth qualifying.
     Counted from chain_entry, which is distinct CONFIRMED wallets, so it can
     read zero next to a funded pool and is omitted rather than drawn as 0. The
     market page has said this for a while ("N in"); the card is where it
     actually matters.

     AND IT IS GATED HIGHER THAN ZERO, which is the correction to the paragraph
     above. Omitting only at zero assumed the count's problem was being absent.
     Its problem is being SMALL. Absence leaves a stranger in "unknown", which
     is a workable state and leaves the claim and the multiple to do the work;
     a low digit moves them to "empty", which is terminal and cannot be argued
     with inside a scroll. That asymmetry makes the count upside-only: free to
     withhold, expensive to print badly, so it is gated rather than defaulted.

     Two below the line is out on this file's own measurement: if two wallets
     can forge any percentage here for 0.011 SOL, then "2 in" beside a
     percentage is printing the price of faking it. Nothing replaces the count
     below the line. The meta line simply ends at the odds, exactly as it
     already does at zero, so there is no slot to notice as empty and no new
     copy on the one surface that leaves the product. */
  const heads = Math.max(0, Math.floor(opts.stakers ?? 0));
  const odds = `${udSide} pays ${mult}\u00d7`;
  const metaText = settled
    ? "settled on chain"
    : unpriced
      ? "first in sets the line"
      : heads >= MIN_HEADS_CARD
        ? `${odds} \u00b7 ${heads} in`
        : odds;

  // A settled market has nothing to invite. The CTA becomes the receipt.
  const inviteText = settled ? "see it" : pick(INVITE_POOL, `${voiceSeed}:invite`);
  // The pill sizes itself around the text plus the DRAWN arrow: the bundled
  // subsets have no U+2192 and resvg renders a missing glyph as tofu.
  const ctaW = Math.round(28 + textWidth(inviteText, 26) + 16 + 26 + 28);
  const ctaX = 942 - 36 - ctaW;

  // Under six hours the chip stops being information and becomes pressure, so
  // it fills solid pink instead of sitting in a lime outline.
  const closing = !settled && /\b[0-5]h\b/.test(pill.text);

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT}">
  <!-- The lime IS the border. A near-black card with no frame floats on a dark
       timeline and a white one melts into a light timeline; this reads on both. -->
  <rect width="${W}" height="${H}" fill="${C.accent}"/>
  <rect x="18" y="18" width="964" height="488" rx="44" fill="${C.ground}"/>

  ${brandLockup(true)}

  <!-- state chip -->
  ${closing
    ? `<rect x="${pill.x}" y="68" width="${pill.w}" height="44" rx="22" fill="${C.echo}"/>
  <text x="${pill.x + pill.w / 2}" y="97" font-family="${META}" font-size="20" font-weight="700"
        fill="${C.ground}" text-anchor="middle">${esc(pill.text)}</text>`
    : `<rect x="${pill.x}" y="68" width="${pill.w}" height="44" rx="22" fill="none" stroke="${C.accent}" stroke-width="2"/>
  <text x="${pill.x + pill.w / 2}" y="97" font-family="${META}" font-size="20" font-weight="700"
        fill="${C.accent}" text-anchor="middle">${esc(pill.text)}</text>`}

  <!-- oddie's line, in his colour, wearing the same pink offset as the headline -->
  <text x="71" y="179" font-size="${voiceFS}" font-weight="700" fill="${C.echo}">${esc(voiceText)}</text>
  <text x="68" y="176" font-size="${voiceFS}" font-weight="700" fill="${C.accent}">${esc(voiceText)}</text>

  <!-- the human's claim, quoted: white behind a lime rule -->
  <rect x="68" y="${Math.round(Q_TOP - 8)}" width="6" height="${Math.round(qHeight + 16)}" rx="3" fill="${C.accent}"/>
  <text font-size="${q.fs}" font-weight="600" fill="${C.white}">${q.lines
    .map((l, k) => `<tspan x="${QUOTE_X}" y="${Math.round(firstBaseline + k * q.lineH)}">${esc(l)}</tspan>`)
    .join("")}</text>

  <!-- the money. The biggest colour area on the card is the button, which is
       the punchline: there is now real SOL on what you just said. -->
  <rect x="58" y="380" width="884" height="104" rx="32" fill="${C.accent}"/>
  <text x="94" y="456" font-size="66" font-weight="700" fill="${C.ground}">${esc(heroText)}</text>
  <text x="${ctaX - 32}" y="441" font-size="26" font-weight="600" fill="${C.ground}"
        fill-opacity="0.68" text-anchor="end">${esc(metaText)}</text>

  <rect x="${ctaX}" y="402" width="${ctaW}" height="60" rx="30" fill="${C.ground}"/>
  <text x="${ctaX + 28}" y="441" font-size="26" font-weight="600" fill="${C.accent}">${esc(inviteText)}</text>
  <path d="M ${ctaX + ctaW - 28 - 26} 432 h 22 m -8 -8 l 8 8 l -8 8" stroke="${C.accent}" stroke-width="4"
        fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}


/** What oddie says over a receipt. Same rules as every other voice pool: short,
 *  smug, and true beside ANY winning call. */
export const VOICE_RECEIPT = [
  "called it.",
  "saw it first.",
  "the crowd caught up.",
  "early is the flex.",
  "receipts, not vibes.",
] as const;

/**
 * The receipt: one wallet's winning call, as a card built to be POSTED.
 *
 * This card exists because of two facts that meet in the middle. X demotes
 * replies, and the bot can only ever reply, so the bot's own cards fight the
 * ranker with one hand tied. And pari-mutuel pays the pile-on the same
 * pro-rata as the early call, so the money never rewards having been right
 * before it was easy. The receipt fixes both at once: it is the early call
 * made into a thing worth showing off, and it is posted by the WINNER as an
 * original post, which is the one format the ranker actually likes. The bot is
 * stuck in the replies; the people who won are not.
 *
 * Winners only, and no amounts anywhere. An amount would let size dress up as
 * conviction, and the whole point of the entry number is that it cannot be
 * bought after the fact.
 */
export function renderReceiptCard(question: string, opts: { side: "yes" | "no"; entryPct: number }): string {
  const side = opts.side.toUpperCase();
  const entry = Math.max(0, Math.min(100, Math.round(opts.entryPct)));

  const q = layoutQuestion(displayTitle(question));
  const firstBaseline = Q_TOP + CAP * q.fs;
  const qHeight = CAP * q.fs + (q.lines.length - 1) * q.lineH + DESC * q.fs;

  const voiceText = pick(VOICE_RECEIPT, `${question}:receipt`);
  let voiceFS = 44;
  while (voiceFS > 32 && textWidth(voiceText, voiceFS) > CONTENT_W - 4) voiceFS -= 6;

  // The flex line. "called YES at 30%" is the entire product of the entry
  // stamp: the lower the number, the louder the card.
  const hero = `called ${side} at ${entry}%`;
  let heroFS = 84;
  while (heroFS > 48 && textWidth(hero, heroFS) > CONTENT_W - 4) heroFS -= 6;

  const chipText = "receipt \u00b7 settled on chain";
  const chipW = Math.round(textWidth(chipText, 20) + 40);
  const chipX = PAD_R - chipW;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT}">
  <rect width="${W}" height="${H}" fill="${C.accent}"/>
  <rect x="18" y="18" width="964" height="488" rx="44" fill="${C.ground}"/>

  ${brandLockup(true)}

  <rect x="${chipX}" y="68" width="${chipW}" height="44" rx="22" fill="none" stroke="${C.accent}" stroke-width="2"/>
  <text x="${chipX + chipW / 2}" y="97" font-family="${META}" font-size="20" font-weight="700"
        fill="${C.accent}" text-anchor="middle">${chipText}</text>

  <text x="71" y="179" font-size="${voiceFS}" font-weight="700" fill="${C.echo}">${esc(voiceText)}</text>
  <text x="68" y="176" font-size="${voiceFS}" font-weight="700" fill="${C.accent}">${esc(voiceText)}</text>

  <rect x="68" y="${Math.round(Q_TOP - 8)}" width="6" height="${Math.round(qHeight + 16)}" rx="3" fill="${C.accent}"/>
  <text font-size="${q.fs}" font-weight="600" fill="${C.white}">${q.lines
    .map((l, k) => `<tspan x="${QUOTE_X}" y="${Math.round(firstBaseline + k * q.lineH)}">${esc(l)}</tspan>`)
    .join("")}</text>

  <!-- the flex, wearing the same pink offset as everything the brand shouts -->
  <text x="71" y="465" font-size="${heroFS}" font-weight="700" fill="${C.echo}">${esc(hero)}</text>
  <text x="68" y="462" font-size="${heroFS}" font-weight="700" fill="${C.accent}">${esc(hero)}</text>
</svg>`;
}
