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

export function renderGenesisCard(card: GenesisCard): string {
  const label = ARCHETYPE_LABEL[card.archetype];

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
    return `<text x="${PAD_L}" y="${y}" font-family="${META}" font-size="${headFs}" font-weight="800" fill="${C.ink}">${esc(ln)}</text>`;
  }).join("\n  ");

  // --- right half: the costume, floor to ceiling ------------------------
  // meet-fit into a tall right zone so no sticker is cropped or distorted; the
  // varied aspect ratios (0.74-1.04) all land big and centred. A slight tilt
  // keeps it in the sticker-sheet language of the landing.
  const art = `<image href="${artHref(card.archetype)}" x="560" y="70" width="410" height="420" preserveAspectRatio="xMidYMid meet" transform="rotate(-2.5 765 280)"/>`;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="${DISPLAY}">
  <rect width="${W}" height="${H}" fill="${C.white}"/>
  <rect x="42" y="42" width="948" height="508" fill="${C.pinkDeep}"/>
  <rect x="26" y="26" width="948" height="508" fill="${C.white}" stroke="${C.ink}" stroke-width="13"/>

  ${brandLockup()}

  <!-- season kicker, moved left so the sticker owns the whole right side -->
  <text x="${PAD_L}" y="176" font-family="${META}" font-size="19" font-weight="700" fill="${C.accentDeep}" letter-spacing="4">GENESIS</text>

  <!-- who, and the costume they earned -->
  <text x="${PAD_L}" y="228" font-size="52" fill="${C.ink}">${esc(card.handle)}</text>
  <g transform="rotate(-1.5 ${PAD_L + labelW / 2} 268)">
    <rect x="${PAD_L + 4}" y="${250 + 4}" width="${labelW}" height="50" fill="${C.echo}"/>
    <rect x="${PAD_L}" y="250" width="${labelW}" height="50" fill="${C.ink}"/>
    <text x="${PAD_L + 22}" y="${250 + 37}" font-size="${labelFs}" fill="${C.accent}">${esc(label)}</text>
  </g>

  <!-- the type's own one-line verdict: the whole reason it gets reposted -->
  ${headLines}

  <!-- one small footer: brand + the hook, nothing else -->
  <text x="${PAD_L}" y="510" font-family="${META}" font-size="17" font-weight="700" fill="${C.muted}" letter-spacing="1">oddie.fun/genesis<tspan fill="${C.accentDeep}">&#160;&#160;·&#160;&#160;5 tickets waiting</tspan></text>

  ${art}
</svg>`;
}
