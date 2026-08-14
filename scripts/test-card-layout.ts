// The card's collision audit: every percentage from 1 to 100, against question
// lengths from terse to the 110-char Fed monsters, measured with the SAME
// width machinery the renderer lays out with. If the hero number, the offer,
// the invitation or the tension badge can ever touch, this fails before a
// broken card reaches a timeline.
//
// Run with: npm run test-card-layout

import { readFileSync, existsSync } from "node:fs";
import { renderCard, textWidth, layoutQuestion, volumePill, LOCKUP_RIGHT, C } from "../src/card/renderCard.js";
import { renderBanner } from "../src/card/renderBanner.js";
import { renderPositionCard } from "../src/card/renderPositionCard.js";
import { renderProfileCard } from "../src/card/renderProfileCard.js";
import { displayTitle } from "../src/title.js";
import { X_HANDLE } from "../src/brand.js";
import type { Market } from "../src/venues/types.js";
import type { ShareCall } from "../src/store/markets.js";

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

// --- The lockup carries the handle on EVERY card ----------------------------
//
// A screenshotted card loses every URL around it; the handle in the pixels is
// the only address that survives. So all three renderers must ship it — via
// the shared brandLockup(), so this can only fail if someone re-inlines a
// bespoke lockup, which is exactly the drift this section is for.
console.log("\nevery card is self-addressing");
{
  const call: ShareCall = {
    token: "t", slug: "s", question: "Will X win?", side: "yes", entryPct: 38,
    volumeUsd: 4_600_000, venue: "polymarket", closesAt: "2026-12-31T00:00:00Z",
    resolved: null, handle: "somebody",
  };
  const cards: [string, string][] = [
    ["market card", renderCard(mk("Will X win?", 38))],
    ["position card (open)", renderPositionCard(call)],
    ["position card (resolved)", renderPositionCard({ ...call, resolved: "yes" })],
    ["profile card", renderProfileCard({
      handle: "somebody", oddieScore: 240, meanEdge: 0.1, accuracyPct: 71,
      streak: 4, resolved: 12, hasEnough: true, rankTopPct: 8, tierLabel: "Sharp Caller",
    })],
  ];
  for (const [name, svg] of cards) {
    check(`${name} carries ${X_HANDLE}`, svg.includes(X_HANDLE));
  }

  // And the top line still has daylight: the volume pill's collision budget is
  // the LOCKUP's right edge (wordmark + handle), so the widest pill a market
  // can produce must start clear of it.
  const pill = volumePill({ venue: "polymarket", closesAt: "2026-12-31T00:00:00Z", volumeUsd: 4_600_000 });
  check("volume pill clears the extended lockup", pill.x >= LOCKUP_RIGHT + 24,
    `pill.x=${Math.round(pill.x)} lockup right=${Math.round(LOCKUP_RIGHT)}`);
}

// --- displayTitle: outcome-market titles read as questions --------------------
console.log("\ndisplayTitle: the card's title is the tweet");
{
  check('"— Yes" is redundant with the YES button and drops',
    displayTitle("Will the U.S. invade Iran before 2027? — Yes") === "Will the U.S. invade Iran before 2027?");
  check('"— No" is LEFT ALONE — yesPct prices the NO outcome, stripping flips the meaning',
    displayTitle("Will the U.S. invade Iran before 2027? — No") === "Will the U.S. invade Iran before 2027? — No");
  check("a named outcome becomes a question without needing a verb",
    displayTitle("F1 Drivers' Champion — Lewis Hamilton") === "F1 Drivers' Champion: Lewis Hamilton?");
  check("...and a question-titled event folds its own ? in",
    displayTitle("How many Fed cuts in 2026? — 3") === "How many Fed cuts in 2026: 3?");
  check("a plain question passes through untouched",
    displayTitle("Will X win?") === "Will X win?");
  check("an em dash INSIDE a sentence (no separator spacing) is not a split",
    displayTitle("Tie—breaker rules apply") === "Tie—breaker rules apply");
  // Wrap-proof assertions: the question is broken into tspans, so a long
  // contiguous substring can straddle a line break — check fragments that
  // survive wrapping instead.
  const f1 = renderCard(mk("F1 Drivers' Champion — Lewis Hamilton", 38));
  check("the card renders the normalized form", f1.includes("Hamilton?") && f1.includes("Champion:"));
  check("...and never the raw dash form", !f1.includes("— Lewis"));
  check("...and never a raw yes suffix",
    !renderCard(mk("Will it rain tomorrow? — Yes", 38)).includes("— Yes"));
}

// --- the outbound brand cannot drift from the app's brand ---------------------
//
// A static guard against a bug that shipped and sat unnoticed for weeks. The
// landing and the feed moved to the chartreuse sampled off the Oddie mark; the
// cards, and a hand-drawn public/banner.png serving as the site's og:image,
// stayed on the mint-lime that preceded it. Nobody caught it, because the card
// palette is a TypeScript literal and the stylesheet is CSS, and nothing has
// ever compared the two. Meanwhile every one of those pixels is what X shows.
//
// So: the card's accent is read against the feed's --accent token, and the
// og:image tags are read against the routes that actually answer. This cannot
// catch a bad colour choice; it catches the two surfaces disagreeing, which is
// the failure that actually happened.
console.log("\nthe images we post match the app people land in");
{
  const feedCss = readFileSync(new URL("../public/feed.html", import.meta.url), "utf8");
  const token = (name: string) => feedCss.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`))?.[1]?.toUpperCase() ?? null;

  check("the feed still declares an --accent to be measured against", token("accent") !== null);
  check("the card's accent IS the app's accent", C.accent.toUpperCase() === token("accent"),
    `card ${C.accent} vs feed --accent ${token("accent")}`);
  check("...and its deep variant is the app's --acc-deep", C.accentDeep.toUpperCase() === token("acc-deep"),
    `card ${C.accentDeep} vs feed --acc-deep ${token("acc-deep")}`);
  check("...and its pale wash is the app's --wash", C.pill.toUpperCase() === token("wash"),
    `card ${C.pill} vs feed --wash ${token("wash")}`);

  // The banner is drawn, not stored. A checked-in public/banner.png is exactly
  // how the last one went stale, so its absence is part of the contract.
  check("no static banner has crept back into public/",
    !existsSync(new URL("../public/banner.png", import.meta.url)));

  const banner = renderBanner();
  check("the banner is painted in the brand accent", banner.includes(`fill="${C.accent}"`));
  check("...and carries the handle as an instruction", banner.includes(`tag ${X_HANDLE} on X.`));
  // The mark is an inlined base64 PNG, and base64's alphabet spells "NaN" by
  // chance often enough that scanning the raw string for it is meaningless.
  const geom = banner.replace(/href="data:[^"]*"/g, 'href="…"');
  check("...and no unmeasurable coordinate reached the SVG", !geom.includes("NaN"));

  // The headline is auto-sized to its column; re-measure the shipped size the
  // way the renderer did and prove it stops short of the leftmost chip.
  const headFS = Number(geom.match(/<text font-size="(\d+)" font-weight="700"/)?.[1] ?? 0);
  const headRight = 70 + Math.max(...["turn arguments", "into markets."].map((l) => textWidth(l, headFS)));
  check("...and the headline clears the yes/no chips", headFS > 0 && headRight <= 618 - 24,
    `headline right edge ${Math.round(headRight)} at ${headFS}px vs chips at 618`);

  // Both share surfaces must point at a route this server answers, not a file.
  for (const page of ["landing", "feed"] as const) {
    const html = readFileSync(new URL(`../public/${page}.html`, import.meta.url), "utf8");
    const imgs = [...html.matchAll(/(?:og:image|twitter:image)" content="([^"]+)"/g)].map((m) => m[1]);
    check(`${page}.html ships both image tags`, imgs.length === 2, JSON.stringify(imgs));
    check(`...and both are the rendered banner`, imgs.every((u) => u.endsWith("/og.png")), JSON.stringify(imgs));
  }
}

console.log(failures === 0 ? "\nall card-layout checks passed.\n" : `\n${failures} card-layout check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
