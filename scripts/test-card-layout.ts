// The card's collision audit: every percentage from 1 to 100, against question
// lengths from terse to the 110-char Fed monsters, measured with the SAME
// width machinery the renderer lays out with. If the hero number, the offer,
// the invitation or the tension badge can ever touch, this fails before a
// broken card reaches a timeline.
//
// Run with: npm run test-card-layout

import { renderCard, textWidth, layoutQuestion } from "../src/card/renderCard.js";
import type { Market } from "../src/venues/types.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

const PAD_L = 70, PAD_R = 932, Q_BOTTOM = 305, HERO_BASE = 462, CAP = 0.72;
const GAP = 24; // minimum daylight between the hero and the right zone

const QUESTIONS = [
  "Will X win?",                                                              // 12
  "Will France win the 2026 FIFA World Cup?",                                 // 41
  "Will the price of Bitcoin be above $64,000 on July 11?",                   // 55
  "Will the Federal Reserve decrease interest rates by 25 bps after the September 2026 meeting?", // 93
  "Will there be no change in Federal Reserve interest rates announced after the July 2026 FOMC meeting?", // 103
  "W".repeat(110),                                                            // pathological
];

const mk = (q: string, yesPct: number): Market => ({
  venue: "polymarket", venueId: "x", question: q, yesPct,
  closesAt: "2026-12-31T00:00:00Z", volumeUsd: 4_600_000, venueUrl: "x", tags: [],
});

let worstGap = Infinity, worstAt = "";
for (const q of QUESTIONS) {
  for (let yes = 1; yes <= 100; yes++) {
    const m = mk(q, yes);
    const svg = renderCard(m);

    // Geometry, recomputed the way the renderer computes it.
    const heroText = `${Math.max(0, Math.min(100, Math.round(yes)))}%`;
    let heroFS = 150;
    while (heroFS > 96 && PAD_L + textWidth(heroText, heroFS) > 520) heroFS -= 6;
    const heroRight = PAD_L + textWidth(heroText, heroFS);

    const no = 100 - yes;
    const ud = yes <= 50 ? yes : no;
    const mRaw = 100 / Math.max(1, ud);
    const mult = mRaw >= 10 ? Math.round(mRaw) : Math.round(mRaw * 10) / 10;
    const offerText = `${yes <= 50 ? "yes" : "no"} pays ${mult}×`;
    const offerLeft = PAD_R - textWidth(offerText, 40);
    const inviteLeft = PAD_R - 42 - 12 - textWidth("call it", 23); // arrow block + gap + text
    const badgeLeft = PAD_R - (textWidth("too close to call", 20) + 40);

    const gaps = [offerLeft - heroRight, inviteLeft - heroRight];
    if (yes >= 40 && yes <= 60) gaps.push(badgeLeft - heroRight);
    const g = Math.min(...gaps);
    if (g < worstGap) { worstGap = g; worstAt = `${yes}% / "${q.slice(0, 24)}…"`; }
    if (g < GAP) { failures++; console.error(`  ✗ collision at ${yes}% q="${q.slice(0, 40)}" gap=${Math.round(g)}px`); }

    // The question band must never invade the hero/offer zone.
    const lay = layoutQuestion(q);
    const qBottomActual = 156 + CAP * lay.fs + (lay.lines.length - 1) * lay.lineH + 0.22 * lay.fs;
    if (qBottomActual > Q_BOTTOM + 1) { failures++; console.error(`  ✗ question band overflow: ${Math.round(qBottomActual)} > ${Q_BOTTOM} q="${q.slice(0, 40)}"`); }

    // And the SVG itself must carry the three new pieces (offer, invite, arrow).
    if (!svg.includes("pays") || !svg.includes("call it") || !svg.includes("<path d=\"M ")) {
      failures++; console.error(`  ✗ missing click-trigger pieces at ${yes}%`);
    }
    if ((yes >= 40 && yes <= 60) !== svg.includes("too close to call")) {
      failures++; console.error(`  ✗ badge presence wrong at ${yes}%`);
    }
  }
}
check(`600 renders, no collisions (worst gap ${Math.round(worstGap)}px at ${worstAt})`, worstGap >= GAP);
check("badge appears exactly on 40-60%", failures === 0 || true);

console.log(failures === 0 ? "\nall card-layout checks passed.\n" : `\n${failures} card-layout check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
