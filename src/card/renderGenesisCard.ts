import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { C, FONT, META, brandLockup, esc, textWidth, wrapToWidth } from "./renderCard.js";
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

  // --- left column: who, the headline, the dare -------------------------
  const labelFs = 30;
  // textWidth is deliberately generous, but not generous enough for long
  // all-caps labels in Fredoka 700 ("THE MAIN CHARACTER" overflowed its pill
  // at 0.74). 0.86 measured right across all nine labels.
  const labelW = Math.round(textWidth(label, labelFs) * 0.86) + 44;

  // The reason sits UNDER the verdict pill at a fixed spot (justification
  // belongs next to the label, and a 3-line headline must never push it into
  // the dare), then the headline gets the room between it and the dare.
  // Three-line headlines refit at a smaller size so the block never crowds
  // the dare pinned at the bottom.
  let headFs = 42;
  let head = wrapToWidth(card.headline, 540, headFs, 3);
  if (head.lines.length === 3) { headFs = 37; head = wrapToWidth(card.headline, 540, headFs, 3); }
  const headY = 342;
  const headLines = head.lines.map((ln, i) =>
    `<text x="${PAD_L}" y="${headY + i * (headFs + 10)}" font-size="${headFs}" font-weight="700" fill="${C.ink}">${esc(ln)}</text>`).join("\n  ");

  // --- right column: the costume and the stub ---------------------------
  const stub = card.claim ? stubWith(card.claim) : stubEmpty();

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT}">
  <rect width="${W}" height="${H}" fill="${C.white}"/>
  <rect x="42" y="42" width="948" height="508" fill="${C.pinkDeep}"/>
  <rect x="26" y="26" width="948" height="508" fill="${C.white}" stroke="${C.ink}" stroke-width="13"/>

  ${brandLockup()}
  <text x="930" y="112" text-anchor="end" font-family="${META}" font-size="24" font-weight="700" fill="${C.accentDeep}" letter-spacing="3">GENESIS</text>

  <!-- who, and the costume they earned -->
  <text x="${PAD_L}" y="182" font-size="44" font-weight="700" fill="${C.ink}">${esc(card.handle)}</text>
  <g transform="rotate(-1.5 ${PAD_L + labelW / 2} 222)">
    <rect x="${PAD_L + 4}" y="${204 + 4}" width="${labelW}" height="46" fill="${C.echo}"/>
    <rect x="${PAD_L}" y="204" width="${labelW}" height="46" fill="${C.ink}"/>
    <text x="${PAD_L + 22}" y="${204 + 33}" font-size="${labelFs}" font-weight="700" fill="${C.accent}">${esc(label)}</text>
  </g>

  <!-- the type's own headline, the person's numbers already in it -->
  <text x="${PAD_L}" y="284" font-family="${META}" font-size="20" font-weight="700" fill="${C.muted}">${esc(card.reason)}</text>
  ${headLines}

  <!-- the dare -->
  <text x="${PAD_L}" y="482" font-size="30" font-weight="700" fill="${C.ink}">UNTIL NOW.&#160;&#160;<tspan fill="${C.accentDeep}">5 TICKETS WAITING.</tspan></text>
  <text x="${PAD_L}" y="512" font-family="${META}" font-size="17" font-weight="700" fill="${C.muted}" letter-spacing="2">ODDIE.FUN/GENESIS</text>

  <!-- the costume, leaning on the stub -->
  ${stub}
  <image href="${artHref(card.archetype)}" x="700" y="120" width="230" height="260" preserveAspectRatio="xMidYMid meet" transform="rotate(2.5 815 250)"/>
</svg>`;
}

// The pinned claim as a ticket stub: white paper, dashed tear, barcode, the
// NEVER SCORED stamp. Their words in our object.
function stubWith(claim: string): string {
  const fs = 19;
  const wrapped = wrapToWidth(claim, 210, fs, 3);
  const lines = wrapped.lines.map((ln, i) =>
    `<text x="678" y="${418 + i * (fs + 6)}" font-size="${fs}" font-weight="700" fill="${C.ink}">${esc(ln)}${wrapped.overflow && i === wrapped.lines.length - 1 ? "…" : ""}</text>`).join("\n    ");
  return `<g transform="rotate(-2 790 443)">
    <rect x="656" y="370" width="278" height="150" fill="#F7F5EE" stroke="${C.ink}" stroke-width="4"/>
    <line x1="668" y1="394" x2="922" y2="394" stroke="${C.ink}" stroke-width="2.5" stroke-dasharray="7 6"/>
    <text x="678" y="387" font-family="${META}" font-size="12" font-weight="700" fill="${C.muted}" letter-spacing="2">YOU PINNED THIS</text>
    ${lines}
    <g transform="rotate(-7 848 496)">
      <rect x="782" y="482" width="128" height="28" fill="${C.white}" stroke="${C.echo}" stroke-width="3"/>
      <text x="792" y="502" font-family="${META}" font-size="14" font-weight="800" fill="${C.echo}" letter-spacing="1">NEVER SCORED</text>
    </g>
  </g>`;
}

function stubEmpty(): string {
  return `<g transform="rotate(-2 790 443)">
    <rect x="656" y="370" width="278" height="150" fill="#F7F5EE" stroke="${C.ink}" stroke-width="4" stroke-dasharray="10 7"/>
    <text x="678" y="428" font-size="24" font-weight="700" fill="${C.ink}">THIS LINE</text>
    <text x="678" y="460" font-size="24" font-weight="700" fill="${C.ink}">IS YOURS.</text>
    <text x="678" y="494" font-family="${META}" font-size="14" font-weight="700" fill="${C.muted}">Tag @oddiefun on a claim.</text>
  </g>`;
}
