import express from "express";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { getMarketData } from "./venues/index.js";
import type { Market } from "./venues/types.js";
import { nearTwins } from "./matching/matcher.js";
import { matchSemantic, matchVenue, replyCopy, semanticEnabled, SEMANTIC_KEY_ENV } from "./matching/semantic.js";
import { categorize, categorizeText, CATEGORIES } from "./matching/categorize.js";
import { createSlug, getSlug, placeCall, getWallet, positionsFor, sellPosition, leaderboard, recordEvent, slugFor, EVENT_NAMES, ensureHandle, setHandle, noticesFor, settleMarket, openSlugs, resolveDevice, crowdSplits, mintShareToken, getShareCall, accuracyFor, claimStatus, claimDaily, categoryHistoryFor, communityPlayerCounts, MARKET_FORMING_MIN, logPageView, metricsSummary, deviceForHandle, resolvedCallsFor, badgesFor, seasonRankFor, surfacersFor, SEASON_POINTS, callersFor, recentlySettled, homeActivity, celebrationsFor, markCelebrationsSeen, notifyClosingSoon, openCallsSummaryFor, weeklyScoreDeltaFor, rankMovementFor, isNewUserFor, claimTagTeachingMoment, CALL_COST } from "./store/markets.js";
import { fetchResolution } from "./venues/resolution.js";
import { emailsFor, mentionCandidates, markMentioned, mintShareTokenForMention, gateFor, addToAllowlist, allowlistRows, streakFor, leaderboardStreaks, leaderboardWinnings } from "./store/markets.js";
import { createCommunityMarket, setCommunityOnchain, openCommunityMarkets, adminListCommunity, communityMarketDetail, markCommunityResolved, logExtraction, logTweetReply, listTweetReplies, type CommunityMarket } from "./store/markets.js";
import { recordSurfacer, awardSurface, seasonPointsLog, usersActivity } from "./store/markets.js";
import { reputationFor } from "./store/markets.js";
import { resolvedOnchainMarkets } from "./store/markets.js";
import { creatorFeesPaidFor } from "./store/markets.js";
import { creatorStatsFor } from "./store/markets.js";
import { communityPoolSizes } from "./store/markets.js";
import { communityRecentCalls } from "./store/markets.js";
import { leaderboardCreators, marketsSurfacedBy } from "./store/markets.js";
import { sortFeedItems, isFeedSort } from "./venues/feedSort.js";
import type { SurfacerInfo } from "./store/markets.js";
import { logRealFeeIntent, feeLog } from "./store/markets.js";
import { setFeaturedMarkets, getFeaturedSlugs } from "./store/markets.js";
import { runExtract, extractEnabled, EXTRACT_KEY_ENV } from "./matching/extractClaim.js";
import { buildTweetReply, buildTweetQuote } from "./matching/tweetReply.js";
import { winBonus, CREATOR_FEE_BPS_PLAY, CREATOR_FEE_BPS_REAL, PROTOCOL_FEE_BPS_REAL } from "./store/economy.js";
import {
  mintMarket, isChainEnabled, onchainEnabled, explorerUrl, adminAddress, adminBalanceSol,
  resolveMarketOnChain, fetchMarketOnChain, fetchPosition, preparePositionTx, prepareClaimTx, isValidPubkeyString,
} from "./chain/oddieChain.js";
import { resolveClientCountry } from "./geo/resolveClientCountry.js";
import { GEOBLOCK_LIST_VERIFIED, venueRealMoneyAllowed } from "./geo/restrictedRegions.js";
import { JUPITER_PREDICT_ENABLED, prepareVenueOrderTx, fetchJupiterPolymarketMarkets } from "./venues/jupiterPredict.js";
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
// Real client IPs, not the reverse proxy's — required for the real-money
// geofence (see src/geo/resolveClientCountry.ts) to read X-Forwarded-For
// instead of reporting Railway's own edge address for every request.
app.set("trust proxy", true);
app.use(express.json());

const BASE_URL = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FEED_HTML = readFileSync(path.join(__dirname, "../public/feed.html"), "utf8");
const TOOL_HTML = readFileSync(path.join(__dirname, "../public/tool.html"), "utf8");
const LANDING_HTML = readFileSync(path.join(__dirname, "../public/landing.html"), "utf8");

// Static assets — favicons, touch/PWA icons, the manifest, the raw logos. The two
// HTML documents keep their own routes (/feed, /tool), and /card, /market are
// dynamic, so this only ever answers for real files. oddie.fun points straight at
// this service, so these are served here from ./public — one origin, no proxy
// allow-list to keep in sync, so the whole /api/ev class of rewrite gaps is gone.
app.use(express.static(path.join(__dirname, "../public"), { index: false, maxAge: "7d" }));

/**
 * The public landing page, served at "/".
 *
 * It is a SEPARATE DOCUMENT from the app, not a view inside it. The two have
 * different jobs and the split is deliberate:
 *
 *  - Cold traffic arrives here from X, overwhelmingly on a phone, and pays for
 *    whatever the front door weighs. The app shell is ~335KB of markup, CSS and
 *    JS that exists to render a logged-in feed; none of it is needed to show a
 *    headline. Landing at "/" used to mean downloading the entire app to read
 *    one sentence.
 *  - The landing commits to one dark, marketing-typography look with no app
 *    chrome. Expressing that inside the app shell means overlaying the shell's
 *    own header, tab bar, guest bar and balance pill, which is a fight that is
 *    won only with position:fixed and z-index, and lost again on every phone.
 *  - The share card, title and description that oddie.fun throws on X belong to
 *    the landing; the app's belong to the app.
 *
 * The app is unchanged and still lives at /feed. Anyone whose browser already
 * carries a device id is bounced there by the landing's own first script, so a
 * returning player never has to read the pitch again.
 *
 * The hero art carries no cards: the painting reads as one picture and they
 * were sitting on top of it. Real markets live in the band BELOW the fold, and
 * that band has two states.
 *
 * A launch-day landing with a "Live on Oddie" shelf holding two markets claims
 * more than the product has, and an empty one claims it and fails. So the band
 * counts what actually exists: under LANDING_LIVE_MIN real markets it teaches
 * the loop instead ("see how a post becomes a market"), and at or above it the
 * same slot becomes proof. One number decides, and nothing about the page has
 * to be edited when it flips.
 */
const LANDING_TTL_MS = 60_000;
const LANDING_LIVE_MIN = 15;    // real markets before the band becomes a shelf
const LANDING_LIVE_CARDS = 6;
let landingCache: { html: string; at: number } | null = null;

/** Escapes text for HTML TEXT position and for a double-quoted attribute. */
const escHtml = (s: string): string =>
  s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));

async function renderLanding(): Promise<string> {
  const fresh = landingCache && Date.now() - landingCache.at < LANDING_TTL_MS;
  if (fresh) return landingCache!.html;

  // Both degrade rather than erroring: the front door has to render even when
  // everything behind it is down. A failed community read counts as zero real
  // markets, which shows the teaching state — the safe way to be wrong.
  const [data, community] = await Promise.all([
    getMarketData().catch(() => null),
    openCommunityMarkets().catch((e) => {
      console.error("[landing] community load failed:", (e as Error).message);
      return [] as Awaited<ReturnType<typeof openCommunityMarkets>>;
    }),
  ]);

  const liveMode = community.length >= LANDING_LIVE_MIN ? "1" : "0";
  // Only built when it will actually be shown. Newest first, same ordering the
  // app's own feed uses for community markets.
  const liveCards = liveMode === "0" ? "" : [...community]
    .sort((a, b) => b.marketId - a.marketId)
    .slice(0, LANDING_LIVE_CARDS)
    .map((m) => {
      const yes = Math.max(0, Math.min(100, Math.round(Number(m.yesPct ?? 0))));
      return `<a class="lcard" href="/m/${escHtml(slugFor(m))}">
      <div class="lcard__top"><span>${escHtml(String(m.category ?? "Market"))}</span><span class="lcard__live">Live</span></div>
      <p class="lcard__q">${escHtml(String(m.question ?? ""))}</p>
      <div class="lcard__bar"><i style="width:${yes}%"></i></div>
      <div class="lcard__odds"><span class="qcard__yes">${yes}% YES</span><span class="qcard__no">${100 - yes}% NO</span></div>
    </a>`;
    }).join("");

  // The whole clause or none of it. A count of zero is not a smaller number to
  // print, it is the absence of an answer: the venue cache is empty for the
  // first seconds after a boot, and "0 markets live right now" is a worse thing
  // to say on the front door than saying nothing.
  const n = data ? data.markets.length : 0;
  const proof = n > 0 ? `<b>${n.toLocaleString("en-US")}</b> markets live right now.` : "";
  // The hero art. public/portal.png is the painted scene; when it is absent the
  // landing falls back to the vector one drawn inline in the page, so a missing
  // file degrades to a different picture rather than to a broken image icon.
  // Checked per render rather than at boot, so dropping the file in takes effect
  // once the 60s render cache below rolls over — no restart needed.
  const hasArt = existsSync(path.join(__dirname, "../public/portal.png")) ? "1" : "0";

  const html = LANDING_HTML
    .replace("<!--PROOF-->", proof)
    .replace("<!--HAS_ART-->", hasArt)
    .replace("<!--LIVE_MODE-->", liveMode)
    .replace("<!--LIVE_CARDS-->", liveCards);

  // Only a COMPLETE render earns a place in the cache. Caching a degraded one
  // pins whatever was missing at boot to the front door for the next full
  // minute; leaving it uncached means the very next request repairs it.
  if (n > 0) landingCache = { html, at: Date.now() };
  return html;
}

app.get("/", async (_req, res) => {
  try {
    res.type("html").send(await renderLanding());
  } catch (e) {
    // Absolute last resort: serve the shell unsubstituted rather than a 500.
    console.error("[landing] render failed:", (e as Error).message);
    res.type("html").send(LANDING_HTML);
  }
});

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
  // pricingSet(), not getMarketData() alone: a shared permalink for a
  // community market must unfurl with its real live odds, not the stored
  // opening line — getMarketData() only ever knows about Kalshi/Polymarket.
  const all = await pricingSet();
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
  const [rep, recentCalls, hd, weeklyDelta] = await Promise.all([
    reputationFor(deviceId), resolvedCallsFor(deviceId, 20), displayHandle(deviceId), weeklyScoreDeltaFor(deviceId),
  ]);
  res.json({
    exists: true, handle: hd.handle, accuracy: { ...rep.accuracy, weeklyDelta },
    recentCalls, badges: rep.badges, rank: rep.rank,
    tier: rep.tier, topCategory: rep.topCategory, flexLine: rep.flexLine,
  });
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
  // Discovery mode — For You / Trending / New / Resolving Soon. A lens over
  // the same set, never a filter; see feedSort.ts for each mode's rule and
  // the honesty constraints behind it.
  const sortRaw = String(req.query.sort ?? "foryou");
  const sort = isFeedSort(sortRaw) ? sortRaw : "foryou";
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
  // Predictions staked, not headcount — see communityPoolSizes. The card shows
  // both because they answer different questions ("how much is riding on this"
  // vs "how many people care") and diverge the moment anyone doubles down.
  const poolSizes = await communityPoolSizes(community.map((m) => slugFor(m))).catch(() => ({} as Record<string, number>));
  // Calls in the last 24h — the "happening now" signal. See communityRecentCalls.
  const recentCalls = await communityRecentCalls(community.map((m) => slugFor(m)), 24).catch(() => ({} as Record<string, number>));
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
      creatorFeeBps: CREATOR_FEE_BPS_PLAY, // transparency: shown on the card, see feed.html's fee-note
      poolTokens: poolSizes[slug] ?? 0,
      callsToday: recentCalls[slug] ?? 0,
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

  // Discovery-mode ordering, applied over the assembled list. "foryou" is a
  // no-op by design — the source-aware order above IS the For You ranking.
  feedItems = sortFeedItems(feedItems, sort);

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
        ...(isCommunity ? { community: true as const, onchain: null, creatorFeeBps: CREATOR_FEE_BPS_PLAY } : {}),
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
    () => ({} as Record<string, SurfacerInfo>),
  );
  // "Who called what" is permalink-only: fetching it for every card in the feed
  // would be an N+1 query across a whole page, so it's scoped to just the
  // pinned start market.
  const callers = start ? await callersFor(start.slug, 20).catch(() => null) : null;
  // What each market's tagger actually earned, for the cards that can show a
  // receipt instead of a promise. Only ever non-empty for RESOLVED markets —
  // the fee is paid at settlement — so in practice this populates the
  // permalink of a settled market, not the open ones filling the feed.
  const feesPaid = await creatorFeesPaidFor(feedItems.filter((x) => x.community).map((x) => x.slug))
    .catch(() => ({} as Record<string, { amount: number; handle: string | null }>));
  const withCrowd = feedItems.map((x) => {
    const surfacer = surfacers[x.slug];
    const paid = feesPaid[x.slug];
    const extra: Record<string, unknown> = {
      ...x,
      crowd: crowd[x.slug] ?? { yes: 0, no: 0 },
      challengeHandle: surfacer?.handle ?? null,
      sourceUrl: surfacer?.sourceUrl ?? null,
      // The source post itself, so a card can SHOW the claim it came from
      // rather than only linking to it. Null whenever we never got the text
      // (private/deleted post, or oEmbed unreachable at record time).
      sourcePost: x.community && surfacer?.sourceText
        ? { text: surfacer.sourceText, author: surfacer.sourceAuthor, handle: surfacer.handle, url: surfacer.sourceUrl }
        : null,
      // Tagging provenance, sent for every community market: the card exists
      // because a person tagged a claim, and that has to be visible on the
      // card itself rather than inferable from the "community market" chip.
      // null handle = tagged anonymously (real tag, no linked handle) — the
      // client renders "anonymous", never a fabricated name.
      taggedBy: x.community ? (surfacer?.handle ?? null) : null,
      creatorFeePaid: paid ? paid.amount : 0,
    };
    if (callers && start && x.slug === start.slug) {
      extra.callers = callers.callers;
      extra.callersTotal = callers.total;
    }
    return extra;
  });

  const chips: string[] = CATEGORIES.filter((c) => c !== "Other");
  if (community.length) chips.push("Community");
  res.json({ categories: ["For you", ...chips], items: withCrowd, sort });
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
async function resolveFeatured(n = 4, prefCats: string[] = []): Promise<Array<Record<string, unknown> & { slug: string }>> {
  let community: CommunityMarket[] = [];
  try { community = await openCommunityMarkets(); }
  catch (e) { console.error("[home] community load failed:", (e as Error).message); }
  if (!community.length) return [];

  // Most recent first, but a market in a category the visitor said they have
  // takes on outranks a newer one they don't care about. This RE-RANKS, it
  // never filters — someone who picked Crypto still sees Sports below it, the
  // same "breadth stays visible" rule /api/feed's own `cats` handling follows.
  // Community markets carry their real topic in `category` (the flattened
  // "Community" label is a display concern applied later), so this is a
  // direct comparison, no re-categorisation needed.
  const pref = new Set(prefCats);
  const sorted = [...community].sort((a, b) => {
    if (pref.size) {
      const ap = pref.has(a.category) ? 0 : 1, bp = pref.has(b.category) ? 0 : 1;
      if (ap !== bp) return ap - bp;
    }
    return b.marketId - a.marketId; // then most recent first
  });
  const slugs = sorted.map((m) => slugFor(m));
  const playerCounts = await communityPlayerCounts(slugs).catch(() => ({} as Record<string, number>));
  const poolSizes = await communityPoolSizes(slugs).catch(() => ({} as Record<string, number>));
  const recentCalls = await communityRecentCalls(slugs, 24).catch(() => ({} as Record<string, number>));

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
    surfacersFor(chosenSlugs).catch(() => ({} as Record<string, SurfacerInfo>)),
  ]);

  // THE FIRST-TRY SLOT RULE. Slot 0 is a brand-new visitor's entire first
  // impression (the cued "try it" card), and recency/activity order was
  // choosing it by accident — live it served a 93/7 niche transfer market
  // "tagged by anonymous": a consensus, not an argument, paying 1.1x on the
  // side the cue points at. When the admin hasn't pinned an explicit order,
  // promote ONE card into slot 0 by argument quality: odds inside 40-60
  // (both sides genuinely worth arguing, either pick pays ~2x) scores
  // highest, a NAMED tagger (the provenance story on its feet) breaks ties.
  // Everything else keeps its activity/recency order — this is a promotion,
  // not a re-sort — and explicit admin picks are never touched.
  if (!explicitSlugs.length && chosen.length > 1) {
    const tryScore = (m: CommunityMarket): number => {
      const inBand = m.yesPct >= 40 && m.yesPct <= 60 ? 2 : 0;
      const named = surfacers[slugFor(m)]?.handle ? 1 : 0;
      return inBand + named;
    };
    let best = 0;
    for (let i = 1; i < chosen.length; i++) if (tryScore(chosen[i]) > tryScore(chosen[best])) best = i;
    if (best > 0 && tryScore(chosen[best]) > tryScore(chosen[0])) {
      chosen.unshift(chosen.splice(best, 1)[0]);
    }
  }
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
      creatorFeeBps: CREATOR_FEE_BPS_PLAY,
      poolTokens: poolSizes[slug] ?? 0,
      callsToday: recentCalls[slug] ?? 0,
      crowd: crowd[slug] ?? { yes: 0, no: 0 },
      challengeHandle: surfacer?.handle ?? null,
      // See the same fields in /api/feed: every community card carries who
      // tagged it. These are all OPEN markets (openCommunityMarkets), and the
      // creator fee only pays at settlement, so creatorFeePaid is 0 here by
      // construction — the card shows the forward-looking "+3%" framing.
      taggedBy: surfacer?.handle ?? null,
      creatorFeePaid: 0,
      sourcePost: surfacer?.sourceText
        ? { text: surfacer.sourceText, author: surfacer.sourceAuthor, handle: surfacer.handle, url: surfacer.sourceUrl }
        : null,
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
  // The visitor's picked categories, same shape and same validation as
  // /api/feed's `cats` — the client sends whatever the taste picker stored.
  // Used to re-rank (never filter) the community markets below.
  const prefCats = String(req.query.cats ?? "").split(",").map((x) => x.trim())
    .filter((x) => (CATEGORIES as readonly string[]).includes(x)).slice(0, 3);
  // Every section degrades to absent on failure, never to a fake: the client
  // renders each one only when its array is non-empty (see renderHome).
  const [featured, settled, board, activity, openCalls, newUser] = await Promise.all([
    resolveFeatured(HOME_FEATURED_POOL, prefCats).catch((e) => { console.error("[home] resolve failed:", (e as Error).message); return []; }),
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
  // The viewer's OWN two identities, for the right rail: how good their CALLS
  // are (reputationFor) and how good their MARKETS are (creatorStatsFor).
  // Deliberately two objects, not one merged "stats" blob — they answer
  // different questions and the rail shows them as two separate panels.
  const [me, creator] = deviceId
    ? await Promise.all([
        reputationFor(deviceId).catch(() => null),
        creatorStatsFor(deviceId).catch(() => null),
      ])
    : [null, null];
  // The rail's "Top creators" teaser — same rows the Leaderboard's creator
  // board shows, so the teaser and the page it links to can never disagree.
  const topCreators = (await leaderboardCreators(3).catch(() => []))
    .map((r, i) => ({ rank: i + 1, handle: r.handle, earnings: r.earnings, marketsCreated: r.marketsCreated }));
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
  res.json({
    featured, settled, topCallers, activity, openCalls, newUser,
    surfaceReward: SEASON_POINTS.surface, featuredShown: HOME_FEATURED_SHOWN,
    // The right rail's two panels. `me` is the caller identity (accuracy,
    // rank, tier), `creator` is the market-maker one (fees earned, markets
    // made, traders reached). Null for a device we don't know yet.
    topCreators,
    me: me ? {
      handle: me.handle, accuracyPct: me.accuracy.accuracyPct, resolved: me.accuracy.resolved,
      hasEnough: me.accuracy.hasEnough, minResolved: me.accuracy.minResolved,
      oddieScore: me.accuracy.oddieScore, rank: me.rank, tier: me.tier,
      topCategory: me.topCategory, streak: me.accuracy.streak,
    } : null,
    creator,
  });
});

/**
 * The creator's own dashboard — every market this device tagged, with pool,
 * callers and fees earned per market. Device-scoped, not admin: it only ever
 * reveals markets the asking device created and numbers that are public on
 * the cards anyway.
 */
app.get("/api/my-markets", async (req, res) => {
  const q = req.query.deviceId;
  const deviceId = typeof q === "string" && DEVICE_ID.test(q) ? q : null;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const markets = await marketsSurfacedBy(deviceId, 50).catch(() => []);
  res.json({ markets });
});

/**
 * Slug data (JSON) for anything that needs one market. Resolves against the raw
 * set: a link already in the wild keeps working, and keeps showing live odds,
 * even after the market drifts past 96%.
 */
app.get("/api/market/:slug", async (req, res) => {
  // This is what the client renders a permalink page FROM — same reasoning as
  // the /m/:slug route above: pricingSet(), so a community market's live pool
  // price actually reaches the page, not just its own card in the feed.
  const all = await pricingSet();
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
  // One read for every reputation surface — see reputationFor. The card, the
  // profile API and the leaderboard all describe a person from this same
  // object, so they cannot disagree about what someone is.
  const [rep, hd] = await Promise.all([reputationFor(deviceId), displayHandle(deviceId)]);
  const acc = rep.accuracy;
  const png = renderCardPng(renderProfileCard({
    handle: hd.handle, oddieScore: acc.oddieScore, accuracyPct: acc.accuracyPct,
    streak: acc.streak, resolved: acc.resolved, hasEnough: acc.hasEnough,
    badges: rep.badges.map((b) => ({ label: b.label, kind: b.kind })),
    rankTopPct: rep.rank ? rep.rank.topPct : null,
    tierLabel: rep.tier ? rep.tier.label : null, flexLine: rep.flexLine,
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
 * Paper trading, phase 1. Virtual predictions only: every device starts with a
 * small handful (STARTING_PREDICTIONS), each call spends exactly one
 * (CALL_COST), and nothing anywhere converts a prediction to or from money.
 * The device id is the only key — no account, no PII.
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

// The /api/onboarding/tour-seen endpoint lived here. Removed with the guided
// tour itself (see the tombstone in feed.html) — nothing calls it, and a
// dead one-shot endpoint invites someone to resurrect the tour through it.

/**
 * Open positions carry today's price so the hold-or-sell decision can be made
 * on the screen that offers it. Closed ones carry the edge they scored, and the
 * reputation is the average of exactly those — including the losses.
 */
app.get("/api/positions", async (req, res) => {
  const q = req.query.deviceId;
  const deviceId = typeof q === "string" && DEVICE_ID.test(q) ? q : null;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  // pricingSet(): an open community-market position's nowPct/edgeNow/valueNow
  // all come from this set (see positionsFor) — venue-only data would make
  // every open community position read as "the venue isn't quoting this",
  // permanently, since community markets were never IN getMarketData() at all.
  const all = await pricingSet();
  const [wallet, positions, streak] = await Promise.all([getWallet(deviceId), positionsFor(deviceId, all), streakFor(deviceId)]);
  res.json({ ...positions, tokens: wallet.tokens, streak });
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
    // The staleness gate is a venue-data concern (a Kalshi/Polymarket fetch
    // failure serving a cached price is exactly when NOT to let someone sell
    // into it) — checked against getMarketData() alone, on purpose. But the
    // set actually PRICING the sell has to include community markets too, or
    // livePctOf never finds the market and every community-market sell fails
    // as "unpriced" — this was true before today's live-pricing change as
    // well, since getMarketData() never included community markets at all.
    const data = await getMarketData();
    if (data.stale) return res.status(503).json({ ok: false, reason: "stale-odds" });
    let community: CommunityMarket[] = [];
    try { community = await openCommunityMarkets(); } catch (e) { /* best-effort, matches pricingSet's own tolerance */ }
    const result = await sellPosition(id, deviceId, [...data.all, ...community]);
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
  const [edge, streaks, winnings, creators] = await Promise.all([leaderboard(20), leaderboardStreaks(20), leaderboardWinnings(20), leaderboardCreators(20).catch(() => [])]);
  // The viewer's OWN standing, sent alongside the boards. A leaderboard whose
  // top 20 you aren't in tells you nothing about yourself, which is exactly
  // the "accuracy accumulates, so what?" complaint — this is the answer:
  // where you actually stand, what tier that earns, and what to say about it.
  const you = me ? await reputationFor(me).catch(() => null) : null;
  res.json({
    you: you ? {
      handle: you.handle, rank: you.rank, tier: you.tier,
      flexLine: you.flexLine, topCategory: you.topCategory,
      accuracyPct: you.accuracy.accuracyPct, resolved: you.accuracy.resolved,
      hasEnough: you.accuracy.hasEnough, minResolved: you.accuracy.minResolved,
    } : null,
    rows: edge.map((r, i) => ({
      rank: i + 1, handle: r.handle, you: r.deviceId === me,
      avgEdge: Math.round(r.avgEdge * 10) / 10, closed: r.closed, provisional: r.provisional,
      accuracyPct: r.accuracyPct,
    })),
    streaks: streaks.map((r, i) => ({ rank: i + 1, handle: r.handle, you: r.deviceId === me, current: r.current, best: r.best })),
    winnings: winnings.map((r, i) => ({ rank: i + 1, handle: r.handle, you: r.deviceId === me, net: r.net, closed: r.closed })),
    // The creator board — who is good at MAKING markets. See leaderboardCreators.
    creators: creators.map((r, i) => ({ rank: i + 1, handle: r.handle, you: r.deviceId === me, earnings: r.earnings, marketsCreated: r.marketsCreated })),
  });
});

/**
 * Place a call. Insufficient balance is a 200 with ok:false rather than an
 * error status: the client caps the picker at the balance, so hitting this
 * means two tabs raced — a state to render, not a failure to throw.
 */
app.post("/api/market/:slug/call", async (req, res) => {
  const side = req.body?.side;
  const deviceId = deviceIdOf(req.body);
  if (side !== "yes" && side !== "no") return res.status(400).json({ error: "side must be yes|no" });
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  // No rope on voting: any device — anonymous or signed in — may place calls
  // with its free predictions. Signing in is optional (it just attaches an
  // identity that follows you across devices). This is what makes a seeded
  // reply link playable the instant someone taps it.
  //
  // The stake is CALL_COST, always — never whatever the client sends. A call
  // costs exactly one prediction; there is no picker, no amount to choose, so
  // there is nothing here to trust the client for. (placeCall itself stays
  // generic — internal callers and the test suite still stake arbitrary
  // amounts — this route is the one place production enforces the flat cost.)
  const all = await pricingSet(); // venue markets + open community markets, so a community market can be entered
  const result = await placeCall(req.params.slug, side, CALL_COST, deviceId, all);
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
  <p style="margin:0 0 16px">Your spot on the Oddie beta just opened. Sign in with this Google account and you're playing — free, virtual predictions, nothing to cash out.</p>
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
      ? `@${r.handle} called ${r.side.toUpperCase()} at ${r.entryPct}% — resolved ${r.outcome.toUpperCase()} ✓ +${r.proceeds} predictions`
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
    const payoutIfWin = entry > 0 ? winBonus(entry) : 0; // what settlement will actually pay — see economy.winBonus
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
  // Real-stakes counterpart: resolve the SAME market on-chain so claim_winnings
  // has an outcome to pay against. Best-effort and entirely after the response-
  // determining work above — the real (virtual) economy never waits on devnet.
  if (isChainEnabled()) {
    void communityMarketDetail(slug).then((detail) => {
      if (!detail?.onchainPubkey) return;
      void resolveMarketOnChain(detail.onchainPubkey, outcome);
      // Real-money creator/protocol fee: logged as an audit-trail "intended
      // fee" only, never actually deducted — the deployed Solana program has
      // no fee instruction (see economy.ts + logRealFeeIntent). Read the
      // vault total straight from chain rather than trusting a stale value.
      void fetchMarketOnChain(detail.onchainPubkey).then((state) => {
        if (state) void logRealFeeIntent(slug, state.totalYesLamports + state.totalNoLamports);
      }).catch(() => {});
    }).catch(() => {});
  }
  res.json({ ok: true, slug, outcome, settled: settled.length });
});

/**
 * Real-stakes ("skin in the game"), opt-in and gated on BOTH ONCHAIN_ENABLED
 * (the env var) AND GEOBLOCK_LIST_VERIFIED (the legal sign-off on the CURRENT
 * restricted-jurisdictions list — see src/geo/restrictedRegions.ts). Neither
 * alone is enough: ops flipping the env var must not be able to go live on a
 * list nobody has actually cleared, and a verified list must not silently
 * arm the layer before ops has deliberately turned it on. Both flags are read
 * once at process boot and never change without a restart, so gating at
 * ROUTE REGISTRATION — not inside each handler — is safe and is the point:
 * with either flag off, everything below except /status is simply never
 * added to Express's routing table. A request to any of them 404s exactly
 * like a path that was never typed, not a custom "disabled" response — there
 * is nothing here to probe. The client mirrors this: it never renders a
 * trace of this UI, and never even fetches the other routes, unless /status
 * said enabled first.
 *
 * The server only ASSEMBLES transactions (prepare-position, prepare-claim); it
 * never holds or signs a user's funds. The user's own wallet signs and
 * broadcasts client-side. Compare admin-signed resolveMarketOnChain above,
 * which the SERVER's own authority key does sign — that instruction is
 * operator-only by the contract itself, not by anything client-controlled.
 */
// isChainEnabled() (flag + admin key present), not just onchainEnabled() (flag
// alone): resolveMarketOnChain — the ONLY way an on-chain market ever gets
// marked resolved, so claim_winnings has an outcome to pay against — is
// itself gated on isChainEnabled() at its call site in /api/community/resolve.
// If ONCHAIN_ENABLED were true but SOLANA_ADMIN_SECRET_KEY were missing, users
// could still open real-money positions (take_position needs no admin key),
// but resolution could never propagate on-chain — a real stake with no
// possible path to a resolved market, and therefore no possible claim. Gating
// on isChainEnabled() here closes that off before it can happen: real money
// is never accepted unless the admin key that resolves it is also present.
const realStakesReady = isChainEnabled() && GEOBLOCK_LIST_VERIFIED;

// The single boolean the client gates every trace of this UI behind (see
// initChainLayer in feed.html). Under REGIME 1 it is the master flag alone:
// the community parimutuel is open everywhere, so there is no geo term to
// fold in here any more. GEOBLOCK_LIST_VERIFIED still gates it — the list is
// what REGIME 2 will enforce, and shipping a real-money surface on an
// unreviewed list stays forbidden regardless of which regime uses it.
/**
 * GEO REGIMES — counsel splits real-money surfaces into separate regimes
 * rather than applying one global rule. There are two, and only one exists:
 *
 *   REGIME 1 · "community" (our own parimutuel) — OPEN TO ALL. No
 *     jurisdiction is blocked. Counsel's position is that our own parimutuel
 *     is fine everywhere, so this surface does not deny anyone. Geo is still
 *     RESOLVED on every request and logged when it lands on a sanctioned
 *     location, so the machinery stays live, exercised and observable — the
 *     safety net is wired, it just isn't pulled. Everything under
 *     /api/chain/* today is community-only (every route keys off
 *     communityMarketDetail), which is why removing the gate here is safe.
 *
 *   REGIME 2 · "venue" (Polymarket-sourced markets) — NOT IMPLEMENTED, and
 *     must not be switched on by reusing this regime. It has to satisfy BOTH
 *     Polymarket's sub-national US blocks AND the source API's own ToU
 *     jurisdiction list, which are stricter and mutually inconsistent (the
 *     latter blocks the entire US). See geoRegimeVenueUnavailable below —
 *     that function exists so a future Polymarket path fails loudly instead
 *     of silently inheriting "open to all" from the community regime.
 */
function noteGeoForCommunity(req: express.Request): void {
  const geo = resolveClientCountry(req);
  if (geo.restricted) {
    // Observed, never enforced on this surface — see REGIME 1 above.
    console.log(JSON.stringify({ evt: "geo_note", regime: "community", country: geo.country, source: geo.source }));
  }
}

/**
 * REGIME 2's single gate. Every venue real-money surface goes through this and
 * nothing else — one function so there is exactly one place to audit, and so
 * no route can accidentally implement a laxer version of the rule.
 *
 * Order matters. The contractual clearance is checked first because it is the
 * broadest condition (no jurisdiction is allowed while it is open), then the
 * geo, which inherits resolveClientCountry's fail-CLOSED behaviour: an IP we
 * cannot place is refused, not waved through. That is the opposite of REGIME
 * 1's posture and deliberately so — our own parimutuel blocks nobody, a
 * sourced venue blocks anyone we can't positively clear.
 */
function venueRealMoneyReady(req: express.Request): boolean {
  if (!realStakesReady) return false;             // master flag + verified list
  if (!JUPITER_PREDICT_ENABLED) return false;     // venue source switched off
  return venueRealMoneyAllowed(resolveClientCountry(req));
}

app.get("/api/chain/status", (req, res) => {
  // Community-only surface: the master flag decides, not the geofence.
  noteGeoForCommunity(req);
  res.json({ enabled: realStakesReady });
});

/**
 * REGIME 2's client-facing boolean, deliberately SEPARATE from
 * /api/chain/status. Two surfaces with two different rules need two answers:
 * a user in the US gets community real-money (enabled) and venue real-money
 * (blocked) in the same session, and one shared boolean could only lie about
 * one of them.
 */
app.get("/api/venue/status", (req, res) => {
  res.json({ enabled: venueRealMoneyReady(req) });
});

/**
 * Build an unsigned Jupiter order for the user's own wallet to sign. Gated
 * identically to /api/venue/status — the status boolean hides the UI, this
 * check is the one that actually stops a stale client or a direct call. Both
 * read the same venueRealMoneyReady, so they cannot drift apart.
 */
app.post("/api/venue/order/prepare", async (req, res) => {
  if (!venueRealMoneyReady(req)) return res.status(451).json({ ok: false, reason: "venue-unavailable-in-region" });
  const marketId = String(req.body?.marketId ?? "");
  const userPubkey = String(req.body?.userPubkey ?? "");
  const isYes = req.body?.side === "yes";
  const depositAmount = Number(req.body?.depositAmount ?? 0);
  const depositMint = String(req.body?.depositMint ?? "");
  if (!marketId) return res.status(400).json({ error: "marketId required" });
  if (!isValidPubkeyString(userPubkey)) return res.status(400).json({ error: "invalid userPubkey" });
  if (req.body?.side !== "yes" && req.body?.side !== "no") return res.status(400).json({ error: "side must be yes|no" });
  if (!Number.isFinite(depositAmount) || depositAmount <= 0) return res.status(400).json({ error: "depositAmount must be positive" });
  if (!isValidPubkeyString(depositMint)) return res.status(400).json({ error: "invalid depositMint" });

  const built = await prepareVenueOrderTx({
    marketId, ownerPubkey: userPubkey, isYes, isBuy: true, depositAmount, depositMint,
  });
  if (!built) return res.status(502).json({ ok: false, reason: "venue-unreachable" });
  res.json({ ok: true, txBase64: built.txBase64 });
});

if (realStakesReady) {
  const MIN_STAKE_LAMPORTS = 1_000_000;    // 0.001 SOL — above rent/fee dust
  const MAX_STAKE_LAMPORTS = 5_000_000_000; // 5 SOL — a sane demo ceiling, not a protocol limit

  app.get("/api/chain/market/:slug", async (req, res) => {
    const detail = await communityMarketDetail(req.params.slug);
    if (!detail?.onchainPubkey) return res.json({ ok: false, reason: "not-minted" });
    const state = await fetchMarketOnChain(detail.onchainPubkey);
    if (!state) return res.json({ ok: false, reason: "unreachable" });
    res.json({
      ok: true, pubkey: detail.onchainPubkey, explorer: explorerUrl(detail.onchainPubkey),
      resolved: state.resolved, winningSide: state.winningSide,
      totalYesLamports: state.totalYesLamports, totalNoLamports: state.totalNoLamports,
      // Proposed rates only — surfaced for transparency, not yet deducted on
      // resolution (the deployed program has no fee instruction; see
      // economy.ts's CREATOR_FEE_BPS_REAL doc comment). realFeesEnforced:false
      // is what the client keys its "not yet enforced" copy off.
      realCreatorFeeBps: CREATOR_FEE_BPS_REAL, realProtocolFeeBps: PROTOCOL_FEE_BPS_REAL, realFeesEnforced: false,
    });
  });

  app.get("/api/chain/position", async (req, res) => {
    const slug = String(req.query.slug ?? "");
    const userPubkey = String(req.query.userPubkey ?? "");
    if (!isValidPubkeyString(userPubkey)) return res.status(400).json({ error: "invalid userPubkey" });
    const detail = await communityMarketDetail(slug);
    if (!detail?.onchainPubkey) return res.json({ ok: false, reason: "not-minted" });
    const position = await fetchPosition(detail.onchainPubkey, userPubkey);
    res.json({ ok: true, position });
  });

  app.post("/api/chain/position/prepare", async (req, res) => {
    // REGIME 1 (community): open to all — this route stakes ONLY on our own
    // parimutuel (see the communityMarketDetail lookup below, which is what
    // makes that true), and counsel's position is that our own parimutuel is
    // fine in every jurisdiction. So geo is resolved and logged, never
    // enforced. The 451 that used to live here was the correct behaviour
    // while one global rule covered every surface; it is wrong now that the
    // community regime is explicitly open, and a Polymarket path must bring
    // its OWN gate (geoRegimeVenueUnavailable) rather than resurrecting this
    // one, because the venue list is stricter and differently shaped.
    noteGeoForCommunity(req);
    const slug = String(req.body?.slug ?? "");
    const userPubkey = String(req.body?.userPubkey ?? "");
    const side = req.body?.side;
    const lamports = Number(req.body?.lamports ?? 0);
    if (!isValidPubkeyString(userPubkey)) return res.status(400).json({ error: "invalid userPubkey" });
    if (side !== "yes" && side !== "no") return res.status(400).json({ error: "side must be yes|no" });
    if (!Number.isInteger(lamports) || lamports < MIN_STAKE_LAMPORTS || lamports > MAX_STAKE_LAMPORTS) {
      return res.status(400).json({ error: `lamports must be between ${MIN_STAKE_LAMPORTS} and ${MAX_STAKE_LAMPORTS}` });
    }
    const detail = await communityMarketDetail(slug);
    if (!detail?.onchainPubkey) return res.status(404).json({ ok: false, reason: "not-minted" });
    if (detail.resolvedOutcome) return res.status(409).json({ ok: false, reason: "already-resolved" });
    const txBase64 = await preparePositionTx({ marketPubkey: detail.onchainPubkey, userPubkey, side, lamports });
    if (!txBase64) return res.status(502).json({ ok: false, reason: "chain-unreachable" });
    res.json({ ok: true, txBase64 });
  });

  /**
   * "Do I have real-money winnings to collect?" — the discoverability half of
   * the claim flow. A resolved market drops out of the feed, and the server
   * cannot notify an on-chain staker because it deliberately never stores a
   * wallet↔device link (see resolvedOnchainMarkets). So the wallet asks, and
   * we check the chain for it, market by market.
   *
   * NOT geofenced, on purpose and consistently with claim/prepare below:
   * this only ever reveals money the user already owns. Blocking a withdrawal
   * is a different and worse act than blocking a new wager.
   */
  app.get("/api/chain/claimable", async (req, res) => {
    const userPubkey = String(req.query.userPubkey ?? "");
    if (!isValidPubkeyString(userPubkey)) return res.status(400).json({ error: "invalid userPubkey" });
    const markets = await resolvedOnchainMarkets(40).catch(() => []);
    const found = await Promise.all(markets.map(async (m) => {
      const position = await fetchPosition(m.onchainPubkey, userPubkey).catch(() => null);
      if (!position || position.claimed) return null;
      if (position.side !== m.resolvedOutcome) return null;   // lost this one
      return { slug: m.slug, question: m.question, side: position.side, lamports: position.lamports, outcome: m.resolvedOutcome };
    }));
    res.json({ ok: true, claimable: found.filter(Boolean) });
  });

  app.post("/api/chain/claim/prepare", async (req, res) => {
    const slug = String(req.body?.slug ?? "");
    const userPubkey = String(req.body?.userPubkey ?? "");
    if (!isValidPubkeyString(userPubkey)) return res.status(400).json({ error: "invalid userPubkey" });
    const detail = await communityMarketDetail(slug);
    if (!detail?.onchainPubkey) return res.status(404).json({ ok: false, reason: "not-minted" });
    const txBase64 = await prepareClaimTx({ marketPubkey: detail.onchainPubkey, userPubkey });
    if (!txBase64) return res.status(502).json({ ok: false, reason: "chain-unreachable" });
    res.json({ ok: true, txBase64 });
  });
}

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

// Every creator/protocol fee — real (credited) and play (logged-only intent)
// — for auditability. See markets.ts's market_fee_log / feeLog.
app.get("/api/admin/fees", requireAdmin, async (req, res) => {
  const limit = Number(req.query.limit ?? 100);
  try {
    res.json({ log: await feeLog(Number.isFinite(limit) ? limit : 100) });
  } catch (e) {
    console.error("[fees] admin log fetch failed:", (e as Error).message);
    res.status(500).json({ error: "fee log unavailable" });
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
        console.log(`[settle] ${slug} -> ${outcome}: ${settled.length} position(s), ${settled.reduce((s, x) => s + x.proceeds, 0)} predictions paid`);
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
