// The PERSONAL card: "@handle called YES at 38%". Same brand frame as the
// market card — chunky black outline, white fill, the two ghost eyes, one lime
// accent — because on a timeline the two must read as the same product. What
// changes is the story: the market card states a question; this one states a
// POSITION someone took on it, and (once resolved) whether they were right.
//
// It is rendered only for calls whose owner minted a share token: the card
// names a handle and a side, so nobody's call becomes an image unless they
// chose to make it one.

import type { ShareCall } from "../store/markets.js";
import { C, FONT, META, brandLockup, esc, layoutQuestion, textWidth, volumePill } from "./renderCard.js";

const W = 1000;
const H = 524;
const PAD_L = 70;
const PAD_R = 932;
const Q_TOP = 156;
const CAP = 0.72;
const HERO_BASE = 462;
const KICKER_FS = 34;

export function renderPositionCard(s: ShareCall): string {
  const q = layoutQuestion(s.question);
  const firstBaseline = Q_TOP + CAP * q.fs;
  const questionTspans = q.lines
    .map((l, i) => `<tspan x="${PAD_L}" y="${Math.round(firstBaseline + i * q.lineH)}">${esc(l)}</tspan>`)
    .join("");

  // Top-right pill: volume while open, the verdict once resolved. The check and
  // cross are DRAWN, not typed: the bundled fonts have no U+2713 and resvg has
  // no system fallback, so the glyph route renders tofu.
  //
  // The OPEN state shares the exact volumePill() logic the general market card
  // uses: a real $ figure for a venue market, forming/closes-in language for a
  // community market (which has no venue volume — it must never read "$0 in
  // play"). Geometry (PAD_R, the wordmark) is identical between the two cards,
  // so its x/w are used as-is, no re-derivation.
  const won = s.resolved === s.side;
  const isResolved = s.resolved !== null && s.resolved !== "sold";
  const markW = isResolved ? 34 : 0; // room for the drawn mark
  let pillText: string, pillW: number, pillX: number;
  if (isResolved) {
    pillText = `resolved ${s.resolved!.toUpperCase()}`;
    pillW = Math.round(textWidth(pillText, 21) + 44 + markW);
    pillX = PAD_R - pillW;
  } else {
    const vp = volumePill({ venue: s.venue, closesAt: s.closesAt, volumeUsd: s.volumeUsd });
    pillText = vp.text; pillW = vp.w; pillX = vp.x;
  }
  const pillBg = !isResolved ? C.pill : won ? C.accent : C.barBg;
  const pillFg = !isResolved ? C.muted : C.ink;
  const markX = pillX + pillW - 40;
  const mark = !isResolved
    ? ""
    : won
      ? `<path d="M ${markX} 97 l 7 8 l 14 -17" stroke="${C.ink}" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<path d="M ${markX + 2} 88 l 16 16 M ${markX + 18} 88 l -16 16" stroke="${C.muted}" stroke-width="5" fill="none" stroke-linecap="round"/>`;

  // Kicker: whose call. Hero: the call itself. The number keeps the brand's
  // near-black + white outline; the side is the lime accent.
  const kicker = `@${s.handle} called`;
  const heroText = `${s.side.toUpperCase()} · ${s.entryPct}%`;
  let heroFS = 130;
  while (heroFS > 72 && PAD_L + textWidth(heroText, heroFS) > PAD_R) heroFS -= 6;
  const heroCapTop = HERO_BASE - CAP * heroFS;
  const kickerBaseline = Math.round(heroCapTop - 14);

  // Under the hero-right: what happened (or what's at stake), quiet and factual.
  const footText =
    s.resolved === null
      ? `right pays ${(100 / s.entryPct) >= 10 ? Math.round(100 / s.entryPct) : Math.round(1000 / s.entryPct) / 10}× · live on oddie`
      : s.resolved === "sold"
        ? `sold early · oddie`
        : won
          ? `called it · oddie`
          : `market said ${s.resolved.toUpperCase()} · oddie`;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT}">
  <rect width="${W}" height="${H}" fill="${C.white}"/>
  <rect x="26" y="26" width="948" height="472" rx="46" fill="${C.white}" stroke="${C.ink}" stroke-width="13"/>

  ${brandLockup()}

  <rect x="${pillX}" y="72" width="${pillW}" height="48" rx="24" fill="${pillBg}" ${isResolved && won ? `stroke="${C.ink}" stroke-width="3"` : ""}/>
  <text x="${pillX + (pillW - markW) / 2}" y="103" font-family="${META}" font-size="21" font-weight="700"
        fill="${pillFg}" text-anchor="middle">${esc(pillText)}</text>
  ${mark}

  <text font-size="${q.fs}" font-weight="600" fill="${C.ink}">${questionTspans}</text>

  <text x="${PAD_L}" y="${kickerBaseline}" font-size="${KICKER_FS}" font-weight="600" fill="${C.accent}">${esc(kicker)}</text>
  <text x="${PAD_L}" y="${HERO_BASE}" font-size="${heroFS}" font-weight="700" fill="${C.number}"
        stroke="${C.white}" stroke-width="9" paint-order="stroke" stroke-linejoin="round">${esc(heroText)}</text>

  <text x="${PAD_R}" y="${kickerBaseline}" font-family="${META}" font-size="22" font-weight="700"
        fill="${C.muted}" text-anchor="end">${esc(footText)}</text>
</svg>`;
}
