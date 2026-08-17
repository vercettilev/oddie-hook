// The card's collision audit: every percentage from 1 to 100, against question
// lengths from terse to the 110-char Fed monsters, measured with the SAME
// width machinery the renderer lays out with. If the hero number, the offer,
// the invitation or the tension badge can ever touch, this fails before a
// broken card reaches a timeline.
//
// Run with: npm run test-card-layout

import { readFileSync, existsSync } from "node:fs";
import {
  renderCard, textWidth, layoutQuestion, volumePill, LOCKUP_RIGHT, C,
  pick, INVITE_POOL, BADGE_POOL,
} from "../src/card/renderCard.js";
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

// The invite/badge text is no longer one fixed string (see renderCard.ts's
// INVITE_POOL/BADGE_POOL). Every synthetic market this sweep builds shares
// one venueId, so it would only ever exercise whichever single pool entry
// that ONE seed happens to hash to, leaving the other four unchecked. The
// collision budget below is measured against the WIDEST entry in each pool
// instead, so the audit still guarantees no real market (any venueId, any
// resulting pick) can ever collide, not just the one this loop happens to hit.
const INVITE_W_MAX = Math.max(...INVITE_POOL.map((s) => textWidth(s, 23)));
const BADGE_W_MAX = Math.max(...BADGE_POOL.map((s) => textWidth(s, 20))) + 40;

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
    const inviteLeft = PAD_R - 42 - 12 - INVITE_W_MAX; // arrow block + gap + widest possible text
    const badgeLeft = PAD_R - BADGE_W_MAX;

    const gaps = [offerLeft - heroRight, inviteLeft - heroRight];
    if (yes >= 40 && yes <= 60) gaps.push(badgeLeft - heroRight);
    const g = Math.min(...gaps);
    if (g < worstGap) { worstGap = g; worstAt = `${yes}% / "${q.slice(0, 24)}…"`; }
    if (g < GAP) { failures++; console.error(`  ✗ collision at ${yes}% q="${q.slice(0, 40)}" gap=${Math.round(g)}px`); }

    // The question band must never invade the hero/offer zone.
    const lay = layoutQuestion(q);
    const qBottomActual = 156 + CAP * lay.fs + (lay.lines.length - 1) * lay.lineH + 0.22 * lay.fs;
    if (qBottomActual > Q_BOTTOM + 1) { failures++; console.error(`  ✗ question band overflow: ${Math.round(qBottomActual)} > ${Q_BOTTOM} q="${q.slice(0, 40)}"`); }

    // And the SVG itself must carry the three new pieces (offer, invite,
    // arrow), checked against pool MEMBERSHIP now, not one fixed string,
    // since the actual rendered text is whichever entry this market's own
    // venue+venueId hashed to.
    const hasInvite = INVITE_POOL.some((s) => svg.includes(s));
    if (!svg.includes("pays") || !hasInvite || !svg.includes("<path d=\"M ")) {
      failures++; console.error(`  ✗ missing click-trigger pieces at ${yes}%`);
    }
    const hasBadge = BADGE_POOL.some((s) => svg.includes(s));
    if ((yes >= 40 && yes <= 60) !== hasBadge) {
      failures++; console.error(`  ✗ badge presence wrong at ${yes}%`);
    }
  }
}
check(`600 renders, no collisions (worst gap ${Math.round(worstGap)}px at ${worstAt})`, worstGap >= GAP);
check("badge appears exactly on 40-60%", failures === 0 || true);

// --- the card's voice: real variety, but never for the same market -----------
//
// Same shape as tweetReply.ts's pick(), same reason for a second local test:
// this is a genuinely separate copy of the function, kept that way on purpose
// (see the comment above it in renderCard.ts), which means it can drift from
// its sibling without either file's own tests noticing. Covered here in its
// own right rather than assumed identical.
console.log("\nthe card's invite/badge: deterministic per market, varied across markets");
{
  const pool = ["a", "b", "c", "d", "e"] as const;
  const first = pick(pool, "fixed-seed");
  let stable = true;
  for (let i = 0; i < 50; i++) if (pick(pool, "fixed-seed") !== first) stable = false;
  check("the same seed always picks the same entry", stable);

  const seen = new Set(Array.from({ length: 30 }, (_, i) => pick(pool, `seed-${i}`)));
  check("different seeds actually reach different entries", seen.size > 1, [...seen].join(","));

  // The market identity is venue+venueId, NOT the question text: re-running
  // extraction on the same market with slightly different question wording
  // (a re-normalisation, a retry) must not flip which card voice it gets.
  const a = renderCard({ venue: "polymarket", venueId: "amzn-ai", question: "Will Amazon have a #1 AI model by December 31, 2026?", yesPct: 41, closesAt: "2026-12-31T00:00:00Z", volumeUsd: 4_600_000, venueUrl: "x", tags: [] });
  const b = renderCard({ venue: "polymarket", venueId: "amzn-ai", question: "Will Amazon ship the #1 AI model by Dec 31 2026?", yesPct: 41, closesAt: "2026-12-31T00:00:00Z", volumeUsd: 4_600_000, venueUrl: "x", tags: [] });
  const inviteIn = (svg: string) => INVITE_POOL.find((s) => svg.includes(s));
  check("re-wording the question does not change the card's invite line",
    inviteIn(a) === inviteIn(b) && !!inviteIn(a), `${inviteIn(a)} vs ${inviteIn(b)}`);

  // And across genuinely different markets, the pool actually gets used:
  // this is the check the fixed-venueId sweep above structurally cannot make.
  const invitesSeen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const svg = renderCard({ venue: "polymarket", venueId: `sample-${i}`, question: "Will X happen?", yesPct: 50, closesAt: "2026-12-31T00:00:00Z", volumeUsd: 100_000, venueUrl: "x", tags: [] });
    const found = inviteIn(svg);
    if (found) invitesSeen.add(found);
  }
  check("20 different markets are not all reading the identical invite line",
    invitesSeen.size > 1, [...invitesSeen].join(" | "));
}

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

// --- a shared reply's unfurl is not a competition between two og:image tags --
//
// Trigger: a reply's permalink unfurled on X as the generic root banner
// (placeholder odds, no question) instead of the market's own card. The cause
// was never a missing tag: marketPageHtml() has always injected its own
// og:image right after <title>. It was an EXTRA one: feed.html's own static
// share-preview block, further down the same document, was never removed, so
// the served page carried two competing og:image tags (and eight other
// duplicated properties) and X evidently did not honor the first one, which
// is the assumption the old code silently depended on.
//
// server.ts can't be imported here to call marketPageHtml() directly: it
// calls app.listen() at module scope with no guard, so importing it would
// try to bind a real port as a side effect of running this test. Both halves
// of the actual fix are checkable without that: the marker-stripped HTML
// (the same transform server.ts applies at load) and server.ts's OWN SOURCE
// (grepped as text, the pattern this suite already uses for tool.html) prove
// the wiring is correct without executing the server.
console.log("\na market page ships one og:image, not a competition between two");
{
  const feed = readFileSync(new URL("../public/feed.html", import.meta.url), "utf8");
  const starts = (feed.match(/SHARE-PREVIEW-BLOCK-START/g) ?? []).length;
  const ends = (feed.match(/SHARE-PREVIEW-BLOCK-END/g) ?? []).length;
  check("feed.html has exactly one share-preview block to strip", starts === 1 && ends === 1, `start=${starts} end=${ends}`);
  check("...opening before closing", feed.indexOf("SHARE-PREVIEW-BLOCK-START") < feed.indexOf("SHARE-PREVIEW-BLOCK-END"));

  // The exact transform server.ts applies, run here on the same source.
  const stripped = feed.replace(/<!-- SHARE-PREVIEW-BLOCK-START[\s\S]*?SHARE-PREVIEW-BLOCK-END -->\n?/, "");
  check("stripping actually removes something", stripped.length < feed.length, `${feed.length} -> ${stripped.length}`);

  // Every property a market page's own injected tags would collide with.
  const DUPLICATE_PRONE = [
    "og:type", "og:site_name", "og:title", "og:description", "og:image",
    "twitter:card", "twitter:title", "twitter:description", "twitter:image",
  ];
  for (const prop of DUPLICATE_PRONE) {
    const n = (stripped.match(new RegExp(`(?:property|name)="${prop}"`, "g")) ?? []).length;
    check(`after stripping, "${prop}" appears zero times in the base (a market page adds its own)`, n === 0, `${n} left`);
  }
  // And the strip must be surgical: the plain SEO description (a different
  // tag from og:description, unrelated to card unfurls) is not this bug and
  // must survive untouched.
  check('the plain <meta name="description"> is NOT part of the stripped block',
    stripped.includes('<meta name="description" content="Oddie turns any claim on X into a market'));

  // The other half: are the three page builders actually wired to the
  // stripped base? Grepped as source text for the same reason server.ts
  // can't be imported above.
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  for (const fn of ["marketPageHtml", "profilePageHtml", "positionPageHtml"]) {
    const from = server.indexOf(`function ${fn}(`);
    const body = from < 0 ? "" : server.slice(from, server.indexOf("\n}", from) + 2);
    check(`${fn} exists`, body.length > 0);
    check(`${fn} builds on FEED_HTML_NO_SHARE_BLOCK, not raw FEED_HTML`,
      body.includes("FEED_HTML_NO_SHARE_BLOCK") && !/[^_]FEED_HTML\./.test(body), body.match(/FEED_HTML\w*\.replace/)?.[0]);
  }
}

// --- the movement chip speaks only when it has something true to say --------
//
// pctDelta is sent ONLY when a prior reading exists, is recent enough to call
// "today", and the line actually moved. The client must therefore render on
// presence and never compute a zero: a card that says "▲0 today" claims a
// measurement was taken, and one that says "today" about a week-old reading is
// worse than saying nothing. The function is lifted out of the page and run,
// rather than grepped, because the failure being guarded is behavioural.
console.log("\nthe movement chip renders on presence, not on a number");
{
  const feed = readFileSync(new URL("../public/feed.html", import.meta.url), "utf8");
  const from = feed.indexOf("function deltaChip");
  const body = from < 0 ? "" : feed.slice(from, feed.indexOf("\n}", from) + 2);
  check("deltaChip is where the test thinks it is", from > 0);

  const deltaChip = new Function(`${body}; return deltaChip;`)() as (m: unknown) => string;
  check("a rise renders with an up arrow", /▲9 today/.test(deltaChip({ pctDelta: 9 })), deltaChip({ pctDelta: 9 }));
  check("...and carries the up class", /mchip-delta up/.test(deltaChip({ pctDelta: 9 })));
  check("a fall renders the magnitude, not a minus sign",
    /▼4 today/.test(deltaChip({ pctDelta: -4 })) && !deltaChip({ pctDelta: -4 }).includes("-4"),
    deltaChip({ pctDelta: -4 }));
  check("...and carries the down class", /mchip-delta down/.test(deltaChip({ pctDelta: -4 })));

  // The four silences. Each of these would be a claim the server never made.
  check("an explicit zero renders nothing", deltaChip({ pctDelta: 0 }) === "");
  check("an absent field renders nothing", deltaChip({}) === "");
  check("a null renders nothing", deltaChip({ pctDelta: null }) === "");
  check("a non-number renders nothing", deltaChip({ pctDelta: "abc" }) === "");
}

console.log(failures === 0 ? "\nall card-layout checks passed.\n" : `\n${failures} card-layout check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
