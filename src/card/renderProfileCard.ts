import { C, FONT, META, esc } from "./renderCard.js";
import { logoMark } from "./logoMark.js";

// The public-profile share card — same brand shell as the market card, but the
// hero is the person: their handle and their Oddie Score (or "building track
// record" before the threshold). Posted to X when someone shares their profile,
// so it has to read at a glance: who, how good, and what they've earned.
//
// The two-concept identity model lives here too: the Oddie Score is the skill
// number, and everything else on the card is IDENTITY, not a second number —
// earned badges (pills) and a season RANK ("top 8%"), never a raw points figure.

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
  /** Earned-badge labels, most identity-defining first (e.g. "Founding Caller"). */
  badges?: string[];
  /** Season standing as a percentile — 8 renders as "TOP 8%". Null = unranked. */
  rankTopPct?: number | null;
}

/** A small stat block: a value over a label, left-anchored at x. */
function stat(x: number, value: string, label: string): string {
  return `<text x="${x}" y="452" font-size="46" font-weight="700" fill="${C.number}">${esc(value)}</text>
  <text x="${x}" y="482" font-family="${META}" font-size="20" font-weight="800" fill="${C.muted}">${esc(label)}</text>`;
}

// A rounded badge pill. resvg has no colour-emoji font, so pills are TEXT only —
// the label carries the meaning. Width is estimated from the character count so
// the pills tile left-to-right without measuring.
function pill(x: number, y: number, text: string): { svg: string; w: number } {
  const w = Math.round(28 + text.length * 12.2);
  return {
    svg: `<g>
      <rect x="${x}" y="${y}" width="${w}" height="44" rx="22" fill="${C.accent}" stroke="${C.ink}" stroke-width="3"/>
      <text x="${x + w / 2}" y="${y + 29}" text-anchor="middle" font-family="${META}" font-size="20" font-weight="800" fill="${C.ink}">${esc(text)}</text>
    </g>`,
    w,
  };
}

export function renderProfileCard(p: ProfileCard): string {
  const handle = "@" + p.handle.replace(/^@+/, "");
  const acc = p.accuracyPct == null ? "—" : `${p.accuracyPct}%`;

  // Hero: the Oddie Score, or the building state. Kicker sits above it in lime.
  const hero = p.hasEnough && p.oddieScore != null ? String(p.oddieScore) : "building";
  const heroFS = p.hasEnough ? 150 : 84;
  const kicker = p.hasEnough ? "ODDIE SCORE" : "TRACK RECORD";
  const HERO_BASE = 348;

  // Rank rides top-right as a status stamp ("TOP 8%") — the standing expressed as
  // a place, never a points number. Only when the record is established.
  const rank = p.hasEnough && p.rankTopPct != null
    ? `<text x="${PAD_R}" y="150" text-anchor="end" font-family="${META}" font-size="26" font-weight="800" fill="${C.muted}">SEASON</text>
       <text x="${PAD_R}" y="196" text-anchor="end" font-size="52" font-weight="700" fill="${C.number}">TOP ${p.rankTopPct}%</text>`
    : "";

  // Badges: a single row of pills below the hero. Screenshot-friendly identity.
  let badgeRow = "";
  const labels = (p.badges ?? []).slice(0, 3);
  if (labels.length) {
    let x = PAD_L;
    const parts: string[] = [];
    for (const label of labels) {
      const { svg, w } = pill(x, 366, label);
      if (x + w > PAD_R) break; // don't run off the card
      parts.push(svg);
      x += w + 12;
    }
    badgeRow = parts.join("\n  ");
  }

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT}">
  <rect width="${W}" height="${H}" fill="${C.white}"/>
  <rect x="26" y="26" width="948" height="472" rx="46" fill="${C.white}" stroke="${C.ink}" stroke-width="13"/>

  <!-- brand lockup -->
  ${logoMark(52, 62, 68)}
  <text x="140" y="112" font-size="46" font-weight="600" fill="${C.ink}">oddie</text>
  ${rank}

  <!-- the person -->
  <text x="${PAD_L}" y="192" font-size="52" font-weight="700" fill="${C.ink}">${esc(handle)}</text>

  <!-- hero: Oddie Score (or building) -->
  <text x="${PAD_L}" y="${HERO_BASE - 108}" font-size="30" font-weight="700" fill="${C.accent}">${kicker}</text>
  <text x="${PAD_L}" y="${HERO_BASE}" font-size="${heroFS}" font-weight="700" fill="${C.number}"
        stroke="${C.white}" stroke-width="9" paint-order="stroke" stroke-linejoin="round">${esc(hero)}</text>

  <!-- badges: earned identity, as pills -->
  ${badgeRow}

  <!-- stat row: accuracy · streak · resolved -->
  <line x1="${PAD_L}" y1="422" x2="${PAD_R}" y2="422" stroke="${C.barBg}" stroke-width="3"/>
  ${stat(PAD_L, acc, "ACCURACY")}
  ${stat(390, String(p.streak), "STREAK")}
  ${stat(690, String(p.resolved), "RESOLVED")}
</svg>`;
}
