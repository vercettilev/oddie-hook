import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { getMarketData } from "./venues/index.js";
import type { Market } from "./venues/types.js";
import { nearTwins } from "./matching/matcher.js";
import { matchSemantic, matchVenue, replyCopy, semanticEnabled, SEMANTIC_KEY_ENV } from "./matching/semantic.js";
import { categorize, categorizeText, CATEGORIES } from "./matching/categorize.js";
import { createSlug, getSlug, placeCall, getWallet, positionsFor, sellPosition, leaderboard, recordEvent, slugFor, EVENT_NAMES, ensureHandle, setHandle, noticesFor, settleMarket, openSlugs, resolveDevice, crowdSplits, mintShareToken, getShareCall, accuracyFor, claimStatus, claimDaily, categoryHistoryFor, communityPlayerCounts, MARKET_FORMING_MIN, logPageView, metricsSummary, deviceForHandle, resolvedCallsFor, badgesFor, seasonRankFor, surfacersFor, SEASON_POINTS, callersFor, recentlySettled, homeActivity, celebrationsFor, markCelebrationsSeen, notifyClosingSoon, openCallsSummaryFor, weeklyScoreDeltaFor, rankMovementFor, isNewUserFor, claimTagTeachingMoment } from "./store/markets.js";
import { fetchResolution } from "./venues/resolution.js";
import { emailsFor, mentionCandidates, markMentioned, mintShareTokenForMention, gateFor, addToAllowlist, allowlistRows, streakFor, leaderboardStreaks, leaderboardWinnings } from "./store/markets.js";
import { createCommunityMarket, setCommunityOnchain, openCommunityMarkets, adminListCommunity, communityMarketDetail, markCommunityResolved, logExtraction, logTweetReply, listTweetReplies, type CommunityMarket } from "./store/markets.js";
import { recordSurfacer, awardSurface, seasonPointsLog, usersActivity } from "./store/markets.js";
import { setFeaturedMarkets, getFeaturedSlugs } from "./store/markets.js";
import { runExtract, extractEnabled, EXTRACT_KEY_ENV } from "./matching/extractClaim.js";
import { buildTweetReply, buildTweetQuote } from "./matching/tweetReply.js";
import { proceedsFor } from "./store/economy.js";
import { mintMarket, isChainEnabled, onchainEnabled, explorerUrl, adminAddress, adminBalanceSol } from "./chain/oddieChain.js";
import { sendSettleMail, sendMail, mailEnabled, MAIL_KEY_ENV } from "./mail.js";
import { TAGLINE } from "./brand.js";
import { renderCard } from "./card/renderCard.js";
import { renderCardPng } from "./card/renderPng.js";
import { renderProfileCard } from "./card/renderProfileCard.js";
import { renderPositionCard } from "./card/renderPositionCard.js";
import { tweetCopy } from "./card/tweetCopy.js";
import { linkAccount, accountsFor } from "./store/accounts.js";
import { authorizeUrl, consume, identify, isConfigured, isProvider, missingSecretEnv, pkce, PROVIDERS, redirectUri, remember } from "./auth/oauth.js";

const app = express();
app.use(express.json());

const BASE_URL = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FEED_HTML = readFileSync(path.join(__dirname, "../public/feed.html"), "utf8");
const TOOL_HTML = readFileSync(path.join(__dirname, "../public/tool.html"), "utf8");

// Static assets — favicons, touch/PWA icons, the manifest, the raw logos. The two
// HTML documents keep their own routes (/feed, /tool), and /card, /market are
// dynamic, so this only ever answers for real files. oddie.fun points straight at
// this service, so these are served here from ./public — one origin, no proxy
// allow-list to keep in sync, so the whole /api/ev class of rewrite gaps is gone.
app.use(express.static(path.join(__dirname, "../public"), { index: false, maxAge: "7d" }));

// The homepage. Positioning-first: it sells the chain (claim -> tag -> call ->
// opponent -> resolution -> receipt -> reputation), not a market catalog. Same
// SPA shell as /feed (deviceId, theme boot, header, nav, daily-claim strip all
// come along for free) — the client renders a "home" view instead of loading
// the feed when the path is bare "/". /feed is unchanged: a real destination,
// not the default.
app.get("/", (_req, res) => res.type("html").send(FEED_HTML));

/**
 * The hook. Tweet text in -> best market, slug, card URL, landing URL out.
 *
 * On a miss we hand back a feed invite rather than the runner-up market. An
 * adjacent market is not a weaker version of the right answer — its odds
 * price a different question, so posting it reads as the bot asserting the
 * opposite of the take it was tagged under. "Here's what's trending" is the
 * only honest thing we can say when nothing fits. The bot layer does the
 * posting; this just returns the pieces.
 *
 * `matched: false` means we looked at a real market set and nothing fit. It
 * never means we couldn't look. When the venues are down we return 503 with
 * no `matched` field and — deliberately — no `feedUrl`: the feed invite is
 * the honest reply to a genuine miss, and there is nothing honest about it
 * when the reason is that we have no data. Withholding feedUrl makes posting
 * one structurally impossible rather than merely discouraged.
 */
app.post("/hook", async (req, res) => {
  const tweetText: string = req.body?.tweetText ?? "";
  if (!tweetText.trim()) return res.status(400).json({ error: "tweetText required" });

  const data = await getMarketData();

  // One line per call, so the Week-1 matched:false rate can be segmented by which
  // venues were actually healthy at the time. A miss recorded while a venue was
  // serving nothing says something about the venue, not about the matcher.
  const venueCounts = { kalshi: data.venues.kalshi.count, polymarket: data.venues.polymarket.count };

  // Keyed on the raw set, not the bettable one. "Every market is lopsided today"
  // is a confident miss; "we have no markets" is an outage. They are not the same
  // answer and the Week-1 numbers must not conflate them.
  if (data.all.length === 0) {
    console.log(JSON.stringify({ evt: "hook", matched: null, reason: "data_unavailable", venues: venueCounts, stale: data.stale }));
    return res.status(503).json({ error: "data_unavailable", venues: data.venues });
  }

  const match = await matchSemantic(tweetText, data.markets);
  console.log(
    JSON.stringify({
      evt: "hook",
      // "lexical" | "semantic" | false — Week-1 data segments on what the LLM adds.
      matched: match ? match.via : false,
      score: match ? Number(match.score.toFixed(3)) : null,
      venue: match?.market.venue ?? null,
      // The audit trail: the referee's one-liner, and the language people
      // actually used (its absence is why the first six real tweets are gone).
      why: match?.reason ?? null,
      tweet: tweetText.slice(0, 140),
      semantic: semanticEnabled(),
      venues: venueCounts,
      bettable: data.markets.length,
      fetched: data.all.length,
      stale: data.stale,
    }),
  );

  if (!match) {
    const cat = categorizeText(tweetText);
    const scoped = cat !== "Other"; // "Other" would scope the feed to leftovers, not to the topic
    return res.json({
      matched: false,
      reason: "no confident market",
      category: scoped ? cat : null,
      feedUrl: scoped ? `${BASE_URL}/feed?cat=${encodeURIComponent(cat)}` : `${BASE_URL}/feed`,
      stale: data.stale,
    });
  }

  const rec = await createSlug(match.market);
  // Markets the matcher literally cannot distinguish from this one (same tokens
  // after the <3-char drop: July 7 vs July 10). The pick among them was made by
  // volume, not by the tweet. Surfaced so /tool can warn the operator before a
  // card goes out by hand. See NOTES/known-gaps.md.
  const twins = nearTwins(match.market, data.markets);
  return res.json({
    matched: true,
    via: match.via,
    why: match.reason,
    score: Number(match.score.toFixed(3)),
    slug: rec.slug,
    landingUrl: `${BASE_URL}/market/${rec.slug}`,
    cardUrl: `${BASE_URL}/card/${rec.slug}.svg`,
    market: rec.market,
    nearTwins: twins.map((m) => m.question),
    // Instant, deterministic lines so /tool always has SOMETHING to copy. The
    // thread-aware reply lines are LLM work and load separately (/api/replycopy)
    // so ten threads in a row never wait 6s each on the match response.
    tweetCopy: tweetCopy(rec.market),
    copySource: "template",
    stale: data.stale,
  });
});

/**
 * Thread-aware reply lines, as their own round trip. /tool renders the match
 * immediately with template copy, then upgrades to these when they land.
 * Null tweetCopy = the model was off or its lines failed validation; the
 * caller keeps the templates and says so.
 */
app.post("/api/replycopy", async (req, res) => {
  const { tweetText, slug } = req.body as { tweetText?: string; slug?: string };
  if (!tweetText?.trim() || !slug) return res.status(400).json({ error: "tweetText and slug required" });
  const { all } = await getMarketData();
  const rec = await getSlug(slug, all);
  if (!rec) return res.status(404).json({ error: "unknown market" });
  const lines = await replyCopy(tweetText, rec.market);
  res.json(lines ? { tweetCopy: lines, copySource: "reply" } : { tweetCopy: null, copySource: "template" });
});

/**
 * THE PAGE. oddie.fun/market/[slug] serves the feed, positioned so the
 * tagged market is the top card. The slug is the door into the feed.
 *
 * Crawlers (X, WhatsApp, iMessage, Slack) don't run the SPA's JS, so the share
 * preview has to live in the HTML they fetch. We look the market up and inject
 * per-slug Open Graph tags whose og:image is the PNG card. A miss just serves
 * the plain shell — the feed still opens, it simply has no rich preview.
 */
const ogEsc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function moneyShort(n: number): string {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

function marketPageHtml(rec: { market: { question: string; yesPct: number; volumeUsd: number; venue?: string } }, slug: string, forming?: { positions: number } | null): string {
  const m = rec.market;
  const yes = Math.max(0, Math.min(100, Math.round(m.yesPct)));
  const title = m.question;
  // Community markets speak "% yes", never venue volume ("$0 in play" would be
  // venue framing on a community share); venue markets keep their liquidity line.
  // A market still FORMING has no meaningful %, so it shows the call count.
  const desc = m.venue === "community"
    ? (forming
        ? `market forming — ${forming.positions} ${forming.positions === 1 ? "call" : "calls"} so far`
        : `call it — ${yes}% yes right now`)
    : `call it — ${yes}% yes · ${moneyShort(m.volumeUsd)} in play`;
  const img = `${BASE_URL}/card/${slug}.png`;
  const url = `${BASE_URL}/m/${slug}`; // canonical: the short permalink
  const tags = [
    `<link rel="canonical" href="${ogEsc(url)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="oddie">`,
    `<meta property="og:title" content="${ogEsc(title)}">`,
    `<meta property="og:description" content="${ogEsc(desc)}">`,
    `<meta property="og:url" content="${ogEsc(url)}">`,
    `<meta property="og:image" content="${ogEsc(img)}">`,
    `<meta property="og:image:type" content="image/png">`,
    `<meta property="og:image:width" content="2000">`,
    `<meta property="og:image:height" content="1048">`,
    `<meta property="og:image:alt" content="${ogEsc(title)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${ogEsc(title)}">`,
    `<meta name="twitter:description" content="${ogEsc(desc)}">`,
    `<meta name="twitter:image" content="${ogEsc(img)}">`,
  ].join("\n");
  return FEED_HTML.replace("<title>oddie</title>", `<title>${ogEsc(title)} · oddie</title>\n${tags}`);
}

// The market permalink — every market's canonical landing page. /m/{slug} is
// the short share path; /market/{slug} (already in the wild) serves the same.
app.get(["/m/:slug", "/market/:slug"], async (req, res) => {
  const { all } = await getMarketData();
  const rec = await getSlug(req.params.slug, all).catch(() => null);
  // ?pc=<token>: a PERSONAL share. The unfurl shows their call, not the generic
  // market — that's the whole reason their followers react. Falls back to the
  // market og on any mismatch, so a stale token still lands on a working page.
  const pc = typeof req.query.pc === "string" ? req.query.pc : null;
  if (rec && pc) {
    const share = await getShareCall(pc).catch(() => null);
    if (share && share.slug === req.params.slug) {
      return res.type("html").send(positionPageHtml(rec, req.params.slug, share));
    }
  }
  // For a community market, the og line reflects the forming state (call count
  // until the market has formed, then the %).
  let forming: { positions: number } | null = null;
  if (rec && rec.market.venue === "community") {
    const n = (await communityPlayerCounts([req.params.slug]).catch(() => ({} as Record<string, number>)))[req.params.slug] ?? 0;
    if (n < MARKET_FORMING_MIN) forming = { positions: n };
  }
  res.type("html").send(rec ? marketPageHtml(rec, req.params.slug, forming) : FEED_HTML);
});

// Public profile page — the reputation/share loop's real destination. Serves the
// SPA shell with per-handle og tags (image = the profile card), so a shared
// /@{handle} link unfurls on X showing the Oddie Score. Fully viewable logged
// out; the SPA renders the public view from /api/profile/{handle}.
function profilePageHtml(handle: string, acc: { oddieScore: number | null; accuracyPct: number | null; streak: number; resolved: number; hasEnough: boolean }): string {
  const title = `@${handle} on oddie`;
  const desc = acc.hasEnough
    ? `Oddie Score ${acc.oddieScore} · ${acc.accuracyPct}% accuracy · ${acc.resolved} resolved picks`
    : `building a track record — ${acc.resolved} resolved picks so far`;
  const img = `${BASE_URL}/card/u/${encodeURIComponent(handle)}.png`;
  const url = `${BASE_URL}/@${handle}`;
  const tags = [
    `<link rel="canonical" href="${ogEsc(url)}">`,
    `<meta property="og:type" content="profile">`,
    `<meta property="og:site_name" content="oddie">`,
    `<meta property="og:title" content="${ogEsc(title)}">`,
    `<meta property="og:description" content="${ogEsc(desc)}">`,
    `<meta property="og:url" content="${ogEsc(url)}">`,
    `<meta property="og:image" content="${ogEsc(img)}">`,
    `<meta property="og:image:type" content="image/png">`,
    `<meta property="og:image:width" content="2000">`,
    `<meta property="og:image:height" content="1048">`,
    `<meta property="og:image:alt" content="${ogEsc(title)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${ogEsc(title)}">`,
    `<meta name="twitter:description" content="${ogEsc(desc)}">`,
    `<meta name="twitter:image" content="${ogEsc(img)}">`,
  ].join("\n");
  return FEED_HTML.replace("<title>oddie</title>", `<title>${ogEsc(title)} · oddie</title>\n${tags}`);
}

app.get("/@:handle", async (req, res) => {
  const handle = String(req.params.handle).replace(/^@+/, "");
  const deviceId = await deviceForHandle(handle).catch(() => null);
  // Unknown handle: still serve the SPA (it shows a "no such profile" state).
  if (!deviceId) return res.type("html").send(FEED_HTML);
  const [acc, hd] = await Promise.all([accuracyFor(deviceId), displayHandle(deviceId)]);
  res.type("html").send(profilePageHtml(hd.handle, acc));
});

// Public profile data (no auth — anyone can view anyone's record).
app.get("/api/profile/:handle", async (req, res) => {
  const handle = String(req.params.handle).replace(/^@+/, "");
  const deviceId = await deviceForHandle(handle).catch(() => null);
  if (!deviceId) return res.status(404).json({ exists: false });
  const [acc, recentCalls, hd, rank, weeklyDelta] = await Promise.all([accuracyFor(deviceId), resolvedCallsFor(deviceId, 20), displayHandle(deviceId), seasonRankFor(deviceId), weeklyScoreDeltaFor(deviceId)]);
  const badges = await badgesFor(deviceId, acc);
  res.json({ exists: true, handle: hd.handle, accuracy: { ...acc, weeklyDelta }, recentCalls, badges, rank });
});

function positionPageHtml(rec: { market: { question: string; yesPct: number; volumeUsd: number } }, slug: string, share: { token: string; handle: string; side: string; entryPct: number; resolved: string | null }): string {
  const title = `@${share.handle} called ${share.side.toUpperCase()} at ${share.entryPct}%`;
  const won = share.resolved === share.side;
  const desc = share.resolved && share.resolved !== "sold"
    ? `resolved ${share.resolved.toUpperCase()} ${won ? "— called it" : ""} · ${rec.market.question}`
    : `${rec.market.question} · market says ${Math.round(rec.market.yesPct)}% yes`;
  const img = `${BASE_URL}/card/pc/${share.token}.png`;
  const url = `${BASE_URL}/market/${slug}?pc=${share.token}`;
  const tags = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="oddie">`,
    `<meta property="og:title" content="${ogEsc(title)}">`,
    `<meta property="og:description" content="${ogEsc(desc)}">`,
    `<meta property="og:url" content="${ogEsc(url)}">`,
    `<meta property="og:image" content="${ogEsc(img)}">`,
    `<meta property="og:image:type" content="image/png">`,
    `<meta property="og:image:width" content="2000">`,
    `<meta property="og:image:height" content="1048">`,
    `<meta property="og:image:alt" content="${ogEsc(title)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${ogEsc(title)}">`,
    `<meta name="twitter:description" content="${ogEsc(desc)}">`,
    `<meta name="twitter:image" content="${ogEsc(img)}">`,
  ].join("\n");
  return FEED_HTML.replace("<title>oddie</title>", `<title>${ogEsc(title)} · oddie</title>\n${tags}`);
}
app.get("/feed", (_req, res) => {
  res.type("html").send(FEED_HTML); // feed without a start market also works
});

/**
 * Feed data: start market first (if given), then same category, then the
 * rest by volume. Optional ?cat= filters to one category (chips).
 */
// How many past picks a device needs before its history overrides the cold
// default. Below this, one or two picks is noise, not a taste.
const FEED_HISTORY_MIN = 3;

/**
 * Re-rank venue cards toward a device's most-played categories, while injecting
 * up to two markets from OTHER categories into the head — engagement bias, not
 * a filter bubble. Leads with the top category, drops an "other" at positions 2
 * and 5, then fills the rest (top category, then the remaining others).
 */
function personalizeByHistory<T extends { cat: string; m: { volumeUsd: number } }>(list: T[], weight: Map<string, number>): T[] {
  const w = (c: string) => weight.get(c) ?? 0;
  const sorted = [...list].sort((a, b) => w(b.cat) - w(a.cat) || b.m.volumeUsd - a.m.volumeUsd);
  const topCat = sorted[0]?.cat ?? null;
  if (topCat === null) return sorted;
  const top = sorted.filter((e) => e.cat === topCat);
  const others = sorted.filter((e) => e.cat !== topCat);
  if (!top.length || !others.length) return sorted; // only one category present — nothing to interleave
  const inject = new Set([1, 4]); // 0-indexed head positions for an "other" card
  const out: T[] = [];
  let ti = 0, oi = 0, injected = 0;
  for (let i = 0; out.length < sorted.length; i++) {
    if (inject.has(i) && injected < 2 && oi < others.length) { out.push(others[oi++]); injected++; }
    else if (ti < top.length) out.push(top[ti++]);
    else if (oi < others.length) out.push(others[oi++]);
    else break;
  }
  return out;
}

app.get("/api/feed", async (req, res) => {
  const startSlug = String(req.query.start ?? "");
  const cat = String(req.query.cat ?? "");
  // Personalization: 1-3 picked categories rank FIRST (not filter — breadth
  // stays visible), each block still volume-sorted.
  const cats = String(req.query.cats ?? "").split(",").map((x) => x.trim()).filter((x) => (CATEGORIES as readonly string[]).includes(x)).slice(0, 3);
  const feedDevice = typeof req.query.deviceId === "string" && DEVICE_ID.test(req.query.deviceId) ? req.query.deviceId : null;
  const data = await getMarketData();

  // The feed is where a miss sends people. Serving it empty would turn a venue
  // outage into a landing page that looks like we simply have no markets.
  if (data.all.length === 0) {
    return res.status(503).json({ error: "data_unavailable", venues: data.venues });
  }

  // Cards come from the CURATED set: bettable, and in one of the five chips. The
  // matcher's universe is wider (`data.markets`) and deliberately not scrollable
  // — a WTI crude market is a fine answer to a WTI take and a bad card to land on
  // while swiping. The start slug resolves against the raw set, so a market that
  // drifted to 98% still opens its own page.
  const enriched = data.feed.map((m) => ({ m, cat: categorize(m) }));
  let list = cat && cat !== "For you" ? enriched.filter((e) => e.cat === cat) : enriched;

  const start = startSlug ? await getSlug(startSlug, data.all) : undefined;
  const startCat = start ? categorize(start.market) : null;

  list = [...list].sort((a, b) => {
    if (startCat) {
      const ac = a.cat === startCat ? 0 : 1;
      const bc = b.cat === startCat ? 0 : 1;
      if (ac !== bc) return ac - bc; // same category as the door first
    }
    return b.m.volumeUsd - a.m.volumeUsd; // then trending by volume
  });

  // Derive, don't write. Slugs are deterministic, so a feed card is shareable
  // without minting a row; the row appears if and when someone opens it.
  if (cats.length) {
    list = [...list].sort((a, b) => {
      const ai = cats.includes(a.cat) ? 0 : 1, bi = cats.includes(b.cat) ? 0 : 1;
      if (ai !== bi) return ai - bi;
      return b.m.volumeUsd - a.m.volumeUsd;
    });
  }

  // Ranking signal for the default "For you" feed: explicit picks > play history
  // > cold default. History bias applies only to a device with a real track of
  // play; a cold/anonymous visitor (no history) keeps the broad-appeal default.
  // Logged either way so the choice can be sanity-checked later.
  let rankSignal: "picked" | "history" | "cold" = cats.length ? "picked" : "cold";
  if (!cats.length && (!cat || cat === "For you") && !start && feedDevice) {
    const hist = await categoryHistoryFor(feedDevice).catch(() => [] as { category: string; count: number }[]);
    const total = hist.reduce((a, h) => a + h.count, 0);
    if (total >= FEED_HISTORY_MIN) {
      list = personalizeByHistory(list, new Map(hist.map((h) => [h.category, h.count])));
      rankSignal = "history";
      console.log(JSON.stringify({ evt: "feed_rank", signal: "history", device: feedDevice.slice(0, 8), picks: total, top: hist.slice(0, 3) }));
    }
  }
  if (rankSignal !== "history") {
    console.log(JSON.stringify({ evt: "feed_rank", signal: rankSignal, device: feedDevice ? feedDevice.slice(0, 8) : null }));
  }

  const items = list.slice(0, 40).map((e) => ({ slug: slugFor(e.m), category: e.cat, ...e.m }));

  // Community markets are the product, but they are NOT the right first thing a
  // cold, organic visitor sees: a niche insider question with zero context is a
  // bad front door. So placement is source-aware (see feedItems below). The
  // on-chain badge is emitted only while ONCHAIN_ENABLED is on (stored pubkeys
  // stay in the DB either way).
  let community: CommunityMarket[] = [];
  try { community = await openCommunityMarkets(); }
  catch (e) { console.error("[community] feed load failed (serving venue markets only):", (e as Error).message); }
  // "Market forming": below MARKET_FORMING_MIN distinct players a % is skewable
  // noise, so we show the call count instead until the market has formed.
  const playerCounts = await communityPlayerCounts(community.map((m) => slugFor(m))).catch(() => ({} as Record<string, number>));
  const communityItems = community.map((m) => {
    const slug = slugFor(m);
    const positions = playerCounts[slug] ?? 0;
    return {
      ...m,
      slug, category: "Community",
      // The market's own topical pick (Sports/Crypto/…), preserved under a
      // separate field since `category` above is deliberately flattened to
      // the single "Community" chip — the client groups the feed's community
      // cluster by this instead, so a football claim and a crypto claim don't
      // render back-to-back with no distinction.
      topicCategory: m.category,
      community: true as const,
      positions,
      forming: positions < MARKET_FORMING_MIN,
      formingMin: MARKET_FORMING_MIN,
      onchain: onchainEnabled() && m.onchainPubkey ? explorerUrl(m.onchainPubkey) : null,
    };
  });

  let feedItems: Array<Record<string, unknown> & { slug: string }> = items;
  if (cat === "Community") {
    // The Community tab is Community markets' correct home — they rank normally here.
    feedItems = communityItems;
  } else if (!cat || cat === "For you") {
    // Source-aware ordering for the default feed:
    //  - permalink landing (start set): UNCHANGED — community-first, and the
    //    shared market is pinned above it anyway (that market IS the context).
    //  - cold/organic visit (no start): broad-appeal venue markets lead; community
    //    still appears, just not auto-ranked to the top with no context to frame it.
    feedItems = start ? [...communityItems, ...items] : [...items, ...communityItems];
  }

  // A start slug (a /m/ permalink landing) pins ITS market to the very top —
  // above even the community block: the shared market is the page's headline,
  // the rest of the feed is "related" below it.
  if (start) {
    const i = feedItems.findIndex((x) => x.slug === start.slug);
    if (i > 0) feedItems.unshift(feedItems.splice(i, 1)[0]);
    else if (i === -1) {
      // Not in the live set (drifted odds, or a resolved community market): the
      // permalink still opens. Community rows keep community framing either way.
      const isCommunity = start.market.venue === "community";
      feedItems.unshift({
        slug: start.slug,
        category: isCommunity ? "Community" : categorize(start.market),
        ...(isCommunity ? { community: true as const, onchain: null } : {}),
        ...start.market,
      });
    }
  }

  // "Other" is the categorizer's shrug, and `inFeed` filters it out of the feed
  // by definition — so shipping it as a chip offers a tab that can never hold a
  // card. It was harmless while every market landed in a real category; widening
  // the fetch to all tags made it a promise the feed cannot keep.
  // The social layer, read from the same rows every screen reads: what the
  // POPPERS said, alongside what the market prices. One query for the page.
  const crowd = await crowdSplits(feedItems.map((x) => x.slug));
  // The surfacer handle + source tweet per market — the party a "challenge the
  // other side" reply is aimed at, and the permalink's source-tweet card. One
  // query for the whole feed; null where a market has no source.
  const surfacers = await surfacersFor(feedItems.map((x) => x.slug)).catch(
    () => ({} as Record<string, { handle: string | null; sourceUrl: string | null }>),
  );
  // "Who called what" is permalink-only: fetching it for every card in the feed
  // would be an N+1 query across a whole page, so it's scoped to just the
  // pinned start market.
  const callers = start ? await callersFor(start.slug, 20).catch(() => null) : null;
  const withCrowd = feedItems.map((x) => {
    const surfacer = surfacers[x.slug];
    const extra: Record<string, unknown> = {
      ...x,
      crowd: crowd[x.slug] ?? { yes: 0, no: 0 },
      challengeHandle: surfacer?.handle ?? null,
      sourceUrl: surfacer?.sourceUrl ?? null,
    };
    if (callers && start && x.slug === start.slug) {
      extra.callers = callers.callers;
      extra.callersTotal = callers.total;
    }
    return extra;
  });

  const chips: string[] = CATEGORIES.filter((c) => c !== "Other");
  if (community.length) chips.push("Community");
  res.json({ categories: ["For you", ...chips], items: withCrowd });
});

/**
 * The homepage's "Live right now" slots (up to `n`). Resolution order:
 *   1. the admin's explicit picks (/tool), in the order they were featured,
 *      each IF it's still an open community market
 *   2. topped up with the most recent open community markets WITH at least
 *      one position, not already picked
 *   3. topped up further with the most recent open community markets at all
 *      (never leave a slot empty just because a fresh market has zero
 *      positions yet)
 * Independent of venue data on purpose — the featured slots are community
 * markets by design, and the home page must render even if venue APIs are down.
 */
async function resolveFeatured(n = 4): Promise<Array<Record<string, unknown> & { slug: string }>> {
  let community: CommunityMarket[] = [];
  try { community = await openCommunityMarkets(); }
  catch (e) { console.error("[home] community load failed:", (e as Error).message); }
  if (!community.length) return [];

  const sorted = [...community].sort((a, b) => b.marketId - a.marketId); // most recent first
  const slugs = sorted.map((m) => slugFor(m));
  const playerCounts = await communityPlayerCounts(slugs).catch(() => ({} as Record<string, number>));

  const explicitSlugs = await getFeaturedSlugs().catch(() => [] as string[]);
  const bySlug = new Map(sorted.map((m) => [slugFor(m), m]));
  const chosen: CommunityMarket[] = [];
  const used = new Set<string>();
  for (const s of explicitSlugs) {
    const m = bySlug.get(s);
    if (m && !used.has(s)) { chosen.push(m); used.add(s); }
    if (chosen.length >= n) break;
  }
  if (chosen.length < n) {
    const withActivity = sorted.filter((m) => !used.has(slugFor(m)) && (playerCounts[slugFor(m)] ?? 0) > 0);
    for (const m of withActivity) {
      if (chosen.length >= n) break;
      chosen.push(m); used.add(slugFor(m));
    }
  }
  if (chosen.length < n) {
    for (const m of sorted) {
      if (chosen.length >= n) break;
      const s = slugFor(m);
      if (used.has(s)) continue;
      chosen.push(m); used.add(s);
    }
  }
  if (!chosen.length) return [];

  const chosenSlugs = chosen.map((m) => slugFor(m));
  const [crowd, surfacers] = await Promise.all([
    crowdSplits(chosenSlugs),
    surfacersFor(chosenSlugs).catch(() => ({} as Record<string, { handle: string | null; sourceUrl: string | null }>)),
  ]);
  // Home's featured slots deliberately carry no sourceUrl/callers — those are
  // permalink-page-only (see /api/feed above, gated on the start slug). The
  // real topical pick (Sports/Crypto/…) is exposed as topicCategory — same
  // convention as the feed's community cluster — since `category` here stays
  // the flat "Community" chip value the rest of the client expects.
  return chosen.map((m) => {
    const slug = slugFor(m);
    const positions = playerCounts[slug] ?? 0;
    const surfacer = surfacers[slug];
    return {
      ...m, slug, category: "Community", topicCategory: m.category, community: true as const,
      positions, forming: positions < MARKET_FORMING_MIN, formingMin: MARKET_FORMING_MIN,
      onchain: onchainEnabled() && m.onchainPubkey ? explorerUrl(m.onchainPubkey) : null,
      crowd: crowd[slug] ?? { yes: 0, no: 0 },
      challengeHandle: surfacer?.handle ?? null,
    };
  });
}
/** How many ranked callers the teaser lists at most. */
const HOME_TOP_CALLERS_SHOWN = 3;
/** How few it will render with. One: at low volume, requiring three hid the
 *  board entirely, and "here is the person to beat" is a real competition even
 *  with one name in it. What counts as RANKED is unchanged — the store's
 *  min-resolved/provisional bar still decides who is eligible at all. */
const HOME_MIN_RANKED = 1;

// The client only ever shows HOME_FEATURED_SHOWN cards in the visible "Open
// markets" section — but it fetches HOME_FEATURED_POOL, and keeps the extras
// client-side as the continuous-play loop's reserve (see the Home CTA chain:
// lock a call -> "Next call" -> pull one from the reserve, in place, no nav).
// One request, one ranking pass, no second endpoint for "more of the same
// list" — the loop and the visible section are just two slices of it.
const HOME_FEATURED_SHOWN = 4;
const HOME_FEATURED_POOL = 12;

app.get("/api/home", async (req, res) => {
  // deviceId is optional here (home renders fine cold, no deviceId at all) —
  // when present it unlocks the one PERSONAL section, openCalls.
  const q = req.query.deviceId;
  const deviceId = typeof q === "string" && DEVICE_ID.test(q) ? q : null;
  // Every section degrades to absent on failure, never to a fake: the client
  // renders each one only when its array is non-empty (see renderHome).
  const [featured, settled, board, activity, openCalls, newUser] = await Promise.all([
    resolveFeatured(HOME_FEATURED_POOL).catch((e) => { console.error("[home] resolve failed:", (e as Error).message); return []; }),
    // Two, not three: settled rows look alike, so the third adds repetition
    // rather than proof — and the 175px it costs is what keeps the leaderboard
    // teaser below it inside the first desktop screen.
    recentlySettled(2).catch((e) => { console.error("[home] settled failed:", (e as Error).message); return []; }),
    leaderboard(20).catch((e) => { console.error("[home] leaderboard failed:", (e as Error).message); return []; }),
    homeActivity().catch((e) => { console.error("[home] activity failed:", (e as Error).message); return null; }),
    deviceId
      ? openCallsSummaryFor(deviceId).catch((e) => { console.error("[home] openCalls failed:", (e as Error).message); return null; })
      : Promise.resolve(null),
    // Stage 1 of onboarding: true only for a device with zero calls, ever — a
    // failure here defaults to false (never falsely cue a returning player).
    deviceId
      ? isNewUserFor(deviceId).catch((e) => { console.error("[home] newUser failed:", (e as Error).message); return false; })
      : Promise.resolve(false),
  ]);
  // Only RANKED callers are eligible — `provisional` is the store's existing
  // "sample too small to mean anything" flag, and the full Leaderboard sorts
  // those below everyone else for the same reason.
  const ranked = board.filter((r) => !r.provisional);
  const topCallers = ranked.length >= HOME_MIN_RANKED
    ? ranked.slice(0, HOME_TOP_CALLERS_SHOWN).map((r, i) => ({
        rank: i + 1, handle: r.handle, avgEdge: Math.round(r.avgEdge * 10) / 10, closed: r.closed,
      }))
    : [];
  // The tag-CTA's points-incentive line reads this live rather than hardcoding
  // "50" — the two can never drift apart, because there's only one number.
  // Same reasoning for featuredShown: the client slices `featured` into the
  // visible section vs. the loop's reserve pool using THIS number, not its own
  // hardcoded 4, so the two can never disagree about where the pool starts.
  res.json({ featured, settled, topCallers, activity, openCalls, newUser, surfaceReward: SEASON_POINTS.surface, featuredShown: HOME_FEATURED_SHOWN });
});

/**
 * Slug data (JSON) for anything that needs one market. Resolves against the raw
 * set: a link already in the wild keeps working, and keeps showing live odds,
 * even after the market drifts past 96%.
 */
app.get("/api/market/:slug", async (req, res) => {
  const { all } = await getMarketData();
  const rec = await getSlug(req.params.slug, all);
  if (!rec) return res.status(404).json({ error: "unknown market" });
  const yesTokens = rec.calls.filter((c) => c.side === "yes").reduce((s, c) => s + c.tokens, 0);
  const noTokens = rec.calls.filter((c) => c.side === "no").reduce((s, c) => s + c.tokens, 0);
  res.json({ ...rec, tally: { yesTokens, noTokens, calls: rec.calls.length } });
});

/**
 * The card as SVG (rasterize to PNG before posting to X). This one is embedded in
 * a tweet, so it must still render long after the market left the live set — it
 * falls back to the stored snapshot.
 */
app.get("/card/:slug.svg", async (req, res) => {
  const { all } = await getMarketData();
  const rec = await getSlug(req.params.slug, all);
  if (!rec) return res.status(404).send("unknown market");
  res.type("image/svg+xml").send(renderCard(rec.market));
});

/**
 * The same card as PNG — the shareable image. X and most chat apps refuse to
 * unfurl an SVG as an og:image, so a pasted oddie.fun/market link needs a raster
 * to preview. Same pixels as the SVG, only rasterised: the design never forks.
 *
 * Rasterising is CPU work and a link dropped in a busy channel is fetched by
 * several unfurlers at once, so a short cache absorbs the burst. Odds drift
 * slowly; a few minutes of staleness on a preview image is invisible, and the
 * live feed the link opens into is always current.
 */
const pngCache = new Map<string, { png: Buffer; at: number }>();
const PNG_TTL_MS = 5 * 60_000;

/**
 * The personal card, by share token only. Tokens are minted by the call's
 * owner (below), so this renders exactly the calls people chose to publish.
 */
app.get("/card/pc/:token.svg", async (req, res) => {
  const share = await getShareCall(req.params.token);
  if (!share) return res.status(404).send("unknown share");
  res.type("image/svg+xml").send(renderPositionCard(share));
});

app.get("/card/pc/:token.png", async (req, res) => {
  const share = await getShareCall(req.params.token);
  if (!share) return res.status(404).send("unknown share");
  // Resolution is part of the cache key: the moment a position settles, the
  // next fetch renders the verdict rather than serving 5 minutes of "in play".
  const key = `pc:${req.params.token}:${share.resolved ?? "open"}`;
  const now = Date.now();
  const hit = pngCache.get(key);
  if (hit && now - hit.at < PNG_TTL_MS) {
    return res.type("image/png").set("Cache-Control", "public, max-age=300").send(hit.png);
  }
  const png = renderCardPng(renderPositionCard(share));
  pngCache.set(key, { png, at: now });
  res.type("image/png").set("Cache-Control", "public, max-age=300").send(png);
});

/** Owner mints the share link for one of their calls. 404 for everyone else. */
app.post("/api/position/:id/sharelink", async (req, res) => {
  const deviceId = deviceIdOf(req.body);
  const id = Number(req.params.id);
  if (!deviceId || !Number.isInteger(id)) return res.status(400).json({ ok: false });
  const r = await mintShareToken(id, deviceId);
  if (!r.ok) return res.status(404).json({ ok: false });
  res.json({ ok: true, url: `${BASE_URL}/market/${r.slug}?pc=${r.token}`, cardUrl: `${BASE_URL}/card/pc/${r.token}.png` });
});

app.get("/card/:slug.png", async (req, res) => {
  const slug = req.params.slug;
  const now = Date.now();
  const hit = pngCache.get(slug);
  if (hit && now - hit.at < PNG_TTL_MS) {
    return res.type("image/png").set("Cache-Control", "public, max-age=300").send(hit.png);
  }
  const { all } = await getMarketData();
  const rec = await getSlug(slug, all);
  if (!rec) return res.status(404).send("unknown market");
  const png = renderCardPng(renderCard(rec.market));
  pngCache.set(slug, { png, at: now });
  if (pngCache.size > 300) for (const [k, v] of pngCache) if (now - v.at > PNG_TTL_MS) pngCache.delete(k);
  res.type("image/png").set("Cache-Control", "public, max-age=300").send(png);
});

// The public-profile og image — same renderer/cache as the market card.
app.get("/card/u/:handle.png", async (req, res) => {
  const handle = String(req.params.handle).replace(/^@+/, "");
  const key = `@${handle.toLowerCase()}`;
  const now = Date.now();
  const hit = pngCache.get(key);
  if (hit && now - hit.at < PNG_TTL_MS) {
    return res.type("image/png").set("Cache-Control", "public, max-age=300").send(hit.png);
  }
  const deviceId = await deviceForHandle(handle).catch(() => null);
  if (!deviceId) return res.status(404).send("unknown profile");
  const [acc, hd, rank] = await Promise.all([accuracyFor(deviceId), displayHandle(deviceId), seasonRankFor(deviceId)]);
  const badges = await badgesFor(deviceId, acc);
  const png = renderCardPng(renderProfileCard({
    handle: hd.handle, oddieScore: acc.oddieScore, accuracyPct: acc.accuracyPct,
    streak: acc.streak, resolved: acc.resolved, hasEnough: acc.hasEnough,
    badges: badges.map((b) => ({ label: b.label, kind: b.kind })), rankTopPct: rank ? rank.topPct : null,
  }));
  pngCache.set(key, { png, at: now });
  res.type("image/png").set("Cache-Control", "public, max-age=300").send(png);
});

/**
 * The anonymous device id the feed generates and keeps in localStorage. It is a
 * random opaque string: not a login, not a user, and never joined to anything a
 * person typed. Anything that does not look like one is treated as absent
 * rather than stored, so a malformed or hostile value cannot become a key.
 */
const DEVICE_ID = /^[a-z0-9-]{8,64}$/i;
const deviceIdOf = (body: unknown): string | null => {
  const v = (body as { deviceId?: unknown })?.deviceId;
  return typeof v === "string" && DEVICE_ID.test(v) ? v : null;
};

/**
 * Paper trading, phase 1. Virtual tokens only: every device starts with 100,
 * a call deducts its stake atomically, and nothing anywhere converts tokens to
 * or from money. The device id is the only key — no account, no PII.
 */
/** The wallet: what you have, and when the game gives you more. */
/**
 * The velvet rope. The feed asks this on boot; the call/sell endpoints enforce
 * it server-side regardless of what any client claims. Passing for the first
 * time after an invite records invite_accepted — the loop's success metric.
 */
/** Honest social proof for the landing: how many markets are live right now.
 *  Counts, no user numbers, no invention. */
app.get("/api/stats", async (_req, res) => {
  const data = await getMarketData();
  res.json({ liveMarkets: data.markets.length, venues: Object.values(data.venues).filter((v) => v.enabled).length });
});

app.get("/api/gate", async (req, res) => {
  const q = req.query.deviceId;
  const deviceId = typeof q === "string" && DEVICE_ID.test(q) ? q : null;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const gate = await gateFor(deviceId);
  if (gate.allowed && gate.justAccepted) {
    recordEvent({ name: "invite_accepted", deviceId }).catch(() => {});
  }
  res.json(gate);
});

app.get("/api/me", async (req, res) => {
  const q = req.query.deviceId;
  const deviceId = typeof q === "string" && DEVICE_ID.test(q) ? q : null;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const [wallet, handle, claim, acc, rank] = await Promise.all([getWallet(deviceId), displayHandle(deviceId), claimStatus(deviceId), accuracyFor(deviceId), seasonRankFor(deviceId)]);
  const badges = await badgesFor(deviceId, acc);
  // pickStreak drives the persistent streak badge near the balance (2+ only).
  res.json({ ...wallet, ...handle, claim, pickStreak: acc.streak, badges, rank });
});

// The daily claim — the active retention hook. GET reports status (claimable,
// streak, countdown); POST collects it (idempotent within the window).
app.get("/api/claim", async (req, res) => {
  const q = req.query.deviceId;
  const deviceId = typeof q === "string" && DEVICE_ID.test(q) ? q : null;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  res.json(await claimStatus(deviceId));
});
app.post("/api/claim", async (req, res) => {
  const deviceId = deviceIdOf(req.body);
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  res.json(await claimDaily(deviceId));
});

// A permalink landing (fired by the SPA when it opens on a /m/{slug} page), so
// the wedge metrics can measure click→pick. Device-attributed; bots that fetch
// the og tags without running JS never fire it, which is what we want.
app.post("/api/pageview", async (req, res) => {
  const slug = String(req.body?.slug ?? "").trim();
  if (!slug) return res.status(400).json({ error: "slug required" });
  const deviceId = deviceIdOf(req.body); // optional
  void logPageView(slug, deviceId || null); // fire-and-forget
  res.json({ ok: true });
});

/**
 * One identity, two sources. A linked X account's real @handle wins for display;
 * the stored (random or chosen) one is what an anonymous device is called and
 * what editing edits. `handleEditable` is the UI's cue to show or hide the pen.
 */
async function displayHandle(deviceId: string): Promise<{ handle: string; handleEditable: boolean }> {
  const [own, accts] = await Promise.all([ensureHandle(deviceId), accountsFor(deviceId)]);
  const tw = accts.find((a) => a.provider === "twitter" && a.handle);
  // Stored X handles carry their own "@"; every consumer prefixes one, so
  // strip it here — the UI showed "@@levvercetti" before this did.
  return tw ? { handle: tw.handle!.replace(/^@+/, ""), handleEditable: false } : { handle: own, handleEditable: true };
}

app.post("/api/handle", async (req, res) => {
  const deviceId = deviceIdOf(req.body);
  if (!deviceId) return res.status(400).json({ ok: false, reason: "deviceId required" });
  const proposed = (req.body as { handle?: unknown })?.handle;
  if (typeof proposed !== "string") return res.status(400).json({ ok: false, reason: "handle required" });
  const r = await setHandle(deviceId, proposed);
  res.status(r.ok ? 200 : 409).json(r);
});

/** Real notifications: whatever has actually happened to this stream. */
app.get("/api/notices", async (req, res) => {
  const q = req.query.deviceId;
  const deviceId = typeof q === "string" && DEVICE_ID.test(q) ? q : null;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  res.json({ notices: await noticesFor(deviceId) });
});

// The resolution celebration — fetched on every boot alongside the gate check.
// Empty on almost every load (the whole point: it only has rows when a
// position resolved since the device was last shown one), so this stays cheap.
app.get("/api/celebrations", async (req, res) => {
  const q = req.query.deviceId;
  const deviceId = typeof q === "string" && DEVICE_ID.test(q) ? q : null;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  res.json({ celebrations: await celebrationsFor(deviceId) });
});
// Fired once the client has actually FINISHED showing the batch (dismissed, or
// swiped past the last card) — see markCelebrationsSeen for why this is never
// called at fetch time.
app.post("/api/celebrations/seen", async (req, res) => {
  const deviceId = deviceIdOf(req.body);
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const raw = req.body?.noticeIds;
  if (!Array.isArray(raw) || raw.some((n) => typeof n !== "number")) {
    return res.status(400).json({ error: "noticeIds must be an array of numbers" });
  }
  await markCelebrationsSeen(deviceId, raw);
  res.json({ ok: true });
});

/**
 * Stage 2 of new-user onboarding — the "now the real move: tag @oddiefun"
 * teaching moment, shown once inline right after a device's first-ever call
 * locks. The client only calls this when placeCall just reported
 * firstEver:true; the response IS the one-shot gate (see claimTagTeachingMoment) —
 * `show:true` at most once per device, ever, regardless of how many times a
 * firstEver:true call is (mistakenly or not) reported.
 */
app.post("/api/onboarding/tag-teaching-seen", async (req, res) => {
  const deviceId = deviceIdOf(req.body);
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  res.json({ show: await claimTagTeachingMoment(deviceId) });
});

/**
 * Open positions carry today's price so the hold-or-sell decision can be made
 * on the screen that offers it. Closed ones carry the edge they scored, and the
 * reputation is the average of exactly those — including the losses.
 */
app.get("/api/positions", async (req, res) => {
  const q = req.query.deviceId;
  const deviceId = typeof q === "string" && DEVICE_ID.test(q) ? q : null;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const { all } = await getMarketData();
  const [wallet, positions, streak] = await Promise.all([getWallet(deviceId), positionsFor(deviceId, all), streakFor(deviceId)]);
  res.json({ ...positions, tokens: wallet.tokens, nextTopUpMs: wallet.nextTopUpMs, streak });
});

/**
 * The accuracy record — the public reputation metric. Overall accuracy (gated by
 * a minimum resolved-pick count), current + best consecutive-correct streak, and
 * best topic. Feeds the Profile stats and the notification/profile share text.
 */
app.get("/api/accuracy", async (req, res) => {
  const q = req.query.deviceId;
  const deviceId = typeof q === "string" && DEVICE_ID.test(q) ? q : null;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const [acc, weeklyDelta] = await Promise.all([accuracyFor(deviceId), weeklyScoreDeltaFor(deviceId)]);
  res.json({ ...acc, weeklyDelta });
});

/**
 * Rank movement — "you moved up 2 spots -> #14" — consumed exactly once per
 * change. Called ONLY from the client's Profile and Leaderboard loaders, never
 * from the balance pill's background /api/me refresh: this read IS the
 * "mark seen" (see rankMovementFor), so wiring it into a poll would burn the
 * one showing before the user ever looked at either screen.
 */
app.get("/api/rank-movement", async (req, res) => {
  const q = req.query.deviceId;
  const deviceId = typeof q === "string" && DEVICE_ID.test(q) ? q : null;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  res.json({ movement: await rankMovementFor(deviceId) });
});

/**
 * Sell a position at the venue's current price for that side.
 *
 * NOT gated. The curated-launch rope governs OPENING positions (the call flow),
 * not closing them: you may always exit a position you already hold. Gating the
 * sell trapped tokens in a market a non-allowlisted holder couldn't leave — and
 * returned a 403 the screen rendered as "Couldn't sell — try again", a lie that
 * invited an endless pointless retry. Selling only ever returns YOUR own stake
 * to YOUR balance; it grants no access, so there is nothing here to gate.
 *
 * Every failure is a state the screen can render — the row is gone, it was
 * already sold, the venue stopped quoting it — so they come back as ok:false
 * with a reason rather than as an exception. A stale venue is the one case that
 * must NOT go through: selling against a price nobody is quoting any more is
 * how a paper economy quietly prints tokens.
 */
app.post("/api/position/:id/sell", async (req, res) => {
  const id = Number(req.params.id);
  const deviceId = deviceIdOf(req.body);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad position id" });
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const data = await getMarketData();
    if (data.stale) return res.status(503).json({ ok: false, reason: "stale-odds" });
    const result = await sellPosition(id, deviceId, data.all);
    if (!result.ok && result.reason === "not-found") return res.status(404).json(result);
    res.json(result);
  } catch (err) {
    // sellPosition re-throws on a DB fault; without this the route 500s with an
    // HTML body, the client's r.json() throws, and it too reads as "try again".
    console.error("[sell] unexpected error:", (err as Error).message);
    res.status(500).json({ ok: false, reason: "server-error" });
  }
});

// --- optional identity -------------------------------------------------------
//
// Sign-in is an upgrade. Nothing below is ever required to read the feed, place
// a call, sell a position or appear on the leaderboard. A provider we have no
// secret for reports itself unavailable rather than pretending to work and
// dying on the redirect.

/** Which providers can actually be used right now, and who this browser is. */
app.get("/api/auth/me", async (req, res) => {
  const q = req.query.deviceId;
  const deviceId = typeof q === "string" && DEVICE_ID.test(q) ? q : null;
  const providers = PROVIDERS.map((p) => ({ provider: p, available: isConfigured(p) }));
  if (!deviceId) return res.json({ accounts: [], providers });
  res.json({ accounts: await accountsFor(deviceId), providers });
});

/**
 * Begin the dance. The device id rides in the pending record, not in the
 * redirect_uri — the provider matches that URI byte for byte against what is
 * registered in its console, and a query string on it is a mismatch.
 */
app.get("/api/auth/:provider/start", (req, res) => {
  const p = req.params.provider;
  if (!isProvider(p)) return res.status(404).json({ error: "unknown provider" });
  if (!isConfigured(p)) return res.status(503).json({ error: "provider not configured", missing: missingSecretEnv(p) });
  const q = req.query.deviceId;
  const deviceId = typeof q === "string" && DEVICE_ID.test(q) ? q : null;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });

  // Optional post-auth destination (e.g. the /m/{slug} permalink the tap came
  // from). Strictly a LOCAL path — anything else (absolute URLs, protocol-
  // relative "//host") is dropped, so this can never become an open redirect.
  const rq = req.query.return;
  const returnTo =
    typeof rq === "string" && rq.startsWith("/") && !rq.startsWith("//") && rq.length <= 200 ? rq : null;

  const { verifier, challenge } = pkce();
  const state = remember(p, verifier, deviceId, returnTo);
  res.redirect(authorizeUrl(p, state, challenge, BASE_URL));
});

/**
 * Come back. Every failure lands the user on the Profile tab with a message,
 * because a person halfway through signing in should not meet a JSON blob.
 */
app.get("/api/auth/:provider/callback", async (req, res) => {
  const p = req.params.provider;
  const back = (params: string) => res.redirect(`${BASE_URL}/feed?${params}#/profile`);
  if (!isProvider(p)) return back("auth_error=unknown_provider");

  // The provider says no: the user hit Cancel, or the app is misconfigured.
  if (typeof req.query.error === "string") return back(`auth_error=${encodeURIComponent(req.query.error)}`);

  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  if (!code || !state) return back("auth_error=missing_code");

  // One-shot: a replayed state is a double-tapped back button at best.
  const pendingAuth = consume(state);
  if (!pendingAuth || pendingAuth.provider !== p) return back("auth_error=expired");

  try {
    const identity = await identify(p, code, pendingAuth.verifier, BASE_URL);
    const result = await linkAccount(pendingAuth.deviceId, identity);
    console.log(JSON.stringify({ evt: "auth_link", provider: p, seeded: result.seeded, bonus: result.bonus }));
    // A sign-in that began on a market permalink returns TO that market — the
    // person came to play this one, not to meet the generic feed.
    if (pendingAuth.returnTo) {
      const sep = pendingAuth.returnTo.includes("?") ? "&" : "?";
      return res.redirect(`${BASE_URL}${pendingAuth.returnTo}${sep}connected=${p}&bonus=${result.bonus}`);
    }
    return back(`connected=${p}&bonus=${result.bonus}`);
  } catch (err) {
    console.error(`[auth] ${p} failed:`, (err as Error).message);
    return back("auth_error=link_failed");
  }
});

/** The exact URI each provider console must have registered. Read-only, no secrets. */
app.get("/api/auth/config", (_req, res) => {
  res.json({
    baseUrl: BASE_URL,
    providers: PROVIDERS.map((p) => ({
      provider: p,
      callback: redirectUri(BASE_URL, p),
      configured: isConfigured(p),
      secretEnv: missingSecretEnv(p),
    })),
  });
});

/**
 * Ranked by average edge. Devices are anonymous and stay that way: the id is
 * truncated to something you can recognise as your own row and nobody else's.
 */
app.get("/api/leaderboard", async (req, res) => {
  const q = req.query.deviceId;
  const raw = typeof q === "string" && DEVICE_ID.test(q) ? q : null;
  // Board rows are canonical devices; a signed-in browser's own id is not.
  const me = raw ? await resolveDevice(raw) : null;
  const [edge, streaks, winnings] = await Promise.all([leaderboard(20), leaderboardStreaks(20), leaderboardWinnings(20)]);
  res.json({
    rows: edge.map((r, i) => ({
      rank: i + 1, handle: r.handle, you: r.deviceId === me,
      avgEdge: Math.round(r.avgEdge * 10) / 10, closed: r.closed, provisional: r.provisional,
    })),
    streaks: streaks.map((r, i) => ({ rank: i + 1, handle: r.handle, you: r.deviceId === me, current: r.current, best: r.best })),
    winnings: winnings.map((r, i) => ({ rank: i + 1, handle: r.handle, you: r.deviceId === me, net: r.net, closed: r.closed })),
  });
});

/**
 * Place a call. Insufficient balance is a 200 with ok:false rather than an
 * error status: the client caps the picker at the balance, so hitting this
 * means two tabs raced — a state to render, not a failure to throw.
 */
app.post("/api/market/:slug/call", async (req, res) => {
  const side = req.body?.side;
  const tokens = Number(req.body?.tokens ?? 0);
  const deviceId = deviceIdOf(req.body);
  if (side !== "yes" && side !== "no") return res.status(400).json({ error: "side must be yes|no" });
  if (!Number.isInteger(tokens) || tokens <= 0 || tokens > 1_000_000) return res.status(400).json({ error: "tokens must be a positive integer" });
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  // No rope on voting: any device — anonymous or signed in — may place calls
  // with its free points. Signing in is optional (it just attaches an identity
  // that follows you across devices). This is what makes a seeded reply link
  // playable the instant someone taps it.
  const all = await pricingSet(); // venue markets + open community markets, so a community market can be entered
  const result = await placeCall(req.params.slug, side, tokens, deviceId, all);
  if (!result.ok && result.reason === "unknown-market") return res.status(404).json({ ok: false, reason: "unknown-market", error: "unknown market" });
  if (!result.ok) return res.json(result);
  // The split INCLUDING the call just placed — the post-call line's "you're
  // with 67% of poppers" is computed from what the table now says, not a guess.
  const crowd = (await crowdSplits([req.params.slug]))[req.params.slug] ?? { yes: 0, no: 0 };
  res.json({ ...result, crowd });
});

/**
 * Week-1 telemetry. Four names, nothing else accepted; an unknown name is a 400
 * rather than a row, so the table cannot silently grow a fifth event nobody
 * decided on.
 *
 * Answers exactly three questions: how many came, how deep did they scroll, how
 * many tapped. No IP, no user agent, no referrer, no free text. The feed sends
 * these with sendBeacon, so the response body is never read — 204 and move on.
 */
app.post("/api/ev", async (req, res) => {
  const name = req.body?.name;
  const deviceId = deviceIdOf(req.body);
  if (!(EVENT_NAMES as readonly string[]).includes(name)) return res.status(400).json({ error: "unknown event" });
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });

  const side = req.body?.side === "yes" || req.body?.side === "no" ? req.body.side : null;
  const idxRaw = Number(req.body?.idx);
  const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : null);

  await recordEvent({
    name,
    deviceId,
    slug: str(req.body?.slug, 120),
    idx: Number.isInteger(idxRaw) && idxRaw >= 0 && idxRaw < 1000 ? idxRaw : null,
    side,
    cat: str(req.body?.cat, 40),
  });
  res.status(204).end();
});

/**
 * Week-1 seeding aid, for one operator. Paste a tweet, get the slug, card and
 * link in one click instead of a curl. It calls /hook on this same origin, so
 * there is no CORS to arrange.
 *
 * It is NOT automation: nothing here touches the X API, and no reply is ever
 * posted. The card and the link get carried to Twitter by hand.
 *
 * Unlisted rather than protected: no nav links here, noindex, and no path anyone
 * would guess. That is obscurity, not auth — it seeds nothing and reads nothing
 * that /hook doesn't already expose to anyone who can POST to it.
 */
/**
 * The manual-mention worklist for /tool. Unlisted like /tool itself — no nav
 * links, noindex — rather than gated.
 * Copy text is generated here so the operator pastes, posts, and marks sent.
 */
/**
 * The invite panel's data. Waitlist emails come from Supabase (the landing's
 * store) over plain REST — no SDK. Without SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
 * on this service the panel says so and manual allowlisting still works.
 * Railway-origin only, like /tool.
 */
const SUPA = () => ({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY });

app.get("/api/invites", async (_req, res) => {
  const { url, key } = SUPA();
  let waitlist: { email: string; created_at: string }[] | null = null;
  if (url && key) {
    try {
      const r = await fetch(`${url}/rest/v1/waitlist?select=email,created_at&order=created_at.desc&limit=200`, {
        headers: { apikey: key, authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) waitlist = (await r.json()) as { email: string; created_at: string }[];
    } catch (err) { console.error("[invites] supabase read failed:", (err as Error).message); }
  }
  res.json({ waitlist, supabase: Boolean(url && key), allowlist: await allowlistRows() });
});

app.post("/api/invites/send", async (req, res) => {
  const email = String((req.body as { email?: unknown })?.email ?? "").trim().toLowerCase();
  const source = String((req.body as { source?: unknown })?.source ?? "waitlist");
  if (!email.includes("@")) return res.status(400).json({ ok: false, reason: "bad email" });
  const ok = await addToAllowlist(email, source, true);
  if (!ok) return res.status(400).json({ ok: false, reason: "bad email" });
  const sent = await sendMail({
    to: email,
    subject: "you're in — Oddie beta",
    html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:520px">
  <p style="font-size:17px;font-weight:700;margin:0 0 12px">you're in.</p>
  <p style="margin:0 0 16px">Your spot on the Oddie beta just opened. Sign in with this Google account and you're playing — free, virtual tokens, nothing to cash out.</p>
  <p style="margin:0 0 20px"><a href="${BASE_URL}/feed?invite=1" style="display:inline-block;background:#68C6FF;color:#000;font-weight:700;border:3px solid #000;border-radius:14px;padding:10px 18px;text-decoration:none">open the feed →</a></p>
  <p style="color:#6B7A88;font-size:12.5px;margin:0">oddie · ${TAGLINE}</p>
</div>`,
  });
  recordEvent({ name: "invite_sent", deviceId: "operator" }).catch(() => {});
  res.json({ ok: true, mail: sent });
});

app.get("/api/mentions", async (_req, res) => {
  const rows = await mentionCandidates();
  const out = [];
  for (const r of rows) {
    const token = r.shareToken ?? (await mintShareTokenForMention(r.callId));
    const won = r.side === r.outcome;
    const line = won
      ? `@${r.handle} called ${r.side.toUpperCase()} at ${r.entryPct}% — resolved ${r.outcome.toUpperCase()} ✓ +${r.proceeds} tokens`
      : `@${r.handle} called ${r.side.toUpperCase()} at ${r.entryPct}% — resolved ${r.outcome.toUpperCase()}`;
    out.push({
      callId: r.callId, handle: r.handle, won, line,
      url: token ? `${BASE_URL}/market/${r.slug}?pc=${token}` : `${BASE_URL}/market/${r.slug}`,
      question: r.question, mentionedAt: r.mentionedAt, returned24h: r.returned24h,
    });
  }
  res.json({ mentions: out });
});

app.post("/api/mentions/:id/sent", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false });
  res.json({ ok: await markMentioned(id) });
});

app.get("/tool", (_req, res) => {
  res.set("X-Robots-Tag", "noindex, nofollow");
  res.type("html").send(TOOL_HTML);
});

/* ------------------------------------------------ community markets (admin) --
 * Layer 1 (virtual product) + Layer 2 (devnet proof). Create and resolve are
 * admin-only and FAIL CLOSED: with no ODDIE_ADMIN_TOKEN set, or a missing/wrong
 * token, every request is rejected — never open. /tool is otherwise reachable by
 * anyone, and resolve settles real user positions, so the token is the only gate.
 */
function adminOk(req: express.Request): boolean {
  const token = process.env.ODDIE_ADMIN_TOKEN;
  if (!token) return false; // fail closed: unconfigured => nobody is admin
  const provided = req.get("x-oddie-admin") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!adminOk(req)) {
    res.status(401).json({ error: "admin token required" });
    return;
  }
  next();
}

/** Venue markets plus open community markets — the set used to PRICE plays, so a
 *  community market (which no venue feed knows about) can still be entered. */
async function pricingSet(): Promise<Market[]> {
  const data = await getMarketData();
  let community: CommunityMarket[] = [];
  try { community = await openCommunityMarkets(); }
  catch (e) { console.error("[community] pricing load failed (venue-only):", (e as Error).message); }
  return [...data.all, ...community];
}

// The claim-extraction engine, now front-run by a DEDUP check: before we ever
// mint a new Community market for a claim, we ask the existing semantic matcher
// whether a live venue market (Polymarket/Kalshi) already covers it. Three
// outcomes, all surfaced to the operator (nothing is written here):
//   venue   — high confidence: hand back the existing market, make nothing new
//   closest — medium: show it for a human eyeball; do NOT auto-publish
//   none    — no usable match: fall through to the resolvability gate + minting
app.post("/api/community/extract", requireAdmin, async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "text required" });
  if (text.length > 4000) return res.status(400).json({ error: "text too long (≤4000 chars)" });
  if (!extractEnabled()) return res.status(503).json({ error: `extraction unavailable — set ${EXTRACT_KEY_ENV}` });
  try {
    const extraction = await runExtract(text);
    void logExtraction("extract", text, extraction);

    // Match on the extracted question when we have one; otherwise on the raw
    // argument (an unresolvable-to-mint claim can still already exist on a venue).
    const matchText = extraction.question || text;
    const data = await getMarketData();
    const venuesAvailable = data.markets.length > 0;
    let match: Record<string, unknown> = { path: "none" };
    if (venuesAvailable) {
      const vm = await matchVenue(matchText, data.markets).catch((e) => {
        console.error("[extract] venue match failed (treating as no match):", (e as Error).message);
        return null;
      });
      if (vm) {
        const m = vm.market;
        match = {
          path: vm.tier, // "venue" | "closest"
          confidence: vm.confidence,
          reason: vm.reason,
          market: {
            id: `${m.venue}:${m.venueId}`, venue: m.venue, venueId: m.venueId,
            question: m.question, yesPct: m.yesPct, volumeUsd: m.volumeUsd,
            category: categorize(m), venueUrl: m.venueUrl, slug: slugFor(m),
          },
        };
      }
    } else {
      match = { path: "none", venuesUnavailable: true };
    }

    // Every case logged with its path + confidence, for tuning the two bars later.
    void logExtraction("match", matchText, {
      path: match.path, confidence: match.confidence ?? null,
      matchedId: (match.market as { id?: string })?.id ?? null, venuesAvailable,
    });

    res.json({ ok: true, extraction, match, venuesAvailable });
  } catch (e) {
    console.error("[extract] failed:", (e as Error).message);
    res.status(502).json({ error: "extraction failed — try again (see server logs)" });
  }
});

// Create a Community market: virtual first (always), then mint on devnet (soft).
app.post("/api/community/create", requireAdmin, async (req, res) => {
  const question = String(req.body?.question ?? "").trim();
  const category = (String(req.body?.category ?? "Community").trim()) || "Community";
  const yesPct = Number(req.body?.yesPct ?? 50);
  const closeInput = req.body?.close_time ?? req.body?.closeTime;
  const resolutionCriteria = req.body?.resolution_criteria != null ? String(req.body.resolution_criteria).trim() : null;
  const resolvability = req.body?.resolvability != null ? String(req.body.resolvability).trim() : null;

  if (!question) return res.status(400).json({ error: "question required" });
  if (question.length > 180) return res.status(400).json({ error: "question must be ≤180 characters (on-chain limit)" });
  // The gate is enforced server-side too: an unresolvable claim is never a market,
  // no matter what the client posts.
  if (resolvability === "unresolvable") return res.status(422).json({ error: "unresolvable claims cannot become markets" });
  if (resolutionCriteria && resolutionCriteria.length > 600) return res.status(400).json({ error: "resolution criteria must be ≤600 characters" });
  let closeTime: number;
  if (typeof closeInput === "number") closeTime = Math.floor(closeInput);
  else {
    const t = Date.parse(String(closeInput));
    if (Number.isNaN(t)) return res.status(400).json({ error: "invalid close_time" });
    closeTime = Math.floor(t / 1000);
  }
  if (!(closeTime > Math.floor(Date.now() / 1000))) return res.status(400).json({ error: "close_time must be in the future" });
  if (!Number.isFinite(yesPct) || yesPct < 1 || yesPct > 99) return res.status(400).json({ error: "starting odds must be 1–99" });

  const { slug, marketId } = await createCommunityMarket({ question, closeTime, category, yesPct, resolutionCriteria, resolvability });
  // The published record, incl. any operator edits — the other half of the tuning log.
  void logExtraction("publish", question, { slug, question, category, yesPct, closeTime, resolutionCriteria, resolvability });

  // Layer 2 — devnet proof. Soft by design: a failure here never blocks Layer 1.
  let onchain: { pubkey: string; explorer: string; signature: string } | null = null;
  const minted = await mintMarket({ marketId, question, closeTime });
  if (minted) {
    await setCommunityOnchain(slug, minted.pubkey, minted.signature);
    onchain = { pubkey: minted.pubkey, explorer: explorerUrl(minted.pubkey), signature: minted.signature };
  }

  res.json({
    ok: true, slug, marketId, url: `${BASE_URL}/m/${slug}`,
    onchain, chainEnabled: isChainEnabled(),
  });
});

// List community markets for the resolve control + a small chain-status readout.
// Explorer links (even for markets minted earlier) surface only while
// ONCHAIN_ENABLED is on; the underlying pubkeys stay stored regardless.
app.get("/api/community/list", requireAdmin, async (_req, res) => {
  const items = await adminListCommunity();
  res.json({
    items: items.map((i) => ({ ...i, explorer: onchainEnabled() && i.onchainPubkey ? explorerUrl(i.onchainPubkey) : null })),
    chain: { enabled: isChainEnabled(), admin: await adminAddress(), balanceSol: await adminBalanceSol() },
  });
});

// The inside-the-market admin view: pool split, positions (with handles), and a
// payout preview for BOTH outcomes, so resolution is done with full visibility.
app.get("/api/community/market/:slug", requireAdmin, async (req, res) => {
  const detail = await communityMarketDetail(req.params.slug);
  if (!detail) return res.status(404).json({ error: "unknown community market" });

  // Resolve handles once per distinct device (few positions, so this is cheap).
  const devices = [...new Set(detail.positions.map((p) => p.deviceId).filter((d): d is string => Boolean(d)))];
  const handleList = await Promise.all(devices.map(async (d) => [d, (await displayHandle(d)).handle] as const));
  const handles = new Map(handleList);

  let totalYes = 0, totalNo = 0, payoutIfYes = 0, payoutIfNo = 0, winnersYes = 0, winnersNo = 0;
  const pYes = new Set<string>(), pNo = new Set<string>();
  const positions = detail.positions.map((p) => {
    const entry = p.entryPct ?? 0;
    const payoutIfWin = entry > 0 ? proceedsFor(p.tokens, entry, 100) : 0; // round(stake*100/entry)
    if (p.side === "yes") { totalYes += p.tokens; if (p.deviceId) pYes.add(p.deviceId); payoutIfYes += payoutIfWin; if (payoutIfWin > 0) winnersYes++; }
    else { totalNo += p.tokens; if (p.deviceId) pNo.add(p.deviceId); payoutIfNo += payoutIfWin; if (payoutIfWin > 0) winnersNo++; }
    return {
      handle: p.deviceId ? (handles.get(p.deviceId) ?? p.deviceId.slice(0, 10) + "…") : "anon",
      deviceId: p.deviceId, side: p.side, tokens: p.tokens, entryPct: p.entryPct, payoutIfWin, closed: p.closed, proceeds: p.proceeds,
    };
  });
  const total = totalYes + totalNo;

  res.json({
    slug: detail.slug, question: detail.question, closesAt: detail.closesAt, yesPct: detail.yesPct, marketId: detail.marketId,
    resolvedOutcome: detail.resolvedOutcome, resolutionCriteria: detail.resolutionCriteria, resolvability: detail.resolvability,
    onchain: onchainEnabled() && detail.onchainPubkey
      ? { pubkey: detail.onchainPubkey, explorer: explorerUrl(detail.onchainPubkey), signature: detail.onchainSig, minted: true }
      : { minted: false },
    pool: { totalYes, totalNo, playersYes: pYes.size, playersNo: pNo.size, poolYesPct: total > 0 ? Math.round((100 * totalYes) / total) : null },
    preview: { ifYes: { totalPayout: payoutIfYes, winners: winnersYes }, ifNo: { totalPayout: payoutIfNo, winners: winnersNo } },
    positions,
  });
});

// Manual resolution: mark resolved, then settle every open position on the slug.
app.post("/api/community/resolve", requireAdmin, async (req, res) => {
  const slug = String(req.body?.slug ?? "");
  const outcome = req.body?.outcome;
  if (!slug || (outcome !== "yes" && outcome !== "no")) return res.status(400).json({ error: "slug and outcome (yes|no) required" });
  const ok = await markCommunityResolved(slug, outcome);
  if (!ok) return res.status(409).json({ error: "unknown or already-resolved community market" });
  const settled = await settleMarket(slug, outcome);
  await emailSettled(slug, outcome, settled);
  res.json({ ok: true, slug, outcome, settled: settled.length });
});

// Tweet mode: given a CONFIRMED market (venue match auto-accepted, closest match
// approved, or a Community market just created), generate a ready-to-paste X
// reply + an ASCII fallback, and log it. No X API — this is the manual-post
// workflow; the reply logic (buildTweetReply) is pure so it drops into an
// automated listener later unchanged.
app.post("/api/tweet/generate", requireAdmin, async (req, res) => {
  const b = req.body ?? {};
  const matchType = b.match_type;
  if (matchType !== "venue" && matchType !== "closest" && matchType !== "new") {
    return res.status(400).json({ error: "match_type must be venue|closest|new" });
  }
  const slug = String(b.slug ?? "").trim();
  const question = String(b.question ?? "").trim();
  if (!slug || !question) return res.status(400).json({ error: "slug and question required" });
  const sourceUrl = b.source_url != null ? String(b.source_url).trim() || null : null;
  const marketId = b.market_id != null ? String(b.market_id) : null;
  const hook = b.hook != null ? String(b.hook).trim() : "";

  const permalink = `${BASE_URL}/m/${slug}`;
  // Two copy variants off the same market (venue / closest / new): the REPLY (to
  // post under the tweet) and the QUOTE (to quote-post on the poster's timeline).
  // Both question-first, odds-free, with an optional teaser hook when it fits.
  const reply = buildTweetReply({ question, permalink, hook });
  const quote = buildTweetQuote({ question, permalink, hook });

  // The reply primary stays the logged canonical (unchanged wedge metric).
  const logged = await logTweetReply({
    sourceUrl, marketId, matchType, slug, permalink, replyText: reply.primary,
  });

  // A tagged claim just became a live market (venue-matched or created): record
  // its surfacer (the tweet author, from the source URL) and award +50 Season
  // Points, once. Backend-only; best-effort so it never blocks the reply.
  void (async () => {
    await recordSurfacer(slug, { sourceUrl });
    await awardSurface(slug);
  })().catch(() => {});

  res.json({
    ok: true,
    primary: reply.primary, fallback: reply.fallback,
    quote: quote.primary, quoteFallback: quote.fallback,
    permalink, logId: logged?.id ?? null, createdAt: logged?.createdAt ?? null,
  });
});

// The list view: everything generated so far, newest first.
app.get("/api/tweet/log", requireAdmin, async (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  const items = await listTweetReplies(Number.isFinite(limit) ? limit : 50);
  res.json({ items });
});

// The homepage's "Live right now" toggle. GET shows both the raw admin picks
// and what's EFFECTIVELY live right now (the same resolution /api/home
// uses — explicit picks topped up with recently-active markets), so /tool can
// tell the operator "you've picked 1 of 4 — these 3 others are the fallback."
app.get("/api/admin/featured", requireAdmin, async (_req, res) => {
  const slugs = await getFeaturedSlugs().catch(() => [] as string[]);
  const resolved = await resolveFeatured().catch(() => []);
  res.json({ slugs, resolved: resolved.map((m) => ({ slug: m.slug, question: m.question })) });
});
app.post("/api/admin/featured", requireAdmin, async (req, res) => {
  const raw = req.body?.slugs;
  if (!Array.isArray(raw)) return res.status(400).json({ error: "slugs must be an array (may be empty)" });
  const slugs = raw.map((s) => String(s).trim()).filter(Boolean);
  for (const slug of slugs) {
    const exists = await communityMarketDetail(slug).catch(() => null);
    if (!exists) return res.status(404).json({ error: `unknown community market: ${slug}` });
  }
  await setFeaturedMarkets(slugs);
  res.json({ ok: true, slugs });
});

// Every device the product has touched + what they've done (read-only, admin).
// One row per unique user; the operator's "who's here" view.
app.get("/api/admin/users", requireAdmin, async (_req, res) => {
  try {
    res.json({ users: await usersActivity() });
  } catch (e) {
    console.error("[users] failed:", (e as Error).message);
    res.status(500).json({ error: "users view unavailable" });
  }
});

// Season Points audit trail (read-only, admin). The backend contribution ledger:
// who earned what, for which event, on which market — so we can tune the values
// against real behaviour. Never exposed to end users.
app.get("/api/admin/season-points", requireAdmin, async (req, res) => {
  const limit = Number(req.query.limit ?? 100);
  try {
    res.json({ log: await seasonPointsLog(Number.isFinite(limit) ? limit : 100) });
  } catch (e) {
    console.error("[season-points] failed:", (e as Error).message);
    res.status(500).json({ error: "season points log unavailable" });
  }
});

// Internal wedge metrics (read-only, admin). All-time over the data we log.
app.get("/api/metrics", requireAdmin, async (_req, res) => {
  try {
    res.json(await metricsSummary());
  } catch (e) {
    console.error("[metrics] failed:", (e as Error).message);
    res.status(500).json({ error: "metrics query failed (see server logs)" });
  }
});

/* --------------------------------------------------------------- settlement --
 * The resolution loop. Every open position's market is checked against its
 * venue's OWN verdict — never inferred from a market merely dropping out of the
 * live set (delistings, tag drift and venue outages all look like that too).
 *
 * A market still trading at a real price is skipped without a network call, so
 * the sweep's cost scales with markets that might have resolved, not with all
 * open positions. Idempotency lives in the store (`WHERE closed_at IS NULL`),
 * so an overlapping or repeated sweep can only ever settle a position once.
 */
// Local demos and tests only: lets a dev box trigger settlement through the API.
// The env var is not set on Railway, so the route does not exist in production —
// resolution there comes only from the sweep reading the venue's own verdict.
if (process.env.ALLOW_TEST_SETTLE === "1") {
  app.post("/api/_settle", async (req, res) => {
    const { slug, outcome } = req.body as { slug?: string; outcome?: string };
    if (!slug || (outcome !== "yes" && outcome !== "no")) return res.status(400).json({ error: "slug and outcome required" });
    const settled = await settleMarket(slug, outcome);
    await emailSettled(slug, outcome, settled);
    res.json({ settled });
  });
}

/**
 * The email leg of settlement outreach: every settled position whose owner has
 * a verified Google address gets exactly one message. Failures are logged and
 * swallowed — the tokens are already paid; mail is a courtesy, not a ledger.
 */
async function emailSettled(slug: string, outcome: "yes" | "no", settled: { deviceId: string | null; side: "yes" | "no"; stake: number; entryPct: number; proceeds: number }[]): Promise<void> {
  try {
    const rec = await getSlug(slug);
    const question = rec?.market.question ?? slug;
    const devices = [...new Set(settled.map((x) => x.deviceId).filter((d): d is string => Boolean(d)))];
    const emails = await emailsFor(devices);
    for (const p of settled) {
      const to = p.deviceId ? emails[p.deviceId] : undefined;
      if (!to) continue;
      await sendSettleMail({
        to, question, side: p.side, entryPct: p.entryPct, outcome,
        proceeds: p.proceeds, stake: p.stake,
        positionsUrl: `${BASE_URL}/feed#/positions`,
      });
    }
  } catch (err) {
    console.error("[mail] settle batch failed:", (err as Error).message);
  }
}

const SWEEP_EVERY_MS = 10 * 60_000;
let sweeping = false;

export async function sweepSettlements(): Promise<void> {
  if (sweeping) return; // one sweep at a time; the next tick catches anything missed
  sweeping = true;
  try {
    const slugs = await openSlugs();
    if (slugs.length === 0) return;
    const { all } = await getMarketData();
    for (const slug of slugs) {
      const rec = await getSlug(slug, all);
      if (!rec) continue;
      const live = all.find((m) => m.venue === rec.market.venue && m.venueId === rec.market.venueId);
      if (live && live.yesPct > 0 && live.yesPct < 100) continue; // still trading
      const outcome = await fetchResolution(rec.market.venue, rec.market.venueId);
      if (!outcome) continue; // closed-not-resolved, unlisted, or a venue hiccup: wait
      const settled = await settleMarket(slug, outcome);
      if (settled.length > 0) {
        console.log(`[settle] ${slug} -> ${outcome}: ${settled.length} position(s), ${settled.reduce((s, x) => s + x.proceeds, 0)} tokens paid`);
        await emailSettled(slug, outcome, settled);
      }
    }
  } catch (err) {
    console.error("[settle] sweep failed:", (err as Error).message);
  } finally {
    sweeping = false;
  }
}
setInterval(sweepSettlements, SWEEP_EVERY_MS).unref();
setTimeout(sweepSettlements, 45_000).unref(); // first pass shortly after boot, once venues are warm

// "Your market closes soon" — a return trigger driven by the passage of time,
// not an event, so it needs its own clock rather than a hook in placeCall.
// Longer interval than the settlement sweep: urgency here is measured in
// hours, not minutes, and notifyClosingSoon() is itself idempotent (the
// per-device "already notified" check lives in the store), so a slower
// cadence just means "closes in 24h" might occasionally read "closes in 23h"
// by the time it's caught — never a duplicate, never a miss.
const CLOSING_SOON_SWEEP_MS = 30 * 60_000;
let sweepingClosingSoon = false;
async function sweepClosingSoon(): Promise<void> {
  if (sweepingClosingSoon) return;
  sweepingClosingSoon = true;
  try {
    const sent = await notifyClosingSoon();
    if (sent > 0) console.log(`[notify] closing-soon: ${sent} notice(s) sent`);
  } catch (err) {
    console.error("[notify] closing-soon sweep failed:", (err as Error).message);
  } finally {
    sweepingClosingSoon = false;
  }
}
setInterval(sweepClosingSoon, CLOSING_SOON_SWEEP_MS).unref();
setTimeout(sweepClosingSoon, 60_000).unref(); // first pass shortly after boot

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () =>
  console.log(
    `oddie on ${BASE_URL} (port ${PORT}) — semantic matching ${semanticEnabled() ? "ON" : `OFF (set ${SEMANTIC_KEY_ENV} to enable)`}; claim extraction ${extractEnabled() ? "ON" : `OFF (set ${EXTRACT_KEY_ENV} to enable)`}; settle mail ${mailEnabled() ? "ON" : `DRY-RUN (set ${MAIL_KEY_ENV} to send)`}`,
  ),
);
