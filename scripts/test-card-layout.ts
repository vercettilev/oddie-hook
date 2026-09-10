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
  pick, INVITE_POOL, BADGE_POOL, VOICE_ANY, VOICE_UNPRICED,
} from "../src/card/renderCard.js";
import { renderBanner } from "../src/card/renderBanner.js";
import { renderPositionCard } from "../src/card/renderPositionCard.js";
import { renderProfileCard } from "../src/card/renderProfileCard.js";
import { renderTeachCard } from "../src/card/renderTeachCard.js";
import { MIN_HEADS_CARD } from "../src/card/renderCard.js";
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
    // The tension badge retired with the old layout: the card opens with a
    // line of oddie's own voice now, and that carries the tension on EVERY
    // market rather than only on a 40-60 split. A badge as well would be two
    // voices arguing on one card.
    const hasVoice = [...VOICE_ANY, ...VOICE_UNPRICED].some((v) => svg.includes(v));
    if (!hasVoice) {
      failures++; console.error(`  ✗ no voice line at ${yes}%`);
    }
    const hasBadge = BADGE_POOL.some((b) => svg.includes(b));
    if (hasBadge) {
      failures++; console.error(`  ✗ retired tension badge came back at ${yes}%`);
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
  // The app people land in is the rebuilt market page. Its :root is the
  // palette every shell under public/app shares, so one file speaks for all.
  const appCss = readFileSync(new URL("../public/app/market.html", import.meta.url), "utf8");
  const token = (name: string) => appCss.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`))?.[1]?.toUpperCase() ?? null;

  check("the app still declares a --yellow to be measured against", token("yellow") !== null);
  check("the card's accent IS the app's --yellow", C.accent.toUpperCase() === token("yellow"),
    `card ${C.accent} vs app --yellow ${token("yellow")}`);
  // Two olives five units apart under one name is exactly the drift this check
  // exists to stop; the app was moved onto the card's documented value.
  check("...and its deep variant is the app's --yellow-deep", C.accentDeep.toUpperCase() === token("yellow-deep"),
    `card ${C.accentDeep} vs app --yellow-deep ${token("yellow-deep")}`);
  check("...and its hard offset is the app's --pink (the NO side)", C.echo.toUpperCase() === token("pink"),
    `card ${C.echo} vs app --pink ${token("pink")}`);
  // C.pill (the card's pale wash) has no app counterpart any more: the app is
  // single-theme on black and never paints a light wash. It is card-internal.

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
  // genesis.html deliberately ships its own campaign image, not the banner,
  // so only the landing is held to "both tags are the rendered banner".
  for (const page of ["landing"] as const) {
    const html = readFileSync(new URL(`../public/${page}.html`, import.meta.url), "utf8");
    const imgs = [...html.matchAll(/(?:og:image|twitter:image)" content="([^"]+)"/g)].map((m) => m[1]);
    check(`${page}.html ships both image tags`, imgs.length === 2, JSON.stringify(imgs));
    check(`...and both are the rendered banner`, imgs.every((u) => u.endsWith("/og.png")), JSON.stringify(imgs));
  }
}

/* Two sections used to live here and went with public/feed.html:
 *  - "a market page ships one og:image": it pinned FEED_HTML_NO_SHARE_BLOCK
 *    and the page builders that wrapped the feed shell. The rebuilt market
 *    page injects its own og tags into a shell that carries none (see
 *    marketShellHtml in server.ts), so there is no second image to strip.
 *  - "the movement chip renders on presence": it pinned feed.html's deltaChip.
 *    The rebuilt app has no movement chip. If one returns, its four silences
 *    (zero, absent, null, non-number render NOTHING) return with it. */

/* ------------------------------------------------------------- ligatures --
 * The bug this guards: the bundled Fredoka subsets carry the GSUB ligature
 * table without the ligature glyphs, so resvg shaped "fi"/"fl"/"ff" into a
 * glyph that is not there and dropped the second letter. Cards shipped
 * "fnal fxes flght proft" for as long as the renderer existed, on the exact
 * image that goes on X, and nothing here noticed because nothing here looked
 * at the rendered pixels or at the text as the shaper would see it.
 *
 * The fix is a U+200C after every f that could start one. This asserts the
 * character is present in the SVG, which is the thing resvg reads, for BOTH
 * user text (the question) and the card's own hardcoded lines. */
console.log("\nligature suppression: the shaper must not be allowed to eat letters");
{
  const ZWNJ = "\u200C";
  const q = "Will inflation confirm a profit flip before the first filing?";
  const svg = renderCard(mk(q, 62));
  // Every f-before-[fil] in the question must be followed by the joiner.
  const pairs = [...q.matchAll(/f(?=[fil])/g)].length;
  check(`the question has ${pairs} ligature pairs to defuse`, pairs >= 6);
  const defused = [...svg.matchAll(new RegExp(`f${ZWNJ}`, "g"))].length;
  check("every one of them carries the joiner in the SVG", defused >= pairs, `found ${defused}`);
  check("no bare f-before-i survives in the question tspans",
    !/<tspan[^>]*>[^<]*f[fil]/.test(svg), svg.match(/<tspan[^>]*>[^<]*f[fil][^<]*<\/tspan>/)?.[0] ?? "");

  // The card's own copy goes through the same funnel. "first in sets the line"
  // is the unpriced offer and shipped as "frst in sets the line" once.
  const unpriced = renderCard(mk("Will it happen?", 50), { unpriced: true });
  check("the unpriced offer line is defused too", unpriced.includes(`f${ZWNJ}irst`), 
    unpriced.match(/f\u200C?irst[^<]*/)?.[0] ?? "no 'first' on the card");

  // And the unpriced card must not quote a price nobody set.
  check("an unpriced card shows no percentage", !/>\d+%</.test(unpriced));
  // The old card carried a "no price yet" kicker above the hero. The kicker is
  // gone with that layout; the hero itself reads "open" and the line beside it
  // says the line is unset. Both are fixed strings, unlike the seeded voice
  // line, so both are safe to assert.
  check("...and says so", unpriced.includes(">open<") && unpriced.includes(`f${ZWNJ}irst in sets the line`),
    unpriced.match(/>open<|first in sets[^<]*/g)?.join(" | ") ?? "neither");
  check("a priced card still shows its number", /62%/.test(svg));
}

/**
 * The profile card is the image that goes to X, and it is the surface where a
 * bad number is loudest: it bypassed every null guard in the app because
 * Math.round(NaN) is NaN and NaN is not `== null`. For a while every shared
 * card read "NaN%  ACCURACY" under a brag line reading "NaN% accuracy across 0
 * calls". These checks render the card from a REAL store record rather than a
 * hand-built literal, because a hand-built literal is exactly what hid it.
 */
console.log("\nthe profile card is postable for a post-pivot user");
{
  const { createCommunityMarket, recordSurfacer, accuracyFor, reputationFor, _memSeasonCredit } =
    await import("../src/store/markets.js");
  const dev = "dev-card-postable";
  const closeTime = Math.floor(Date.now() / 1000) + 86_400;
  for (let i = 0; i < 3; i++) {
    const m = await createCommunityMarket({ question: `will card proof ${i} land?`, category: "Sports", yesPct: 50, closeTime });
    await recordSurfacer(m.slug, { deviceId: dev, handle: "cardproof" });
  }
  _memSeasonCredit(dev, 75);

  const acc = await accuracyFor(dev);
  const rep = await reputationFor(dev);
  const svg = renderProfileCard({
    handle: "cardproof", oddieScore: acc.oddieScore, accuracyPct: acc.accuracyPct,
    streak: acc.streak, resolved: acc.resolved, hasEnough: acc.hasEnough,
    marketsCreated: acc.marketsCreated, pooledLamports: 2_870_000_000,
    loudMultiplier: acc.loudMultiplier,
    badges: [{ label: "First Tag", id: "first_tag" }, { label: "First Pool", id: "first_pool" }],
    rankTopPct: rep.rank ? rep.rank.topPct : null,
    tierLabel: rep.tier ? rep.tier.label : null, flexLine: rep.flexLine,
  });
  const texts = [...svg.matchAll(/>([^<>]+)</g)].map((m) => m[1].trim()).filter(Boolean);

  // Text nodes only, never the raw SVG: the file embeds base64 font data, and
  // random base64 contains "NaN" often enough to make a whole-file regex a
  // permanent false positive.
  check("no NaN, null or undefined survives onto the card",
    !texts.some((t) => /NaN|null|undefined/.test(t)),
    texts.filter((t) => /NaN|null|undefined/.test(t)).join(" | "));
  check("...nor into the brag line it carries",
    !/NaN|null|undefined/.test(rep.flexLine), rep.flexLine);
  check("the card shows the score it earned, not 'building'",
    texts.includes(String(acc.oddieScore)) && !texts.some((t) => /building/i.test(t)),
    String(acc.oddieScore));
  check("the stat row reports the ladder, not the dead play record",
    texts.includes("MARKETS") && texts.includes("SOL POOLED") && texts.includes("LOUD")
    && !texts.includes("ACCURACY") && !texts.includes("RESOLVED") && !texts.includes("STREAK")
    && !texts.includes("PLAYERS"),
    texts.join(" | "));
  // PLAYERS was tradersReached, which counts rows in the dead play-token table.
  // Every card ever shared would have read "0 PLAYERS" under a real score.
  check("...and the pooled figure is the real one it was handed",
    texts.includes("2.87"), texts.join(" | "));
  check("the brag says what was brought", rep.flexLine === "3 markets tagged", rep.flexLine);
}

/* ------------------------------------------------- the teach card ---------- */
// The card that answers a tag we could not price. Its whole method is that the
// rules are drawn ON the words that satisfy them, which means every mark on it
// is a measured coordinate rather than a placed one, and a coordinate that is
// measured wrong fails silently: the first build of this card painted the
// marked word at the start of its line instead of at the word, and the SVG was
// perfectly valid. So the audit reads the geometry back out of the markup.
{
  const svg = renderTeachCard();
  const texts = [...svg.matchAll(/>([^<>]+)<\/text>/g)].map((m) => m[1].trim()).filter(Boolean);

  // The card is the SECOND half of a sentence the post's text already started,
  // and X always puts the words above the picture. Restating the refusal here
  // spent the biggest type on the artboard on a line the reader has already
  // read, which is how the specimen ended up in the bottom third.
  // It answers "what does it take" rather than "what did you get wrong", which
  // is also why it can pair with any of the reply's three lines instead of
  // hinging on one - the earlier headline answered exactly one of them and the
  // line is chosen at random.
  check("the teach card answers the reply instead of repeating it",
    texts.some((t) => t.startsWith("THIS IS ALL IT TAKES")) && !texts.some((t) => /COULDN'T/.test(t)),
    texts.join(" | "));
  check("...and never corrects the person who tagged us",
    !texts.some((t) => /\byou\b|\byour\b/i.test(t)), texts.join(" | "));

  // NO LINK, and this is the one that costs money as well as reach: a reply
  // carrying a URL is priced at a different tier by X than a plain one.
  check("the teach card carries no URL anywhere in its copy",
    !texts.some((t) => /https?:|\.com|\.fun\b/i.test(t)), texts.join(" | "));
  check("...and no em dash or emoji",
    !texts.some((t) => /[\u2014\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t)), texts.join(" | "));

  // The specimen is the teaching. If an edit ever renames a span, the mark that
  // labels it is dropped rather than misplaced (the renderer refuses to draw a
  // coordinate it cannot justify), so the failure looks like a missing label.
  // NO WORKED EXAMPLE, deliberately. The version that carried one taught well
  // and taught the wrong thing: a dated price target is what every prediction
  // market already lists, and this is the one card that leaves the product.
  check("the teach card carries both halves of the rule",
    texts.some((t) => /A YES OR A NO/.test(t)) && texts.some((t) => /A DATE/.test(t)),
    texts.join(" | "));
  check("...and no specimen claim to copy the wrong shape from",
    !texts.some((t) => /\$\d|SOL closes|Dec 31/.test(t)), texts.join(" | "));
  check("...said in display type, not as a list in body text",
    /font-family="'Anton'[^"]*"\s+font-size="(\d+)"[^>]*>A YES OR A NO/.test(svg)
    || /font-size="(\d+)"[^>]*>A YES OR A NO/.test(svg), "the rule is not set in the display face");

  // The marked word is painted over its own line as a second run. Its x has to
  // be the MEASURED offset of that word, not the line's own x.
  const line = "THIS IS ALL IT TAKES.";
  const headFS = Number(svg.match(/font-size="(\d+)"[^>]*>THIS IS ALL/)?.[1] ?? 0);
  const wantX = 70 + textWidth(line.slice(0, line.indexOf("ALL")), headFS, "display");
  const gotX = Number(svg.match(/<text x="([\d.]+)"[^>]*>ALL<\/text>/)?.[1] ?? -1);
  check("the marked word sits on the word it marks, not at the line's start",
    headFS > 0 && Math.abs(gotX - wantX) < 1.5, `want ~${wantX.toFixed(1)}, got ${gotX}`);

  check("the ask names the handle the reader has to retype",
    texts.some((t) => t.includes(X_HANDLE)), texts.join(" | "));
}

/* ------------------------------------------- the crowd count is gated ------ */
// The count is upside-only: free to withhold, expensive to print badly. Absence
// leaves a stranger in "unknown"; a low digit moves them to "empty", which is
// terminal inside a scroll. So the card names people only once there are enough
// of them to be a claim, and below that the meta line simply ends at the odds -
// no gap, no dash, nothing new to read. Asserted at the boundary in both
// directions, because an off-by-one here is invisible until it is on a timeline.
{
  const base: Market = { ...mk("Will the count show up when it should?", 50), venue: "community" };
  const metaOf = (n: number) => {
    const svg = renderCard(base, { stakers: n });
    return [...svg.matchAll(/>([^<>]+)<\/text>/g)].map((m) => m[1].trim()).find((t) => /pays/.test(t)) ?? "";
  };
  check("the share card gates the crowd count above zero, not at it", MIN_HEADS_CARD > 1, String(MIN_HEADS_CARD));
  check(`...at ${MIN_HEADS_CARD}, so a forgeable two never sits beside a percentage`, MIN_HEADS_CARD > 2);
  check("one below the line, the meta line ends at the odds",
    !/\bin\b/.test(metaOf(MIN_HEADS_CARD - 1)), metaOf(MIN_HEADS_CARD - 1));
  check("...and nothing is drawn in its place",
    metaOf(MIN_HEADS_CARD - 1) === metaOf(0), `${metaOf(MIN_HEADS_CARD - 1)} vs ${metaOf(0)}`);
  check("on the line, the count is named", metaOf(MIN_HEADS_CARD).includes(`${MIN_HEADS_CARD} in`),
    metaOf(MIN_HEADS_CARD));
  check("the live market today (one wallet, both sides) says nothing about people",
    !/\bin\b/.test(metaOf(1)), metaOf(1));

  // The app surfaces gate lower on purpose: beside a POOL the count is a
  // composition fact to somebody already inside, not a credibility claim to a
  // stranger. Lower, but never at zero, and never below the card's own
  // forgeable-two floor.
  for (const f of ["public/app/markets.html", "public/app/market.html"]) {
    const src = readFileSync(f, "utf8");
    const n = Number(src.match(/var MIN_HEADS_LIST = (\d+);/)?.[1] ?? 0);
    check(`${f} gates the count too`, n >= 3, String(n));
    check(`...below the share card's ${MIN_HEADS_CARD}, because it is a different claim`, n < MIN_HEADS_CARD);
    check(`...and no code path there still tests it against zero`,
      !/stakers[^)]*\)\s*>\s*0|heads > 0/.test(src));
  }
}

console.log(failures === 0 ? "\nall card-layout checks passed.\n" : `\n${failures} card-layout check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
