import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { C, DISPLAY, META, brandLockup, esc, wrapToWidth } from "./renderCard.js";
import { Archetype } from "../genesis/archetype.js";

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
  const p = PALETTES[theme];

  // The card is a flex someone reposts, so it carries only what is theirs to
  // brag about: their handle and the type's one-line verdict. The archetype
  // name lives on the sticker itself, so the old pill badge (a second "THE OG")
  // and the GENESIS kicker (a third brand mark next to the wordmark and footer)
  // are both cut — the sticker owns the right half, the left holds four things
  // at most: wordmark, handle, the flex line, and the url.

  // The handle and the flex line are one hero unit: WHO, then their verdict.
  // Centred vertically in the space between the wordmark and the footer so the
  // block never strands the handle at the top over a gap.
  const handleFs = 60;
  let headFs = 46;
  let head = wrapToWidth(card.headline, 455, headFs, 4, "meta");
  if (head.lines.length >= 4) { headFs = 35; head = wrapToWidth(card.headline, 455, headFs, 4, "meta"); }
  const lineH = headFs + 8;
  const gap = 66;                         // handle baseline -> first headline baseline
  const region = { top: 156, bottom: 486 };
  const blockH = 46 /*handle cap*/ + gap + (head.lines.length - 1) * lineH;
  const handleY = Math.max(region.top + 46, region.top + Math.round(((region.bottom - region.top) - blockH) / 2) + 46);
  const headTop = handleY + gap;
  const headLines = head.lines.map((ln, i) =>
    `<text x="${PAD_L}" y="${headTop + i * lineH}" font-family="${META}" font-size="${headFs}" font-weight="800" fill="${p.head}">${esc(ln)}</text>`
  ).join("\n  ");

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

  <!-- who: the only identity line, given room now the pill and kicker are gone -->
  <text x="${PAD_L}" y="${handleY}" font-size="${handleFs}" fill="${p.handle}">${esc(card.handle)}</text>

  <!-- the type's own one-line verdict: the whole reason it gets reposted -->
  ${headLines}

  <!-- one small footer: just the brand, nothing transactional -->
  <text x="${PAD_L}" y="510" font-family="${META}" font-size="17" font-weight="700" fill="${p.footer}" letter-spacing="1">oddie.fun/genesis</text>

  ${art}
</svg>`;
}
