import { C, FONT, META, esc, textWidth, wrapToWidth } from "./renderCard.js";
import { logoMark } from "./logoMark.js";

// The public-profile share card — same brand shell as the market card, but the
// hero is the person: their handle and their Oddie Score (or "building track
// record" before the threshold). Posted to X when someone shares their profile,
// so it has to read at a glance: who, how good, and what they've earned.
//
// Matches the live profile's trophy-room language, translated into static SVG:
// a ring/gauge for the Oddie Score (an SVG stroke-dasharray donut — the direct
// equivalent of the live page's CSS conic-gradient ring), badges as medallions
// (a drawn glyph on a lime medal-sheen, not emoji — resvg has no colour-emoji
// font, so a glyph is DRAWN, the same trick renderPositionCard already uses for
// its checkmark/cross). No animation (it's a static PNG for X's unfurl), but
// the visual hierarchy — Oddie Score as the one big number, everything else
// stepped down — is the same product as the live page, not a different one.
//
// The two-concept identity model still holds: the Oddie Score is the skill
// number, and everything else on the card is IDENTITY, not a second number —
// earned badges and a season RANK ("top 8%"), never a raw points figure.

const W = 1000;
const H = 524;
const PAD_L = 70;
const PAD_R = 932;

export interface ProfileBadge {
  label: string;
  kind: "founding" | "streak" | "category" | "rank";
}

export interface ProfileCard {
  handle: string;
  oddieScore: number | null;
  accuracyPct: number | null;
  streak: number;
  resolved: number;
  hasEnough: boolean;
  /** Earned badges, most identity-defining first (kind picks the drawn glyph). */
  badges?: ProfileBadge[];
  /** Season standing as a percentile — 8 renders as "TOP 8%". Null = unranked. */
  rankTopPct?: number | null;
}

/** A small stat block: a value over a label, left-anchored at x. */
function stat(x: number, value: string, label: string): string {
  return `<text x="${x}" y="452" font-size="46" font-weight="700" fill="${C.number}">${esc(value)}</text>
  <text x="${x}" y="482" font-family="${META}" font-size="20" font-weight="800" fill="${C.muted}">${esc(label)}</text>`;
}

/** A regular n-pointed star's outline, as a path `d` — used for the "founding"
 *  medallion glyph. Generated, not hand-typed: reliable at any size. */
function starPath(rOuter: number, rInner: number, points = 5): string {
  const step = Math.PI / points;
  let d = "";
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = i * step - Math.PI / 2;
    const x = Math.round(r * Math.cos(a) * 10) / 10;
    const y = Math.round(r * Math.sin(a) * 10) / 10;
    d += `${i === 0 ? "M" : "L"}${x},${y} `;
  }
  return d + "Z";
}

/** The medallion glyph, DRAWN (never emoji — resvg has no colour-emoji font),
 *  local coordinates centred on the medallion, solid ink so it reads clearly
 *  at 64px. One shape per badge kind; "rank" isn't produced today but is kept
 *  so the card never breaks if that changes. */
function medalGlyph(kind: ProfileBadge["kind"]): string {
  switch (kind) {
    case "streak": // a flame
      return `<path d="M0,-15 C4,-10 4,-3 1,1 C3,-2 5,0 5,4 C5,10 1,14 -1,14 C-6,14 -8,9 -7,4 C-8,7 -10,4 -9,0 C-8,-4 -5,-8 -2,-11 C-1,-12.5 -0.5,-14 0,-15 Z" fill="${C.ink}"/>`;
    case "category": // a target
      return `<circle r="13" fill="none" stroke="${C.ink}" stroke-width="2.6"/>
        <circle r="8" fill="none" stroke="${C.ink}" stroke-width="2.6"/>
        <circle r="3.2" fill="${C.ink}"/>`;
    case "rank": // an upward chevron
      return `<path d="M-10,7 L0,-9 L10,7" fill="none" stroke="${C.ink}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`;
    case "founding": // a star
    default:
      return `<path d="${starPath(14, 6)}" fill="${C.ink}"/>`;
  }
}

/** One badge medallion: a circular icon on a lime medal-sheen (a radial
 *  gradient — the flat-pill's replacement), the label wrapped beneath it. */
function medallion(x: number, cy: number, badge: ProfileBadge): string {
  const R = 32;
  const lines = wrapToWidth(badge.label, 148, 18, 2).lines;
  const labelY = cy + R + 30;
  const labelText = lines
    .map((l, i) => `<tspan x="${x}" y="${labelY + i * 22}">${esc(l)}</tspan>`)
    .join("");
  return `<g>
    <circle cx="${x}" cy="${cy}" r="${R}" fill="url(#medalGrad)" stroke="${C.ink}" stroke-width="3"/>
    <g transform="translate(${x},${cy})">${medalGlyph(badge.kind)}</g>
    <text text-anchor="middle" font-family="${META}" font-size="18" font-weight="800" fill="${C.ink}">${labelText}</text>
  </g>`;
}

export function renderProfileCard(p: ProfileCard): string {
  const handle = "@" + p.handle.replace(/^@+/, "");
  const acc = p.accuracyPct == null ? "—" : `${p.accuracyPct}%`;

  // The ring/gauge: an SVG stroke-dasharray donut, filled to score/1000 — the
  // direct static equivalent of the live page's CSS conic-gradient ring.
  const RING_CX = 165, RING_CY = 312, RING_R = 85, RING_SW = 20;
  const circumference = 2 * Math.PI * RING_R;
  const pct = p.hasEnough && p.oddieScore != null ? Math.max(0, Math.min(1, p.oddieScore / 1000)) : 0;
  const heroText = p.hasEnough && p.oddieScore != null ? String(p.oddieScore) : "building";
  const heroFS = p.hasEnough ? 62 : 32;
  const kicker = p.hasEnough ? "ODDIE SCORE" : "TRACK RECORD";
  const ring = `<circle cx="${RING_CX}" cy="${RING_CY}" r="${RING_R}" fill="none" stroke="${C.barBg}" stroke-width="${RING_SW}"/>
    ${pct > 0 ? `<circle cx="${RING_CX}" cy="${RING_CY}" r="${RING_R}" fill="none" stroke="${C.accent}" stroke-width="${RING_SW}"
      stroke-linecap="round" stroke-dasharray="${circumference.toFixed(1)}"
      stroke-dashoffset="${(circumference * (1 - pct)).toFixed(1)}"
      transform="rotate(-90 ${RING_CX} ${RING_CY})"/>` : ""}
    <text x="${RING_CX}" y="${RING_CY + heroFS * 0.36}" text-anchor="middle" font-size="${heroFS}" font-weight="700"
      fill="${C.number}" stroke="${C.white}" stroke-width="5" paint-order="stroke" stroke-linejoin="round">${esc(heroText)}</text>
    <text x="${RING_CX}" y="${RING_CY + 34}" text-anchor="middle" font-family="${META}" font-size="15" font-weight="900"
      letter-spacing="0.5" fill="${C.accentDeep}">${kicker}</text>`;

  // Season rank — a status CHIP, top-right, a place rather than a number.
  const rank = p.hasEnough && p.rankTopPct != null
    ? (() => {
        const t1 = "SEASON", t2 = `TOP ${p.rankTopPct}%`;
        const w = Math.round(Math.max(textWidth(t1, 20), textWidth(t2, 34)) + 44);
        const x = PAD_R - w;
        return `<rect x="${x}" y="118" width="${w}" height="88" rx="20" fill="${C.pill}" stroke="${C.ink}" stroke-width="3"/>
          <text x="${PAD_R - 22}" y="150" text-anchor="end" font-family="${META}" font-size="20" font-weight="800" fill="${C.muted}">${t1}</text>
          <text x="${PAD_R - 22}" y="188" text-anchor="end" font-size="34" font-weight="700" fill="${C.number}">${t2}</text>`;
      })()
    : "";

  // Badges: medallions to the right of the ring, vertically centred on it.
  const labels = (p.badges ?? []).slice(0, 3);
  const GAP = 155;
  let badgeRow = "";
  {
    let x = 400;
    const parts: string[] = [];
    for (const b of labels) {
      if (x + 40 > PAD_R) break; // don't run the last medallion off the card
      parts.push(medallion(x, RING_CY, b));
      x += GAP;
    }
    badgeRow = parts.join("\n  ");
  }

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT}">
  <defs>
    <radialGradient id="medalGrad" cx="32%" cy="26%" r="80%">
      <stop offset="0%" stop-color="#eefccb"/>
      <stop offset="100%" stop-color="${C.accent}"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${C.white}"/>
  <rect x="26" y="26" width="948" height="472" rx="46" fill="${C.white}" stroke="${C.ink}" stroke-width="13"/>

  <!-- brand lockup -->
  ${logoMark(52, 62, 68)}
  <text x="140" y="112" font-size="46" font-weight="600" fill="${C.ink}">oddie</text>
  ${rank}

  <!-- the person -->
  <text x="${PAD_L}" y="192" font-size="52" font-weight="700" fill="${C.ink}">${esc(handle)}</text>

  <!-- hero: Oddie Score ring (or the empty "building" gauge) -->
  ${ring}

  <!-- badges: earned identity, as medallions -->
  ${badgeRow}

  <!-- stat row: accuracy · streak · resolved -->
  <line x1="${PAD_L}" y1="422" x2="${PAD_R}" y2="422" stroke="${C.barBg}" stroke-width="3"/>
  ${stat(PAD_L, acc, "ACCURACY")}
  ${stat(390, String(p.streak), "STREAK")}
  ${stat(690, String(p.resolved), "RESOLVED")}
</svg>`;
}
