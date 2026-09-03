import express from "express";
import { displayTitle } from "./title.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { timingSafeEqual, createHash } from "node:crypto";
import type { Market } from "./venues/types.js";
import { nearTwins } from "./matching/matcher.js";
import { matchSemantic, matchVenue, replyCopy, semanticEnabled, SEMANTIC_KEY_ENV } from "./matching/semantic.js";
import { categorize, categorizeText, CATEGORIES } from "./matching/categorize.js";
import { createSlug, getSlug, placeCall, getWallet, positionsFor, sellPosition, leaderboard, recordEvent, slugFor, EVENT_NAMES, ensureHandle, setHandle, noticesFor, settleMarket, openSlugs, resolveDevice, crowdSplits, mintShareToken, getShareCall, accuracyFor, categoryHistoryFor, communityPlayerCounts, MARKET_FORMING_MIN, logPageView, metricsSummary, deviceForHandle, resolvedCallsFor, badgesFor, achievementsFor, seasonRankFor, surfacersFor, SEASON_POINTS, callersFor, recentlySettled, homeActivity, celebrationsFor, markCelebrationsSeen, notifyClosingSoon, openCallsSummaryFor, weeklyScoreDeltaFor, rankMovementFor, isNewUserFor, claimTagTeachingMoment, CALL_COST, awardShare, botStateGet, PERSISTENT, setDeviceAvatar, clearDeviceAvatar, deviceAvatarImage, deviceAvatarStamp, parseAvatarDataUrl, avatarStampsForHandles, deviceForHandlePublic,
} from "./store/markets.js";
import { emailsFor, mentionCandidates, markMentioned, dismissMention, mintShareTokenForMention, gateFor, addToAllowlist, allowlistRows, streakFor, leaderboardStreaks, leaderboardWinnings, awardLoud, isoWeekOf, submitLoudPost, loudPostsFor, loudQueue, decideLoudPost, LOUD_DAILY_CAP, loudWinners, ODDIES_PER, loudStatusFor } from "./store/markets.js";
import { createCommunityMarket, setCommunityOnchain, openCommunityMarkets, adminListCommunity, communityMarketDetail, markCommunityResolved, logExtraction, logTweetReply, listTweetReplies, type CommunityMarket } from "./store/markets.js";
import { recordSurfacer, awardSurface, seasonPointsLog, usersActivity, surfacedSlugs, handleFromSourceUrl, sourceUrlKind, pctDeltasFor } from "./store/markets.js";
import { reputationFor } from "./store/markets.js";
import { resolvedOnchainMarkets } from "./store/markets.js";
import { creatorFeesPaidFor } from "./store/markets.js";
import { creatorStatsFor } from "./store/markets.js";
import { communityPoolSizes } from "./store/markets.js";
import { communityRecentCalls } from "./store/markets.js";
import { leaderboardCreators, marketsSurfacedBy } from "./store/markets.js";
import { sortFeedItems, isFeedSort } from "./venues/feedSort.js";
import type { SurfacerInfo } from "./store/markets.js";
import { claimKeyLookup, claimKeyRecord, takeQuotaToken, releaseQuotaToken, callerScope, refusalForText, recordRefusalForText, openMarketForSourcePost, recordChainEntry, chainEntryFor, slugForOnchainPubkey, emailsForWallets, walletsInMarket, walletReceipts, walletLeaderboard, openEntriesFor, receiptWeight, logRealFee, feeLog, onchainMarketsSurfacedBy, surfacerFor } from "./store/markets.js";
import { setFeaturedMarkets, getFeaturedSlugs } from "./store/markets.js";
import { runExtract, extractEnabled, EXTRACT_KEY_ENV } from "./matching/extractClaim.js";
import { inferenceProvider } from "./inference.js";
import { buildTweetReply, buildTweetQuote, buildVerdict } from "./matching/tweetReply.js";
import { winBonus, CREATOR_FEE_BPS_REAL, PROTOCOL_FEE_BPS_REAL, SCORE_WEIGHTS } from "./store/economy.js";
import {
  mintMarket, isChainEnabled, onchainEnabled, explorerUrl, adminAddress, adminBalanceSol, cluster, nameCreator, prepareCreatorFeeTx,
  resolveMarketOnChain, fetchMarketOnChain, fetchPosition, preparePositionTx, prepareClaimTx, submitSignedTx, isValidPubkeyString,
  takePositionFromTx, entryShareOf,
} from "./chain/oddieChain.js";
import { resolveClientCountry } from "./geo/resolveClientCountry.js";
import { GEOBLOCK_LIST_VERIFIED } from "./geo/restrictedRegions.js";
import { sendSettleMail, sendMail, settleMailBody, mailEnabled, MAIL_KEY_ENV } from "./mail.js";
import { TAGLINE } from "./brand.js";
import { renderCard, renderReceiptCard } from "./card/renderCard.js";
import { runMentionSweep, SWEEP_CAP } from "./x/mentionLoop.js";
import type { SweepDeps, SweepResult } from "./x/mentionLoop.js";
import * as X from "./x/client.js";
import { renderCardPng } from "./card/renderPng.js";
import { renderBanner } from "./card/renderBanner.js";
import { renderProfileCard } from "./card/renderProfileCard.js";
import { renderGenesisCard } from "./card/renderGenesisCard.js";
import { classifyArchetype, ARCHETYPE_LABEL } from "./genesis/archetype.js";
import { captureGenesisProfile, genesisProfileByHandle, genesisProfileForDevice, type GenesisProfile } from "./genesis/profileStore.js";
import { ticketsLeft, spendTicketForTag, creditFundedBettor, genesisStanding, genesisBoard, GENESIS_TICKETS } from "./genesis/season.js";
import { renderPositionCard } from "./card/renderPositionCard.js";
import { postResolution } from "./x/resolutionReply.js";
import { tweetCopy } from "./card/tweetCopy.js";
import { linkAccount, accountsFor } from "./store/accounts.js";
import { authorizeUrl, consume, identify, isConfigured, isProvider, missingSecretEnv, pkce, PROVIDERS, redirectUri, remember } from "./auth/oauth.js";
import { issueChallenge, consumeChallenge, verifyWalletSignature, shortAddress, WALLET_ADDRESS } from "./auth/wallet.js";

const app = express();
// Real client IPs, not the reverse proxy's — required for the real-money
// geofence (see src/geo/resolveClientCountry.ts) to read X-Forwarded-For
// instead of reporting Railway's own edge address for every request.
app.set("trust proxy", true);
app.use(express.json());

const BASE_URL = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FEED_HTML = readFileSync(path.join(__dirname, "../public/feed.html"), "utf8");
// A market page's own og/twitter tags replace this block rather than merely
// outranking it: see the SHARE-PREVIEW-BLOCK comment in feed.html for why
// "inject ours first and assume it wins" turned out not to hold for X.
// Computed once at load, not per-request: this route sees real crawler
// traffic every time a card gets shared.
const FEED_HTML_NO_SHARE_BLOCK = FEED_HTML.replace(
  /<!-- SHARE-PREVIEW-BLOCK-START[\s\S]*?SHARE-PREVIEW-BLOCK-END -->\n?/, "");
const TOOL_HTML = readFileSync(path.join(__dirname, "../public/tool.html"), "utf8");
const LANDING_HTML = readFileSync(path.join(__dirname, "../public/landing.html"), "utf8");
// Genesis campaign page. Read once at boot like every other static shell here,
// so an edit needs a restart to show up.
const GENESIS_HTML = readFileSync(path.join(__dirname, "../public/genesis.html"), "utf8");

// Static assets — favicons, touch/PWA icons, the manifest, the raw logos. The two
// HTML documents keep their own routes (/feed, /tool), and /card, /market are
// dynamic, so this only ever answers for real files. oddie.fun points straight at
// this service, so these are served here from ./public — one origin, no proxy
// allow-list to keep in sync, so the whole /api/ev class of rewrite gaps is gone.
/**
 * chain.js is exempt from the week, and it is the one file that has to be.
 *
 * It is the money surface: it names the network someone is spending on, states
 * the fee, and builds the flow that ends in a wallet signature. A seven-day
 * max-age means a returning browser does not even ASK whether it changed, so a
 * deploy that moves the app to mainnet leaves people staring at "Solana
 * devnet" over real SOL for a week, and a corrected fee line takes a week to
 * reach the people it was corrected for. Nothing else in public/ can be wrong
 * in a way that costs money.
 *
 * no-cache is not no-store: the file is still cached, the browser just has to
 * revalidate, and express.static's own ETag turns almost every one of those
 * into a 304. The cost is one conditional request per load; the alternative is
 * a stale betting UI with no way to invalidate it.
 *
 * Set through `setHeaders` rather than a middleware in front of this one.
 * express.static writes its own Cache-Control from `maxAge` when it serves the
 * file, so anything set earlier is silently overwritten and the exemption
 * looks applied while doing nothing. setHeaders runs last, right before the
 * send, which is the only hook that wins.
 */
app.use(express.static(path.join(__dirname, "../public"), {
  index: false,
  maxAge: "7d",
  setHeaders: (res, filePath) => {
    if (path.basename(filePath) === "chain.js") res.setHeader("Cache-Control", "no-cache");
  },
}));

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
  const [community, activity] = await Promise.all([
    openCommunityMarkets().catch((e) => {
      console.error("[landing] community load failed:", (e as Error).message);
      return [] as Awaited<ReturnType<typeof openCommunityMarkets>>;
    }),
    homeActivity().catch(() => null),
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

  // ODDIE'S OWN NUMBERS, not the venue catalogue's.
  //
  // This line used to read "<N> markets live right now" off getMarketData(),
  // which counts every bettable Polymarket market we can see — a real number,
  // but next to Oddie's name it claims Oddie has hundreds of markets when it has
  // the ones people actually tagged. A true number answering a question nobody
  // asked is still the page overstating itself.
  //
  // So: markets people tagged here, and calls placed here. Both are Oddie's,
  // both are checkable by clicking through to the feed. Same rule as everywhere
  // else on this page — a fact is printed whole or not at all, and a zero is the
  // absence of an answer rather than a smaller number to boast.
  const parts: string[] = [];
  if (community.length > 0) {
    parts.push(`<b>${community.length.toLocaleString("en-US")}</b> market${community.length === 1 ? "" : "s"} tagged so far`);
  }
  if (activity && activity.callsToday > 0) {
    parts.push(`<b>${activity.callsToday.toLocaleString("en-US")}</b> call${activity.callsToday === 1 ? "" : "s"} today`);
  }
  const proof = parts.join(" · ");
  // The one hard status claim on the page, rendered per cluster so it cannot
  // lie. "Real SOL" is only written where the SOL is real; on devnet the chip
  // says devnet, because a landing that calls test money real is the exact
  // kind of page this product must never be.
  const netChip = cluster() === "mainnet-beta"
    ? '<span class="livechip"><i></i>Real SOL · live on Solana</span>'
    : '<span class="livechip"><i></i>Live on Solana devnet · mainnet next</span>';

  const html = LANDING_HTML
    .replace("<!--PROOF-->", proof)
    .replace("<!--LIVE_MODE-->", liveMode)
    .replace("<!--LIVE_CARDS-->", liveCards)
    .replace("<!--NET_CHIP-->", netChip);

  // Only a COMPLETE render earns a place in the cache. Caching a degraded one
  // pins whatever was missing at boot to the front door for the next full
  // minute; leaving it uncached means the very next request repairs it.
  // A render is complete enough to cache once the market read succeeded. The
  // proof line being empty is a legitimate answer (a brand-new install has
  // nothing to report), so it is not a reason to keep re-rendering.
  if (community.length > 0) landingCache = { html, at: Date.now() };
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
/**
 * METERED BECAUSE IT SPENDS MONEY. /hook and /api/replycopy reach a model
 * (the referee in semantic.ts) and neither had an admin gate or a limiter, so
 * anything on the internet could loop them and bill the inference key. They are
 * not admin routes by design and should not become ones, so they get the same
 * two-tier meter /api/v1/markets uses: a per-caller ceiling that no real use
 * comes near, and a shared one so a spread-out flood still stops.
 */
function meteredRoute(req: express.Request, res: express.Response, name: string, perIp: number): boolean {
  const ip = String(req.ip ?? req.socket.remoteAddress ?? "unknown");
  if (overLimit(`${name}:${ip}`, perIp)) {
    res.status(429).json({ error: `rate limit: ${perIp} per hour` });
    return false;
  }
  if (overLimit(`${name}:global`, perIp * 40)) {
    res.status(429).json({ error: "rate limit: the shared hourly ceiling is full" });
    return false;
  }
  recordHit(`${name}:${ip}`, 3600_000);
  recordHit(`${name}:global`, 3600_000);
  return true;
}

app.post("/hook", async (req, res) => {
  const tweetText: string = req.body?.tweetText ?? "";
  if (!tweetText.trim()) return res.status(400).json({ error: "tweetText required" });
  if (!meteredRoute(req, res, "hook", 60)) return;

  const data = await liveMarketData();

  // One line per call, so the Week-1 matched:false rate can be segmented by which
  // This used to separate "every market is lopsided today" from "the venues are
  // down", because conflating them would have made an upstream outage look like
  // a matcher that could not find anything. With one local source that
  // distinction is gone: an empty set means nobody has opened a market yet,
  // which is a true and ordinary state on a young install rather than a fault.
  if (data.all.length === 0) {
    console.log(JSON.stringify({ evt: "hook", matched: null, reason: "no_markets_yet" }));
    return res.status(503).json({ error: "no_markets_yet" });
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
  // Two model calls per request when fewer than three variants survive, so this
  // one is held tighter than /hook.
  if (!meteredRoute(req, res, "replycopy", 30)) return;
  const { all } = await liveMarketData();
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
  const title = displayTitle(m.question);
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
  return FEED_HTML_NO_SHARE_BLOCK.replace("<title>oddie</title>", `<title>${ogEsc(title)} · oddie</title>\n${tags}`);
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
function profilePageHtml(handle: string, acc: { oddieScore: number | null; hasEnough: boolean; marketsCreated: number }): string {
  const title = `@${handle} on oddie`;
  // What unfurls on X. It used to quote accuracy over resolved picks, which is
  // frozen at zero for everyone post-pivot, and once the score gate moved to
  // the ladder it read "NaN% accuracy" on the one surface X shows strangers.
  const made = acc.marketsCreated;
  const desc = acc.hasEnough
    ? [`${acc.oddieScore} oddies`,
       made > 0 ? `${made} market${made === 1 ? "" : "s"} tagged` : null,
      ].filter(Boolean).join(" · ")
    : `not on the board yet`;
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
  return FEED_HTML_NO_SHARE_BLOCK.replace("<title>oddie</title>", `<title>${ogEsc(title)} · oddie</title>\n${tags}`);
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
  return FEED_HTML_NO_SHARE_BLOCK.replace("<title>oddie</title>", `<title>${ogEsc(title)} · oddie</title>\n${tags}`);
}
// Both paths serve the SAME file: /genesis/how is a view of the campaign page,
// not a second copy of it. The explanation lives in exactly one place, and the
// boot script switches views off location.pathname.
app.get(["/genesis", "/genesis/how"], (_req, res) => {
  res.type("html").send(GENESIS_HTML);
});

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

// How many tagged markets For You needs before it stops padding itself with
// untagged ones. Roughly a session's worth of full-screen cards: below it a
// tagged-only feed would dead-end in a few swipes, which teaches a new visitor
// that the product is empty rather than that it is tag-driven. Above it the
// padding is gone and every card in the feed is one somebody tagged.
const FEED_TAGGED_FLOOR = 12;

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
  const data = await liveMarketData();

  // An empty feed is now a real state rather than an outage: it means nobody
  // has tagged an argument yet. Still a 503 so the client keeps its existing
  // retry, but named for what it is.
  if (data.all.length === 0) {
    return res.status(503).json({ error: "no_markets_yet" });
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

  const scored = list.map((e) => ({ slug: slugFor(e.m), category: e.cat, ...e.m }));
  const items = scored.slice(0, 40);

  /* --------------------------------------------------- the tagged-only rule --
   * Everything in For You is there because a person tagged it. A venue market
   * qualifies the same way a community market does — by having a surfacer —
   * not by being big.
   *
   * This reverses the old cold-visitor rule (broad-appeal venue markets first,
   * community below). That rule optimised for a trustworthy front door and it
   * worked, but it made the product read as a market list with a tagging
   * feature attached. The tag IS the product, so the tag leads.
   *
   * Membership is looked up across EVERY candidate, not the top 40: a tagged
   * market must never be invisible because it is small. Venue markets nobody
   * tagged still appear, below a divider, as the wider market to tag from.
   */
  const taggedFeed = !cat || cat === "For you";
  const surfaced = taggedFeed
    ? await surfacedSlugs(scored.map((x) => x.slug)).catch(() => new Set<string>())
    : new Set<string>();

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
      // The rate SHOWN is the rate CHARGED, read off the market's own row.
      // It was briefly derived from a batched surfacer lookup, which meant a
      // single failed query printed 0% on every card at once.
      creatorFeeBps: m.creatorFeeBps, // the rate the program deducts; shown on the card's stake line
      poolTokens: poolSizes[slug] ?? 0,
      callsToday: recentCalls[slug] ?? 0,
    };
  });

  let feedItems: Array<Record<string, unknown> & { slug: string }> = items;
  if (cat === "Community") {
    // The Community tab is Community markets' correct home — they rank normally here.
    feedItems = communityItems;
  } else if (taggedFeed) {
    // Tagged first, the wider market after. Each block is sorted on its own so
    // the discovery lenses (Trending / New / Resolving Soon) re-rank WITHIN the
    // partition instead of dissolving it — a lens should change the order of
    // the tagged markets, never bury them under untagged ones.
    // Deduped by slug, and the community item wins.
    //
    // These two lists used to be disjoint: communityItems was ours and `scored`
    // was the venue feed. Removing venues made `scored` a view of the SAME
    // community markets, so every market that carries a surfacer row appeared
    // in both and the feed rendered it twice. Measured live before this fix:
    // five markets, ten cards. The community item is the one to keep because it
    // carries the fields the card needs (pool, forming, creator fee, on-chain
    // link); the scored copy has none of them.
    const seen = new Set(communityItems.map((x) => x.slug));
    const tagged = [
      ...communityItems,
      ...scored.filter((x) => surfaced.has(x.slug) && !seen.has(x.slug)),
    ];
    // The wider market is SCAFFOLDING, not a section. It exists only while
    // there are too few tagged markets to be a feed on their own, and it
    // removes itself the moment there are — no flag to flip, no date to
    // remember, and it comes back by itself if tagged supply ever thins out
    // again. Above the floor the feed is nothing but markets people tagged,
    // which is the thing the product is actually for.
    // Deduped against `tagged`, not just against `surfaced`. A community market
    // with no surfacer row (one made in the app, or an old row whose provenance
    // was lost) is absent from `surfaced`, so it fell through to here while
    // already sitting in communityItems above: the first dedupe pass caught four
    // of the five duplicates and this was the fifth. Whatever is already on the
    // feed does not get a second card, whichever list it came from.
    const onFeed = new Set(tagged.map((x) => x.slug));
    const untagged = tagged.length >= FEED_TAGGED_FLOOR
      ? []
      : items.filter((x) => !surfaced.has(x.slug) && !onFeed.has(x.slug));
    console.log(JSON.stringify({ evt: "feed_tagged", tagged: tagged.length, floor: FEED_TAGGED_FLOOR, scaffolding: untagged.length > 0 }));
    feedItems = [...sortFeedItems(tagged, sort), ...sortFeedItems(untagged, sort)];
  }

  // Discovery-mode ordering, applied over the assembled list. "foryou" is a
  // no-op by design — the ranking above IS the For You ranking. Skipped in the
  // tagged feed, which has already sorted each side of its partition.
  if (!taggedFeed) feedItems = sortFeedItems(feedItems, sort);

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
        // A DEFAULT, not an assertion: `...start.market` is spread after it, so
        // a community market that carries its own rate overrides this. It only
        // survives for a record that predates the column, and those all predate
        // any 0-bps market, so the full rate is right for them.
        ...(isCommunity ? { community: true as const, onchain: null, creatorFeeBps: CREATOR_FEE_BPS_REAL } : {}),
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
  // Tag membership for the cards actually being sent. The For You feed already
  // has it (the wide lookup it partitioned on is a superset); every other tab
  // asks now, because being tagged is a property of the MARKET, not of the tab
  // it happens to be shown in — a card that leads with "tagged by @x" in For
  // You must say the same thing under the Politics chip.
  const taggedSet = taggedFeed
    ? surfaced
    : await surfacedSlugs(feedItems.map((x) => x.slug)).catch(() => new Set<string>());
  const crowd = await crowdSplits(feedItems.map((x) => x.slug));
  // How far each line has moved since yesterday's reading. One query for the
  // page; absent for markets with no prior reading, no movement, or a stale
  // one, so a missing entry means "nothing to say" rather than "flat".
  const pctDeltas = await pctDeltasFor(feedItems.map((x) => x.slug)).catch(
    () => ({} as Record<string, number>),
  );
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
  // Faces for the author rows. Only for handles that actually have an oddie
  // account and picked one; everyone else falls back to the letter avatar the
  // client generates, which needs no round trip at all.
  const avatars = await avatarStampsForHandles(
    Object.values(surfacers).map((sf) => sf?.handle ?? "").filter(Boolean),
  ).catch(() => ({} as Record<string, number>));
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
      // Any TAGGED market can show the post it came from, not just a community
      // one. A venue market somebody tagged has the same story — "this argument
      // on X is now a market" — and gating the post on `community` was an
      // artefact of the days when only community markets could be tagged.
      sourcePost: (x.community === true || taggedSet.has(x.slug)) && surfacer?.sourceText
        ? { text: surfacer.sourceText, author: surfacer.sourceAuthor, handle: surfacer.handle, url: surfacer.sourceUrl }
        : null,
      // Tagging provenance, for EVERY tagged market — community by definition,
      // and a venue market once somebody tagged it. The card exists because a
      // person tagged a claim, and that has to be visible on the card itself
      // rather than inferable from a "community market" chip.
      //
      // `tagged` is the flag the client renders from; taggedBy is the name. A
      // null name means no surfacer was ever recorded, which the client renders
      // as "opened by oddie" — never a fabricated person, and no longer the
      // "anonymous" this comment used to promise (that framing asserted a real
      // tagger we merely couldn't name). An untagged market sends tagged:false
      // and no name at all.
      tagged: x.community === true || taggedSet.has(x.slug),
      taggedBy: x.community === true || taggedSet.has(x.slug) ? (surfacer?.handle ?? null) : null,
      taggedByAvatar: surfacer?.handle ? (avatars[surfacer.handle.replace(/^@+/, "").toLowerCase()] ?? null) : null,
      creatorFeePaid: paid ? paid.amount : 0,
      // Absent, not zero, when there is nothing honest to say — see pctDeltasFor.
      ...(pctDeltas[x.slug] != null ? { pctDelta: pctDeltas[x.slug] } : {}),
    };
    if (callers && start && x.slug === start.slug) {
      extra.callers = callers.callers;
      extra.callersTotal = callers.total;
    }
    return extra;
  });

  // The divider between the two halves of the tagged feed, inserted by finding
  // the first untagged card rather than by index — the start-slug pin can
  // reorder the list after the partition was built, and a boundary index would
  // silently drift. Absent when the feed is all one kind (nothing tagged yet,
  // or nothing untagged left), because a divider with nothing above it teaches
  // nothing and a divider with nothing below it is a dead end.
  if (taggedFeed) {
    const at = withCrowd.findIndex((x) => x.tagged !== true);
    if (at > 0) {
      withCrowd.splice(at, 0, {
        slug: "__wider",
        sectionHeader: "the wider market",
        sectionNote: "nobody's tagged these yet. Tag one on X and it lands above, with your name on it.",
      });
      // The top half had no header at all, so the feed opened on markets that
      // were made for an argument and markets listed from a venue with nothing
      // saying which was which. A first reader's honest conclusion was that
      // oddie runs all of them — that it is another venue. One line, because
      // the per-card chips carry the specific attribution.
      withCrowd.unshift({
        slug: "__made",
        sectionHeader: "made for an argument",
        sectionNote: "these started as a claim on X. Tag @oddiefun under one and yours lands here.",
      });
    }
  }

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
      creatorFeeBps: m.creatorFeeBps,
      poolTokens: poolSizes[slug] ?? 0,
      callsToday: recentCalls[slug] ?? 0,
      crowd: crowd[slug] ?? { yes: 0, no: 0 },
      challengeHandle: surfacer?.handle ?? null,
      // See the same fields in /api/feed: every community card carries who
      // tagged it. These are all OPEN markets (openCommunityMarkets), and the
      // creator fee only pays at settlement, so creatorFeePaid is 0 here by
      // construction — the card shows the forward-looking creator-fee framing.
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
  // Everyone with something on the ladder is eligible. It used to filter on
  // `provisional`, which meant "too few resolved picks to mean anything" and is
  // now true for every ladder row by construction, so the teaser emptied itself
  // as soon as ladder rows filled the top of the board.
  const ranked = board.filter((r) => r.oddies > 0);
  const topCallers = ranked.length >= HOME_MIN_RANKED
    ? ranked.slice(0, HOME_TOP_CALLERS_SHOWN).map((r, i) => ({
        rank: i + 1, handle: r.handle, oddies: r.oddies, loudMultiplier: r.loudMultiplier,
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
      handle: me.handle, hasEnough: me.accuracy.hasEnough,
      oddieScore: me.accuracy.oddieScore, rank: me.rank, tier: me.tier,
      marketsCreated: me.accuracy.marketsCreated,
      loudMultiplier: me.accuracy.loudMultiplier,
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
/**
 * The site's own unfurl image, drawn rather than stored. See renderBanner.ts for
 * why: the hand-made public/banner.png it replaces was cut before the rebrand
 * and kept serving the retired palette and retired copy on every share of the
 * root link, with nothing in the codebase able to notice.
 *
 * It lives at a NEW path on purpose. X caches unfurl images by URL for about a
 * week and retired the Card Validator that used to force a re-fetch, so the only
 * reliable way to stop showing a stale card is to stop asking for that URL.
 *
 * Rendered once per process: it takes no arguments, so every request would
 * otherwise rasterise identical pixels.
 *
 * /banner.png is kept alive and pointed at the SAME renderer rather than 404ed.
 * Tweets posted before today already carry that URL, and an unfurler that comes
 * back to refresh one should find the current brand there, not a missing image.
 */
let bannerPng: Buffer | null = null;
const sendBanner = (_req: express.Request, res: express.Response) => {
  bannerPng ??= renderCardPng(renderBanner());
  res.type("image/png").set("Cache-Control", "public, max-age=86400").send(bannerPng);
};
app.get("/og.png", sendBanner);

/**
 * Genesis card PREVIEW: the full real pipeline (classifier -> renderer) fed
 * from query params instead of a stored profile snapshot, because the
 * snapshot capture at OAuth-callback time does not exist yet. This is how the
 * card is designed and reviewed; the production route will feed the same two
 * functions from stored data and this route will remain as the test bench.
 * No writes, no external calls, so it is safe to leave open.
 */
app.get("/card/genesis-preview.png", (req, res) => {
  const q = (k: string, dflt: string) => (typeof req.query[k] === "string" && (req.query[k] as string).length ? (req.query[k] as string) : dflt);
  const num = (k: string, dflt: number) => { const v = Number(req.query[k]); return Number.isFinite(v) && v >= 0 ? v : dflt; };
  const handle = "@" + q("handle", "somebody").replace(/^@+/, "").slice(0, 20);
  const r = classifyArchetype({
    handle,
    bio: q("bio", "").slice(0, 400),
    createdAt: q("created", "2019-03-01T00:00:00Z"),
    tweetCount: num("tweets", 4000),
    followers: num("followers", 800),
    following: num("following", 600),
    pinnedText: q("pinned", "") || null,
  });
  const png = renderCardPng(renderGenesisCard({
    handle, archetype: r.archetype, headline: r.headline, reason: r.reason,
    claim: (q("pinned", "") || null)?.slice(0, 200) ?? null,
  }));
  res.type("image/png").set("Cache-Control", "no-store").send(png);
});
app.get("/banner.png", sendBanner);

/* ------------------------------------------------------------ genesis card --
 * The REAL pipeline the preview above rehearses: stored snapshot in, PNG out.
 * Anyone can fetch anyone's card by handle — everything on it came from the
 * public profile of someone who connected, and the share page below needs it
 * to unfurl for strangers. */
const genesisCardPngCache = new Map<string, Buffer>(); // uid:capturedAt -> png
// ~300KB per card (the sticker rides inside), so the cache is BOUNDED: its job
// is absorbing the unfurl burst on a card that is being shared right now, not
// holding every card ever minted. Map iteration is insertion-ordered, which
// makes FIFO eviction one delete of the first key.
const GENESIS_CARD_CACHE_MAX = 200;

/* A render is ~90ms of SYNCHRONOUS CPU on the one event loop that also serves
 * the money routes, and the route is anonymous. Cache hits are free and stay
 * unmetered; this bucket meters RENDERS, so a crawler cycling through more
 * handles than the cache holds cannot pin the process. Review measured the
 * attack at ~11 req/s of misses = 100% CPU; at 3/s sustained the same traffic
 * costs a quarter of a core, and a genuinely hot card is a hit anyway. */
const RENDER_BURST = Math.max(1, Number(process.env.GENESIS_RENDER_BURST ?? 12));
const RENDER_PER_SEC = Math.max(0.1, Number(process.env.GENESIS_RENDER_PER_SEC ?? 3));
let renderTokens = RENDER_BURST;
let renderRefillAt = Date.now();
function takeRenderToken(): boolean {
  const now = Date.now();
  renderTokens = Math.min(RENDER_BURST, renderTokens + ((now - renderRefillAt) / 1000) * RENDER_PER_SEC);
  renderRefillAt = now;
  if (renderTokens < 1) return false;
  renderTokens -= 1;
  return true;
}

function genesisCardPng(gp: GenesisProfile): Buffer {
  const key = `${gp.uid}:${gp.capturedAt}`;
  const hit = genesisCardPngCache.get(key);
  if (hit) return hit;
  // Belt to profileStore's capture-time strip: rows written before the strip
  // existed (or seeded) must not be able to make the XML parser throw.
  const safe = (t: string) => t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/g, "");
  const png = renderCardPng(renderGenesisCard({
    handle: `@${gp.handle}`, archetype: gp.archetype,
    headline: safe(gp.headline), reason: safe(gp.reason),
    claim: gp.pinnedText ? safe(gp.pinnedText).slice(0, 200) : null,
  }));
  // A reconnect mints a new key; drop the stale one rather than letting each
  // reconnect leave a corpse behind.
  for (const k of genesisCardPngCache.keys()) if (k.startsWith(`${gp.uid}:`)) genesisCardPngCache.delete(k);
  while (genesisCardPngCache.size >= GENESIS_CARD_CACHE_MAX) {
    genesisCardPngCache.delete(genesisCardPngCache.keys().next().value as string);
  }
  genesisCardPngCache.set(key, png);
  return png;
}

app.get("/card/genesis/:handle.png", async (req, res) => {
  // Express 4 does not catch a rejected async handler, and an uncaught
  // rejection ends the process on modern Node — same guard as /api/v1/claims.
  try {
    const gp = await genesisProfileByHandle(req.params.handle).catch(() => null);
    if (!gp) return res.status(404).send("no such card");
    const key = `${gp.uid}:${gp.capturedAt}`;
    if (!genesisCardPngCache.has(key) && !takeRenderToken()) {
      return res.status(429).set("Retry-After", "2").send("rendering, try again");
    }
    // One hour, not a week: short enough that a reconnect's fresh verdict wins
    // the next unfurl, long enough that a viral card is not re-rasterised per view.
    res.type("image/png").set("Cache-Control", "public, max-age=3600").send(genesisCardPng(gp));
  } catch (err) {
    console.error("[genesis] card render failed:", (err as Error).message);
    res.status(500).send("card render failed");
  }
});

/**
 * The card's SHARE PAGE, and the whole reason the card exists: X intents cannot
 * carry an image, so the tweet carries this link and the og:image puts the card
 * in the timeline. Public on purpose — a stranger who taps through lands one
 * button away from their own card.
 */
app.get("/g/:handle", async (req, res) => {
  const gp = await genesisProfileByHandle(req.params.handle).catch(() => null);
  if (!gp) return res.redirect("/genesis");
  const label = ARCHETYPE_LABEL[gp.archetype];
  const png = `${BASE_URL}/card/genesis/${encodeURIComponent(gp.handle)}.png`;
  const title = `${label} · @${gp.handle}`;
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)} · oddie</title>
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(gp.headline)}">
<meta property="og:image" content="${png}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${png}">
<link rel="icon" href="/favicon.ico?v=2" sizes="any">
<style>body{margin:0;background:#020302;color:#fff;font-family:'Nunito',system-ui,sans-serif;font-weight:600;
display:flex;flex-direction:column;align-items:center;gap:18px;padding:34px 18px}
img{max-width:min(96vw,760px);border-radius:18px}
p{margin:0;color:rgba(255,255,255,.62);max-width:60ch;text-align:center}
a.claim{background:#D7DC1F;color:#020302;text-decoration:none;font-weight:800;
padding:14px 26px;border-radius:999px;font-size:17px}</style></head><body>
<img src="${png}" alt="${escHtml(title)}">
<p>oddie read this profile. Yours is one tap away.</p>
<a class="claim" href="/genesis">Claim your 5 tickets</a>
</body></html>`);
});

/**
 * The connected page's own card lookup: which snapshot belongs to this
 * browser's X account. Same deviceId the rest of the API speaks.
 */
app.get("/api/genesis/me", async (req, res) => {
  const deviceId = typeof req.query.deviceId === "string" && DEVICE_ID.test(req.query.deviceId) ? req.query.deviceId : null;
  if (!deviceId) return res.json({ profile: null });
  const gp = await genesisProfileForDevice(deviceId).catch(() => null);
  if (!gp) return res.json({ profile: null });
  const standing = await genesisStanding(gp.handle).catch(() => null);
  res.json({ profile: {
    handle: gp.handle, name: gp.name, archetype: gp.archetype,
    label: ARCHETYPE_LABEL[gp.archetype], headline: gp.headline, reason: gp.reason,
    cardUrl: `/card/genesis/${encodeURIComponent(gp.handle)}.png`,
    shareUrl: `${BASE_URL}/g/${encodeURIComponent(gp.handle)}`,
    // Absent rather than zeroed when the read failed: the page shows what it
    // knows, and a fabricated 5/5 would be a lie about somebody's balance.
    standing,
  } });
});

/** The season board. Public: it is a leaderboard. */
app.get("/api/genesis/board", async (req, res) => {
  const limit = Number(req.query.limit);
  const rows = await genesisBoard(Number.isFinite(limit) ? limit : 20).catch(() => []);
  res.json({ tickets: GENESIS_TICKETS, rows });
});

/* Dev-only seed for exercising the real store+render path without an OAuth
 * round trip (the client secret lives in prod). Absent unless the env flag is
 * set, which production never sets. */
if (process.env.GENESIS_DEV_SEED === "1") {
  app.post("/api/genesis/_seed", express.json(), async (req, res) => {
    const b = req.body ?? {};
    const gp = await captureGenesisProfile(String(b.uid ?? "dev1"), String(b.handle ?? "levvercetti"), b.name ?? null, {
      createdAt: String(b.createdAt ?? "2014-05-01T00:00:00Z"),
      bio: String(b.bio ?? ""),
      tweetCount: Number(b.tweetCount ?? 12000),
      followers: Number(b.followers ?? 900),
      following: Number(b.following ?? 400),
      pinnedText: b.pinnedText ? String(b.pinnedText) : null,
    });
    // Optionally bind a browser to it, so /api/genesis/me answers for that
    // device exactly the way a real OAuth return would leave things.
    if (typeof b.deviceId === "string" && DEVICE_ID.test(b.deviceId)) {
      await linkAccount(b.deviceId, { provider: "twitter", uid: gp.uid, handle: `@${gp.handle}`, name: gp.name });
    }
    res.json({ ok: true, profile: gp });
  });

  /* Season seeding for the same dev-only purpose: drive the connected page
   * through spent/ranked states without a bot sweep or an on-chain stake. */
  app.post("/api/genesis/_seedSeason", express.json(), async (req, res) => {
    const b = req.body ?? {};
    const handle = String(b.handle ?? "levvercetti");
    const tags = Math.max(0, Math.min(5, Number(b.tags ?? 0)));
    const bettors = Math.max(0, Math.min(50, Number(b.bettors ?? 0)));
    for (let i = 0; i < tags; i++) await spendTicketForTag(`dev-${handle}-${i}`, handle, "somebodyelse");
    for (let i = 0; i < bettors; i++) await creditFundedBettor(`dev-${handle}-0`, `devwallet-${handle}-${i}`);
    res.json({ ok: true, standing: await genesisStanding(handle) });
  });
}

app.get("/og.svg", (_req, res) => res.type("image/svg+xml").send(renderBanner()));

/** Whether a market's vault is empty, which is not the same as 50/50. A chain
 *  that will not answer degrades to "unpriced", the safe direction: the card
 *  invites the first stake instead of quoting odds nobody set. */
async function marketIsUnpriced(slug: string): Promise<boolean> {
  const detail = await communityMarketDetail(slug).catch(() => null);
  if (!detail?.onchainPubkey) return true;
  const state = await fetchMarketOnChain(detail.onchainPubkey).catch(() => null);
  return ((state?.totalYesLamports ?? 0) + (state?.totalNoLamports ?? 0)) <= 0;
}

/**
 * A RECEIPT: one wallet's winning call, as a page whose whole job is to be
 * POSTED.
 *
 * The mechanics matter more than the page. X demotes replies three separate
 * ways and the bot can only ever reply, so the bot's reach is capped by the
 * ranker. The winner's reach is not: they post this link as an ORIGINAL post,
 * the og:image puts the card in the tweet, and the flex does the distribution.
 * The bot is stuck in the replies; the people who won are not.
 *
 * Winners only. A loss is recorded in the accuracy numbers where it belongs,
 * but a receipt is a brag artifact, and the product must never mint a card
 * whose job is to embarrass somebody under their own name.
 *
 * Everything on it is already public on chain (the position, the outcome), so
 * the page exposes nothing: it dresses what any explorer would show.
 */
app.get("/r/:slug/:wallet", async (req, res) => {
  const { slug, wallet } = req.params;
  if (!isValidPubkeyString(wallet)) return res.status(404).send("no such receipt");
  const detail = await communityMarketDetail(slug).catch(() => null);
  const entry = await chainEntryFor(slug, wallet).catch(() => null);
  if (!detail?.resolvedOutcome || !entry || entry.side !== detail.resolvedOutcome) {
    return res.status(404).send("no such receipt");
  }
  const side = entry.side.toUpperCase();
  const title = `called ${side} at ${entry.entryPct}%`;
  const png = `${BASE_URL}/r/${encodeURIComponent(slug)}/${encodeURIComponent(wallet)}/card.png`;
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)} · oddie</title>
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(detail.question)}">
<meta property="og:image" content="${png}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${png}">
<style>body{margin:0;background:#020302;color:#fff;font-family:'Nunito',system-ui,sans-serif;font-weight:600;
display:flex;flex-direction:column;align-items:center;gap:18px;padding:34px 18px}
img{max-width:min(96vw,760px);border-radius:18px}
a{color:#D7DC1F}p{margin:0;color:rgba(255,255,255,.62);max-width:60ch;text-align:center}</style></head><body>
<img src="${png}" alt="${escHtml(title)}">
<p>${escHtml(detail.question)}</p>
<p><a href="/m/${encodeURIComponent(slug)}">see the market</a></p>
</body></html>`);
});

app.get("/r/:slug/:wallet/card.png", async (req, res) => {
  const { slug, wallet } = req.params;
  if (!isValidPubkeyString(wallet)) return res.status(404).send("no such receipt");
  const detail = await communityMarketDetail(slug).catch(() => null);
  const entry = await chainEntryFor(slug, wallet).catch(() => null);
  if (!detail?.resolvedOutcome || !entry || entry.side !== detail.resolvedOutcome) {
    return res.status(404).send("no such receipt");
  }
  res.type("image/png").send(renderCardPng(renderReceiptCard(detail.question, { side: entry.side, entryPct: entry.entryPct })));
});

/**
 * A WALLET'S RECORD: every settled call it made, and what each was worth.
 *
 * This is the surface that makes oddie useful to somebody who is not currently
 * betting. CT is full of screenshotted calls with editable timestamps; this one
 * is stamped on chain at the moment of the stake, weighted by how much the crowd
 * disagreed, and it cannot be edited afterwards. It is a link for a bio.
 *
 * Public by construction and it exposes nothing new: every position and every
 * outcome here is already readable by anyone with the program id. It dresses
 * what an explorer would show.
 */
app.get("/api/w/:wallet", async (req, res) => {
  const wallet = req.params.wallet;
  if (!isValidPubkeyString(wallet)) return res.status(404).json({ ok: false, error: "unknown wallet" });
  const [receipts, board] = await Promise.all([
    walletReceipts(wallet, 100).catch(() => []),
    walletLeaderboard(100).catch(() => []),
  ]);
  const standing = board.find((w) => w.wallet === wallet) ?? { wallet, wins: 0, losses: 0, points: 0 };
  const rank = board.findIndex((w) => w.wallet === wallet);
  res.json({
    ok: true, ...standing,
    rank: rank >= 0 ? rank + 1 : null,
    settled: receipts.length,
    receipts: receipts.map((r) => ({
      slug: r.slug, question: r.question, side: r.side, outcome: r.outcome,
      won: r.won, entryPct: r.entryPct, weight: r.weight,
      poolSol: Number((r.poolLamports / 1e9).toFixed(4)),
      at: r.createdAt,
    })),
  });
});

app.get("/w/:wallet", async (req, res) => {
  const wallet = req.params.wallet;
  if (!isValidPubkeyString(wallet)) return res.status(404).send("unknown wallet");
  const receipts = await walletReceipts(wallet, 100).catch(() => []);
  const wins = receipts.filter((r) => r.won).length;
  const points = receipts.reduce((a, r) => a + r.weight, 0);
  const short = `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
  const title = receipts.length
    ? `${wins}/${receipts.length} calls, ${points} points`
    : "no settled calls yet";

  const rows = receipts.map((r) => `<li class="rw ${r.won ? "w" : "l"}">
    <a href="/m/${encodeURIComponent(r.slug)}">${escHtml(r.question)}</a>
    <span class="m">called ${r.side.toUpperCase()} at ${r.entryPct}% · settled ${r.outcome.toUpperCase()}${r.won ? ` · +${r.weight}` : ""}</span>
  </li>`).join("");

  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(short)} on oddie</title>
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="Calls stamped on chain the moment they were made, weighted by how much the crowd disagreed.">
<meta name="twitter:card" content="summary">
<style>
 body{margin:0;background:#020302;color:#fff;font-family:'Nunito',system-ui,sans-serif;font-weight:600;padding:32px 20px 64px}
 .s{max-width:640px;margin:0 auto}
 h1{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#D7DC1F;margin:0 0 6px}
 .big{font-size:clamp(30px,7vw,46px);line-height:1.05;letter-spacing:-.03em;margin:0 0 4px}
 .sub{color:rgba(255,255,255,.62);margin:0 0 26px;font-size:14px}
 ul{list-style:none;padding:0;margin:0}
 .rw{border-top:1px solid rgba(255,255,255,.11);padding:13px 0}
 .rw a{color:#fff;text-decoration:none;display:block;line-height:1.35}
 .rw a:hover{color:#D7DC1F}
 .m{display:block;margin-top:5px;font-size:12.5px;color:rgba(255,255,255,.44)}
 .rw.w .m{color:#D7DC1F}
 .rw.l .m{color:rgba(255,255,255,.34)}
 .empty{color:rgba(255,255,255,.44);border-top:1px solid rgba(255,255,255,.11);padding-top:16px;font-size:14px}
 .f{margin-top:30px;font-size:12px;color:rgba(255,255,255,.34)}
 .f a{color:rgba(255,255,255,.62)}
</style></head><body><div class="s">
<h1>oddie record</h1>
<p class="big">${escHtml(title)}</p>
<p class="sub">${escHtml(short)} · every call stamped on chain when it was made</p>
${receipts.length ? `<ul>${rows}</ul>` : `<p class="empty">No settled calls yet. A call shows up here once its market resolves.</p>`}
<p class="f">Points are how far from the crowd a winning call was, scaled by how much money was in the pool. <a href="/feed">oddie</a></p>
</div></body></html>`);
});

app.get("/card/:slug.svg", async (req, res) => {
  const { all } = await liveMarketData();
  const rec = await getSlug(req.params.slug, all);
  if (!rec) return res.status(404).send("unknown market");
  res.type("image/svg+xml").send(renderCard(rec.market, { unpriced: await marketIsUnpriced(req.params.slug) }));
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
  // Sharing a position is a scored growth event — this route is where a real
  // share link gets minted, so it is the only honest place to award it. Deduped
  // on the call id, so pressing share twice on the same position pays once and
  // sharing a DIFFERENT position pays again. Fire-and-forget: the share link is
  // the thing the user asked for and must not wait on a points write.
  void awardShare(r.slug, deviceId, id).catch(() => {});
  res.json({ ok: true, url: `${BASE_URL}/market/${r.slug}?pc=${r.token}`, cardUrl: `${BASE_URL}/card/pc/${r.token}.png` });
});

app.get("/card/:slug.png", async (req, res) => {
  const slug = req.params.slug;
  const now = Date.now();
  const hit = pngCache.get(slug);
  if (hit && now - hit.at < PNG_TTL_MS) {
    return res.type("image/png").set("Cache-Control", "public, max-age=300").send(hit.png);
  }
  const { all } = await liveMarketData();
  const rec = await getSlug(slug, all);
  if (!rec) return res.status(404).send("unknown market");
  // Ask the vault whether this market has a price at all. The card is what
  // goes on X, so it is the last place that should draw the seeded 50 as if
  // somebody had staked it. A chain that will not answer degrades to the
  // unpriced card, which is the safe direction to be wrong in: it invites a
  // stake instead of quoting odds nobody set.
  const png = renderCardPng(renderCard(rec.market, { unpriced: await marketIsUnpriced(slug) }));
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
  // The chain read is best-effort and shared with the money strip's cache: this
  // card is the image X unfurls, so a slow RPC must cost one stat, never the
  // card.
  const [rep, hd, chain] = await Promise.all([
    reputationFor(deviceId), displayHandle(deviceId), chainMineFor(deviceId).catch(() => null),
  ]);
  const acc = rep.accuracy;
  // The card wears the same stamps the app's sheet does. It used to be fed by
  // badgesFor, which can only produce one earnable kind, so someone holding
  // eight achievements shared a card carrying one medallion.
  const earnedStamps = (await achievementsFor(deviceId, acc, rep.rank,
    chain ? { ...chain, resolved: chain.settled } : null).catch(() => []))
    .filter((a) => a.earned);
  const png = renderCardPng(renderProfileCard({
    handle: hd.handle, oddieScore: acc.oddieScore, accuracyPct: acc.accuracyPct,
    streak: acc.streak, resolved: acc.resolved, hasEnough: acc.hasEnough,
    marketsCreated: acc.marketsCreated, pooledLamports: chain?.pooledLamports ?? 0,
    loudMultiplier: acc.loudMultiplier,
    badges: earnedStamps.map((a) => ({ label: a.name, id: a.id })),
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
  const data = await liveMarketData();
  res.json({ liveMarkets: data.markets.length });
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
  // openCalls and creator ride along here rather than getting their own request:
  // the feed already fetches /api/me at boot, and the status strip at the top of
  // it needs exactly these two. Both degrade to null — the strip omits whatever
  // did not arrive rather than showing a zero it cannot stand behind.
  const [wallet, handle, acc, rank, openCalls, creator] = await Promise.all([
    getWallet(deviceId), displayHandle(deviceId),
    accuracyFor(deviceId), seasonRankFor(deviceId),
    openCallsSummaryFor(deviceId).catch(() => null),
    creatorStatsFor(deviceId).catch(() => null),
  ]);
  const badges = await badgesFor(deviceId, acc);
  // pickStreak drives the persistent streak badge near the balance (2+ only).
  // `oddies` rides along from the accuracy read this route already performs.
  // The header pill used to count predictions, which stopped meaning anything
  // the moment a call became free: a number nobody can spend is not a balance,
  // it is decoration in the most prominent slot on the screen. The pill now
  // carries the one number the product has.
  res.json({ ...wallet, ...handle, pickStreak: acc.streak, oddies: acc.oddieScore ?? 0, badges, rank, openCalls, creator,
    avatarStamp: await deviceAvatarStamp(deviceId).catch(() => null) });
});

/**
 * The daily claim is gone, and so is the balance it topped up.
 *
 * It handed a device five predictions a day, on a streak, to spend on calls.
 * That was a real retention loop while calls cost something and the pool they
 * fed settled in the same currency. Neither is true any more: a position is
 * real SOL from the user's own wallet, so the balance had nothing left to buy
 * and the claim was a button that incremented a number for its own sake.
 *
 * Removing the claim on its own would have been worse than leaving it: the
 * grant and the spend are two halves of one economy, and keeping the half that
 * only goes down is how you end up with a counter people ask about and nobody
 * can explain. Both halves go together, here and in /api/market/:slug/call.
 */

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

/**
 * Upload a profile picture, already square and small.
 *
 * The browser crops and resizes to 256x256 on a canvas and sends a data URL,
 * so this only validates. The magic bytes are checked rather than the declared
 * content type, because we later serve these back with an image header and a
 * `data:image/jpeg` prefix costs nothing to write.
 */
/**
 * The money side of a profile: what the markets you tagged are actually
 * holding, read from the chain.
 *
 * Deliberately NOT a full PnL. A position is taken by a wallet signing a
 * transaction and nothing off-chain records it, so the server cannot tell you
 * what you have staked or won without indexing every position account. What it
 * CAN say exactly is what your own markets hold and what they have already
 * earned you, which is the half of the loop this product is trying to cause.
 */
// NOT /api/profile/earnings: `/api/profile/:handle` is registered hundreds of
// lines earlier, Express matches in order, and it would capture "earnings" as
// a handle and answer 404 exists:false. Anything device-scoped lives under
// /api/me, which has no wildcard sibling.
/**
 * Everything the chain knows about one device's markets, in one read.
 *
 * Two surfaces need it now (the money strip and the achievement shelf) and it
 * costs one RPC round trip per market, so it is cached briefly rather than
 * fetched twice per profile load. Cached by device, short enough that a fee
 * claimed in another tab shows up on the next visit.
 */
interface ChainMine { markets: number; live: number; settled: number; pooledLamports: number; earnedLamports: number; claimed: boolean }
const chainMineCache = new Map<string, { at: number; val: ChainMine }>();
const CHAIN_MINE_TTL_MS = 30_000;

async function chainMineFor(deviceId: string): Promise<ChainMine> {
  const hit = chainMineCache.get(deviceId);
  if (hit && Date.now() - hit.at < CHAIN_MINE_TTL_MS) return hit.val;
  const mine = await onchainMarketsSurfacedBy(deviceId, 50);
  let pooledLamports = 0, earnedLamports = 0, live = 0, settled = 0, claimed = false;
  for (const m of mine) {
    const st = await fetchMarketOnChain(m.onchainPubkey).catch(() => null);
    if (!st) continue;
    pooledLamports += st.totalYesLamports + st.totalNoLamports;
    if (st.resolved) { settled++; earnedLamports += st.creatorFeeLamports; if (st.creatorFeeClaimed) claimed = true; }
    else live++;
  }
  const val: ChainMine = { markets: mine.length, live, settled, pooledLamports, earnedLamports, claimed };
  chainMineCache.set(deviceId, { at: Date.now(), val });
  return val;
}

app.get("/api/me/earnings", async (req, res) => {
  const deviceId = deviceIdOf(req.query);
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    res.json({ ok: true, ...(await chainMineFor(deviceId)), cluster: cluster() });
  } catch (e) {
    console.error("[earnings] failed:", (e as Error).message);
    res.status(502).json({ ok: false, error: "chain unreachable" });
  }
});

app.post("/api/profile/avatar", async (req, res) => {
  const deviceId = deviceIdOf(req.body);
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const a = parseAvatarDataUrl(req.body?.image);
  if (!a) return res.status(400).json({ error: "a jpeg or png data URL under 250KB is required" });
  // Caught rather than thrown: an unhandled rejection in an async handler takes
  // the whole process with it, which is how a single bad column turned one
  // broken route into a 502 for everybody.
  try {
    await setDeviceAvatar(deviceId, a);
    res.json({ ok: true, stamp: (await deviceAvatarStamp(deviceId)) ?? Date.now() });
  } catch (e) {
    console.error("[avatar] save failed:", (e as Error).message);
    res.status(502).json({ error: "couldn't save that picture" });
  }
});

app.post("/api/profile/avatar/clear", async (req, res) => {
  const deviceId = deviceIdOf(req.body);
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  await clearDeviceAvatar(deviceId);
  res.json({ ok: true });
});

/**
 * Serve a picture by HANDLE, so a feed card can point an <img> straight at it
 * without the server having to inline bytes into every payload. Cached hard and
 * busted by the `v` the feed sends, which is the row's own set_at.
 */
app.get("/api/avatar/:handle.jpg", async (req, res) => {
  const handle = String(req.params.handle || "").replace(/^@+/, "").toLowerCase();
  const dev = handle ? await deviceForHandlePublic(handle).catch(() => null) : null;
  const img = dev ? await deviceAvatarImage(dev).catch(() => null) : null;
  if (!img) return res.status(404).end();
  res.type(img.mime).set("Cache-Control", "public, max-age=604800, immutable").send(img.image);
});

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
  // Numbers OR numeric strings, because notice.id is a bigserial and
  // node-postgres hands int8 back as a STRING to avoid losing precision past
  // 2^53. This route only accepted numbers, so every real client sent the ids
  // it had been given, got a 400, and nothing was ever marked seen: the
  // celebration modal came back on every single load, forever. The TypeScript
  // annotation on the query said `number` and was simply wrong about runtime.
  const raw = req.body?.noticeIds;
  const isId = (n: unknown) =>
    (typeof n === "number" && Number.isInteger(n)) || (typeof n === "string" && /^\d+$/.test(n));
  if (!Array.isArray(raw) || !raw.every(isId)) {
    return res.status(400).json({ error: "noticeIds must be an array of ids" });
  }
  await markCelebrationsSeen(deviceId, raw.map(String));
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
  // What a first tag is worth, computed from the same constants that pay it: a
  // market on the board plus the ledger's surface award. The profile quotes
  // this number as a price, so it must come from the economy rather than be
  // typed into the client, where a re-weighting would quietly make it a lie.
  const firstTagPays = SCORE_WEIGHTS.marketCreated
    + SEASON_POINTS.surface * SCORE_WEIGHTS.contribution;
  // The shelf ships with the record, so the profile paints it in one fetch. The
  // chain half is best-effort: a slow or unreachable RPC costs the four foil
  // stamps, not the whole screen, and they read as not-yet rather than as an
  // error the user has to understand.
  const [rank, chain] = await Promise.all([
    seasonRankFor(deviceId).catch(() => null),
    chainMineFor(deviceId).catch(() => null),
  ]);
  const achievements = await achievementsFor(deviceId, acc, rank,
    chain ? { ...chain, resolved: chain.settled } : null).catch(() => []);
  res.json({ ...acc, weeklyDelta, firstTagPays, achievements });
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
    const data = await liveMarketData();
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
  // Phantom is appended, not added to PROVIDERS: that list drives the OAuth
  // routes, and a wallet has no client id to configure. Whether it is usable is
  // a question only the browser can answer (is the extension installed?), so
  // the server reports it as available and the client decides what to render.
  const providers = [
    ...PROVIDERS.map((p) => ({ provider: p as string, available: isConfigured(p) })),
    { provider: "phantom", available: true },
  ];
  if (!deviceId) return res.json({ accounts: [], providers });
  res.json({ accounts: await accountsFor(deviceId), providers });
});

/**
 * Begin the dance. The device id rides in the pending record, not in the
 * redirect_uri — the provider matches that URI byte for byte against what is
 * registered in its console, and a query string on it is a mismatch.
 */
/**
 * Wallet sign-in, part 1: hand out something to sign.
 *
 * Unauthenticated by necessity — proving who you are is the point — so it does
 * the smallest amount of work possible and mints a bounded, expiring, one-shot
 * nonce. Nothing is written to the database here; a challenge nobody redeems
 * simply ages out of memory.
 */
app.get("/api/auth/wallet/challenge", (req, res) => {
  const q = req.query.deviceId;
  const deviceId = typeof q === "string" && DEVICE_ID.test(q) ? q : null;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });

  const address = String(req.query.address ?? "");
  if (!WALLET_ADDRESS.test(address)) return res.status(400).json({ error: "bad address" });

  // The domain in the signed text is OURS, from config — never the Host header.
  // It is the only thing telling a reader which site they are signing into, and
  // a caller-controlled value there is how a phishing page borrows our wording.
  const domain = new URL(BASE_URL).host;
  const { nonce, message } = issueChallenge(deviceId, address, domain);
  res.json({ nonce, message });
});

/**
 * Wallet sign-in, part 2: check the signature and link the account.
 *
 * The message that gets verified is the one the SERVER issued and stored, never
 * the one the client sends back — the client does not send one. That is what
 * stops a caller pairing a signature over text of their choosing with different
 * text here. The nonce is consumed before the signature is checked, so a failed
 * attempt burns it too and there is nothing to retry with.
 *
 * On success this goes through the exact same linkAccount() as X and Google:
 * same account row, same canonical-device adoption, same one-time bonus, same
 * anti-farming rules. A wallet is a third way to be somebody here, not a
 * parallel identity system — and it is still not a way to move money. Nothing
 * in this path signs or sends a transaction.
 */
/**
 * Point every market this person tagged at the wallet they just connected.
 *
 * The gap this closes: a market is minted the instant an argument is tagged on
 * X, and the tagger has no wallet at that instant, so it goes on-chain with the
 * program's unnamed-creator sentinel. The fee still accrues to it at resolve.
 * It just accrues to an address nobody holds the key to, and stays in the vault
 * forever. Connecting a wallet is the moment we finally know where the money
 * should go, so it is the moment to write it down.
 *
 * Entirely best-effort. It runs off the response, never blocks a sign-in, and
 * a market that fails to name here is not lost: naming is idempotent in one
 * direction, so the next connect from the same person tries again. Markets
 * already named are skipped before spending a transaction, and the program
 * refuses a rename anyway, so the failure mode is a wasted RPC read.
 */
async function nameCreatorOnTaggedMarkets(deviceId: string, address: string): Promise<void> {
  try {
    const mine = await onchainMarketsSurfacedBy(deviceId);
    let named = 0;
    for (const m of mine) {
      const state = await fetchMarketOnChain(m.onchainPubkey).catch(() => null);
      if (!state || state.creator) continue; // unreachable, or somebody already named it
      if (await nameCreator(m.onchainPubkey, address)) named++;
    }
    if (named) console.log(JSON.stringify({ evt: "creator_named", count: named, address }));
  } catch (e) {
    console.error("[chain] naming creator on tagged markets failed:", (e as Error).message);
  }
}

app.post("/api/auth/wallet/verify", async (req, res) => {
  const deviceId = deviceIdOf(req.body);
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });

  const address = String(req.body?.address ?? "");
  const nonce = String(req.body?.nonce ?? "");
  const sigHex = String(req.body?.signature ?? "");
  if (!WALLET_ADDRESS.test(address)) return res.status(400).json({ error: "bad address" });
  if (!/^[0-9a-fA-F]{128}$/.test(sigHex)) return res.status(400).json({ error: "bad signature" });

  const challenge = consumeChallenge(nonce, deviceId);
  if (!challenge) return res.status(400).json({ error: "challenge expired" });
  // The address is pinned at challenge time and signed into the message, so a
  // different one arriving now means this is not the exchange we started.
  if (!challenge.message.includes(address)) return res.status(400).json({ error: "address mismatch" });

  if (!verifyWalletSignature(address, challenge.message, Buffer.from(sigHex, "hex"))) {
    console.log(JSON.stringify({ evt: "auth_wallet", ok: false, reason: "bad_signature" }));
    return res.status(401).json({ error: "signature did not verify" });
  }

  try {
    const result = await linkAccount(deviceId, {
      provider: "phantom",
      uid: address,               // the address IS the identity
      handle: shortAddress(address),
      name: null,
    });
    console.log(JSON.stringify({ evt: "auth_wallet", ok: true, seeded: result.seeded }));
    res.json({ connected: "phantom", handle: shortAddress(address) });
    // After the response, never in front of it: the sign-in is done and this is
    // bookkeeping on markets that may not resolve for weeks.
    void nameCreatorOnTaggedMarkets(deviceId, address);
  } catch (err) {
    console.error("[auth] wallet link failed:", (err as Error).message);
    res.status(500).json({ error: "link_failed" });
  }
});

app.get("/api/auth/:provider/start", (req, res) => {
  // This route is only ever reached by a TOP-LEVEL NAVIGATION — the landing and
  // the app both set location.href — so every failure here is a page a person
  // is looking at, not a response some code will parse. Returning JSON meant
  // that pressing "Continue with X" against a misconfigured provider printed
  // {"error":"provider not configured"} in the viewport, which is the worst
  // possible thing for a sign-in button to do. They redirect now, into the
  // app's existing ?auth_error= handling, which says "nothing changed" and
  // leaves the person somewhere they can use.
  // Optional post-auth destination (e.g. /genesis, or the /m/{slug} permalink
  // the tap came from). Strictly a LOCAL path — anything else (absolute URLs,
  // protocol-relative "//host") is dropped, so this can never become an open
  // redirect. Parsed FIRST because failures honour it too: a person who
  // started on /genesis must land back on /genesis, not inside the app.
  const rq = req.query.return;
  const returnTo =
    typeof rq === "string" && rq.startsWith("/") && !rq.startsWith("//") && rq.length <= 200 ? rq : null;
  const bail = (why: string) => {
    const dest = returnTo ?? "/feed";
    const sep = dest.includes("?") ? "&" : "?";
    return res.redirect(`${BASE_URL}${dest}${sep}auth_error=${encodeURIComponent(why)}`);
  };
  const p = req.params.provider;
  if (!isProvider(p)) return bail("unknown_provider");
  if (!isConfigured(p)) {
    console.error(`[auth] ${p} start refused: ${missingSecretEnv(p)} is not set`);
    return bail("provider_unavailable");
  }
  const q = req.query.deviceId;
  const deviceId = typeof q === "string" && DEVICE_ID.test(q) ? q : null;
  if (!deviceId) return bail("missing_device");

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
  // One-shot, consumed UP FRONT so even a Cancel on the provider's screen can
  // send the person back where they started (the returnTo lives in the state).
  const state = typeof req.query.state === "string" ? req.query.state : null;
  const pendingAuth = state ? consume(state) : null;
  const back = (params: string) => {
    if (pendingAuth?.returnTo) {
      const sep = pendingAuth.returnTo.includes("?") ? "&" : "?";
      return res.redirect(`${BASE_URL}${pendingAuth.returnTo}${sep}${params}`);
    }
    return res.redirect(`${BASE_URL}/feed?${params}#/profile`);
  };
  if (!isProvider(p)) return back("auth_error=unknown_provider");

  // The provider says no: the user hit Cancel, or the app is misconfigured.
  if (typeof req.query.error === "string") return back(`auth_error=${encodeURIComponent(req.query.error)}`);

  const code = typeof req.query.code === "string" ? req.query.code : null;
  if (!code || !state) return back("auth_error=missing_code");
  if (!pendingAuth || pendingAuth.provider !== p) return back("auth_error=expired");

  try {
    const identity = await identify(p, code, pendingAuth.verifier, BASE_URL);
    const result = await linkAccount(pendingAuth.deviceId, identity);
    console.log(JSON.stringify({ evt: "auth_link", provider: p, seeded: result.seeded }));
    // The Genesis card. Best-effort ON PURPOSE: the sign-in is complete and a
    // storage hiccup must not turn a successful link into an auth_error page.
    if (identity.provider === "twitter" && identity.xProfile && identity.handle) {
      try {
        const gp = await captureGenesisProfile(
          identity.uid, identity.handle.replace(/^@+/, ""), identity.name ?? null, identity.xProfile);
        console.log(JSON.stringify({ evt: "genesis_card", handle: gp.handle, archetype: gp.archetype }));
      } catch (err) {
        console.error("[genesis] card capture failed:", (err as Error).message);
      }
    }
    // A sign-in that began on a market permalink returns TO that market — the
    // person came to play this one, not to meet the generic feed.
    if (pendingAuth.returnTo) {
      const sep = pendingAuth.returnTo.includes("?") ? "&" : "?";
      return res.redirect(`${BASE_URL}${pendingAuth.returnTo}${sep}connected=${p}`);
    }
    return back(`connected=${p}`);
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
  // 40, not 20: two boards are drawn from this one pool and each shows 20, so
  // the pool has to be wider than either. It is also the scoring cap, so this
  // asks for exactly what leaderboard() is willing to score and no more.
  const [edge, streaks, creators] = await Promise.all([leaderboard(40), leaderboardStreaks(20), leaderboardCreators(20).catch(() => [])]);
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
    // oddies is what the board RANKS by now, and loudMultiplier is how it
    // says so on the row — both have to survive this reshaping or the client
    // renders a board that sorts by a number it never received.
    // Same scored pool, sorted a second way. "Who is loudest" and "who is
    // right" are different questions and each gets a board; drawing both from
    // one call keeps their numbers identical and the reads bounded.
    accurate: edge
      .filter((r) => r.accuracyPct != null)
      .sort((a, b) => (b.accuracyPct ?? 0) - (a.accuracyPct ?? 0) || b.closed - a.closed)
      .slice(0, 20)
      .map((r, i) => ({
        rank: i + 1, handle: r.handle, you: r.deviceId === me,
        accuracyPct: r.accuracyPct, closed: r.closed,
      })),
    rows: edge.slice(0, 20).map((r, i) => ({
      rank: i + 1, handle: r.handle, you: r.deviceId === me,
      avgEdge: Math.round(r.avgEdge * 10) / 10, closed: r.closed, provisional: r.provisional,
      accuracyPct: r.accuracyPct, oddies: r.oddies, loudMultiplier: r.loudMultiplier,
    })),
    streaks: streaks.map((r, i) => ({ rank: i + 1, handle: r.handle, you: r.deviceId === me, current: r.current, best: r.best })),
    // The creator board — who is good at MAKING markets. See leaderboardCreators.
    creators: creators.map((r, i) => ({ rank: i + 1, handle: r.handle, you: r.deviceId === me, earnings: r.earnings, marketsCreated: r.marketsCreated })),
  });
});

/**
 * Placing a play-token call is gone. Settling and selling one is not.
 *
 * This route opened a new position in the virtual economy. With the venues
 * removed every market in the product is our own parimutuel, and a position in
 * one is real SOL through the user's own wallet, so a route that opened a
 * play-token position could only ever add to a pool that pays in a currency
 * nothing spends.
 *
 * /api/position/:id/sell and the settlement path deliberately survive. There
 * are markets that were open before this changed, people hold positions in
 * them, and freezing an economy means letting it finish, not confiscating what
 * is in it. Nothing new enters; what is already there still resolves and can
 * still be exited.
 */


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

// Admin-gated (requireAdmin is a hoisted declaration, so referencing it above
// its definition is fine): this is an operator worklist, and reading it MINTS
// share tokens for other people's calls — the one path allowed to bypass the
// "nobody's call becomes an image unless they chose to" rule. Open, that meant
// anyone could mint a stranger's position card by GETting a public URL.
app.get("/api/mentions", requireAdmin, async (_req, res) => {
  const rows = await mentionCandidates();
  // The post that started each market, so a verdict can QUOTE the claim rather
  // than describe it. One query for the page.
  const srcs = await surfacersFor(rows.map((r) => r.slug)).catch(
    () => ({} as Record<string, SurfacerInfo>),
  );
  const out = [];
  for (const r of rows) {
    const token = r.shareToken ?? (await mintShareTokenForMention(r.callId));
    const url = token ? `${BASE_URL}/market/${r.slug}?pc=${token}` : `${BASE_URL}/market/${r.slug}`;
    // Voice and shape both come from buildVerdict: loud on a win, dry on a
    // loss, and never a jab at the person who got it wrong — see the rule
    // above it for why that is arithmetic rather than manners.
    const v = buildVerdict({
      handle: r.handle, side: r.side, entryPct: r.entryPct, outcome: r.outcome,
      question: r.question, permalink: url, sourceUrl: srcs[r.slug]?.sourceUrl ?? null,
    });
    out.push({
      callId: r.callId, handle: r.handle, won: v.won, longshot: v.longshot,
      line: v.primary, fallback: v.fallback, url,
      // The claim this market came from. With it the operator posts a QUOTE —
      // an original post as far as ranking is concerned, so it clears the
      // reply filter and is boost-eligible. Without it, a plain post.
      sourceUrl: srcs[r.slug]?.sourceUrl ?? null,
      // The image to attach to the post itself — the personal card as a PNG,
      // so the tweet carries the visual natively instead of leaning on unfurl.
      cardPng: token ? `${BASE_URL}/card/pc/${token}.png` : null,
      question: r.question, mentionedAt: r.mentionedAt, returned24h: r.returned24h,
    });
  }
  res.json({ mentions: out });
});

app.post("/api/mentions/:id/sent", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false });
  res.json({ ok: await markMentioned(id) });
});

// Not the same action as "sent" wearing a different label: this is the
// operator saying a verdict will never be posted (stale, a test call, not
// worth the tweet), and mentioned_at must stay true to "actually went out" for
// the 24h-return read beside it. See dismissed_at's comment in markets.ts.
app.post("/api/mentions/:id/dismiss", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false });
  res.json({ ok: await dismissMention(id) });
});

// Loud submissions — phase 1 of the loudness flywheel. A player who posted
// about oddie pastes their link; it lands in a review queue. Approval (the
// operator today, an X API read once credits exist) pays SEASON_POINTS.loud_post.
app.post("/api/loud/submit", async (req, res) => {
  const deviceId = typeof req.body?.deviceId === "string" && DEVICE_ID.test(req.body.deviceId) ? req.body.deviceId : null;
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  if (!url) return res.status(400).json({ error: "url required" });
  const r = await submitLoudPost(deviceId, url);
  if (r.ok) return res.json({ ok: true, status: r.status, dailyCap: LOUD_DAILY_CAP });
  const message: Record<string, string> = {
    bad_url: "that's not an X post link — paste the full x.com/…/status/… URL",
    no_x_account: "connect your X account first — loud points need a real author",
    not_your_account: "that post isn't from your connected X account",
    already_submitted: "that post was already submitted",
    daily_cap: `that's ${LOUD_DAILY_CAP} submissions in 24h — save the next one for tomorrow`,
  };
  res.status(400).json({ ok: false, reason: r.reason, error: message[r.reason] ?? r.reason });
});

app.get("/api/loud/mine", async (req, res) => {
  const q = req.query.deviceId;
  const deviceId = typeof q === "string" && DEVICE_ID.test(q) ? q : null;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const [posts, status] = await Promise.all([loudPostsFor(deviceId), loudStatusFor(deviceId)]);
  res.json({ posts, ...status });
});

// Public: the latest weekly Loudest picks, for the feed's promo card. Real
// names being paid is the whole pitch, so this is deliberately not gated.
app.get("/api/loud/winners", async (_req, res) => {
  res.json({ winners: await loudWinners() });
});

app.get("/api/admin/loud/queue", requireAdmin, async (_req, res) => {
  res.json({ queue: await loudQueue() });
});

app.post("/api/admin/loud/decide", requireAdmin, async (req, res) => {
  const id = Number(req.body?.id);
  const approve = req.body?.approve === true;
  const note = typeof req.body?.note === "string" && req.body.note.trim() ? req.body.note.trim().slice(0, 200) : null;
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "id required" });
  const r = await decideLoudPost(id, approve, note);
  if (!r.ok) return res.status(r.reason === "not_found" ? 404 : 409).json({ ok: false, reason: r.reason });
  res.json({ ok: true, status: r.status, points: r.status === "approved" ? ODDIES_PER.loud_post : 0 });
});

// Weekly Loudest Callers — phase 0 of the loudness flywheel, human all the way
// through: the operator searches X for the week's best posts about oddie, then
// names the authors here. +300 oddies each (ODDIES_PER.loud), one award per
// (person, ISO week) by dedup, so resubmitting a list is safe.
app.post("/api/admin/loud", requireAdmin, async (req, res) => {
  const week = typeof req.body?.week === "string" && /^\d{4}-W\d{2}$/.test(req.body.week)
    ? req.body.week
    : isoWeekOf(new Date());
  const handles = Array.isArray(req.body?.handles) ? req.body.handles.map(String).filter(Boolean) : [];
  if (handles.length < 1 || handles.length > 25) {
    return res.status(400).json({ error: "handles: 1-25 X handles required" });
  }
  const results = [];
  for (const h of handles) {
    results.push({ handle: h.replace(/^@+/, ""), ...(await awardLoud(h, week)) });
  }
  res.json({ week, points: ODDIES_PER.loud, results });
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
/**
 * The live market set. Community markets, and nothing else.
 *
 * This replaces getMarketData(), which fetched Kalshi and Polymarket and made
 * them the bulk of everything: the feed served forty venue cards to one of
 * ours, the matcher tried to answer every tagged claim with somebody else's
 * market first, and a tap on any of those forty spent a play token against a
 * pool that settles nowhere.
 *
 * Removing them is not a feature cut, it is the product finally being one
 * thing. Oddie's markets are real money in a vault we settle; a venue market
 * is a link to a venue that does not know we exist. Carrying both meant every
 * screen had to explain which kind of market you were looking at, and the
 * honest answer for most of them was "the kind you cannot actually win".
 *
 * The shape is kept identical to what getMarketData returned so the sixteen
 * call sites did not each need rewriting: `markets` was the matcher's wider
 * universe, `feed` the curated subset, `all` everything including markets too
 * lopsided to offer. With one source those three are the same list, and
 * saying so here is cheaper than pretending the distinction survived.
 */
interface LiveMarketData {
  /** The matcher's universe, the feed's, and everything: one source, one list. */
  markets: Market[];
  feed: Market[];
  all: Market[];
  /** Kept because callers branch on it. A local source cannot fall behind. */
  stale: boolean;
  ageMs: number;
}

async function liveMarketData(): Promise<LiveMarketData> {
  let community: CommunityMarket[] = [];
  try { community = await openCommunityMarkets(); }
  catch (e) { console.error("[markets] community load failed:", (e as Error).message); }
  return {
    markets: community, feed: community, all: community,
    // No venues field at all. Faking one so the old shape still typechecked
    // would leave four call sites reporting the health of something that no
    // longer exists.
    stale: false, ageMs: 0,
  };
}

async function pricingSet(): Promise<Market[]> {
  // Was venue markets plus community ones. One source now, so this and
  // liveMarketData().all are the same list; kept as a name because the call
  // sites read better saying what they want it FOR.
  return (await liveMarketData()).all;
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
    const data = await liveMarketData();
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
/* ------------------------------------------------- the agent surface (v1) --
 * A small, stable, documented API for other people's agents, kept separate
 * from the routes this app's own client uses.
 *
 * The separation is the point. /api/feed and /api/market/:slug are shaped for
 * a screen: device-scoped, feed-ranked, and they hand back the whole internal
 * record including every call ever placed. An agent reading those would break
 * the next time the feed changed, and would be parsing a shape nobody promised
 * it. /api/v1 is the shape that is promised, so it can change on its own clock.
 *
 * Reads are keyless on purpose. Odds and open markets are public facts, and a
 * key in front of them buys nothing except a reason for an agent not to
 * bother. Writing is different: every market minted costs the admin wallet
 * real rent on Solana, so the create route is metered.
 */

/**
 * Naive fixed-window limiter, in memory. Resets on deploy, which is fine for
 * what it defends: the cost of an abusive burst is SOL rent, not data.
 *
 * CHECKING and RECORDING are separate calls, and that split is the whole
 * point. The first version counted every request, so five malformed bodies in
 * a row locked a client out for an hour despite creating nothing and spending
 * nothing. The meter exists to protect rent, and a request rejected for a bad
 * source_url never reached the mint. Only a market that actually got minted
 * costs us anything, so only that is recorded.
 */
const v1Hits = new Map<string, { n: number; resetAt: number }>();
function overLimit(key: string, max: number): boolean {
  const cur = v1Hits.get(key);
  if (!cur || Date.now() > cur.resetAt) return false;
  return cur.n >= max;
}
function recordHit(key: string, windowMs: number): void {
  const now = Date.now();
  const cur = v1Hits.get(key);
  if (!cur || now > cur.resetAt) { v1Hits.set(key, { n: 1, resetAt: now + windowMs }); return; }
  cur.n++;
}

type OpenMarketResult =
  // `onchain` is null for a market opened on-demand: the row exists, the rent
  // has not been spent, and ensureMinted spends it when somebody turns up.
  | { ok: true; slug: string; marketId: number; onchain: { pubkey: string; explorer: string; signature: string } | null }
  | { ok: false; status: number; error: string };

/**
 * Open a market from a claim. The one path, for every caller.
 *
 * Extracted when the agent API arrived, because the alternative was a second
 * copy of the rules a market is born under, and those rules are not
 * decoration: provenance is required so a card can name who it came from, the
 * question is capped at the program's own 180 bytes, and the on-chain mint is
 * a hard failure because a market with no vault is a table nobody can sit at.
 * A caller that skipped any one of those would produce a market this product
 * cannot honour, and the second copy is always the one that drifts.
 *
 * Returns a result rather than writing a response, so callers own their own
 * status codes and shapes. Never throws for input problems.
 */
/**
 * The creator fee is only charged when there is somebody it can be paid TO.
 *
 * create_market deducts creator_fee_bps from the winners' pool and holds it for
 * whatever address sits in `creator`. That address is filled in later, by
 * set_creator, from the X handle in the source URL. A market whose source has
 * no handle -- every Telegram market, by construction -- can never be filled
 * in, so the fee would come out of real winners and sit in the vault unclaimed
 * forever. The program is explicit that it will not reroute an unclaimed fee to
 * the house, and it is right to refuse; the honest answer is not to charge it.
 *
 * The rate is stored per market on chain, so this can go back to the full rate
 * for Telegram the day a group admin can claim it, without repricing anything
 * already open.
 */
function creatorFeeBpsForHandle(handle: string | null | undefined): number {
  return handle ? CREATOR_FEE_BPS_REAL : 0;
}

async function openMarketFromClaim(input: {
  question: string;
  closeInput: unknown;
  sourceUrl: string | null;
  category?: string;
  yesPct?: number;
  resolutionCriteria?: string | null;
  resolvability?: string | null;
  /**
   * WHEN THE RENT GETS SPENT.
   *
   * "now" is the old behaviour and stays the default for the admin and agent
   * routes, whose callers are handed an `onchain` object and would be surprised
   * by a null.
   *
   * "on-demand" writes the row and skips the mint. The bot uses it, and the bot
   * is the volume: every tagged claim used to cost a rent deposit out of our own
   * wallet whether or not one human ever looked at it, and a market nobody
   * stakes in is a market whose on-chain account proves nothing the row does not
   * (the vault is empty). ensureMinted below spends it the moment somebody
   * actually shows up, and the market_id is assigned HERE either way, so the PDA
   * is already fixed and two people arriving at once cannot mint two accounts.
   */
  mint?: "now" | "on-demand";
}): Promise<OpenMarketResult> {
  const bad = (status: number, error: string): OpenMarketResult => ({ ok: false, status, error });
  const question = input.question.trim();
  const category = (input.category ?? "Community").trim() || "Community";
  const yesPct = Number(input.yesPct ?? 50);
  const resolutionCriteria = input.resolutionCriteria != null ? String(input.resolutionCriteria).trim() : null;
  const resolvability = input.resolvability != null ? String(input.resolvability).trim() : null;

  if (!question) return bad(400, "question required");
  if (question.length > 180) return bad(400, "question must be 180 characters or fewer (the program's own limit)");
  if (resolvability === "unresolvable") return bad(422, "unresolvable claims cannot become markets");
  if (resolutionCriteria && resolutionCriteria.length > 600) return bad(400, "resolution criteria must be 600 characters or fewer");

  let closeTime: number;
  if (typeof input.closeInput === "number") closeTime = Math.floor(input.closeInput);
  else {
    const t = Date.parse(String(input.closeInput));
    if (Number.isNaN(t)) return bad(400, "invalid close_time");
    closeTime = Math.floor(t / 1000);
  }
  if (!(closeTime > Math.floor(Date.now() / 1000))) return bad(400, "close_time must be in the future");
  if (!Number.isFinite(yesPct) || yesPct < 1 || yesPct > 99) return bad(400, "starting odds must be between 1 and 99");

  const sourceUrl = input.sourceUrl?.trim() || null;
  if (!sourceUrl) return bad(400, "source_url required: a market with no source can never show who it came from");
  // ACCEPTANCE, not attribution. These were the same check, and on X they
  // coincide -- the handle in the URL is both where the market came from and
  // who gets paid. A t.me link is a real source with no handle in it, so asking
  // handleFromSourceUrl whether to accept a source rejected every Telegram
  // market ever submitted. Who gets paid is decided separately, below.
  if (!sourceUrlKind(sourceUrl)) {
    return bad(400, "source_url must be an x.com/…/status/… or t.me/…/… link");
  }

  // Decided ONCE, here, from the source, and used by both the mint below and
  // the row that publishes the market. ensureMinted reads it back from that row
  // rather than re-deriving it from market_surfacer, which is written later and
  // behind an oEmbed fetch: for up to six seconds the market was live on the
  // feed with no surfacer row, and a missing row reads as null rather than
  // raising, so an unauthenticated /api/chain/ensure landing in that window
  // minted an X market at 0 bps. Nothing on chain can change a rate afterwards,
  // so that was the creator's entire share, gone, unrecoverably.
  const creatorFeeBps = creatorFeeBpsForHandle(handleFromSourceUrl(sourceUrl));

  // The vault comes first. Written the other way round, a Solana failure
  // returned "was not published" to the caller while the row it had already
  // created went on being served by the feed: a market nobody could ever take a
  // side in, because the account the bet needs does not exist. Minting first
  // means the failure path writes nothing, so there is no orphan to clean up.
  const marketId = Date.now(); // unique-per-ms; also the on-chain market_id (u64)
  const lazy = input.mint === "on-demand";
  const minted = lazy
    ? null
    : await mintMarket({ marketId, question, closeTime, creator: null,
        creatorFeeBps, protocolFeeBps: PROTOCOL_FEE_BPS_REAL });
  if (!lazy && !minted) {
    return bad(502, "market could not be opened on Solana, so it has no vault and was not published");
  }

  const { slug } = await createCommunityMarket({ question, closeTime, category, yesPct, resolutionCriteria, resolvability, marketId, creatorFeeBps });
  if (minted) await setCommunityOnchain(slug, minted.pubkey, minted.signature);
  void logExtraction("publish", question, { slug, question, category, yesPct, closeTime, resolutionCriteria, resolvability });

  // Awaited, not fire-and-forget: this row is the thing being guaranteed, so a
  // market must not report success while its provenance silently failed to
  // land. recordSurfacer swallows its own oEmbed failures, so this waits on the
  // write and not on X.
  await recordSurfacer(slug, { sourceUrl });
  void awardSurface(slug).catch(() => {}); // points are best-effort; the row is not

  return {
    ok: true, slug, marketId,
    onchain: minted ? { pubkey: minted.pubkey, explorer: explorerUrl(minted.pubkey), signature: minted.signature } : null,
  };
}

/**
 * Put a market on chain, now, and do it at most once.
 *
 * IDEMPOTENT BY CONSTRUCTION rather than by locking. market_id is assigned when
 * the ROW is written, and the market PDA is derived from it, so two people
 * arriving at the same moment are aiming at the same address: one mint lands,
 * the other fails with an account that already exists, and the re-read below
 * turns that into the same success. There is no window in which two accounts
 * can exist for one market.
 */
async function ensureMinted(slug: string): Promise<{ pubkey: string } | null> {
  const detail = await communityMarketDetail(slug).catch(() => null);
  if (!detail) return null;
  if (detail.onchainPubkey) return { pubkey: detail.onchainPubkey };
  if (!isChainEnabled()) return null;
  if (detail.resolvedOutcome) return null; // nothing to stake in

  // THE path for bot-created markets: the claims route mints on-demand, so this
  // is where a Telegram market actually reaches the chain.
  //
  // The rate comes off `detail` — the same row whose absence already made this
  // function return null a few lines up. An earlier version re-derived it from
  // market_surfacer, which is written AFTER the market is published and behind
  // an oEmbed fetch, and whose absence reads as null rather than as an error.
  // That gave a window in which this minted an X market at 0 bps, permanently.
  // There is no window now: a market that cannot be read is not minted, and a
  // market that can be read carries its own rate.
  const minted = await mintMarket({
    marketId: detail.marketId, question: detail.question,
    closeTime: Math.floor(new Date(detail.closesAt ?? Date.now()).getTime() / 1000),
    creator: null, creatorFeeBps: detail.creatorFeeBps, protocolFeeBps: PROTOCOL_FEE_BPS_REAL,
  }).catch(() => null);

  if (minted) {
    await setCommunityOnchain(slug, minted.pubkey, minted.signature);
    return { pubkey: minted.pubkey };
  }
  // The mint failed. It may have failed because somebody else's landed first,
  // which is a success wearing the wrong hat, so the row is re-read before this
  // is called a failure.
  const again = await communityMarketDetail(slug).catch(() => null);
  return again?.onchainPubkey ? { pubkey: again.onchainPubkey } : null;
}

/**
 * Open markets, newest first, with the odds that actually matter: the vault's.
 *
 * `oddsSource` is reported rather than assumed. A market minted seconds ago
 * has an empty vault and therefore no price at all, and an agent that read a
 * missing number as 50/50 would be trading against a figure nobody set. Null
 * odds mean unpriced, and the field says which it is.
 */
/**
 * A CLAIM, FROM A CHANNEL WE DO NOT OWN, BECOMING A MARKET.
 *
 * /api/v1/markets takes a finished question. This takes raw text out of a
 * conversation and runs the whole thing: extract, gate, mint. It exists because
 * a partner bot cannot be handed the admin token (that token can resolve
 * markets, which is to say pay money out), and until now the extractor was only
 * reachable behind it.
 *
 * THE IDEMPOTENCY KEY IS THE AUTHORITY, not the caller's own dedupe. A bot's
 * lookup can be raced by two people triggering the same claim in the same
 * second, and the thing that settles a race is a unique constraint. Same key,
 * same answer, forever: created once, existing after that.
 *
 * A REFUSAL IS AN ANSWER AND IS CACHED. An unsettleable claim is a property of
 * its text, so re-asking spends a model call to be told the same thing. The
 * response carries the TTL rather than the caller hardcoding one, because the
 * only thing that can change a refusal is our own classifier, and that is our
 * side of the wire.
 *
 * QUOTA IS PER CALLER PER GROUP, never per IP: everything from a bot arrives
 * from one address, so an IP limit makes every group it serves share a bucket
 * and lets the busiest starve the rest. Dedupe hits and refusals do not spend a
 * token, because neither costs us anything.
 */
const BOT_KEYS = (process.env.ODDIE_BOT_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
/** Capacity is the burst and the refill is the sustain. Arguments cluster: a
 *  goal goes in and six people call it in ninety seconds, so a flat hourly cap
 *  would throttle exactly when the product is working. */
const BOT_BURST = Math.max(1, Number(process.env.ODDIE_BOT_BURST ?? 10));
const BOT_PER_HOUR = Math.max(1, Number(process.env.ODDIE_BOT_PER_HOUR ?? 10));
/** How long a refusal is trusted. Ours to choose and ours to send, because the
 *  only thing that can change a refusal is our own classifier. */
const REFUSAL_TTL_S = 86_400;

app.post("/api/v1/claims", async (req, res) => {
  try {
    // --- FREE CHECKS FIRST. Nothing below this block costs anything, and an
    // --- adversarial review measured what happens when they run late: a
    // --- malformed permalink burned a full model call to return a 400.
    const auth = String(req.get("authorization") ?? "");
    const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    // Fixed-width digests, so the comparison never depends on the length of a
    // configured key and cannot leak it.
    const presented = createHash("sha256").update(key).digest();
    const authorised = key.length > 0 && BOT_KEYS.some((k) => timingSafeEqual(presented, createHash("sha256").update(k).digest()));
    if (!authorised) return res.status(401).json({ error: "unauthorized" });

    const idem = String(req.get("idempotency-key") ?? "").trim();
    if (!idem || idem.length > 200) return res.status(400).json({ error: "Idempotency-Key required, max 200 chars" });

    const claimText = String(req.body?.claim_text ?? "").trim().slice(0, 4000);
    if (claimText.length < 12) return res.status(400).json({ error: "claim_text too short" });

    // chat_id is bounded because it becomes part of a primary key. Unbounded, a
    // 3KB value overflows the btree, the insert throws, and the throw escapes an
    // async handler Express does not catch: one request, whole process.
    const rawChat = req.body?.context?.chat_id;
    const chatId = rawChat == null ? "" : String(rawChat).slice(0, 64);
    if (!chatId) return res.status(400).json({ error: "context.chat_id required" });

    // The permalink is the provenance, the dedupe identity, and the thing that
    // decides who is credited -- so EVERY test it has to pass runs here, before
    // anything costs money.
    //
    // It used to be checked for https only, with the host rejected deep inside
    // openMarketFromClaim, AFTER a full extraction had been billed. The bot can
    // only ever send a t.me link, so every Telegram claim ever submitted paid
    // for a model call and got a 400 back -- and because a 400 is not a 422, it
    // was never cached as a refusal and the quota was refunded, so there was
    // nothing at all capping the repeat spend.
    const permalink = req.body?.permalink != null ? String(req.body.permalink) : null;
    if (!permalink) {
      return res.status(400).json({ error: "permalink required: a market with no source cannot show where it came from" });
    }
    let permalinkUrl: URL | null = null;
    try { permalinkUrl = new URL(permalink); } catch { permalinkUrl = null; }
    if (!permalinkUrl || permalinkUrl.protocol !== "https:") {
      return res.status(400).json({ error: "permalink must be an https URL" });
    }
    if (!sourceUrlKind(permalink)) {
      return res.status(400).json({ error: "permalink must be an x.com/.../status/... or t.me/.../... link" });
    }

    const scope = callerScope(key);
    // NAMESPACED BY CALLER. A global ledger let one key holder read another's
    // answers, and squat their keys outright.
    const ledgerKey = `${scope}:${idem}`;

    // --- ANSWER FROM WHAT WE ALREADY KNOW, still spending nothing ---
    const seen = await claimKeyLookup(ledgerKey).catch(() => null);
    if (seen?.slug) {
      const detail = await communityMarketDetail(seen.slug).catch(() => null);
      // A key that produced a market is SETTLED. Falling through here on an
      // unreadable market turned a failed read into a write: every retry minted
      // another market and reported it as "existing".
      return res.json({ state: "existing", market: marketPayload(seen.slug, detail) });
    }
    if (seen?.refusal) {
      return res.status(422).json({ state: "refused", reason: seen.refusal, detail: seen.detail ?? "", cache_for_seconds: REFUSAL_TTL_S });
    }
    // The caller picks the idempotency key and can rotate it; it cannot change
    // what the claim says. This is the cache that actually stops repeat spend.
    const textRefusal = await refusalForText(claimText).catch(() => null);
    if (textRefusal) {
      await claimKeyRecord(ledgerKey, { refusal: textRefusal.reason, detail: textRefusal.detail, cacheForSeconds: REFUSAL_TTL_S }).catch(() => {});
      return res.status(422).json({ state: "refused", reason: textRefusal.reason, detail: textRefusal.detail ?? "", cache_for_seconds: REFUSAL_TTL_S });
    }
    // One post, one market, the same rule the X loop follows. Without it a
    // single permalink minted a market per idempotency key.
    const already = await openMarketForSourcePost(permalink).catch(() => null);
    if (already) {
      await claimKeyRecord(ledgerKey, { slug: already.slug }).catch(() => {});
      const detail = await communityMarketDetail(already.slug).catch(() => null);
      return res.json({ state: "existing", market: marketPayload(already.slug, detail) });
    }
    // Asking for a token before checking the engine is even configured spends a
    // group's budget on an outage.
    if (!extractEnabled()) return res.status(503).json({ error: "extraction unavailable" });

    // --- FROM HERE IT COSTS ---
    // TWO buckets. The per-group one keeps a loud room from starving the
    // others; the per-key one is the ceiling, and it exists because the group
    // is named by the CALLER. With only the first, a partner rotating chat_id
    // got a fresh full bucket every time: measured at 30 fabricated groups, 30
    // model calls, zero refusals.
    const globalToken = await takeQuotaToken(key, "all", { capacity: BOT_BURST * 4, perHour: BOT_PER_HOUR * 4 });
    if (!globalToken.ok) {
      res.set("Retry-After", String(globalToken.retryAfterSeconds));
      return res.status(429).json({ error: "rate limited", retry_after_seconds: globalToken.retryAfterSeconds });
    }
    const groupToken = await takeQuotaToken(key, `chat:${chatId}`, { capacity: BOT_BURST, perHour: BOT_PER_HOUR });
    if (!groupToken.ok) {
      await releaseQuotaToken(key, "all", BOT_BURST * 4);
      res.set("Retry-After", String(groupToken.retryAfterSeconds));
      return res.status(429).json({ error: "rate limited", retry_after_seconds: groupToken.retryAfterSeconds });
    }
    /** Give both tokens back on any path that did no work. */
    const refund = async () => {
      await releaseQuotaToken(key, "all", BOT_BURST * 4);
      await releaseQuotaToken(key, `chat:${chatId}`, BOT_BURST);
    };

    let ex: Awaited<ReturnType<typeof runExtract>>;
    try {
      ex = await runExtract(claimText);
    } catch (e) {
      // Ours and transient. Never cached as a refusal, and never charged: an
      // outage locking a group out for half an hour is the outage plus a
      // penalty.
      console.error("[claims] extract failed:", (e as Error).message);
      await refund();
      return res.status(503).json({ error: "extraction unavailable" });
    }

    const refusal = !ex.appropriate ? "inappropriate" : ex.resolvability === "unresolvable" ? "unresolvable" : !ex.question ? "no_question" : null;
    if (refusal) {
      await recordRefusalForText(claimText, refusal, ex.reason, REFUSAL_TTL_S);
      const wrote = await claimKeyRecord(ledgerKey, { refusal, detail: ex.reason, cacheForSeconds: REFUSAL_TTL_S })
        .then(() => true).catch(() => false);
      // A refusal whose ledger write failed is not cached, and saying it is
      // would have the caller skip a claim we will happily re-bill.
      return res.status(422).json({ state: "refused", reason: refusal, detail: ex.reason, cache_for_seconds: wrote ? REFUSAL_TTL_S : 0 });
    }

    const out = await openMarketFromClaim({
      question: ex.question,
      closeInput: ex.close_time,
      sourceUrl: permalink,
      category: ex.category,
      resolutionCriteria: ex.resolution_criteria || null,
      resolvability: ex.resolvability,
      mint: "on-demand",
    });
    if (!out.ok) {
      await refund();
      return res.status(out.status >= 500 ? 502 : out.status).json({ error: out.error });
    }

    // The ledger is the authority, so what it returns decides the answer. The
    // previous version reconciled with `settled.slug ?? out.slug`, which reads
    // a stored REFUSAL as agreement and reported a market as created under a
    // key that answers 422 forever after.
    let settled: Awaited<ReturnType<typeof claimKeyRecord>>;
    try {
      settled = await claimKeyRecord(ledgerKey, { slug: out.slug });
    } catch (e) {
      console.error("[claims] ledger write failed after mint:", (e as Error).message, out.slug);
      return res.status(500).json({ error: "market created but not recorded", slug: out.slug });
    }
    if (settled.refusal || !settled.slug) {
      return res.status(422).json({ state: "refused", reason: settled.refusal ?? "no_question", detail: settled.detail ?? "", cache_for_seconds: REFUSAL_TTL_S });
    }
    const detail = await communityMarketDetail(settled.slug).catch(() => null);
    res.json({ state: settled.slug === out.slug ? "created" : "existing", market: marketPayload(settled.slug, detail) });
  } catch (e) {
    // Express 4 does not catch a rejected async handler, and an uncaught
    // rejection ends the process on modern Node. One bad request must not be a
    // restart loop.
    console.error("[claims] unhandled:", (e as Error).message);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  }
});

/** The one shape every claims response returns, so created and existing cannot
 *  drift apart. Slug-keyed: there is no other id in this system. */
function marketPayload(slug: string, detail: { question: string; closesAt: string | null } | null) {
  return {
    slug,
    url: `${BASE_URL}/m/${slug}`,
    card_image_url: `${BASE_URL}/card/${slug}.png`,
    question: detail?.question ?? "",
    closes_at: detail?.closesAt ?? null,
  };
}

app.get("/api/v1/markets", async (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? 20) || 20));
  // adminListCommunity despite the name: it is a store query, not a permission,
  // and it is the only one that carries slug + on-chain pubkey + outcome
  // together. openCommunityMarkets returns the pricing shape, which has none of
  // those.
  const all = await adminListCommunity().catch(() => []);
  // Retired markets are off the board, and this is a public surface. The list
  // above is the admin view and returns them on purpose, so the filter has to be
  // here: without it the agent API kept serving markets that had already left
  // the feed.
  const items = await Promise.all(all.filter((m) => !m.resolvedOutcome && !m.retiredAt).slice(0, limit).map(async (m) => {
    const state = m.onchainPubkey ? await fetchMarketOnChain(m.onchainPubkey).catch(() => null) : null;
    const yes = state?.totalYesLamports ?? 0, no = state?.totalNoLamports ?? 0;
    const total = yes + no;
    return {
      slug: m.slug,
      question: m.question,
      url: `${BASE_URL}/m/${m.slug}`,
      closesAt: m.closesAt,
      resolved: Boolean(m.resolvedOutcome),
      outcome: m.resolvedOutcome ?? null,
      pool: { yesLamports: yes, noLamports: no, totalSol: total / 1e9 },
      yesPct: total > 0 ? Math.max(1, Math.min(99, Math.round((yes / total) * 100))) : null,
      oddsSource: total > 0 ? "vault" : "unpriced",
      onchain: m.onchainPubkey ? { pubkey: m.onchainPubkey, explorer: explorerUrl(m.onchainPubkey) } : null,
      // PER MARKET, because the rates differ now: a market with no creator to
      // pay is minted at 0. The chain is the authority once minted; the row is
      // what it WILL be minted with. A single response-level constant quoted a
      // creator share against markets that charge none.
      creatorFeeBps: state?.creatorFeeBps ?? m.creatorFeeBps,
    };
  }));
  res.json({
    ok: true, cluster: cluster(),
    // The DEFAULT rate, kept for callers that read it. Prefer the per-market
    // creatorFeeBps on each item above; this one cannot be right for every row.
    creatorFeeBps: CREATOR_FEE_BPS_REAL, protocolFeeBps: PROTOCOL_FEE_BPS_REAL,
    markets: items,
  });
});

/** One market, including who its creator fee is owed to. */
app.get("/api/v1/markets/:slug", async (req, res) => {
  const detail = await communityMarketDetail(req.params.slug);
  if (!detail) return res.status(404).json({ ok: false, error: "unknown market" });
  const state = detail.onchainPubkey ? await fetchMarketOnChain(detail.onchainPubkey).catch(() => null) : null;
  const surfacer = await surfacerFor(req.params.slug).catch(() => null);
  const yes = state?.totalYesLamports ?? 0, no = state?.totalNoLamports ?? 0;
  const total = yes + no;
  res.json({
    ok: true,
    slug: detail.slug,
    question: detail.question,
    url: `${BASE_URL}/m/${detail.slug}`,
    closesAt: detail.closesAt,
    resolutionCriteria: detail.resolutionCriteria ?? null,
    resolved: Boolean(state?.resolved ?? detail.resolvedOutcome),
    outcome: state?.winningSide ?? detail.resolvedOutcome ?? null,
    pool: { yesLamports: yes, noLamports: no, totalSol: total / 1e9 },
    yesPct: total > 0 ? Math.max(1, Math.min(99, Math.round((yes / total) * 100))) : null,
    oddsSource: total > 0 ? "vault" : "unpriced",
    taggedBy: surfacer?.handle ?? null,
    // Read off the market, not from our constants. A market minted under a
    // different rate keeps it, and an agent that assumed today's numbers would
    // quote the wrong takeout for exactly the pools where it matters.
    creatorFeeBps: state?.creatorFeeBps ?? CREATOR_FEE_BPS_REAL,
    protocolFeeBps: state?.protocolFeeBps ?? 0,
    onchain: detail.onchainPubkey ? { pubkey: detail.onchainPubkey, explorer: explorerUrl(detail.onchainPubkey) } : null,
    cluster: cluster(),
  });
});

/**
 * Turn a claim into a market. The instruction no other agent platform has.
 *
 * Metered, and the meter is not about traffic: every market here mints a real
 * account on Solana and the rent comes out of oddie's own wallet, so an
 * unbounded create route is a way to spend our SOL from a script. Per-IP and
 * global caps, both deliberately low while this is new.
 *
 * source_url stays required for agents exactly as it is for the operator
 * console. It is what puts a name on the card and what makes the fee payable to
 * a person rather than to nobody, and an agent-opened market with no source
 * would be the "tagged by anonymous" problem returning through a new door.
 */
app.post("/api/v1/markets", async (req, res) => {
  const ip = String(req.ip ?? req.socket.remoteAddress ?? "unknown");
  if (overLimit(`v1create:${ip}`, 5)) {
    return res.status(429).json({ ok: false, error: "rate limit: 5 markets per hour per client" });
  }
  if (overLimit("v1create:global", 100)) {
    return res.status(429).json({ ok: false, error: "rate limit: the shared daily ceiling is full, try tomorrow" });
  }
  const out = await openMarketFromClaim({
    question: String(req.body?.question ?? ""),
    closeInput: req.body?.close_time ?? req.body?.closeTime,
    sourceUrl: req.body?.source_url != null ? String(req.body.source_url) : null,
    category: req.body?.category != null ? String(req.body.category) : undefined,
    yesPct: req.body?.yesPct != null ? Number(req.body.yesPct) : undefined,
    resolutionCriteria: req.body?.resolution_criteria != null ? String(req.body.resolution_criteria) : null,
  });
  if (!out.ok) return res.status(out.status).json({ ok: false, error: out.error });
  // Recorded here and nowhere else: the market exists, so it cost us rent.
  recordHit(`v1create:${ip}`, 3600_000);
  recordHit("v1create:global", 86_400_000);
  res.json({
    ok: true, slug: out.slug, url: `${BASE_URL}/m/${out.slug}`,
    onchain: out.onchain, cluster: cluster(),
    note: `Anyone can now take a side with real SOL. ${(CREATOR_FEE_BPS_REAL / 100).toFixed(0)}% of the pool goes to the handle in source_url.`,
  });
});

app.post("/api/community/create", requireAdmin, async (req, res) => {
  // Thin now. Every rule a market is born under lives in openMarketFromClaim,
  // which the agent API calls too, so the two callers cannot drift apart on
  // what provenance is required or on whether a failed mint is fatal.
  const out = await openMarketFromClaim({
    question: String(req.body?.question ?? ""),
    closeInput: req.body?.close_time ?? req.body?.closeTime,
    sourceUrl: req.body?.source_url != null ? String(req.body.source_url) : null,
    category: req.body?.category != null ? String(req.body.category) : undefined,
    yesPct: req.body?.yesPct != null ? Number(req.body.yesPct) : undefined,
    resolutionCriteria: req.body?.resolution_criteria != null ? String(req.body.resolution_criteria) : null,
    resolvability: req.body?.resolvability != null ? String(req.body.resolvability) : null,
  });
  if (!out.ok) return res.status(out.status).json({ error: out.error, chainEnabled: isChainEnabled() });
  res.json({
    ok: true, slug: out.slug, marketId: out.marketId, url: `${BASE_URL}/m/${out.slug}`,
    onchain: out.onchain, chainEnabled: isChainEnabled(), cluster: cluster(),
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
  // The wallet half of the same notice. Fired, never awaited: the play emails
  // above are part of settling, this one is an announcement.
  void emailChainStakers(slug, outcome);
  // Real-stakes counterpart: resolve the SAME market on-chain so claim_winnings
  // has an outcome to pay against. Best-effort and entirely after the response-
  // determining work above — the real (virtual) economy never waits on devnet.
  if (isChainEnabled()) {
    void communityMarketDetail(slug).then((detail) => {
      if (!detail?.onchainPubkey) return;
      // The answer is READ now. It used to be discarded, which is how a
      // resolution came to exist only in our database: the row latches on
      // `resolved_outcome IS NULL`, so calling this route again answers 409 and
      // never retries the chain, and claim_winnings is left with no outcome to
      // pay against. The row still latches; what changed is that a chain that
      // did not get the verdict is now LOUD, and `npm run resolve-reconcile`
      // is the way back.
      void resolveMarketOnChain(detail.onchainPubkey, outcome).then((r) => {
        if (r.ok) return;
        console.error(JSON.stringify({
          evt: "resolve_chain_gap", slug, outcome, reason: r.reason, error: r.error,
          onChainOutcome: r.onChainOutcome ?? null,
          fix: "npm run resolve-reconcile",
        }));
      }).catch(() => {});
      // Real-money creator/protocol fee: logged as an audit-trail "intended
      // fee" only, never actually deducted — the deployed Solana program has
      // no fee instruction (see economy.ts + logRealFee). Read the
      // vault total straight from chain rather than trusting a stale value.
      void fetchMarketOnChain(detail.onchainPubkey).then((state) => {
        // state.creatorFeeBps, not the constant: the ledger must record what the
        // program fixed on THIS market, which is 0 for one with no creator.
        if (state) void logRealFee(slug, state.totalYesLamports + state.totalNoLamports, state.creatorFeeBps);
      }).catch(() => {});
    }).catch(() => {});
  }
  /**
   * ANNOUNCE IT WHERE THE ARGUMENT WAS.
   *
   * oddie already replied once in that thread, with the card, and the id of its
   * own reply is stored, so the result can answer it. Entirely after the
   * response and never awaited: the money has already moved by the time this
   * runs, so X being slow or unreachable must not hold up a resolution or fail
   * one that succeeded.
   *
   * It respects X_BOT_DRY_RUN like every other write, so turning the bot's
   * posting on is still one deliberate switch rather than something a resolve
   * quietly starts doing.
   */
  void postResolution(slug, outcome, {
    dryRun: X_BOT_DRY_RUN,
    cardPng: async (s2, o) => {
      const { all } = await liveMarketData();
      const rec = await getSlug(s2, all);
      return rec ? renderCardPng(renderCard(rec.market, { settled: o })) : null;
    },
    uploadMedia: (png) => X.uploadMedia(png),
    postReply: (o) => X.postReply(o),
    log: (line, extra) => console.log(JSON.stringify({ evt: "x_resolution", line, ...extra })),
    // The take's author and their cut, for the one @-mention oddie sends: the
    // result reply reaches whoever TAGGED the market, and the person who earned
    // the fee is the source author, two levels up and otherwise never told.
    authorHandle: async (s2) => (await surfacerFor(s2).catch(() => null))?.handle ?? null,
    authorFeeLamports: async (s2) => {
      const d = await communityMarketDetail(s2).catch(() => null);
      if (!d?.onchainPubkey) return 0;
      const st = await fetchMarketOnChain(d.onchainPubkey).catch(() => null);
      return st?.creatorFeeLamports ?? 0;
    },
  }).catch((e) => console.error("[resolution] announce failed:", (e as Error).message));

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
 * The switch the whole client-side chain layer hangs off: initChainLayer in
 * feed.html probes this before injecting chain.js, so if this route is absent
 * the betting UI silently never exists.
 *
 * RESTORED. The venue removal deleted a span that ran from venueRealMoneyReady
 * to the realStakesReady block, and this route lived inside it despite having
 * nothing to do with venues. Nothing caught it for a while because the
 * verification loop probing it used curl -sf, which treats a 404 as "keep
 * waiting", and then echoed ready unconditionally when the loop ran out. Two
 * layers of masking on the one probe that mattered.
 *
 * Deliberately OUTSIDE the realStakesReady block below: this route answering
 * "enabled: false" is how a client learns trading is off. Inside the block,
 * off would mean 404, and the client cannot tell a disabled layer from a
 * broken one.
 */
app.get("/api/chain/status", (req, res) => {
  noteGeoForCommunity(req);
  res.json({ enabled: realStakesReady, cluster: cluster() });
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
      // READ FROM THE MARKET, not from our constants, and that distinction is
      // the whole reason the program stores both rates per market. This used
      // to report the constants, which meant the sheet quoted today's rate for
      // a pool that had been minted under a different one: the exact repricing
      // the on-chain design exists to make impossible, reintroduced one layer
      // up where nobody would see it. The constants survive only as the answer
      // for a market minted before the field existed and therefore reading 0.
      // ?? not ||: a legitimate 0 is now possible (a market with no creator
      // to pay), and `0 || 200` quotes a 4% takeout on a 2% market.
      realCreatorFeeBps: state.creatorFeeBps ?? CREATOR_FEE_BPS_REAL,
      realProtocolFeeBps: state.protocolFeeBps,
      realFeesEnforced: true,
      // Who the fee is owed to, and whether it is still waiting. Null creator
      // means the tagger has not connected a wallet yet, which the UI should
      // read as "unclaimed and claimable by the right person", not as "nobody
      // earned this".
      creator: state.creator, creatorFeeLamports: state.creatorFeeLamports,
      creatorFeeClaimed: state.creatorFeeClaimed,
      cluster: cluster(),
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
    if (!detail) return res.status(404).json({ ok: false, reason: "unknown-market" });
    if (detail.resolvedOutcome) return res.status(409).json({ ok: false, reason: "already-resolved" });
    // Markets the bot opened carry no on-chain account until somebody wants to
    // stake in one. This is that moment. It is also the LAST line of defence
    // rather than the intended one: /api/chain/ensure below is called when the
    // wallet connects, several seconds of human time earlier, so by the time
    // anyone has picked a side and an amount the account is already there.
    const ready = detail.onchainPubkey ? { pubkey: detail.onchainPubkey } : await ensureMinted(slug);
    if (!ready) return res.status(502).json({ ok: false, reason: "not-minted", error: "this market could not be opened on Solana" });

    /**
     * EVERY RULE take_position ENFORCES, CHECKED HERE FIRST.
     *
     * This route used to consult only our own database's resolvedOutcome and
     * then hand over a signable transaction. The program enforces two more
     * things (lib.rs: `clock < close_time` -> MarketClosed, and
     * `pos.side == side` -> SideAlreadyTaken), and nothing checked either, so
     * a wallet already holding YES that tapped NO, or anyone staking a market
     * past its on-chain close that our resolver had not caught up to, was
     * handed a transaction guaranteed to revert. Measured: 3 of 15 live
     * markets were past close and unresolved, one by more than a month.
     *
     * A guaranteed revert is not just a wasted fee. Phantom's documented
     * fourth cause of "This dApp could be malicious" is a transaction that
     * would fail on chain, so this was manufacturing the red banner ourselves,
     * and it would go on doing it on mainnet.
     *
     * Chain unreadable is NOT treated as a refusal: the program is still the
     * authority, and blocking every stake because an RPC blinked would be a
     * worse failure than the one being fixed.
     */
    const chainState = await fetchMarketOnChain(ready.pubkey).catch(() => null);
    /**
     * A market we cannot READ is a market we cannot verify, and handing over a
     * transaction we cannot verify is the thing these guards exist to stop.
     *
     * This used to fall through on the reasoning that an RPC blink should not
     * close the whole board. That protected availability over correctness on
     * the money path, and it could not tell a blink from an account that is
     * permanently not ours: one market on the board is owned by the program
     * this one replaced, so it can never decode, and every stake on it was a
     * guaranteed revert dressed as a working button. Refusing costs a retry
     * during an outage; allowing costs the user a failed transaction and
     * Phantom's red banner.
     */
    if (!chainState) return res.status(503).json({ ok: false, reason: "chain-unreachable" });
    {
      if (chainState.resolved) return res.status(409).json({ ok: false, reason: "already-resolved" });
      const now = Math.floor(Date.now() / 1000);
      if (chainState.closeTime > 0 && now >= chainState.closeTime) {
        return res.status(409).json({ ok: false, reason: "closed", closeTime: chainState.closeTime });
      }
      const held = await fetchPosition(ready.pubkey, userPubkey).catch(() => null);
      if (held && held.side !== side) {
        return res.status(409).json({ ok: false, reason: "other-side", side: held.side });
      }
    }
    const txBase64 = await preparePositionTx({ marketPubkey: ready.pubkey, userPubkey, side, lamports });
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
  /**
   * Put this market on chain now, because somebody just connected a wallet.
   *
   * The point is LATENCY, not correctness: position/prepare mints on its own if
   * it has to. Calling this the moment a wallet connects moves the mint behind
   * several seconds of human time (pick a side, type an amount, approve in
   * Phantom) so nobody ever waits on it.
   *
   * Metered, and not as a formality: this route spends SOL. The ceiling is
   * bounded by what the old eager behaviour did anyway — mint every market once
   * — but there is no reason to leave a rent tap open to the internet.
   */
  app.post("/api/chain/ensure", async (req, res) => {
    if (!meteredRoute(req, res, "chain-ensure", 60)) return;
    const slug = String(req.body?.slug ?? "");
    if (!slug) return res.status(400).json({ error: "slug required" });
    const ready = await ensureMinted(slug).catch(() => null);
    // Not an error the client should act on: the stake path mints on its own if
    // this did not, so a failure here costs latency and nothing else.
    res.json({ ok: Boolean(ready), pubkey: ready?.pubkey ?? null });
  });

  /**
   * A wallet's OPEN stakes: SOL that is on the line right now.
   *
   * The gap this fills is the plainest one in the product. After "You're in",
   * the stake vanished: /api/chain/position was only ever read from the claim
   * flow, which runs AFTER resolution, so an open position appeared on no
   * screen at all and the trader's only record was Phantom and a tx link they
   * had already closed.
   *
   * chain_entry says which markets this wallet touched, which is cheap; the
   * CHAIN says how much is in them, which is authoritative. A stamp records
   * only a first stake, so quoting it would understate anyone who topped up.
   */
  app.get("/api/chain/open", async (req, res) => {
    const userPubkey = String(req.query.userPubkey ?? "");
    if (!isValidPubkeyString(userPubkey)) return res.status(400).json({ ok: false, error: "invalid userPubkey" });
    const candidates = await openEntriesFor(userPubkey).catch(() => []);
    const open = (await Promise.all(candidates.map(async (c) => {
      if (!c.onchainPubkey) return null;
      const pos = await fetchPosition(c.onchainPubkey, userPubkey).catch(() => null);
      // No position on chain means it was claimed, refunded, or never landed.
      if (!pos || pos.lamports <= 0 || pos.claimed) return null;
      const state = await fetchMarketOnChain(c.onchainPubkey).catch(() => null);
      return {
        slug: c.slug, question: c.question, side: pos.side, lamports: pos.lamports,
        entryPct: c.entryPct, closesAt: c.closesAt,
        explorer: explorerUrl(c.onchainPubkey),
        // The pool as it stands, so the trader can see the line move against or
        // with them. Null when the market cannot be read rather than zero.
        pool: state ? { yes: state.totalYesLamports, no: state.totalNoLamports } : null,
      };
    }))).filter(Boolean);
    res.json({ ok: true, open, cluster: cluster() });
  });

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
    // Same rule as the stake route: never hand over a transaction the program
    // will reject. Simulated live before this existed, this endpoint returned
    // HTTP 200 and a signable transaction that failed with Custom 3012,
    // "AnchorError caused by account: position. AccountNotInitialized", for
    // any wallet that had never staked on the market.
    const claimState = await fetchMarketOnChain(detail.onchainPubkey).catch(() => null);
    // A market we cannot READ is a market we cannot verify, and the guards below
    // are the whole reason this route exists. Wrapping them in `if (claimState)`
    // meant an unreadable market skipped ALL of them and still got HTTP 200 with
    // a signable transaction, which is the exact failure they were written to
    // stop. Not hypothetical: while the committed IDL did not match the deployed
    // program every read returned null, so this route handed out
    // guaranteed-revert transactions for the length of that window. Same rule as
    // the stake route: unreadable is a refusal.
    if (!claimState) return res.status(503).json({ ok: false, reason: "chain-unreachable" });
    {
      if (!claimState.resolved) return res.status(409).json({ ok: false, reason: "not-resolved" });
      const pos = await fetchPosition(detail.onchainPubkey, userPubkey).catch(() => null);
      if (!pos) return res.status(409).json({ ok: false, reason: "no-position" });
      if (pos.claimed) return res.status(409).json({ ok: false, reason: "already-claimed" });
      if (claimState.winningSide && pos.side !== claimState.winningSide) {
        return res.status(409).json({ ok: false, reason: "lost", side: pos.side, outcome: claimState.winningSide });
      }
    }
    const txBase64 = await prepareClaimTx({ marketPubkey: detail.onchainPubkey, userPubkey });
    if (!txBase64) return res.status(502).json({ ok: false, reason: "chain-unreachable" });
    res.json({ ok: true, txBase64 });
  });

  /**
   * What a tagger is owed, across every market they started.
   *
   * The other side of /api/chain/claimable: that one answers "what did I win",
   * this one answers "what did being loud earn me". They are separate reads
   * because they are separate people as often as not, and because the fee is
   * the half of the economy the product actually advertises.
   *
   * Reports markets that are resolved, owe a fee, have not been claimed, and
   * name THIS wallet as the creator. A market still carrying the unnamed
   * sentinel is invisible here by construction: it belongs to somebody who has
   * not connected a wallet, and nameCreatorOnTaggedMarkets is what moves it
   * into this list when they do.
   */
  app.get("/api/chain/creator-fees", async (req, res) => {
    const creatorPubkey = String(req.query.creatorPubkey ?? "");
    if (!isValidPubkeyString(creatorPubkey)) return res.status(400).json({ error: "invalid creatorPubkey" });
    const markets = await resolvedOnchainMarkets(40).catch(() => []);
    const owed = await Promise.all(markets.map(async (m) => {
      const state = await fetchMarketOnChain(m.onchainPubkey).catch(() => null);
      if (!state || state.creatorFeeClaimed) return null;
      if (state.creatorFeeLamports <= 0) return null;      // nobody backed the winner
      if (state.creator !== creatorPubkey) return null;    // not theirs, or nobody's yet
      return { slug: m.slug, question: m.question, lamports: state.creatorFeeLamports, feeBps: state.creatorFeeBps };
    }));
    res.json({ ok: true, fees: owed.filter(Boolean) });
  });

  /**
   * Relay a transaction the user's wallet already signed.
   *
   * Pairs with the prepare routes: the server builds it, the wallet signs it,
   * and the server broadcasts it to the cluster the app actually runs on. The
   * client used to let the wallet broadcast, which sent every stake to whatever
   * cluster the visitor's Phantom was set to, and that is why fifteen live
   * markets held zero SOL.
   *
   * This never signs and cannot: it forwards bytes that already carry the
   * user's signature. A transaction with no valid signature is rejected by the
   * cluster, not by us, which is the correct place for that check.
   */
  app.post("/api/chain/submit", async (req, res) => {
    // Parity with position/prepare: a stake that lands through the relay stays
    // visible to the same REGIME 1 observability, which is resolved and logged
    // and never enforced.
    noteGeoForCommunity(req);
    const txBase64 = req.body?.txBase64;
    if (typeof txBase64 !== "string" || txBase64.length < 64 || txBase64.length > 8000) {
      return res.status(400).json({ ok: false, error: "txBase64 required" });
    }
    /**
     * THE ENTRY STAMP, read here and nowhere else.
     *
     * This relay is the one moment a real stake passes through our hands
     * signed, which makes it the only honest place to record what the crowd
     * said when this wallet called it. Stamping at prepare would let anyone
     * farm early-looking entries without ever signing; stamping after the
     * pool moves would let them look early after the fact. So: decode the
     * envelope, read the pool BEFORE broadcasting (the stake must not be in
     * its own crowd number), and stamp only once the send succeeded.
     *
     * Entirely best-effort. The stamp is reputation, the stake is money, and
     * a bookkeeping failure must never cost anyone their transaction.
     */
    const stake = await takePositionFromTx(txBase64).catch(() => null);
    const crowdBefore = stake ? await fetchMarketOnChain(stake.market).catch(() => null) : null;

    const out = await submitSignedTx(txBase64);
    // 400 for a client that sent something wrong, 502 only for a chain that is
    // actually unreachable. Funnelling a parse failure into 502 would tell the
    // user Solana is down when the bug is ours.
    if (!out.ok) return res.status(out.badRequest ? 400 : 502).json({ ok: false, error: out.error, signature: out.signature });

    if (stake && crowdBefore) {
      void slugForOnchainPubkey(stake.market).then(async (slug) => {
        if (!slug) return;
        await recordChainEntry({
          slug, wallet: stake.user, side: stake.side,
          entryPct: entryShareOf(crowdBefore, stake.side), lamports: stake.lamports,
        });
        // The Genesis board's ONLY number: a wallet that had never funded
        // anything before is a new human, credited to whoever's tag got them
        // here. Best-effort like the stamp above — this is the money path, and
        // bookkeeping must never cost anybody their transaction.
        await creditFundedBettor(slug, stake.user).catch((e) =>
          console.error("[genesis] bettor credit failed (non-fatal):", (e as Error).message));
      }).catch(() => {});
    }

    res.json({ ok: true, signature: out.signature, confirmed: out.confirmed !== false, cluster: cluster() });
  });

  app.post("/api/chain/creator-fee/prepare", async (req, res) => {
    const slug = String(req.body?.slug ?? "");
    const creatorPubkey = String(req.body?.creatorPubkey ?? "");
    if (!isValidPubkeyString(creatorPubkey)) return res.status(400).json({ error: "invalid creatorPubkey" });
    const detail = await communityMarketDetail(slug);
    if (!detail?.onchainPubkey) return res.status(404).json({ ok: false, reason: "not-minted" });
    // Simulated live before this existed: HTTP 200 and a signable transaction
    // that failed with Custom 6014, "WrongCreator", whenever the asking wallet
    // was not the market's named creator.
    const feeState = await fetchMarketOnChain(detail.onchainPubkey).catch(() => null);
    // Same inversion as the claim route above, same reason.
    if (!feeState) return res.status(503).json({ ok: false, reason: "chain-unreachable" });
    {
      if (!feeState.resolved) return res.status(409).json({ ok: false, reason: "not-resolved" });
      if (feeState.creator !== creatorPubkey) return res.status(409).json({ ok: false, reason: "not-creator" });
      if (feeState.creatorFeeClaimed) return res.status(409).json({ ok: false, reason: "already-claimed" });
      if (feeState.creatorFeeLamports <= 0) return res.status(409).json({ ok: false, reason: "nothing-owed" });
    }
    const txBase64 = await prepareCreatorFeeTx({ marketPubkey: detail.onchainPubkey, creatorPubkey });
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
/**
 * Tell the WALLETS that a market they staked in has settled.
 *
 * emailSettled below reaches play-economy positions by deviceId. A wallet-only
 * staker has no deviceId anywhere in that path, so the people with actual SOL
 * on the line were the only ones the product could not reach: they learned by
 * revisiting and pressing Check, or they never learned at all.
 *
 * Reachability is entirely opt-in and no link is created here. A wallet is
 * reachable only if its owner signed the wallet-link challenge AND signed in
 * with Google on the same device; anything less and they simply get nothing.
 *
 * Best-effort and never awaited into the response: a mailer failure must not
 * touch a settlement that has already happened.
 */
async function emailChainStakers(slug: string, outcome: "yes" | "no"): Promise<void> {
  try {
    const stakers = await walletsInMarket(slug);
    if (stakers.length === 0) return;
    const emails = await emailsForWallets([...new Set(stakers.map((s2) => s2.wallet))]);
    if (Object.keys(emails).length === 0) return;
    const rec = await getSlug(slug);
    const question = rec?.market.question ?? slug;
    for (const st of stakers) {
      const to = emails[st.wallet];
      if (!to) continue;
      // The winner is pointed at the claim, the loser at the market. Neither is
      // quoted a payout: pari-mutuel pays from the final pool, and the exact
      // number lives on the claim screen where it is read from the chain.
      const won = st.side === outcome;
      const url = won ? `${BASE_URL}/m/${encodeURIComponent(slug)}` : `${BASE_URL}/m/${encodeURIComponent(slug)}`;
      const { subject, html } = settleMailBody({
        to, question, side: st.side, entryPct: st.entryPct, outcome,
        // Denominated in SOL, and deliberately not a predicted payout.
        stake: Number((st.lamports / 1e9).toFixed(4)), proceeds: 0,
        positionsUrl: url,
      });
      await sendMail({ to, subject, html });
    }
  } catch (err) {
    console.error("[mail] chain settle batch failed:", (err as Error).message);
  }
}

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

/**
 * The venue auto-settle sweep is gone with the venues.
 *
 * It polled Kalshi and Polymarket every ten minutes asking whether a market
 * someone still held had resolved, and settled it when the venue said so. That
 * was the only way a venue market could ever pay out, because nobody here
 * decides what happened in somebody else's market.
 *
 * Oddie's own markets do not work that way and never did: an operator resolves
 * them through /api/community/resolve, which settles positions off-chain and
 * calls resolve_market on-chain in the same step. There is nothing left for a
 * sweep to ask, and leaving one running would have meant a cron quietly
 * hitting two APIs for markets the product no longer carries.
 */


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

/* --------------------------------------------------------- the X bot loop ---
 * The autonomous half. Everything the sweep needs is wired here because this
 * is the only file that already has all of it: the market path, the card
 * renderer, and the live market list the card is drawn from.
 *
 * THREE SWITCHES, and they are deliberately separate:
 *
 *   X_BOT_ENABLED   the timer runs at all. Off by default, so a deploy that
 *                   happens to carry credentials does not start posting.
 *   X_BOT_DRY_RUN   defaults to TRUE. Everything runs (read mentions, grade
 *                   the claim, MINT THE MARKET) except the two calls that
 *                   touch X. Turning the bot on and leaving this alone gives
 *                   a real transcript of what it would have said, at the cost
 *                   of real rent, which is the honest way to watch it before
 *                   trusting it.
 *   DATABASE_URL    enforced inside the sweep: no durable ledger, no posting.
 *
 * The dry run is not a mock. It really opens the market, because the part
 * worth reviewing is the JUDGEMENT (is this claim priceable, is this question
 * neutral, is this the right close time) and a mocked mint would review none
 * of it.
 */
const X_BOT_ENABLED = (process.env.X_BOT_ENABLED ?? "false").toLowerCase() === "true";
const X_BOT_DRY_RUN = (process.env.X_BOT_DRY_RUN ?? "true").toLowerCase() !== "false";
// Number("2m") is NaN, Math.max(60_000, NaN) is NaN, and Node coerces a NaN
// interval to ONE MILLISECOND. The re-entrancy guard stops it fanning out, but
// the two-minute poll becomes a back-to-back loop hammering the mentions read,
// and nothing anywhere says so. A value we cannot read is the default.
const X_POLL_MS = (() => {
  const raw = Number(process.env.X_POLL_MS ?? 120_000);
  if (!Number.isFinite(raw)) {
    console.error(`[x] X_POLL_MS=${JSON.stringify(process.env.X_POLL_MS)} is not a number. Using 120000.`);
    return 120_000;
  }
  return Math.max(60_000, raw);
})();

function sweepDeps(overrides: Partial<SweepDeps> = {}): SweepDeps {
  return {
    mentions: (since, max) => X.mentions(since, max),
    tweet: (id) => X.tweet(id),
    extract: (text) => runExtract(text),
    existingMarket: (sourceUrl) => openMarketForSourcePost(sourceUrl),
    openMarket: async (input) => {
      const out = await openMarketFromClaim({
        question: input.question,
        closeInput: input.closeInput,
        sourceUrl: input.sourceUrl,
        category: input.category,
        resolutionCriteria: input.resolutionCriteria,
        resolvability: input.resolvability,
        // The bot is the volume, so the bot is where the rent goes. A tagged
        // claim used to cost a deposit out of our own wallet whether or not one
        // human ever opened it, and a market nobody stakes in has an empty vault
        // and therefore an on-chain account that proves nothing the row does
        // not. It gets minted the moment somebody actually turns up.
        mint: "on-demand",
      });
      return out.ok ? { ok: true, slug: out.slug } : { ok: false, status: out.status, error: out.error };
    },
    cardPng: async (slug) => {
      const { all } = await liveMarketData();
      const rec = await getSlug(slug, all);
      return rec ? renderCardPng(renderCard(rec.market)) : null;
    },
    uploadMedia: (png) => X.uploadMedia(png),
    postReply: (o) => X.postReply(o),
    // The Genesis season. A tag is a ticket, checked before the model call and
    // charged only once the market exists.
    ticketsLeft: (handle) => ticketsLeft(handle),
    spendTicket: (slug, tagger, source) => spendTicketForTag(slug, tagger, source),
    baseUrl: BASE_URL,
    botUserId: process.env.X_BOT_USER_ID ?? "",
    dryRun: X_BOT_DRY_RUN,
    log: (line, extra) => console.log(JSON.stringify({ evt: "x_bot", line, ...extra })),
    ...overrides,
  };
}

let sweeping = false;
async function sweepMentions(overrides: Partial<SweepDeps> = {}): Promise<SweepResult | null> {
  if (sweeping) return null;
  sweeping = true;
  try {
    const r = await runMentionSweep(sweepDeps(overrides));
    if (r.looked > 0) {
      console.log(JSON.stringify({ evt: "x_sweep", ...r, decisions: undefined, dryRun: sweepDeps(overrides).dryRun }));
    }
    return r;
  } catch (err) {
    console.error("[x] sweep failed:", (err as Error).message);
    return null;
  } finally {
    sweeping = false;
  }
}

/**
 * Run one sweep on demand. Admin-gated, and it forces a DRY RUN whatever the
 * environment says: this is the "show me what you would do" button, and a
 * version of it that could post would be a way to make the bot tweet by
 * guessing a token.
 */
app.post("/api/admin/x/sweep", requireAdmin, async (_req, res) => {
  if (!X.xConfigured()) {
    return res.status(503).json({ ok: false, error: "x not configured", missing: X.xMissing() });
  }
  const r = await runMentionSweep(sweepDeps({ dryRun: true })).catch((e) => {
    res.status(502).json({ ok: false, error: (e as Error).message });
    return null;
  });
  if (r) res.json({ ok: true, dryRun: true, ...r });
});

/** What the bot is, without touching X. Safe to curl while debugging a deploy. */
app.get("/api/admin/x/status", requireAdmin, async (_req, res) => {
  res.json({
    ok: true,
    enabled: X_BOT_ENABLED,
    dryRun: X_BOT_DRY_RUN,
    configured: X.xConfigured(),
    missing: X.xMissing(),
    durable: PERSISTENT,
    inference: inferenceProvider(),
    pollMs: X_POLL_MS,
    sweepCap: SWEEP_CAP,
    sinceId: await botStateGet(X.SINCE_KEY),
  });
});

if (X_BOT_ENABLED) {
  if (!X.xConfigured()) {
    console.error(`[x] X_BOT_ENABLED is set but credentials are missing: ${X.xMissing().join(", ")}. The loop will not start.`);
  } else {
    setInterval(sweepMentions, X_POLL_MS).unref();
    setTimeout(sweepMentions, 20_000).unref();
    console.log(`[x] mention loop ON, every ${Math.round(X_POLL_MS / 1000)}s, ${X_BOT_DRY_RUN ? "DRY RUN (nothing is posted)" : "POSTING FOR REAL"}`);
  }
}

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () =>
  console.log(
    `oddie on ${BASE_URL} (port ${PORT}) — inference ${inferenceProvider().anthropic ? "anthropic" : inferenceProvider().host} (${inferenceProvider().model}) — semantic matching ${semanticEnabled() ? "ON" : `OFF (set ${SEMANTIC_KEY_ENV} to enable)`}; claim extraction ${extractEnabled() ? "ON" : `OFF (set ${EXTRACT_KEY_ENV} to enable)`}; settle mail ${mailEnabled() ? "ON" : `DRY-RUN (set ${MAIL_KEY_ENV} to send)`}`,
  ),
);
