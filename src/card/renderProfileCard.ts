import { C, FONT, META, esc } from "./renderCard.js";
import { logoMark } from "./logoMark.js";

// The public-profile share card — same brand shell as the market card, but the
// hero is the person: their handle and their Oddie Score (or "building track
// record" before the threshold). Posted to X when someone shares their profile,
// so it has to read at a glance: who, and how good.

const W = 1000;
const H = 524;
const PAD_L = 70;
const PAD_R = 932;

export interface ProfileCard {
  handle: string;
  oddieScore: number | null;
  accuracyPct: number | null;
  streak: number;
  resolved: number;
  hasEnough: boolean;
}

/** A small stat block: a value over a label, left-anchored at x. */
function stat(x: number, value: string, label: string): string {
  return `<text x="${x}" y="452" font-size="46" font-weight="700" fill="${C.number}">${esc(value)}</text>
  <text x="${x}" y="482" font-family="${META}" font-size="20" font-weight="800" fill="${C.muted}">${esc(label)}</text>`;
}

export function renderProfileCard(p: ProfileCard): string {
  const handle = "@" + p.handle.replace(/^@+/, "");
  const acc = p.accuracyPct == null ? "—" : `${p.accuracyPct}%`;

  // Hero: the Oddie Score, or the building state. Kicker sits above it in lime.
  const hero = p.hasEnough && p.oddieScore != null ? String(p.oddieScore) : "building";
  const heroFS = p.hasEnough ? 150 : 84;
  const kicker = p.hasEnough ? "ODDIE SCORE" : "TRACK RECORD";
  const HERO_BASE = 348;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT}">
  <rect width="${W}" height="${H}" fill="${C.white}"/>
  <rect x="26" y="26" width="948" height="472" rx="46" fill="${C.white}" stroke="${C.ink}" stroke-width="13"/>

  <!-- brand lockup -->
  ${logoMark(52, 62, 68)}
  <text x="140" y="112" font-size="46" font-weight="600" fill="${C.ink}">oddie</text>

  <!-- the person -->
  <text x="${PAD_L}" y="192" font-size="52" font-weight="700" fill="${C.ink}">${esc(handle)}</text>

  <!-- hero: Oddie Score (or building) -->
  <text x="${PAD_L}" y="${HERO_BASE - 108}" font-size="30" font-weight="700" fill="${C.accent}">${kicker}</text>
  <text x="${PAD_L}" y="${HERO_BASE}" font-size="${heroFS}" font-weight="700" fill="${C.number}"
        stroke="${C.white}" stroke-width="9" paint-order="stroke" stroke-linejoin="round">${esc(hero)}</text>
  ${p.hasEnough ? `<text x="${PAD_L}" y="${HERO_BASE + 40}" font-family="${META}" font-size="21" font-weight="700" fill="${C.muted}">500 = matches the market</text>` : ""}

  <!-- stat row: accuracy · streak · resolved -->
  <line x1="${PAD_L}" y1="392" x2="${PAD_R}" y2="392" stroke="${C.barBg}" stroke-width="3"/>
  ${stat(PAD_L, acc, "ACCURACY")}
  ${stat(390, String(p.streak), "STREAK")}
  ${stat(690, String(p.resolved), "RESOLVED")}
</svg>`;
}
