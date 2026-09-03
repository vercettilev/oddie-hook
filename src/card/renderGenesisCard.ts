import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { C, DISPLAY, META, brandLockup, esc, textWidth, wrapToWidth } from "./renderCard.js";
import { Archetype, ARCHETYPE_LABEL } from "../genesis/archetype.js";

// The Genesis profile card: the mirror a freshly connected account gets back.
// Same brand shell as every other share card (white ground, ink-stroked frame,
// the lockup with its pink echo), because on an X timeline these cards are one
// family whatever page minted them.
//
// Composition is the approved three-beat: WHO (handle + archetype costume),
// the TYPE'S OWN HEADLINE with the person's real numbers already inside it
// (the classifier wrote it; this file never invents copy), and THE DARE. The
// right column carries the costume sticker and, when the profile pinned a
// claim, that claim printed on a ticket stub stamped NEVER SCORED — their own
// words inside our object is the screenshot this card exists for.

const W = 1000;
const H = 560;
const PAD_L = 70;

const here = path.dirname(fileURLToPath(import.meta.url));
const ART_DIR = path.join(here, "../../assets/arch");

// Stickers embed as base64 PNG (resvg reads png/jpeg, not webp). Cached per
// type for the process lifetime; ~250KB each, nine of them, fine.
const artCache = new Map<Archetype, string>();
function artHref(t: Archetype): string {
  const hit = artCache.get(t);
  if (hit) return hit;
  const b = readFileSync(path.join(ART_DIR, `arch-${t}.png`));
  const uri = `data:image/png;base64,${b.toString("base64")}`;
  artCache.set(t, uri);
  return uri;
}

export interface GenesisCard {
  handle: string;           // "@lev"
  archetype: Archetype;
  headline: string;         // from the classifier, real numbers inside
  reason: string;           // the one-line justification
  /** The pinned claim to print on the stub; null renders the invitation. */
  claim: string | null;
}

export type GenesisTheme = "light" | "midnight" | "acid";

// The three surfaces the landing actually uses. The card wears one so it reads
// as a page pulled out of the site, not a plain white box. Midnight and acid are
// the loud ones; light is the tame fallback.
interface Palette {
  bg: string; frameStroke: string; frameW: number; offset: string;
  onDark: boolean; kicker: string; handle: string;
  pillBg: string; pillText: string; pillOffset: string;
  head: string; footer: string; spark: string;
}
const PALETTES: Record<GenesisTheme, Palette> = {
  light: {
    bg: C.white, frameStroke: C.ink, frameW: 13, offset: C.pinkDeep, onDark: false,
    kicker: C.accentDeep, handle: C.ink, pillBg: C.ink, pillText: C.accent,
    pillOffset: C.echo, head: C.ink, footer: C.muted, spark: C.echo,
  },
  midnight: {
    bg: C.ground, frameStroke: C.accent, frameW: 7, offset: C.echo, onDark: true,
    kicker: C.accent, handle: "#FFFFFF", pillBg: C.accent, pillText: C.ground,
    pillOffset: C.echo, head: "#FFFFFF", footer: "#9AA3AE", spark: C.accent,
  },
  acid: {
    bg: C.accent, frameStroke: C.ink, frameW: 13, offset: C.ink, onDark: false,
    kicker: C.ink, handle: C.ink, pillBg: C.ink, pillText: C.accent,
    pillOffset: C.echo, head: C.ink, footer: "#4A4F0A", spark: C.echo,
  },
};

export function renderGenesisCard(card: GenesisCard, theme: GenesisTheme = "midnight"): string {
  const label = ARCHETYPE_LABEL[card.archetype];
  const p = PALETTES[theme];

  // The card is a flex someone reposts, so it carries only what is theirs to
  // brag about: their handle, the costume they earned, and the type's one-line
  // verdict. Everything transactional (the old ticket stub, the "tag @oddiefun"
  // instruction, the redundant "account since" reason) is gone — the sticker
  // owns the right half and the words are cut to the share-worthy minimum.

  // --- left column: who, the costume, the one flex line ------------------
  const labelFs = 32;
  const labelW = Math.round(textWidth(label, labelFs, "display")) + 44;

  // The headline is the shareable payload. It gets the full left column above
  // the footer; the sticker takes the right, so it wraps to ~455px.
  let headFs = 44;
  let head = wrapToWidth(card.headline, 455, headFs, 4, "meta");
  if (head.lines.length >= 4) { headFs = 34; head = wrapToWidth(card.headline, 455, headFs, 4, "meta"); }
  // Bottom-anchored so 2- and 4-line headlines both sit on the footer.
  const headBottom = 470;
  const headLines = head.lines.map((ln, i) => {
    const y = headBottom - (head.lines.length - 1 - i) * (headFs + 8);
    return `<text x="${PAD_L}" y="${y}" font-family="${META}" font-size="${headFs}" font-weight="800" fill="${p.head}">${esc(ln)}</text>`;
  }).join("\n  ");

  // --- right half: the costume, floor to ceiling ------------------------
  // meet-fit into a tall right zone so no sticker is cropped or distorted; the
  // varied aspect ratios (0.74-1.04) all land big and centred. A slight tilt
  // keeps it in the sticker-sheet language of the landing.
  const art = `<image href="${artHref(card.archetype)}" x="560" y="70" width="410" height="420" preserveAspectRatio="xMidYMid meet" transform="rotate(-2.5 765 280)"/>`;

  // A few hand-drawn sparks behind the sticker, the landing's marginalia energy.
  const sparks = `<g stroke="${p.spark}" stroke-width="6" stroke-linecap="round" fill="none" opacity="0.9">
    <path d="M556 128 l26 -16"/><path d="M548 168 l30 4"/>
    <path d="M980 300 l-26 12"/><path d="M956 470 l20 20"/>
  </g>`;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="${DISPLAY}">
  <rect width="${W}" height="${H}" fill="${p.bg}"/>
  <rect x="42" y="42" width="948" height="508" fill="${p.offset}"/>
  <rect x="26" y="26" width="948" height="508" fill="${p.bg}" stroke="${p.frameStroke}" stroke-width="${p.frameW}"/>

  ${sparks}
  ${brandLockup(p.onDark)}

  <!-- season kicker, moved left so the sticker owns the whole right side -->
  <text x="${PAD_L}" y="176" font-family="${META}" font-size="19" font-weight="700" fill="${p.kicker}" letter-spacing="4">GENESIS</text>

  <!-- who, and the costume they earned -->
  <text x="${PAD_L}" y="228" font-size="52" fill="${p.handle}">${esc(card.handle)}</text>
  <g transform="rotate(-1.5 ${PAD_L + labelW / 2} 268)">
    <rect x="${PAD_L + 4}" y="${250 + 4}" width="${labelW}" height="50" fill="${p.pillOffset}"/>
    <rect x="${PAD_L}" y="250" width="${labelW}" height="50" fill="${p.pillBg}"/>
    <text x="${PAD_L + 22}" y="${250 + 37}" font-size="${labelFs}" fill="${p.pillText}">${esc(label)}</text>
  </g>

  <!-- the type's own one-line verdict: the whole reason it gets reposted -->
  ${headLines}

  <!-- one small footer: just the brand, nothing transactional -->
  <text x="${PAD_L}" y="510" font-family="${META}" font-size="17" font-weight="700" fill="${p.footer}" letter-spacing="1">oddie.fun/genesis</text>

  ${art}
</svg>`;
}
