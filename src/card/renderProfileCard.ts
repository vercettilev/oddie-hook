import { C, FONT, META, brandLockup, esc, textWidth, wrapToWidth } from "./renderCard.js";

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
  /** An achievement id from achievementsFor. It used to be one of four "kinds",
   *  three of which were computed from the dead play-token table, so the card
   *  could only ever draw one medallion however much somebody had earned. */
  id: string;
}

export interface ProfileCard {
  handle: string;
  oddieScore: number | null;
  /** Kept so existing callers still type-check. Nothing on the card reads it:
   *  edge is no longer part of the score. */
  meanEdge?: number | null;
  accuracyPct: number | null;
  streak: number;
  resolved: number;
  /** The ladder, which is what this card is now made of. */
  marketsCreated?: number;
  /** Real SOL staked in the markets this person started. The reach figure that
   *  is actually countable: a per-user position index does not exist on chain,
   *  and the old tradersReached counted rows in the dead play-token table, so
   *  the card printed "0 PLAYERS" for everybody. */
  pooledLamports?: number;
  /** >=1. Fills the ring, because it is the one bounded number left. */
  /** People whose FIRST real-money bet landed in a market this handle opened,
   *  counted once per wallet forever. The card's third stat and its ring. */
  takers?: number;
  hasEnough: boolean;
  /** Earned badges, most identity-defining first (kind picks the drawn glyph). */
  badges?: ProfileBadge[];
  /** Season standing as a percentile — 8 renders as "TOP 8%". Null = unranked. */
  rankTopPct?: number | null;
  /** The earned tier's claimable noun ("Oracle", "Sharp Caller"). Null = none
   *  earned, and the card then says nothing rather than inventing a label. */
  tierLabel?: string | null;
  /** "78% accuracy across 40 calls · top 3% in Crypto" — the line the card
   *  exists to make screenshottable, sat directly under the handle. */
  flexLine?: string | null;
}

// Vertical rhythm, top to bottom, kept here because the flex line squeezed it:
// handle 178 · flex 212 · ring 235..409 · divider 428 · stats 458/486. The ring
// was previously r=85 at cy=312 (top edge 217), which the new flex line at 226
// ran straight through — the arc cut across the text. Shrinking the ring
// slightly and dropping everything below it buys the line its own band.
const RING_CX = 165, RING_CY = 322, RING_R = 78, RING_SW = 18;
/** The ring is full at ten takers. Arbitrary, declared, and not a cap:
 *  the stat beside it prints the true number however far past ten it goes. */
const RING_FULL_AT = 10;
const DIVIDER_Y = 428, STAT_VALUE_Y = 458, STAT_LABEL_Y = 486;

/** A small stat block: a value over a label, left-anchored at x. */
function stat(x: number, value: string, label: string): string {
  return `<text x="${x}" y="${STAT_VALUE_Y}" font-size="46" font-weight="700" fill="${C.number}">${esc(value)}</text>
  <text x="${x}" y="${STAT_LABEL_Y}" font-family="${META}" font-size="20" font-weight="800" fill="${C.muted}">${esc(label)}</text>`;
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

/**
 * The medallion glyph, DRAWN (never emoji: resvg has no colour-emoji font, and
 * a colour emoji renders differently on every platform anyway).
 *
 * These are the SAME fourteen shapes the app's stamp sheet draws, on the same
 * 24x24 grid, so what you collect on screen is what people see on the image you
 * post. They are wrapped in a transform that recentres the box on the origin,
 * because the medallion draws in coordinates centred on itself.
 */
const CARD_GLYPH: Record<string, string> = {
  first_tag: '<path fill="INK" fill-rule="evenodd" d="M12 2.2c3.5 0 6.3 2.8 6.3 6.3 0 4.4-6.3 13.3-6.3 13.3S5.7 12.9 5.7 8.5C5.7 5 8.5 2.2 12 2.2Zm-2.2 4.2v4.4h4.4V6.4z"/>',
  ranked: '<g stroke="INK" stroke-width="2.4" fill="none"><rect x="4" y="4.4" width="16" height="4" rx="2"/><rect x="4" y="15.6" width="16" height="4" rx="2"/></g><rect x="2.8" y="10" width="18.4" height="4" rx="2" fill="INK"/>',
  first_pool: '<g fill="INK"><rect x="2.4" y="7.6" width="19.2" height="3" rx="1.5"/><path d="M4.2 12.2h15.6a7.8 7.8 0 0 1-15.6 0Z"/></g>',
  cleared: '<rect x="2.6" y="3.8" width="15.2" height="13.2" rx="3" stroke="INK" stroke-width="2.4" fill="none"/><circle cx="17.8" cy="17.2" r="4.2" fill="INK"/>',
  resolved: '<circle cx="12" cy="12" r="8.8" stroke="INK" stroke-width="2.4" fill="none"/><path fill="INK" d="M12 3.2a8.8 8.8 0 0 0 0 17.6z"/>',
  first_fee: '<path fill="INK" fill-rule="evenodd" d="M12 2.6a9.4 9.4 0 1 0 0 18.8 9.4 9.4 0 0 0 0-18.8Zm0 3.4v6h6a6 6 0 0 0-6-6Z"/>',
  range: '<g fill="INK"><circle cx="4.4" cy="12" r="3.2"/><rect x="9" y="8.8" width="6.4" height="6.4" rx="1.4"/><path d="M19.9 8.4 22.9 15.4h-6z"/></g>',
  collected: '<g fill="INK"><rect x="8.4" y="2.6" width="7.2" height="7.6" rx="1.6"/><path d="M3 12.2h3.8v5h10.4v-5H21v7.4a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 19.6z"/></g>',
  ten_tags: '<g fill="INK"><circle cx="3.6" cy="8.8" r="1.4"/><circle cx="7.8" cy="8.8" r="1.4"/><circle cx="12" cy="8.8" r="1.4"/><circle cx="16.2" cy="8.8" r="1.4"/><circle cx="20.4" cy="8.8" r="1.4"/><circle cx="3.6" cy="15.2" r="1.4"/><circle cx="7.8" cy="15.2" r="1.4"/><circle cx="12" cy="15.2" r="1.4"/><circle cx="16.2" cy="15.2" r="1.4"/><circle cx="20.4" cy="15.2" r="1.4"/></g>',
  triple: '<g stroke="INK" stroke-width="2.8" stroke-linecap="square" fill="none"><path d="m4.6 8.2 7.4-4.8 7.4 4.8"/><path d="m4.6 13.8 7.4-4.8 7.4 4.8"/><path d="m4.6 19.4 7.4-4.8 7.4 4.8"/></g>',
  big_pool: '<g fill="INK"><rect x="3.6" y="2.8" width="16.8" height="3.6" rx="1.8"/><rect x="7.4" y="8.4" width="9.2" height="12.8" rx="2.2"/></g>',
  top_ten: '<g fill="INK"><path d="M12 2.6 21.6 15H2.4z"/><rect x="3.2" y="17.4" width="17.6" height="3.8" rx="1.9"/></g>',
  loudest: '<rect x="2.4" y="8.4" width="7.2" height="7.2" rx="1.8" fill="INK"/><g fill="none" stroke="INK" stroke-width="2.6" stroke-linecap="round"><path d="M13.2 8.6a5.2 5.2 0 0 1 0 6.8"/><path d="M17.6 5.4a10.4 10.4 0 0 1 0 13.2"/></g>',
  founding: '<path fill="INK" fill-rule="evenodd" d="M7.6 3.4h8.8l3.7 17.2H3.9zM9.8 9.4h4.4v5.2H9.8z"/>',
};

function medalGlyph(id: string): string {
  // A 24x24 box scaled to about 30px and recentred, so it fills the 64px
  // medallion the way the stamp fills its plate in the app.
  const body = (CARD_GLYPH[id] ?? CARD_GLYPH.first_tag).replace(/INK/g, C.ink);
  return `<g transform="scale(1.25) translate(-12,-12)">${body}</g>`;
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
    <g transform="translate(${x},${cy})">${medalGlyph(badge.id)}</g>
    <text text-anchor="middle" font-family="${META}" font-size="18" font-weight="800" fill="${C.ink}">${labelText}</text>
  </g>`;
}

export function renderProfileCard(p: ProfileCard): string {
  const handle = "@" + p.handle.replace(/^@+/, "");
  const made = p.marketsCreated ?? 0;
  const pooledSol = ((p.pooledLamports ?? 0) / 1e9);
  const pooledText = pooledSol >= 1 ? pooledSol.toFixed(2) : pooledSol.toFixed(3);
  const takers = Math.max(0, Math.floor(Number(p.takers) || 0));

  // THE RING SHOWS TAKERS, and the denominator is declared rather than derived.
  // It has now had three fills. meanEdge left the score entirely and, with
  // meanEdge null, produced exactly half for every single person, so the gauge
  // on every shared card was identical and measured nothing. Then it filled by
  // a multiplier moved by POSTING about oddie -- the shape X revoked API access
  // for on 2026-01-15, so it went with the mechanic.
  // Takers is what the card should have been measuring all along: it only moves
  // when a stranger puts real SOL on a side of a market this person opened. Ten
  // is an arbitrary full ring and is written here so nobody mistakes it for a
  // cap on anything real -- the stat beside it prints the true number.
  const circumference = 2 * Math.PI * RING_R;
  const pct = Math.max(0, Math.min(1, takers / RING_FULL_AT));
  const score = p.oddieScore ?? 0;
  const heroText = String(score);
  const heroFS = 62;
  const kicker = "ODDIES";
  const ring = `<circle cx="${RING_CX}" cy="${RING_CY}" r="${RING_R}" fill="none" stroke="${C.barBg}" stroke-width="${RING_SW}"/>
    ${pct > 0 ? `<circle cx="${RING_CX}" cy="${RING_CY}" r="${RING_R}" fill="none" stroke="${C.accent}" stroke-width="${RING_SW}"
      stroke-linecap="round" stroke-dasharray="${circumference.toFixed(1)}"
      stroke-dashoffset="${(circumference * (1 - pct)).toFixed(1)}"
      transform="rotate(-90 ${RING_CX} ${RING_CY})"/>` : ""}
    <text x="${RING_CX}" y="${RING_CY + heroFS * 0.36}" text-anchor="middle" font-size="${heroFS}" font-weight="700"
      fill="${C.number}" stroke="${C.white}" stroke-width="5" paint-order="stroke" stroke-linejoin="round">${esc(heroText)}</text>
    <text x="${RING_CX}" y="${RING_CY + 34}" text-anchor="middle" font-family="${META}" font-size="15" font-weight="900"
      letter-spacing="0.5" fill="${C.accentDeep}">${kicker}</text>`;

  // The status CHIP, top-right: the earned tier over the season percentile.
  // Tier and rank share one chip rather than sitting in two — they are the
  // same fact at two resolutions ("Oracle" is what "top 3%" MEANS), and
  // splitting them into competing chips made the card read as a dashboard.
  // With no tier earned it degrades to the plain SEASON / TOP x% it was.
  const tierChip = p.tierLabel ? p.tierLabel.toUpperCase() : "SEASON";
  const rank = p.hasEnough && p.rankTopPct != null
    ? (() => {
        const t1 = tierChip, t2 = `TOP ${p.rankTopPct}%`;
        const w = Math.round(Math.max(textWidth(t1, 20), textWidth(t2, 34)) + 44);
        const x = PAD_R - w;
        return `<rect x="${x}" y="118" width="${w}" height="88" rx="20" fill="${C.pill}" stroke="${C.ink}" stroke-width="3"/>
          <text x="${PAD_R - 22}" y="150" text-anchor="end" font-family="${META}" font-size="20" font-weight="800" fill="${p.tierLabel ? C.accentDeep : C.muted}">${esc(t1)}</text>
          <text x="${PAD_R - 22}" y="188" text-anchor="end" font-size="34" font-weight="700" fill="${C.number}">${t2}</text>`;
      })()
    // Ranked-but-untiered still deserves the tier line if one was earned
    // (a Proven Caller outside the top 25% has no percentile worth showing).
    : p.tierLabel
      ? (() => {
          const w = Math.round(textWidth(p.tierLabel!.toUpperCase(), 26) + 44);
          const x = PAD_R - w;
          return `<rect x="${x}" y="132" width="${w}" height="60" rx="20" fill="${C.pill}" stroke="${C.ink}" stroke-width="3"/>
            <text x="${PAD_R - 22}" y="172" text-anchor="end" font-size="26" font-weight="700" fill="${C.accentDeep}">${esc(p.tierLabel!.toUpperCase())}</text>`;
        })()
      : "";

  // The brag, directly under the handle — the line this card exists to make
  // screenshottable. Truncated to the card's usable width rather than wrapped:
  // it is one line by design, and a two-line version collides with the ring.
  const flex = p.flexLine
    ? `<text x="${PAD_L}" y="212" font-family="${META}" font-size="22" font-weight="800" fill="${C.muted}">${esc(wrapToWidth(p.flexLine, PAD_R - PAD_L - 10, 22, 1).lines[0] ?? "")}</text>`
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
  ${brandLockup()}
  ${rank}

  <!-- the person, then what they've proven -->
  <text x="${PAD_L}" y="178" font-size="52" font-weight="700" fill="${C.ink}">${esc(handle)}</text>
  ${flex}

  <!-- hero: the score, ringed by how loud they have been -->
  ${ring}

  <!-- badges: earned identity, as medallions -->
  ${badgeRow}

  <!-- stat row: what they brought, who turned up, how loud they have been -->
  <line x1="${PAD_L}" y1="${DIVIDER_Y}" x2="${PAD_R}" y2="${DIVIDER_Y}" stroke="${C.barBg}" stroke-width="3"/>
  ${stat(PAD_L, String(made), "MARKETS")}
  ${stat(390, pooledText, "SOL POOLED")}
  ${stat(690, String(takers), "TAKERS")}
</svg>`;
}
