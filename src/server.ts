import express from "express";
import { displayTitle } from "./title.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { timingSafeEqual, createHash, createHmac } from "node:crypto";
import type { Market } from "./venues/types.js";
import { nearTwins } from "./matching/matcher.js";
import { matchSemantic, matchVenue, replyCopy, semanticEnabled, SEMANTIC_KEY_ENV } from "./matching/semantic.js";
import { categorize, categorizeText, CATEGORIES } from "./matching/categorize.js";
import { type CommunityMarket, createSlug, getSlug, placeCall, leaderboard, recordEvent, slugFor, ensureHandle, settleMarket, crowdSplits, getShareCall, communityPlayerCounts, MARKET_FORMING_MIN, metricsSummary, deviceForHandle, surfacersFor, homeActivity, notifyClosingSoon, CALL_COST, botStateGet, PERSISTENT } from "./store/markets.js";
import { mentionCandidates, markMentioned, dismissMention, mintShareTokenForMention, addToAllowlist, allowlistRows } from "./store/markets.js";
import { refusalRepliesTo, toldAboutMarket, walletsInMarket, sourcePostKey,
  recordPayoutNotices, unseenPayouts, markPayoutsSeen,
  savePushSubscription, pushSubscriptionsFor, dropPushSubscription } from "./store/markets.js";
import { sendPush, vapidFromEnv } from "./push/webpush.js";
import { findDuplicate } from "./matching/duplicate.js";
import { createCommunityMarket, setCommunityOnchain, openCommunityMarkets, adminListCommunity, communityMarketDetail, markCommunityResolved, logExtraction, logTweetReply, listTweetReplies } from "./store/markets.js";
import { adoptSurfacedMarkets, recordSurfacer, awardSurface, seasonPointsLog, usersActivity, handleFromSourceUrl, sourceUrlKind } from "./store/markets.js";
import { resolvedOnchainMarkets } from "./store/markets.js";
import { communityPoolSizes } from "./store/markets.js";
import { communityRecentCalls } from "./store/markets.js";
import type { SurfacerInfo } from "./store/markets.js";
import { oracleSweep } from "./oracle/sweep.js";
import { decide } from "./oracle/oracle.js";
import { oracleAvailable } from "./oracle/verdict.js";
import { oracleAttemptFor, recordOracleDecision } from "./store/markets.js";
import { claimKeyLookup, claimKeyRecord, takeQuotaToken, releaseQuotaToken, callerScope, refusalForText, recordRefusalForText, openMarketForSourcePost, recordChainEntry, chainEntryFor, slugForOnchainPubkey, openEntriesFor, receiptWeight, logRealFee, feeLog, onchainMarketsSurfacedBy, surfacerFor, FULL_CREDIT_LAMPORTS, settledCalls, stakerCounts } from "./store/markets.js";
import { priceCall, standingsFrom, denseRank } from "./store/standings.js";
import { resolvePriceClaim, type PriceClaim, type PriceCheck } from "./price/index.js";
import type { PricedCall, Standing } from "./store/standings.js";
import { setFeaturedMarkets, getFeaturedSlugs } from "./store/markets.js";
import { hookFor, viewCounts } from "./store/markets.js";
import { runExtract, extractEnabled, EXTRACT_KEY_ENV, unsettleablePhrase, addressInQuestion } from "./matching/extractClaim.js";
import { inferenceProvider } from "./inference.js";
import { buildTweetReply, buildTweetQuote, buildVerdict } from "./matching/tweetReply.js";
import { winBonus, CREATOR_FEE_BPS_REAL, PROTOCOL_FEE_BPS_REAL } from "./store/economy.js";
import { oddsFromPools } from "./odds.js";
import {
  mintMarket, isChainEnabled, onchainEnabled, explorerUrl, adminAddress, adminBalanceSol, cluster, nameCreator, prepareCreatorFeeTx, claimProtocolFee, closeMarketOnChain, _devPutMarket,
  walletBalanceLamports,
  prepareRefundTx, refundOpensAt,
  resolveMarketOnChain, fetchMarketOnChain, fetchPosition, preparePositionTx, prepareClaimTx, submitSignedTx, isValidPubkeyString,
  prepareListTx, prepareCancelListingTx, prepareTakeListingTx, listingsFor,
  takePositionFromTx, entryShareOf, chainHealth, readMarket, readMarkets, readPositions, forgetMarket,
} from "./chain/oddieChain.js";
import type { MarketRead, OnChainMarketState } from "./chain/oddieChain.js";
import { resolveClientCountry } from "./geo/resolveClientCountry.js";
import { GEOBLOCK_LIST_VERIFIED } from "./geo/restrictedRegions.js";
import { sendMail, mailEnabled, MAIL_KEY_ENV } from "./mail.js";
import { TAGLINE } from "./brand.js";
import { renderCard, renderReceiptCard } from "./card/renderCard.js";
import { runMentionSweep, SWEEP_CAP } from "./x/mentionLoop.js";
import type { SweepDeps, SweepResult } from "./x/mentionLoop.js";
import * as X from "./x/client.js";
import { renderCardPng } from "./card/renderPng.js";
import { renderTeachCard } from "./card/renderTeachCard.js";
import { renderBanner } from "./card/renderBanner.js";
import { renderGenesisCard } from "./card/renderGenesisCard.js";
import { classifyArchetype, ARCHETYPE_LABEL, genesisShareLine } from "./genesis/archetype.js";
import { captureGenesisProfile, genesisProfileByHandle, genesisProfileForDevice, type GenesisProfile } from "./genesis/profileStore.js";
import { ticketsLeft, spendTicketForMiss, spendTicketForTag, creditFundedBettor, genesisStanding, genesisBoard, genesisRoster, genesisOpened, GENESIS_TICKETS } from "./genesis/season.js";
import { renderPositionCard } from "./card/renderPositionCard.js";
import { postResolution } from "./x/resolutionReply.js";
import { tweetCopy } from "./card/tweetCopy.js";
import { linkAccount, accountsFor, disconnectDevice, twitterHandleForWallet, twitterHandlesForWallets, walletForTwitterHandle, walletsForDevice, devicesForWallets } from "./store/accounts.js";
import { authorizeUrl, consume, identify, isConfigured, isProvider, missingSecretEnv, pkce, PROVIDERS, redirectUri, remember } from "./auth/oauth.js";
import { issueChallenge, consumeChallenge, verifyWalletSignature, shortAddress, WALLET_ADDRESS } from "./auth/wallet.js";

const app = express();
// Real client IPs, not the reverse proxy's — required for the real-money
// geofence (see src/geo/resolveClientCountry.ts) to read X-Forwarded-For
// instead of reporting Railway's own edge address for every request.
//
// 1, NOT true. `true` trusts the WHOLE X-Forwarded-For chain, and Express then
// takes its leftmost entry: a value the client writes. Every per-IP limit in
// this file (meteredRoute, the claims quota) was therefore keyed on a string
// the caller chooses, so one attacker could present a fresh "IP" per request
// and never be limited at all. Railway puts exactly one proxy in front of this
// service, so trusting one hop makes req.ip the address THAT proxy observed,
// which is the real client and is not writable from outside.
//
// If a second proxy is ever added in front (a CDN), this number goes to 2. Too
// low is safe (limits get stricter and collapse onto the proxy); too high is
// the hole above.
app.set("trust proxy", 1);

// The split itself. Only GET/HEAD navigations are redirected: an API POST that
// lands on the wrong host is a caller's bug and a 301 would silently turn it
// into a GET. Nothing happens at all while APP_HOST is unset.
app.use((req, res, next) => {
  if (!APP_HOST || (req.method !== "GET" && req.method !== "HEAD")) return next();
  const where = hostFor(req.path);
  const onApp = isAppHost(req);
  if (where === "app" && !onApp) return res.redirect(301, `${APP_BASE_URL}${req.originalUrl}`);
  if (where === "apex" && onApp && req.path !== "/") return res.redirect(301, `${BASE_URL}${req.originalUrl}`);
  next();
});
app.use(express.json());

const BASE_URL = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
/**
 * THE HOST SPLIT, BEHIND A FLAG.
 *
 * Lev's call: oddie.fun keeps the landing and the Genesis campaign; the app
 * (list at the root, /m, /you, /board, /w) moves to app.oddie.fun. Same
 * server, same repo, answering two names. Identity already crosses the line
 * (the device id is a .oddie.fun cookie, see public/app/id.js).
 *
 * APP_HOST unset = no split, today's behaviour, so this ships before the DNS
 * exists without sending anybody to a host that does not resolve. Once Lev
 * adds the CNAME and sets APP_HOST=app.oddie.fun:
 *   - app paths on the apex 301 to the app host (the one-line insurance for a
 *     bot reply or a card that still carries an apex market link);
 *   - landing paths on the app host 301 back to the apex;
 *   - "/" on the app host is the market list, not the landing.
 * Absolute app links (og:url, the bot's permalink, the v1 API's url field)
 * are built from APP_BASE_URL so they point at the right host either way.
 */
const APP_HOST = (process.env.APP_HOST ?? "").trim().toLowerCase();
const APP_BASE_URL = APP_HOST ? `https://${APP_HOST}` : BASE_URL;
const isAppHost = (req: express.Request): boolean => Boolean(APP_HOST) && req.hostname.toLowerCase() === APP_HOST;
/** The absolute origin a local path should be reached on: app paths on the
 *  app host, everything else on the apex. Used wherever the server builds a
 *  redirect from a path, so an X sign-in started on the app comes back to the
 *  app in one hop instead of via a 301 off the apex. */
const homeFor = (path: string): string => (APP_HOST && hostFor(path) === "app" ? APP_BASE_URL : BASE_URL);
/** Which host a path belongs on. "shared" is served by both (APIs, assets). */
function hostFor(path: string): "app" | "apex" | "shared" {
  if (/^\/(m|market|w)\//.test(path) || /^\/(you|positions|profile|board|leaderboard|markets)\/?$/.test(path) || path.startsWith("/@")) return "app";
  if (path === "/" || /^\/(genesis|g|card)(\/|$)/.test(path)) return "apex";
  return "shared";
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROSTER_HTML = readFileSync(path.join(__dirname, "../public/roster.html"), "utf8");
/** The rebuilt market page. Read once at boot like every other shell here,
 *  which means an edit to it needs a server restart to be visible. */
const MARKET_HTML = readFileSync(path.join(__dirname, "../public/app/market.html"), "utf8");
/** "Your positions": what a wallet has riding and what it can collect. */
const YOU_HTML = readFileSync(path.join(__dirname, "../public/app/you.html"), "utf8");
/** The board: who was right when the room disagreed. */
const LEADERBOARD_HTML = readFileSync(path.join(__dirname, "../public/app/leaderboard.html"), "utf8");
/** One wallet's record. The shareable artifact: the page somebody posts. */
const WHO_HTML = readFileSync(path.join(__dirname, "../public/app/who.html"), "utf8");
/** The list: every open market, newest first. The app's front door. */
const MARKETS_HTML = readFileSync(path.join(__dirname, "../public/app/markets.html"), "utf8");

/**
 * UYGULAMA KAPALI (Lev, 2026-09-03): app bastan yazilacak, o yuzden simdilik
 * hicbir yol eski kabugu SERVIS ETMIYOR. Kod duruyor, dosya duruyor, tek
 * degisen sey disari acilmasi.
 *
 * Bunun kapatilmasi gereken bir sey olmasinin sebebi: nav zaten "Launch app ·
 * Coming soon" diyor ve tiklamayi blokluyordu, ama /feed URL'ini yazan herkes
 * calisan uygulamayi aliyordu; menu "yakinda" derken urun aciktu. Uc kapi
 * vardi ve ucu de ayni kabugu donduruyordu: /feed, /@handle ve bilinmeyen bir
 * slug'la /m/:slug.
 *
 * Env ile geri acilir, deploy gerektirmeden: APP_OPEN=true.
 */
const APP_OPEN = (process.env.APP_OPEN ?? "false").toLowerCase() === "true";
/**
 * The X gate on the app's own pages (the list and /you). Default ON: it is
 * Lev's call that the app is the social layer and every board row should carry
 * a name from day one. Public market pages are never gated (they are what the
 * bot links to and what X unfurls). The flag exists so loosening the gate after
 * the Genesis season is an env change, not a deploy.
 */
const APP_X_GATE = (process.env.APP_X_GATE ?? "true").toLowerCase() === "true";
/**
 * THE GENESIS SEASON, INSIDE THE APP.
 *
 * The app links to /genesis in its nav, which is a destination, not a reason to
 * go. While the season is running there is a live campaign with a fixed number
 * of tickets per person, and somebody who only ever lands on app.oddie.fun has
 * no way to learn that. One line on the app's front door says it; when the
 * season ends this is an env change, not a deploy, exactly like the gate.
 */
const GENESIS_SEASON = (process.env.GENESIS_SEASON ?? "true").toLowerCase() === "true";

/** Stamp a shell so its own script knows which season/gate flags are on. Meta
 *  tags rather than body attributes because the shells have no explicit
 *  <body>. Both stamps ride the same charset anchor. */

const stampApp = (html: string): string => {
  const metas = (APP_X_GATE ? '\n<meta name="oddie-xgate" content="1">' : "")
    + (GENESIS_SEASON ? '\n<meta name="oddie-genesis" content="1">' : "");
  const stamped = metas ? html.replace('<meta charset="utf-8">', '<meta charset="utf-8">' + metas) : html;
  /* THE NAV ENTRY IS "Leaderboard" NOW, and that is a word matching a page
     rather than a rename: Genesis was the name of a season, and a person
     reading a nav needs the name of a thing. The season switch still hides it,
     because what it gates is the standing the page shows, not the word above
     it.
     Exact-string matching, and it has to stay exact: the anchor text is the
     WHOLE link or this hides a word mid-sentence and leaves prose broken. */
  return GENESIS_SEASON ? stamped
    : stamped.split('<a href="/leaderboard">Leaderboard</a>').join('<a href="/leaderboard" hidden>Leaderboard</a>');
};

/**
 * THE OPERATOR'S DOOR INTO THE CLOSED APP.
 *
 * APP_OPEN=false is the right state until Lev has tested, but "closed" must
 * not mean closed to the person testing it. /preview takes the admin token
 * he already uses for the roster, and sets a cookie on .oddie.fun (so it
 * holds across the split) whose value is an HMAC of that token: nothing
 * secret travels in the cookie, and rotating the admin token invalidates
 * every preview cookie at once. Everybody else keeps seeing the campaign.
 */
const PREVIEW_COOKIE = "oddie_preview";
const previewValue = (): string | null => {
  const t = process.env.ODDIE_ADMIN_TOKEN;
  return t ? createHmac("sha256", t).update("oddie-preview-v1").digest("hex") : null;
};
const cookieOf = (req: express.Request, name: string): string | null => {
  const m = (req.headers.cookie ?? "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
};
const hasPreview = (req: express.Request): boolean => {
  const want = previewValue(); const got = cookieOf(req, PREVIEW_COOKIE);
  return Boolean(want && got && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want)));
};
/** Open to the public, or open to this operator's browser. */
const appOpenFor = (req: express.Request): boolean => APP_OPEN || hasPreview(req);

/** Kapaliyken herkesi kampanyaya gonder: 404 vermek yerine gidilecek bir yer. */
function appClosed(res: express.Response): void {
  // Absolute, to the apex. A relative "/genesis" resolves on whichever host
  // the request hit; on app.oddie.fun that is an apex path, which the split
  // then 301s back to oddie.fun: two hops for every closed-app visit, and the
  // closed app is the path every visitor takes until APP_OPEN flips.
  res.set("Cache-Control", "no-store").redirect(302, `${BASE_URL}/genesis`);
}
const TOOL_HTML = readFileSync(path.join(__dirname, "../public/tool.html"), "utf8");
const LANDING_HTML = readFileSync(path.join(__dirname, "../public/landing.html"), "utf8");
// Genesis campaign page. Read once at boot like every other static shell here,
// so an edit needs a restart to show up.
const GENESIS_HTML = readFileSync(path.join(__dirname, "../public/genesis.html"), "utf8");

// Static assets — favicons, touch/PWA icons, the manifest, the raw logos. The two
// HTML documents keep their own routes (/tool and the app shells), and /card, /market are
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
/* THE CLOSED APP WAS NOT CLOSED.
 *
 * Every app route opens with `if (!appOpenFor(req)) return appClosed(res)`,
 * but the pages those routes serve are also real files in public/app, and
 * express.static is mounted FIRST. So /markets redirected the public to the
 * campaign while /app/markets.html handed them the whole product, 200 and
 * 98KB of it, and with no robots.txt the four pages were indexable as well.
 *
 * Only the PAGES are gated. public/app also holds id.js, me.js and money.css,
 * and public/genesis.html:941 loads /app/id.js on every single visit, so
 * gating the directory would take the campaign page down with it. The test is
 * therefore ".html directly under /app/", not "/app/".
 */
app.use((req, res, next) => {
  if (!/^\/app\/[^/]+\.html$/.test(req.path)) return next();
  if (appOpenFor(req)) return next();
  return appClosed(res);
});

app.use(express.static(path.join(__dirname, "../public"), {
  index: false,
  maxAge: "7d",
  setHeaders: (res, filePath) => {
    // chain.js and everything under public/app are the two halves of ONE
    // betting UI: the script that builds the money sheet and the stylesheet
    // that makes it legible. Shipping a markup change against a week-old
    // stylesheet is the same stale-UI-with-no-invalidation problem the note
    // above describes, so the exemption covers both.
    const base = path.basename(filePath);
    const inApp = filePath.includes(`${path.sep}public${path.sep}app${path.sep}`);
    if (base === "chain.js" || inApp) res.setHeader("Cache-Control", "no-cache");
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
 * The old app lived at /feed until 2026-09-05; the shells under public/app are the app now. The landing does NOT bounce a
 * returning player into it: the storage read that used to do that went in
 * e4f1ef0, and `grep -c "localStorage\|OddieId" public/landing.html` is 0
 * today. Everyone gets the pitch, every time. Said plainly because the old
 * sentence claimed a behaviour that has not existed for two weeks, and the
 * next person to edit this file would have believed it.
 *
 * The hero art carries no cards: the painting reads as one picture and they
 * were sitting on top of it.
 *
 * There WAS a two-state band below the fold -- teach the loop under N real
 * markets, become a shelf of live ones at or above it -- and its reasoning is
 * still right: a launch-day landing holding two markets claims more than the
 * product has, and an empty shelf claims it and fails. The slot was deleted
 * from the page in e169921 and the code that fed it is gone with it (see the
 * note at the render below). LANDING_PROOF_MIN now survives NOTHING on the
 * page: the slot went when the cream half became one block. It is kept as the
 * number that reasoning arrived at, so bringing the line back does not have to
 * re-derive it. Nothing reads it.
 */
const LANDING_TTL_MS = 60_000;
const LANDING_PROOF_MIN = 25;   // markets before the count is worth printing
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

  /* THE LIVE-CARDS BAND IS GONE, AND SO IS THE CODE THAT FED IT.
   *
   * This built up to LANDING_LIVE_CARDS anchors and wrote them into
   * <!--LIVE_CARDS-->, next to a <!--LIVE_MODE--> flag. Commit e169921 deleted
   * both slots and all the .lcard CSS from public/landing.html and left this
   * standing: `grep -c "<!--LIVE_CARDS-->" public/landing.html` is 0.
   *
   * Harmless today only because community.length is 0 and LANDING_LIVE_MIN is
   * 15, so liveMode is "0" and nothing is built. On the day the 15th market
   * opens it would have sorted, sliced, rendered six real market cards and
   * thrown every one of them at a placeholder that is not in the document. No
   * error, no log, no test, and the front door would go on teaching the loop
   * forever while the code that decides when to stop believed it had flipped.
   *
   * This is not hypothetical: landing.html:1110 records the same bug reaching
   * production once already with NET_CHIP. scripts/test-placeholders.ts now
   * fails the build if any .replace("<!--NAME-->") has no matching slot.
   *
   * Deleted rather than rewired because the band was removed on purpose. The
   * implementation is in e169921^ if the proof band comes back.
   */
  /* THE PROOF LINE IS GONE WITH ITS SLOT. The cream half is one block now --
     the offer, and nothing else -- so the counter that used to sit in the fee
     band has nowhere to be printed. The placeholder and the .replace() that
     filled it go TOGETHER: leaving the replace behind is how this file ended
     up with a live no-op once before, which is what test-placeholders exists
     to catch and did.
     To bring it back, add <!--PROOF--> to a page and rebuild the two or three
     lines below it; LANDING_PROOF_MIN is deliberately kept as the threshold
     that reasoning arrived at. */
  /* THE STATUS CHIP IS GONE FROM THE PAGE (Lev), and its code goes with it.
     It printed "Real SOL · live on Solana" on mainnet and an empty string
     anywhere else, which was the honest version of a network claim. Nothing
     about that reasoning was wrong; the cream half is one block now and the
     chip was the last thing still sitting outside it.
     The placeholder and the .replace() leave TOGETHER. This file has shipped a
     live no-op twice by deleting one and keeping the other, which is what
     test-placeholders exists to catch. The network is still stated where it
     decides something: chain.js writes clusterLabel from the server's cluster
     in the app, and nothing there changed. */

  /* THE UNLINK-WHEN-EMPTY DANCE IS GONE WITH THE SENTENCE IT GUARDED. It
     stripped the href from "The board ranks" so a launch-day page did not send
     anybody to an empty table. The landing does not write that sentence any
     more -- it renders the BOARD, and the board renders nothing when nobody is
     on it, which is the same judgment made one step earlier and without a
     string to keep in sync. */

  /* THE OPENER BOARD, ON THE FRONT DOOR.
   *
   * It ranks by people brought in -- distinct wallets whose FIRST real-money
   * bet landed in a market that handle opened -- which is the one number
   * opening a market accumulates. The app has the same board; this is the copy
   * that has to make a stranger want to go and look.
   *
   * TWO STATES, ONE IMPLEMENTATION, because the honest answer changes and the
   * markup must not. With rows it prints them. With none it prints the dare
   * instead, which is true on a launch and needs no edit the day it stops being
   * true. What it must NEVER do is print an empty table: this page decided once
   * already that a true-but-empty number ("1 market tagged so far") does
   * nothing but announce that nobody is here, and LANDING_PROOF_MIN is the
   * scar. An empty shelf is the same claim.
   *
   * Failure renders nothing at all. A board that could not be read is not a
   * board with nobody on it, and guessing between those is how a page starts
   * lying by accident. */
  const boardRows = await genesisBoard(5).catch(() => null);
  /* EMPTY PRINTS NOTHING, same as a failed read (Lev). The apology line that
     used to sit here said out loud that nobody was on it, which is a status
     report where an invitation belongs -- and the headline above already IS
     the invitation. The app's own leaderboard still carries the long version,
     because somebody who clicked through has asked to know. */
  const boardHtml = !boardRows || boardRows.length === 0
    ? ""
    : '<ol class="lead__rows">'
        + boardRows.map((r) => '<li class="lead__row"><span class="lead__n">'
            + r.rank + '</span><span class="lead__h">@' + escHtml(r.handle) + '</span>'
            + '<span class="lead__p"><b>' + r.peopleBrought + '</b> '
            + (r.peopleBrought === 1 ? "person" : "people") + '</span></li>').join("")
        + "</ol>";

  const html = LANDING_HTML.replace("<!--BOARD-->", boardHtml);

  // Only a COMPLETE render earns a place in the cache. Caching a degraded one
  // pins whatever was missing at boot to the front door for the next full
  // minute; leaving it uncached means the very next request repairs it.
  // A render is complete enough to cache once the market read succeeded. The
  // proof line being empty is a legitimate answer (a brand-new install has
  // nothing to report), so it is not a reason to keep re-rendering.
  if (community.length > 0) landingCache = { html, at: Date.now() };
  return html;
}

app.get("/", async (req, res) => {
  // On the app host the root IS the app: the list, not the landing. This is
  // the front door Lev felt was missing ("the app has no home").
  if (isAppHost(req)) {
    if (!appOpenFor(req)) return appClosed(res);
    return res.set("Cache-Control", "no-cache").type("html").send(stampApp(MARKETS_HTML));
  }
  res.set("Cache-Control", "no-cache");
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
      feedUrl: `${APP_BASE_URL}/markets`,
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


/**
 * The rebuilt market page's og tags.
 *
 * The description is built from an ACTUAL read, not from a stored opening
 * line, and it refuses to quote a percentage it could not measure: an unfurl
 * is the most-copied surface we have, and "68% yes right now" pasted into X
 * about a pool nobody could read would outlive the blip that caused it.
 */
async function marketShellHtml(slug: string, question: string): Promise<string> {
  const title = displayTitle(question);
  const detail = await communityMarketDetail(slug).catch(() => null);
  const read = detail?.onchainPubkey
    ? await readMarket(detail.onchainPubkey, { maxAgeMs: 10_000 }).catch((): MarketRead => ({ ok: false, reason: "unreadable", error: "read threw" }))
    : ({ ok: false, reason: "absent" } as MarketRead);
  let desc = "Real money on Solana. Call it YES or NO.";
  if (read.ok) {
    if (read.state.resolved && read.state.winningSide) {
      desc = `Resolved ${read.state.winningSide.toUpperCase()}. Settled on Solana.`;
    } else {
      /* THE THIRD COPY. This description is what unfurls on X, in Slack, in
         iMessage -- every place a market link is pasted -- and it carried its
         own clamped Math.min(99, ...), so it went on saying "99% yes right
         now" about a pool nobody had taken the other side of after the card,
         the API and the page had all stopped. Same definition as the rest now:
         a price exists only when both sides hold money. */
      const view = oddsFromPools(
        read.state.totalYesLamports, read.state.totalNoLamports,
        { creatorBps: read.state.creatorFeeBps ?? detail?.creatorFeeBps ?? CREATOR_FEE_BPS_REAL,
          protocolBps: PROTOCOL_FEE_BPS_REAL });
      const sol = (n: number): string => (n / 1e9).toFixed(2);
      if (view.state === "priced") {
        desc = `${sol(view.totalLamports)} SOL in the pool, ${view.yesPct}% yes right now.`;
      } else if (view.state === "one-sided") {
        desc = `${sol(view.totalLamports)} SOL in the pool. Nobody has taken the other side yet.`;
      } else {
        desc = "No one has backed a side yet. The first stake sets the price.";
      }
    }
  }
  const img = `${BASE_URL}/card/${slug}.png`;
  const url = `${BASE_URL}/m/${slug}`;
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
  /* THE PAYLOAD RIDES ALONG. Without it this page ships 137KB whose whole
     visible body is "Loading the market...", then asks for the content in a
     second round trip: html done at 211ms, content painted at 893ms, measured
     on a desktop connection. On the one page every visitor from X lands on.
     Not a second renderer -- the client's render() runs on this object exactly
     as it runs on the fetched one, so there is no markup to drift. A failure
     here inlines nothing and the page falls back to fetching, which is the
     behaviour it has today. JSON inside a script element needs only "</" broken
     up; the rest is already safe because the content type is not HTML. */
  let boot = "null";
  try {
    const payload = await marketDetailPayload(slug);
    if (payload) boot = JSON.stringify(payload).replace(/<\//g, "<\\/");
  } catch { /* the page fetches for itself */ }
  return MARKET_HTML
    .replace("<title>oddie</title>", `<title>${ogEsc(title)} · oddie</title>\n${tags}`)
    .replace('id="boot">null<', `id="boot">${boot}<`);
}

/** The market permalink while the app is closed: an honest object instead of a
 *  redirect. It carries the claim, the market card as its unfurl image, and one
 *  way forward. An unknown slug still renders, without inventing a claim. */
function closedMarketHtml(slug: string, question: string | null): string {
  const png = `${BASE_URL}/card/${encodeURIComponent(slug)}.png`;
  const title = question ?? "An oddie market";
  const desc = "A real prediction market on Solana, opened by tagging @oddiefun on a claim on X.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)} \u00b7 oddie</title>
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(desc)}">
<meta property="og:image" content="${png}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${png}">
<link rel="icon" href="/favicon.ico?v=2" sizes="any">
<style>body{margin:0;background:#020302;color:#fff;font-family:'Nunito',system-ui,sans-serif;font-weight:600;
display:flex;flex-direction:column;align-items:center;gap:18px;padding:34px 18px;text-align:center}
img{max-width:min(96vw,760px);border-radius:18px}
h1{font-size:21px;line-height:1.35;margin:0;max-width:26ch}
p{margin:0;color:rgba(255,255,255,.62);max-width:52ch;font-size:15px}
a.claim{background:#D7DC1F;color:#020302;text-decoration:none;font-weight:800;
padding:14px 26px;border-radius:999px;font-size:17px}</style></head><body>
<img src="${png}" alt="${escHtml(title)}">
${question ? `<h1>${escHtml(question)}</h1>` : ""}
<p>This market is open on Solana. Betting opens to everyone shortly. Genesis is running first.</p>
<a class="claim" href="/genesis">Get your 5 tickets</a>
</body></html>`;
}


// The market permalink — every market's canonical landing page. /m/{slug} is
// the short share path; /market/{slug} (already in the wild) serves the same.
app.get(["/m/:slug", "/market/:slug"], async (req, res) => {
  /* Eskiden burasi appClosed() idi: her market kalici baglantisi iki hop
   * atlayip /genesis'e dusuyordu. Ustundeki "canlida hic market yok" olcumu
   * artik dogru degil (/api/v1/markets bir acik market donuyor) ve bot'un
   * cevabi tam bu adresin etrafinda kuruluyor. Kapali uygulama market
   * sayfasini acmaz, ama baglanti artik NE oldugunu soyleyen, X'te unfurl
   * eden ve devam edilecek bir yeri olan bir sayfadir. */
  if (!appOpenFor(req)) {
    const q = (await communityMarketDetail(req.params.slug).catch(() => null))?.question ?? null;
    return res.set("Cache-Control", "no-cache").type("html").send(closedMarketHtml(req.params.slug, q));
  }
  // The ?pc= personal-share page went with feed.html: its unfurl is now the
  // wallet's record at /w/<address>, and the bot's resolution card (/card/pc)
  // still renders without it. A stale ?pc= link lands on the market, which is
  // the honest fallback it always had.
  // The rebuilt shell. no-cache for the same reason genesis carries it: this
  // page inlines its own script, and a heuristically-cached copy runs stale
  // script against a live money API.
  const question = (await communityMarketDetail(req.params.slug).catch(() => null))?.question ?? null;
  // An unknown slug still gets the shell: the page's own fetch renders the
  // "no market here" state, which is a better dead end than the old app.
  const html = question
    ? await marketShellHtml(req.params.slug, question)
    : MARKET_HTML;
  res.set("Cache-Control", "no-cache").type("html").send(html);
});

// Public profile page — the reputation/share loop's real destination. Serves the
// SPA shell with per-handle og tags (image = the profile card), so a shared
// /@{handle} link unfurls on X showing the Oddie Score. Fully viewable logged
// out; the SPA renders the public view from /api/profile/{handle}.

app.get("/@:handle", async (req, res) => {
  if (!appOpenFor(req)) return appClosed(res);
  /**
   * ONE PERSON, ONE RECORD, TWO DOORS.
   *
   * This was a second profile system keyed on the device (score, badges,
   * accuracy), beside the wallet-keyed record at /w/<address>. Two records for
   * one person disagree eventually, and the device-keyed one was already
   * frozen (its inputs stopped being written at the pivot). So the handle is
   * now a door onto the wallet's record: linked wallet -> 302 there. A handle
   * that exists but never linked a wallet gets the honest dead end below rather
   * than an empty profile pretending to be a record.
   */
  const handle = String(req.params.handle).replace(/^@+/, "");
  const wallet = await walletForTwitterHandle(handle).catch(() => null);
  if (wallet) return res.redirect(302, `/w/${wallet}`);
  const known = await deviceForHandle(handle).catch(() => null);
  const title = known ? `@${handle} has not linked a wallet yet` : `No such handle`;
  const body = known
    ? `Every call on oddie is stamped to a wallet. <b>@${escHtml(handle)}</b> has connected X but has not linked the wallet they stake from, so there is no record to show yet.`
    : `Nobody by that name has connected to oddie.`;
  res.status(known ? 200 : 404).set("Cache-Control", "no-cache").type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escHtml(title)} · oddie</title>
<style>body{margin:0;background:#020302;color:#FBFCF4;font-family:'Nunito',system-ui,sans-serif;padding:40px 20px}
.s{max-width:640px;margin:0 auto}h1{font-family:'Anton','Arial Narrow',sans-serif;font-weight:400;text-transform:uppercase;font-size:clamp(28px,6vw,44px);line-height:1.02;margin:0 0 14px}
p{font-size:16px;line-height:1.55;color:rgba(255,255,255,.72);margin:0 0 22px}b{color:#FBFCF4}
a{font-family:ui-monospace,Menlo,monospace;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#D7DC1F}</style></head>
<body><div class="s"><h1>${escHtml(title)}</h1><p>${body}</p><a href="/board">See who was right</a></div></body></html>`);
});

// Both paths serve the SAME file: /genesis/how is a view of the campaign page,
// not a second copy of it. The explanation lives in exactly one place, and the
// boot script switches views off location.pathname.
app.get(["/genesis", "/genesis/how"], (_req, res) => {
  // no-cache = the browser must revalidate (cheap 304 via etag) before reusing.
  // The page inlines its JS, so a heuristically-cached copy runs stale script;
  // this is what left an old "Post your card" tweet string live after a deploy.
  res.set("Cache-Control", "no-cache").type("html").send(GENESIS_HTML);
});

/**
 * The return half of the loop.
 *
 * Somebody who staked had nowhere to come back to: the open-stakes and
 * claim-check widgets existed only as mounts inside feed.html, keyed off its
 * own `data-view="positions"` shell. A market page that says "collect it with
 * the wallet you staked from" needs a page where that happens.
 *
 * Wallet-scoped, not account-scoped, so it is noindex and holds nothing
 * personal in the URL: everything on it comes from the wallet the visitor
 * connects, and the server never links a wallet to a device.
 */
app.get("/profile", (req, res) => {
  if (!appOpenFor(req)) return appClosed(res);
  res.set("Cache-Control", "no-cache").set("X-Robots-Tag", "noindex, nofollow").type("html").send(stampApp(YOU_HTML));
});
/* /you was the original name and is kept forever, not deleted. It is a page
 * people bookmark, it is the return path baked into X sign-ins that were
 * started before this rename, and returnTo is validated for SHAPE and never
 * for existence -- so a deleted /you would link somebody's X account
 * successfully and then drop them on a 404, with nothing logged. Relative
 * target, so it stays on whichever host the request arrived on.
 *
 * Both names stay in hostFor()'s app-path alternation permanently: tidying
 * "you|" out of it while this redirect lives would reclassify /you as shared,
 * stop the apex-to-app 301 firing for it, and land old links on the wrong
 * host with no error anywhere. */
app.get(["/you", "/positions"], (_req, res) => res.redirect(301, "/profile"));

/**
 * The list. Public and indexable.
 *
 * Deliberately the only ordering: newest first, which is what a product fed by
 * X should show — the market somebody just opened is the one being argued
 * about right now. No sort control, because a second ordering would need a
 * reason and there is not one yet; the pool is on every card, so where the
 * action is stays visible without a toggle.
 */
// NOT also "/app": public/app/ is a real asset directory now, and
// express.static (registered first) answers /app with a 301 to /app/ before
// this route is ever reached. A route name that a directory already owns is a
// trap rather than a convenience.
const PREVIEW_PAGE = (msg: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Preview · oddie</title><style>body{margin:0;background:#020302;color:#FBFCF4;font-family:system-ui,sans-serif;padding:40px 20px}
.s{max-width:420px;margin:0 auto}h1{font-family:'Anton','Arial Narrow',sans-serif;font-weight:400;text-transform:uppercase;font-size:34px;margin:0 0 6px}
p{color:rgba(255,255,255,.7);font-size:14px;line-height:1.5;margin:0 0 18px}label{display:block;font:700 11px ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.5);margin:0 0 8px}
input{width:100%;box-sizing:border-box;font:inherit;padding:12px;border:3px solid #FBFCF4;background:#020302;color:#FBFCF4}
button{margin-top:12px;font:800 15px ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;background:#D7DC1F;color:#0B0D04;border:3px solid #020302;padding:12px 18px;cursor:pointer;box-shadow:5px 6px 0 #5A6109}
.e{color:#FF2D78;font:700 12px ui-monospace,monospace;margin:10px 0 0}</style></head>
<body><div class="s"><h1>Operator preview</h1><p>The app is closed to the public. Your admin token opens it in this browser, on both hosts, for 30 days.</p>
<form method="post" action="/preview"><label for="t">Admin token</label><input id="t" name="token" type="password" autocomplete="off"><button type="submit">Open the app for me</button></form>${msg ? `<p class="e">${msg}</p>` : ""}</div></body></html>`;

/* Terms and privacy. A product that takes an OAuth grant and puts money in a
 * vault had neither, and both URLs answered 404, which is the one answer a
 * legal page must never give. Read at boot like every other shell here, and
 * routed explicitly because express.static is mounted with index:false and so
 * never maps /terms to terms.html by itself. */
const TERMS_HTML = readFileSync(path.join(__dirname, "../public/terms.html"), "utf8");
const PRIVACY_HTML = readFileSync(path.join(__dirname, "../public/privacy.html"), "utf8");
app.get(["/terms", "/terms.html"], (_req, res) => res.type("html").send(TERMS_HTML));
app.get(["/privacy", "/privacy.html"], (_req, res) => res.type("html").send(PRIVACY_HTML));


app.get("/preview", (_req, res) => {
  res.set("Cache-Control", "no-store").type("html").send(PREVIEW_PAGE(""));
});
app.post("/preview", express.urlencoded({ extended: false }), (req, res) => {
  const want = process.env.ODDIE_ADMIN_TOKEN ?? "";
  const got = String(req.body?.token ?? "");
  const ok = want.length > 0 && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
  if (!ok) {
    console.log(JSON.stringify({ evt: "preview_refused" }));
    return res.status(401).set("Cache-Control", "no-store").type("html").send(PREVIEW_PAGE("That token was not accepted."));
  }
  const host = new URL(BASE_URL).hostname;
  const domain = /(^|\.)oddie\.fun$/.test(host) ? "; Domain=.oddie.fun" : "";
  const secure = BASE_URL.startsWith("https:") ? "; Secure" : "";
  res.set("Set-Cookie", `${PREVIEW_COOKIE}=${previewValue()}; Path=/; Max-Age=${30 * 86400}; HttpOnly; SameSite=Lax${secure}${domain}`);
  res.set("Cache-Control", "no-store").redirect(302, `${APP_BASE_URL}/`);
});

// Old bookmarks and any link that still says /feed land on the app's home.
// The route itself is gone; this is one line so it never 404s on somebody.
app.get("/feed", (_req, res) => res.redirect(301, "/markets"));

app.get("/markets", (req, res) => {
  if (!appOpenFor(req)) return appClosed(res);
  res.set("Cache-Control", "no-cache").type("html").send(stampApp(MARKETS_HTML));
});

/** /board IS /leaderboard NOW, and this redirect is the whole of what is left
 *  of it. As a RANKING the page never worked: its own code hides the table
 *  below three people, one person has ever settled a call, so it rendered as a
 *  heading over a single card. Its three parts moved to the page that is named
 *  for what they are -- the openers' board, the callers' board and the
 *  settlements that both are computed from, one under the other.
 *  301 and not a delete: the bot has been posting links for weeks and a shared
 *  link that 404s is a worse answer than one that lands somewhere true. */
app.get("/board", (req, res) => {
  if (!appOpenFor(req)) return appClosed(res);
  res.redirect(301, "/leaderboard");
});

/** THE OTHER BOARD, and /leaderboard used to be an ALIAS of the one above: the
 *  same page under two names, which is how a product ends up with one word for
 *  two things. They rank different people by different numbers -- /board ranks
 *  callers by being right when the room disagreed, this ranks openers by the
 *  people they brought in. Splitting the alias is what lets the front door
 *  link to a ranking that matches what it advertised. */
app.get("/leaderboard", (req, res) => {
  if (!appOpenFor(req)) return appClosed(res);
  res.set("Cache-Control", "no-cache").type("html").send(LEADERBOARD_HTML);
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

// The client only ever shows HOME_FEATURED_SHOWN cards in the visible "Open
// markets" section — but it fetches HOME_FEATURED_POOL, and keeps the extras
// client-side as the continuous-play loop's reserve (see the Home CTA chain:
// lock a call -> "Next call" -> pull one from the reserve, in place, no nav).
// One request, one ranking pass, no second endpoint for "more of the same
// list" — the loop and the visible section are just two slices of it.
const HOME_FEATURED_SHOWN = 4;
const HOME_FEATURED_POOL = 12;




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
/** The teach card, likewise drawn once: it carries no per-tweet content. */
let teachPngCache: Buffer | null = null;
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
// Bump when the Genesis card design changes so X (which caches og:images hard)
// re-fetches: the query makes the URL new to the crawler, the bytes are already
// the current render.
const GENESIS_CARD_VERSION = "3";

app.get("/g/:handle", async (req, res) => {
  const gp = await genesisProfileByHandle(req.params.handle).catch(() => null);
  if (!gp) return res.redirect("/genesis");
  const label = ARCHETYPE_LABEL[gp.archetype];
  const png = `${BASE_URL}/card/genesis/${encodeURIComponent(gp.handle)}.png?v=${GENESIS_CARD_VERSION}`;
  const title = `${label} · @${gp.handle}`;
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)} · oddie</title>
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(gp.headline)} \u00b7 oddie turns a claim on X into a real prediction market.">
<meta property="og:image" content="${png}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${png}">
<link rel="icon" href="/favicon.ico?v=2" sizes="any">
<style>body{margin:0;background:#020302;color:#fff;font-family:'Nunito',system-ui,sans-serif;font-weight:600;
display:flex;flex-direction:column;align-items:center;gap:18px;padding:34px 18px}
img{max-width:min(96vw,760px);border-radius:18px}
h1{font-size:20px;line-height:1.35;margin:0;max-width:26ch;text-align:center}
p{margin:0;color:rgba(255,255,255,.62);max-width:56ch;text-align:center;font-size:15px}
a.claim{background:#D7DC1F;color:#020302;text-decoration:none;font-weight:800;
padding:14px 26px;border-radius:999px;font-size:17px}</style></head><body>
<img src="${png}" alt="${escHtml(title)}">
<h1>oddie turns a claim on X into a real prediction market.</h1>
<p>Tag @oddiefun on any claim and people bet real money on YES or NO.
This card is what oddie read in @${escHtml(gp.handle)}. Yours is one tap away.</p>
<a class="claim" href="/genesis">Get your 5 tickets</a>
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
  /* Bilet harcandiktan sonra alinan seyi gosteren tek bir yuzey yoktu:
   * genesis_tag ilk etiketten beri cevabi tutuyordu, ama parayi odeyen kisi
   * icin hicbir zaman geri okunmadi. Bos dizi gecerli bir cevaptir, o yuzden
   * standing gibi "yoksa yok" degil, "okuma coktuyse bos". */
  const opened = await genesisOpened(gp.handle).catch(() => []);
  res.json({ profile: {
    handle: gp.handle, name: gp.name, archetype: gp.archetype,
    label: ARCHETYPE_LABEL[gp.archetype], headline: gp.headline, reason: gp.reason,
    cardUrl: `/card/genesis/${encodeURIComponent(gp.handle)}.png`,
    shareUrl: `${BASE_URL}/g/${encodeURIComponent(gp.handle)}`,
    shareText: genesisShareLine(gp.archetype),
    // Absent rather than zeroed when the read failed: the page shows what it
    // knows, and a fabricated 5/5 would be a lie about somebody's balance.
    standing,
      opened,
  } });
});

/**
 * THE ROSTER — everybody the campaign has touched, and what they did with it.
 *
 * Admin-gated, because it is the one place handles, display names, archetypes
 * and tag targets sit together; the public board deliberately shows only people
 * who brought somebody and only their count.
 *
 * The PAGE is served open (it is an empty shell) and asks for the token itself,
 * so the token travels in a header instead of a URL and never lands in a log or
 * a referrer.
 */
app.get("/genesis/roster", (_req, res) => {
  res.set("X-Robots-Tag", "noindex, nofollow").type("html").send(ROSTER_HTML);
});

app.get("/api/admin/genesis/roster", requireAdmin, async (req, res) => {
  const limit = Number(req.query.limit);
  const roster = await genesisRoster(Number.isFinite(limit) ? limit : 200).catch(() => []);
  res.set("Cache-Control", "no-store").json({ tickets: GENESIS_TICKETS, roster });
});

/**
 * How much runway the admin wallet has left, in markets.
 *
 * Every market costs the admin wallet rent it will never get back (close_market
 * refuses any market that took a bet, and mints are on-demand, so effectively
 * every minted market has taken one). When the balance crosses the floor,
 * minting stops -- and the only trace today is a log line. This endpoint, and
 * the strip it draws on /genesis/roster, are what make that visible before it
 * happens rather than after.
 *
 * Admin-gated because it names the admin wallet and its balance. That is not a
 * secret in the cryptographic sense (the address is on chain either way), but
 * "here is the wallet that pays for everything and here is how close it is to
 * empty" is an invitation we do not need to print publicly.
 */
app.get("/api/admin/chain/health", requireAdmin, async (req, res) => {
  const health = await chainHealth(req.query.fresh === "1").catch(() => null);
  if (!health) return res.status(503).json({ ok: false, error: "health unavailable" });
  res.set("Cache-Control", "no-store").json({ ok: true, ...health });
});

/** The season board. Public: it is a leaderboard. */
/**
 * KNOCK ON THE DOOR OF EVERY BROWSER THAT ASKED TO BE TOLD.
 *
 * Wallets to devices to subscriptions, in that order, because those are three
 * genuinely different things: the money belongs to a wallet, permission belongs
 * to a browser, and one person can have both a phone and a laptop and should
 * hear once on each.
 *
 * BEST-EFFORT BY CONTRACT, and more firmly than most things wearing that label.
 * The money has already moved on chain by the time this runs. A push is an
 * announcement, the profile says the same thing forever whether or not it
 * arrives, and nothing here may hold up or fail a settlement.
 *
 * A 404 or 410 is the push service saying that subscription no longer exists,
 * which is the one failure worth acting on: the row is deleted, because keeping
 * it means trying forever for a browser that will never answer.
 */
async function pushPayoutNotice(slug: string, outcome: "yes" | "no", wallets: string[]): Promise<void> {
  const keys = vapidFromEnv();
  if (!keys || wallets.length === 0) return;
  const devices = await devicesForWallets(wallets).catch(() => []);
  const subs = await pushSubscriptionsFor(devices).catch(() => []);
  if (subs.length === 0) return;

  /* WHAT IT MAY SAY. The same rule the public post follows: it is about the
     MARKET, never about a person. This lands on a lock screen that anybody
     standing nearby can read, and "you won" on somebody's lock screen is their
     business becoming the room's. It settled, there is something to collect,
     the app says the rest behind whatever lock the phone has. */
  const payload = {
    title: "oddie",
    body: `A market you were in settled ${outcome.toUpperCase()}. There is something to collect.`,
    url: `${APP_BASE_URL}/profile`,
    tag: `payout:${slug}`,
  };
  let sent = 0, gone = 0;
  for (const sub of subs) {
    const r = await sendPush(sub, payload, keys);
    if (r.ok) { sent++; continue; }
    if (r.gone) { gone++; await dropPushSubscription(sub.endpoint).catch(() => {}); }
    else console.error(JSON.stringify({ evt: "push_failed", slug, status: r.status, error: r.error }));
  }
  console.log(JSON.stringify({ evt: "payout_push", slug, outcome, sent, gone, subscriptions: subs.length }));
}

/**
 * IS THERE MONEY WAITING FOR THIS BROWSER?
 *
 * Keyed on the DEVICE and answered from the wallets linked to it, which is the
 * only shape that works for everybody: a bettor is guaranteed to have a wallet
 * and is not guaranteed to have connected X, so anything routed through a
 * handle would quietly skip the people who arrived from a tweet and bet.
 *
 * A pure database read on purpose. The masthead asks this on every page, and a
 * live getMultipleAccounts per page view would be a chain read per visitor per
 * navigation. What it counts is settlements this browser has not been SHOWN,
 * not what is still unclaimed; the profile's own claimable list is the
 * authority on what is actually owed.
 *
 * Registered OUTSIDE the real-stakes gate, deliberately. Those routes disappear
 * when the chain layer is off, and money that already moved is exactly the
 * thing somebody must still be able to hear about on a deploy with betting
 * switched off.
 */
app.get("/api/chain/payouts", async (req, res) => {
  const deviceId = typeof req.query.deviceId === "string" && DEVICE_ID.test(req.query.deviceId) ? req.query.deviceId : null;
  if (!deviceId) return res.json({ count: 0 });
  const wallets = await walletsForDevice(deviceId).catch(() => []);
  if (!wallets.length) return res.json({ count: 0 });
  const count = await unseenPayouts(wallets).catch(() => 0);
  res.set("Cache-Control", "no-store").json({ count });
});

/**
 * THE PUBLIC HALF OF THE VAPID PAIR.
 *
 * Not a secret: every browser that subscribes is handed it, and a subscription
 * is bound to it forever. Null when push is simply not configured, which the
 * client reads as "do not ask anybody for permission" rather than as an error.
 */
app.get("/api/push/key", (_req, res) => {
  const keys = vapidFromEnv();
  res.set("Cache-Control", "no-store").json({ key: keys?.publicKey ?? null });
});

/** A browser granting permission. Endpoint-keyed upsert, so a re-subscribe
 *  after a permission reset replaces the row instead of doubling it. */
app.post("/api/push/subscribe", express.json(), async (req, res) => {
  const deviceId = typeof req.body?.deviceId === "string" && DEVICE_ID.test(req.body.deviceId) ? req.body.deviceId : null;
  const sub = req.body?.subscription;
  if (!deviceId || typeof sub?.endpoint !== "string" || !sub.keys?.p256dh || !sub.keys?.auth) {
    return res.status(400).json({ ok: false });
  }
  // An endpoint is a URL the server will later POST to, so it is checked like
  // one: https only, and no shape we did not expect.
  if (!/^https:\/\/[^\s]+$/.test(sub.endpoint)) return res.status(400).json({ ok: false });
  await savePushSubscription(deviceId, {
    endpoint: sub.endpoint,
    keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) },
  }).catch(() => {});
  res.json({ ok: true });
});

/**
 * PROVE IT ON THE DEVICE, BEFORE A PAYOUT DEPENDS ON IT.
 *
 * Everything about this path is verified except the last inch, and the last
 * inch is the one that cannot be tested from a server: whether a notification
 * actually appears, on a real phone, from a real push service. The alternative
 * to this route is finding out the first time somebody wins.
 *
 * It only ever reaches subscriptions the CALLING DEVICE registered, so there is
 * nothing here to abuse: making your own browser show a notification is
 * something you can already do. Device ids are unguessable and the text is
 * fixed, so the worst a guessed id buys is one fixed buzz, and the rate limit
 * bounds even that.
 */
app.post("/api/push/test", express.json(), async (req, res) => {
  if (!meteredRoute(req, res, "push-test", 20)) return;
  const deviceId = typeof req.body?.deviceId === "string" && DEVICE_ID.test(req.body.deviceId) ? req.body.deviceId : null;
  if (!deviceId) return res.status(400).json({ ok: false });
  const keys = vapidFromEnv();
  if (!keys) return res.json({ ok: false, reason: "push is not configured" });
  const subs = await pushSubscriptionsFor([deviceId]).catch(() => []);
  if (subs.length === 0) return res.json({ ok: false, reason: "this browser has not subscribed" });

  let sent = 0;
  for (const sub of subs) {
    const r = await sendPush(sub, {
      title: "oddie",
      // Deliberately shaped like the real thing, because what is being proven
      // is the whole delivery and not a string: same icon, same landing page,
      // same lock screen.
      body: "This is what a settled market will look like.",
      url: `${APP_BASE_URL}/profile`,
      tag: "push-test",
    }, keys);
    if (r.ok) sent++;
    else if (r.gone) await dropPushSubscription(sub.endpoint).catch(() => {});
  }
  res.json({ ok: sent > 0, sent, subscriptions: subs.length });
});

/** Permission withdrawn, or the browser rotated its endpoint. */
app.post("/api/push/unsubscribe", express.json(), async (req, res) => {
  const endpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint : "";
  if (endpoint) await dropPushSubscription(endpoint).catch(() => {});
  res.json({ ok: true });
});

/** They have been shown it. Called by the profile once it has actually drawn
 *  the money on screen, never by the masthead: a badge that cleared itself by
 *  being counted would vanish before anybody read it. */
app.post("/api/chain/payouts/seen", express.json(), async (req, res) => {
  const deviceId = typeof req.body?.deviceId === "string" && DEVICE_ID.test(req.body.deviceId) ? req.body.deviceId : null;
  if (!deviceId) return res.json({ ok: false });
  const wallets = await walletsForDevice(deviceId).catch(() => []);
  if (wallets.length) await markPayoutsSeen(wallets).catch(() => {});
  res.json({ ok: true });
});

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

  /* A MARKET, WITHOUT A CHAIN.
   * Dev-only, and the reason it exists is that the money page could not be
   * looked at locally at all: /api/v1/markets mints before it publishes, so
   * with no admin key every attempt answered "no vault, not published" and the
   * one page worth designing carefully was the one page nobody could open
   * without pointing at production.
   * It writes the row and the provenance and nothing else. No mint, no vault,
   * no stake: the page reads the pool off the chain and degrades to "unpriced"
   * on its own, which is a state worth being able to see anyway. */
  /** The seed itself, so the route and the boot below cannot drift apart. */
  const devSeedMarket = async (b: Record<string, unknown>) => {
    const closeIso = String(b.closeTime ?? new Date(Date.now() + 19 * 86_400_000).toISOString());
    /* THE DEFAULTS ARE THE POINT. A bare call has to produce a market that
       looks like the ones the bot actually opens - a hook, a long question, a
       tagger, a source post and a pool - because a market missing any of those
       is missing exactly the rows whose layout is being judged. */
    const out = await createCommunityMarket({
      question: String(b.question
        ?? "Will World (@world_xyz) officially announce a $319M airdrop for Solana users by September 30, 2026?"),
      closeTime: Math.floor(new Date(closeIso).getTime() / 1000),
      category: String(b.category ?? "Crypto"),
      yesPct: 50,
      resolutionCriteria: String(b.resolutionCriteria
        ?? "Resolves YES if an official post from the @world_xyz X account or the World (world.org) website announces an airdrop totalling approximately $319 million designated for Solana users on or before September 30, 2026. Resolves NO otherwise."),
      resolvability: "clean",
      hook: String(b.hook ?? "$319M Solana airdrop?"),
    });
    await recordSurfacer(out.slug, {
      sourceUrl: String(b.sourceUrl ?? "https://x.com/smolwyne/status/2096291092820062429"),
      handle: String(b.handle ?? "smolwyne"),
    }).catch(() => {});

    /* AND A POOL, WHICH IS THE WHOLE REASON THIS EXISTS.
       "First bet opens this on Solana" is a real state and a rare one: the
       market a stranger arrives at from a tweet almost always has SOL in it
       already, and the pool card is the tallest, loudest block on the page.
       Designing the money page against its empty state is designing against
       the market nobody will ever see.
       The pubkey is made up and so are the totals; _devPutMarket answers for
       them at the one door every consumer already knocks on, so the detail
       route, the list, the card and the resolve path all see one world. Pass
       yes and no as 0 to look at the empty state on purpose. */
    const yesL = Math.round(Number(b.yes ?? 0.12) * 1e9);
    const noL = Math.round(Number(b.no ?? 0.08) * 1e9);
    if (yesL > 0 || noL > 0) {
      const pubkey = `Dev${out.slug.replace(/[^A-Za-z0-9]/g, "").slice(0, 40)}`;
      await setCommunityOnchain(out.slug, pubkey, "dev-no-signature");
      _devPutMarket(pubkey, {
        resolved: false, authority: null,
        closeTime: Math.floor(new Date(closeIso).getTime() / 1000),
        winningSide: null, totalYesLamports: yesL, totalNoLamports: noL,
        creator: null, creatorFeeBps: CREATOR_FEE_BPS_REAL,
        creatorFeeLamports: 0, creatorFeeClaimed: false,
        protocolFeeBps: PROTOCOL_FEE_BPS_REAL,
        protocolFeeLamports: 0, protocolFeeClaimed: false,
      });
    }
    return { slug: out.slug, url: `${APP_BASE_URL}/m/${out.slug}` };
  };

  app.post("/api/genesis/_seedMarket", express.json(), async (req, res) => {
    res.json({ ok: true, ...(await devSeedMarket((req.body ?? {}) as Record<string, unknown>)) });
  });

  /* ONE COMMAND, NOT TWO.
     The store is in memory without a DATABASE_URL, so it empties on every
     restart - and tsx watch restarts on every save, which is every few seconds
     while somebody is actually designing. Re-running a curl by hand after each
     one is the kind of friction that ends with the page being judged on
     production instead. Two markets: the ordinary one with SOL in it, and the
     empty one, because both states are real and only one of them was ever
     reachable here. */
  /* A URL THAT SURVIVES THE RESTART.
     The watcher now reloads on an HTML save, which is the only way a stylesheet
     edit can reach a page whose file is read once at boot - and every reload
     empties the in-memory store and mints a new slug. Without a fixed entry
     point that means fishing the new URL out of the terminal after every single
     save, which is worse than the trap it fixes. /dev and /dev/empty always
     point at whatever the current boot seeded. */
  let devSlugs = { pooled: "", empty: "" };
  app.get("/dev", (_req, res) =>
    devSlugs.pooled ? res.redirect(`/m/${devSlugs.pooled}`) : res.status(503).type("text").send("still seeding"));
  app.get("/dev/empty", (_req, res) =>
    devSlugs.empty ? res.redirect(`/m/${devSlugs.empty}`) : res.status(503).type("text").send("still seeding"));

  void (async () => {
    try {
      const a = await devSeedMarket({});
      const b = await devSeedMarket({
        question: "Will oddie open a hundred markets before the end of the season?",
        hook: "100 markets?", yes: 0, no: 0,
      });
      devSlugs = { pooled: a.slug, empty: b.slug };
      console.log(`[dev] a market with a pool:     ${APP_BASE_URL}/dev`);
      console.log(`[dev] one nobody has bet on:    ${APP_BASE_URL}/dev/empty`);
    } catch (e) {
      console.error("[dev] seed failed:", (e as Error).message);
    }
  })();

  /* Season seeding for the same dev-only purpose: drive the connected page
   * through spent/ranked states without a bot sweep or an on-chain stake. */
  app.post("/api/genesis/_seedSeason", express.json(), async (req, res) => {
    const b = req.body ?? {};
    const handle = String(b.handle ?? "levvercetti");
    const tags = Math.max(0, Math.min(5, Number(b.tags ?? 0)));
    const bettors = Math.max(0, Math.min(50, Number(b.bettors ?? 0)));
    // Misses too, or the one state the profile block exists to make visible
    // (a ticket burnt on a take we could not price) is the one state dev
    // cannot reach.
    const misses = Math.max(0, Math.min(5, Number(b.misses ?? 0)));
    for (let i = 0; i < tags; i++) await spendTicketForTag(`dev-${handle}-${i}`, handle, "somebodyelse");
    for (let i = 0; i < misses; i++) await spendTicketForMiss(`devmiss-${handle}-${i}`, handle);
    for (let i = 0; i < bettors; i++) await creditFundedBettor(`dev-${handle}-0`, `devwallet-${handle}-${i}`, null);
    res.json({ ok: true, standing: await genesisStanding(handle) });
  });
}

app.get("/og.svg", (_req, res) => res.type("image/svg+xml").send(renderBanner()));

/** Whether a market's vault is empty, which is not the same as 50/50. A chain
 *  that will not answer degrades to "unpriced", the safe direction: the card
 *  invites the first stake instead of quoting odds nobody set. */
/* WHAT THE CARD IS ALLOWED TO SAY ABOUT THE MONEY.
   This used to answer a yes/no -- "is the pool empty" -- and threw away the two
   numbers it had just read to do it. The card then priced itself off the stored
   record instead, which is a blend of a 50 anchor with a count of PEOPLE, and
   printed a multiple derived from that. Money is the only thing the chain pays
   from, so money is what leaves this function.
   A chain that will not answer degrades to null, which renders as no price at
   all: the safe direction, because it invites a stake instead of quoting odds
   nobody set. */
async function marketPools(
  slug: string,
): Promise<{ yes: number; no: number; creatorFeeBps: number } | null> {
  const detail = await communityMarketDetail(slug).catch(() => null);
  if (!detail?.onchainPubkey) return null;
  const state = await fetchMarketOnChain(detail.onchainPubkey).catch(() => null);
  if (!state) return null;
  return {
    yes: state.totalYesLamports ?? 0,
    no: state.totalNoLamports ?? 0,
    creatorFeeBps: state.creatorFeeBps ?? detail.creatorFeeBps ?? CREATOR_FEE_BPS_REAL,
  };
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
  // The SAME ledger the board is built from. This route used to compute its
  // own standing from walletLeaderboard and its own receipts from
  // walletReceipts, both priced off our store's pool estimate; the board now
  // prices off the chain, and two prices for one call is how a profile and a
  // leaderboard end up disagreeing about the same person.
  const { calls, standings } = await settledLedger().catch(() => ({ calls: [] as PricedCall[], standings: [] as Standing[] }));
  const mine = calls.filter((c) => c.wallet === wallet);
  const standing = standings.find((w) => w.wallet === wallet)
    ?? { wallet, wins: 0, losses: 0, points: 0, realizedLamports: 0, unpriced: 0 };
  // DENSE rank, the same rule /api/board uses. This was idx + 1, so two people
  // tied on points saw one "#" on their profile and a different one on the
  // board -- the exact disagreement the comment above this block warns about.
  const idx = denseRank(standings).find((w) => w.wallet === wallet)?.rank ?? null;
  const handle = await twitterHandleForWallet(wallet).catch(() => null);
  res.json({
    ok: true,
    wallet: standing.wallet, wins: standing.wins, losses: standing.losses, points: standing.points,
    handle,
    realizedSol: Number((standing.realizedLamports / 1e9).toFixed(4)),
    unpriced: standing.unpriced,
    rank: idx,
    settled: mine.length,
    receipts: mine.map((r) => ({
      slug: r.slug, question: r.question, side: r.side, outcome: r.outcome,
      won: r.won, entryPct: r.entryPct, weight: r.weight,
      stakeSol: Number((r.lamports / 1e9).toFixed(4)),
      // Null, not zero, when the market could not be read.
      pnlSol: r.pnlLamports === null ? null : Number((r.pnlLamports / 1e9).toFixed(4)),
      poolSol: r.poolLamports === null ? null : Number((r.poolLamports / 1e9).toFixed(4)),
    })),
  });
});

/**
 * THE LEDGER: every settled call, priced by the program's own payout maths.
 *
 * The maths live in src/store/standings.ts, pure and tested. This is only the
 * plumbing: the settled calls from the store, the frozen totals from the
 * chain (one batched read), and the roll-up. A market we cannot read prices
 * to null there, never to zero, and the standings count the call right or
 * wrong regardless: the outcome is ours, only the money needed the chain.
 */
async function settledLedger(): Promise<{ calls: PricedCall[]; standings: Standing[] }> {
  const raw = await settledCalls().catch(() => []);
  const keys = [...new Set(raw.map((c) => c.onchainPubkey).filter(Boolean))] as string[];
  const states = await readMarkets(keys, { maxAgeMs: 10_000 }).catch(() => new Map<string, MarketRead>());
  const calls = raw.map((c) => {
    const r = c.onchainPubkey ? states.get(c.onchainPubkey) : undefined;
    return priceCall(c, r?.ok ? r.state : null);
  });
  return { calls, standings: standingsFrom(calls) };
}

/**
 * THE BOARD, AND WHY IT RANKS THIS AND NOT VOLUME.
 *
 * receiptWeight is `(100 - entryPct) x min(1, pool / 5 SOL)`, and zero for a
 * loss. So being right at 90%, when the room already agreed, is worth 10; being
 * right at 20% is worth 80; and either is scaled down to nothing in a pool
 * nobody else was in. That closes the two games a prediction board invites:
 * you cannot farm it by stacking near-certainties, and you cannot farm it by
 * funding your own tiny market and calling it.
 *
 * Volume was the obvious alternative and it ranks whoever has the most money,
 * which says nothing about whether they were right. Raw accuracy was the other
 * one and it rewards betting on sure things. This is accuracy, corrected.
 *
 * Dense rank, matching the Genesis board: the rank advances per distinct total,
 * not per row, so two people on the same points are the same place.
 */
app.get("/api/board", async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 20) || 20));
  const { standings, calls } = await settledLedger().catch(() => ({ standings: [] as Standing[], calls: [] as PricedCall[] }));
  const top = standings.slice(0, limit);
  // A board of base58 strings is not a social object. One query for the lot.
  const handles = await twitterHandlesForWallets(top.map((b) => b.wallet)).catch(() => new Map<string, string>());
  const rows = denseRank(top).map((b) => {
    const rank = b.rank;
    return {
      wallet: b.wallet,
      short: `${b.wallet.slice(0, 4)}…${b.wallet.slice(-4)}`,
      handle: handles.get(b.wallet) ?? null,
      wins: b.wins, losses: b.losses, points: b.points, rank,
      // ORDERING is points; this is the same standing said in money, because
      // "341 points" needs a footnote and "+2.4 SOL" does not. Shown, never
      // sorted on: sorting on it would rank the biggest bankroll.
      realizedSol: Number((b.realizedLamports / 1e9).toFixed(4)),
      unpriced: b.unpriced,
    };
  });
  /* THE MOMENTS, WHICH THIS ROUTE ALREADY COMPUTED AND THREW AWAY.
     settledLedger() returns one priced call per person per settled market --
     who, which side, THE PRICE THEY TOOK IT AT, and what it paid. All of that
     was collapsed into a standings row and dropped, and the page was left
     ranking people on a board that needs hundreds of settled calls before a
     rank means anything. With one, it put somebody who had been wrong once at
     number one with zero points.

     A moment needs no volume to be worth reading. One settled argument, with
     two named sides and the price between them, is a whole story on its own and
     it is the same story at scale. So the ledger's own rows are published. */
  const grouped = new Map<string, PricedCall[]>();
  for (const c of calls) {
    const g = grouped.get(c.slug);
    if (g) g.push(c); else grouped.set(c.slug, [c]);
  }
  const momentWallets = [...new Set(calls.map((c) => c.wallet))];
  const allHandles = momentWallets.length
    ? await twitterHandlesForWallets(momentWallets).catch(() => new Map<string, string>())
    : new Map<string, string>();
  const person = (c: PricedCall) => ({
    wallet: c.wallet,
    short: `${c.wallet.slice(0, 4)}…${c.wallet.slice(-4)}`,
    handle: allHandles.get(c.wallet) ?? handles.get(c.wallet) ?? null,
    side: c.side,
    entryPct: c.entryPct,
    sol: Number((c.lamports / 1e9).toFixed(4)),
    pnlSol: c.pnlLamports === null ? null : Number((c.pnlLamports / 1e9).toFixed(4)),
  });
  // NAMED, NOT ALL OF THEM. A moment is a sentence, and a sentence with forty
  // names in it is a table again. The rest are a count, which is the part that
  // makes the sentence land anyway ("and 11 others were wrong").
  const NAMED = 3;
  const moments = [...grouped.entries()].map(([slug, cs]) => {
    const won = cs.filter((c) => c.won);
    const lost = cs.filter((c) => !c.won);
    const first = cs[0];
    return {
      slug, question: first.question, outcome: first.outcome,
      settledAt: first.resolvedAt ?? null,
      poolSol: first.poolLamports === null ? null : Number((first.poolLamports / 1e9).toFixed(4)),
      right: won.slice(0, NAMED).map(person), rightCount: won.length,
      wrong: lost.slice(0, NAMED).map(person), wrongCount: lost.length,
    };
  }).sort((a, b) => {
    // Newest settle first. A moment with no timestamp predates the column and
    // sinks to the bottom rather than claiming to be recent.
    const t = (x: string | null) => (x ? Date.parse(x) : 0);
    return t(b.settledAt) - t(a.settledAt);
  });

  /* WHAT IS ABOUT TO BE ANSWERED. An empty board is the state this page is in
     today and will be in for days, and a leaderboard has nothing to say in it.
     A countdown does: the arguments are already live and already have
     deadlines, so the page can be about what is coming rather than apologise
     for having nothing behind it. */
  const open = await adminListCommunity().catch(() => [] as Awaited<ReturnType<typeof adminListCommunity>>);
  const pending = open
    .filter((m) => !m.resolvedOutcome && !m.retiredAt && m.closesAt)
    .sort((a, b) => Date.parse(a.closesAt!) - Date.parse(b.closesAt!))
    .slice(0, 3)
    .map((m) => ({ slug: m.slug, question: m.question, closesAt: m.closesAt, hook: m.hook }));

  res.json({
    ok: true, rows, moments, pending,
    // The denominator the weight uses, published so the page can explain the
    // number instead of asking people to trust it.
    fullCreditSol: FULL_CREDIT_LAMPORTS / 1e9,
  });
});

app.get("/w/:wallet", async (req, res) => {
  const wallet = req.params.wallet;
  if (!isValidPubkeyString(wallet)) return res.status(404).send("unknown wallet");

  /**
   * THE SHAREABLE ARTIFACT, so its unfurl is built from a real read.
   *
   * This is the page somebody posts to say "I called it", which makes the og
   * line the most-copied sentence on the site. It leads with MONEY because
   * money needs no footnote: "+4.21 SOL" travels and "341 points" needs the
   * page to explain it. Both are true and both are here; only one goes in the
   * card. A wallet whose markets could not be priced gets the honest line
   * instead of a confident zero.
   */
  const { calls, standings } = await settledLedger().catch(() => ({ calls: [] as PricedCall[], standings: [] as Standing[] }));
  const mine = calls.filter((c) => c.wallet === wallet);
  const st = standings.find((w) => w.wallet === wallet);
  const handle = await twitterHandleForWallet(wallet).catch(() => null);
  const short = `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
  const who = handle ? `@${handle}` : short;

  let title: string;
  if (!st || mine.length === 0) title = `${who} has no settled calls yet`;
  else {
    const net = st.realizedLamports / 1e9;
    const money = st.unpriced === mine.length ? null : `${net > 0 ? "+" : ""}${net.toFixed(2)} SOL`;
    title = money
      ? `${who}: ${st.wins}/${st.wins + st.losses} calls right, ${money}`
      : `${who}: ${mine.length} settled call${mine.length === 1 ? "" : "s"}`;
  }

  const url = `${APP_BASE_URL}/w/${wallet}`;
  const tags = [
    `<link rel="canonical" href="${ogEsc(url)}">`,
    `<meta property="og:type" content="profile">`,
    `<meta property="og:site_name" content="oddie">`,
    `<meta property="og:title" content="${ogEsc(title)}">`,
    `<meta property="og:description" content="Every call stamped on chain the moment it was made, priced by the pool it settled against.">`,
    `<meta property="og:url" content="${ogEsc(url)}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${ogEsc(title)}">`,
    `<meta name="twitter:description" content="Every call stamped on chain the moment it was made, priced by the pool it settled against.">`,
  ].join("\n");
  res.set("Cache-Control", "no-cache").type("html")
    .send(stampApp(WHO_HTML).replace("<title>oddie</title>", `<title>${ogEsc(title)} · oddie</title>\n${tags}`));
});

/** Distinct confirmed wallets on a market, for the card. Best-effort by design:
 *  a count we could not read is omitted from the card rather than drawn as 0,
 *  which would be the same lie the pool reads refuse to tell. */
async function cardStakers(slug: string): Promise<number> {
  const counts = await stakerCounts([slug]).catch(() => ({} as Record<string, number>));
  return counts[slug] ?? 0;
}

app.get("/card/:slug.svg", async (req, res) => {
  const { all } = await liveMarketData();
  const rec = await getSlug(req.params.slug, all);
  if (!rec) return res.status(404).send("unknown market");
  res.type("image/svg+xml").send(renderCard(rec.market, {
    pools: await marketPools(req.params.slug), stakers: await cardStakers(req.params.slug),
    hook: await hookFor(req.params.slug).catch(() => null),
  }));
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
  const png = renderCardPng(renderCard(rec.market, {
    pools: await marketPools(slug), stakers: await cardStakers(slug),
    hook: await hookFor(slug).catch(() => null),
  }));
  pngCache.set(slug, { png, at: now });
  if (pngCache.size > 300) for (const [k, v] of pngCache) if (now - v.at > PNG_TTL_MS) pngCache.delete(k);
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
interface ChainMine {
  markets: number; live: number; settled: number;
  pooledLamports: number; earnedLamports: number; claimed: boolean;
  /**
   * How many of this person's markets we could not read.
   *
   * These totals are SUMS, and a sum that silently drops its unreadable terms
   * is not a smaller sum, it is a wrong one. "You have earned 0" to somebody
   * who has earned is the single most damaging thing this endpoint can say, so
   * the count travels with the number and the surface can mark it partial.
   */
  unreadable: number;
}
const chainMineCache = new Map<string, { at: number; val: ChainMine }>();
const CHAIN_MINE_TTL_MS = 30_000;

async function chainMineFor(deviceId: string): Promise<ChainMine> {
  const hit = chainMineCache.get(deviceId);
  if (hit && Date.now() - hit.at < CHAIN_MINE_TTL_MS) return hit.val;
  const mine = await onchainMarketsSurfacedBy(deviceId, 50);
  // One batched read instead of up to 50 separate ones. The old shape was the
  // exact request pattern a public RPC throttles, and a throttled read did not
  // slow this down, it zeroed it.
  const states = await readMarkets(mine.map((m) => m.onchainPubkey), { maxAgeMs: CHAIN_MINE_TTL_MS })
    .catch(() => new Map<string, MarketRead>());
  let pooledLamports = 0, earnedLamports = 0, live = 0, settled = 0, claimed = false, unreadable = 0;
  for (const m of mine) {
    const r = states.get(m.onchainPubkey);
    // `absent` is knowledge (nothing was ever minted there) and counts as
    // nothing. `unreadable` is the absence of knowledge and is counted as such.
    if (!r || (!r.ok && r.reason === "unreadable")) { unreadable++; continue; }
    if (!r.ok) continue;
    const st = r.state;
    pooledLamports += st.totalYesLamports + st.totalNoLamports;
    if (st.resolved) { settled++; earnedLamports += st.creatorFeeLamports; if (st.creatorFeeClaimed) claimed = true; }
    else live++;
  }
  const val: ChainMine = { markets: mine.length, live, settled, pooledLamports, earnedLamports, claimed, unreadable };
  // A partial answer is not cached: caching it would hold the wrong total for
  // the full TTL after the RPC recovered.
  if (unreadable === 0) chainMineCache.set(deviceId, { at: Date.now(), val });
  return val;
}









// The /api/onboarding/tour-seen endpoint lived here. Removed with the guided
// tour itself (the feed that carried it is retired) — nothing calls it, and a
// dead one-shot endpoint invites someone to resurrect the tour through it.





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
    const states = await readMarkets(mine.map((m) => m.onchainPubkey)).catch(() => new Map<string, MarketRead>());
    let named = 0;
    for (const m of mine) {
      const r = states.get(m.onchainPubkey);
      // Unreadable is skipped rather than named: naming writes to chain, and
      // writing on the strength of a read that failed is how you pay a fee to
      // set a field that was already set. It retries on the next wallet verify.
      if (!r || !r.ok || r.state.creator) continue;
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
    const dest = returnTo ?? "/markets";
    const sep = dest.includes("?") ? "&" : "?";
    return res.redirect(`${homeFor(dest)}${dest}${sep}auth_error=${encodeURIComponent(why)}`);
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
      return res.redirect(`${homeFor(pendingAuth.returnTo)}${pendingAuth.returnTo}${sep}${params}`);
    }
    return res.redirect(`${APP_BASE_URL}/markets?${params}`);
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
    if (identity.provider === "twitter" && identity.handle) {
      /* THE MARKETS THEY ALREADY OPENED BECOME THEIRS HERE.
         Their 2% is paid to an on-chain creator, and the step that writes it
         finds markets by device. Until now that link was only ever made at tag
         time, so anybody who tagged BEFORE connecting - which is every person
         the product's own headline describes - left a row with a null device
         and could never be named or paid. Adopting them at connect time is the
         other half of that link, and it is the half that was missing.
         Best-effort like the card below: a failed backfill must not turn a
         completed sign-in into an error page. It is idempotent, so the next
         connect picks up whatever this missed. */
      try {
        const adopted = await adoptSurfacedMarkets(identity.handle, pendingAuth.deviceId);
        if (adopted) console.log(JSON.stringify({ evt: "surfacer_adopted", handle: identity.handle, count: adopted }));
      } catch (err) {
        console.error("[surfacer] adopting earlier markets failed:", (err as Error).message);
      }
    }
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
      return res.redirect(`${homeFor(pendingAuth.returnTo)}${pendingAuth.returnTo}${sep}connected=${p}`);
    }
    return back(`connected=${p}`);
  } catch (err) {
    console.error(`[auth] ${p} failed:`, (err as Error).message);
    return back("auth_error=link_failed");
  }
});

/**
 * Sign this browser out. POST because it changes state; body carries the same
 * deviceId the rest of the API speaks. Deliberately NOT provider-scoped: the
 * genesis page has exactly one identity to let go of, and dropping the
 * device_account row is what "disconnect" honestly means here — the account
 * and its history survive, reconnecting is one OAuth round trip.
 */
app.post("/api/auth/disconnect", express.json(), async (req, res) => {
  const raw = (req.body as { deviceId?: unknown })?.deviceId;
  const deviceId = typeof raw === "string" && DEVICE_ID.test(raw) ? raw : null;
  if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });
  await disconnectDevice(deviceId).catch(() => {});
  res.json({ ok: true });
});

/** The exact URI each provider console must have registered. Read-only, no secrets. */
app.get("/api/auth/config", (_req, res) => {
  res.json({
    baseUrl: APP_BASE_URL, // the app host: the bot's link must not 301 through the apex
    providers: PROVIDERS.map((p) => ({
      provider: p,
      callback: redirectUri(BASE_URL, p),
      configured: isConfigured(p),
      secretEnv: missingSecretEnv(p),
    })),
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
 * ADMIN ONLY. Yorumda "Railway-origin only" yaziyordu ama kodda oyle bir
 * kontrol HIC yoktu: iki uc da herkese acikti. GET, SUPABASE_* set edilir
 * edilmez 200 bekleme listesi e-postasini herkese acik bir URL'de yayinlardi;
 * POST ise oddie.fun'in kendi gonderen alan adindan isteyene mail attiran
 * ACIK BIR POSTACIYDI ve gonderdigi adresi allowlist'e yaziyordu.
 */
const SUPA = () => ({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY });

app.get("/api/invites", requireAdmin, async (_req, res) => {
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

app.post("/api/invites/send", requireAdmin, async (req, res) => {
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
  <p style="margin:0 0 20px"><a href="${APP_BASE_URL}/markets?invite=1" style="display:inline-block;background:#68C6FF;color:#000;font-weight:700;border:3px solid #000;border-radius:14px;padding:10px 18px;text-decoration:none">open the feed →</a></p>
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



/* THE WEEKLY LOUDEST ROUTES ARE GONE, and this note is why nobody should
   write them again. They paid oddies for "the week's best posts about oddie".
   On 2026-01-15 X revoked API access for apps that reward users for posting on
   X -- Kaito, Cookie, Wallchain, Bantr and Xeet in one sweep, and Kaito sunset
   Yaps. Those companies lost a product line. oddie would lose the product: the
   whole loop needs the mentions endpoint to read tags and POST /2/tweets to
   answer them, so the key going is the machine stopping.
   What oddie counts instead is what happens ON CHAIN after a tag: distinct
   wallets whose first real-money bet landed in a market somebody opened. That
   is a settlement record, not a posting reward, and it is defensible in one
   sentence. */

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
  | { ok: true; slug: string; marketId: number; onchain: { pubkey: string; explorer: string; signature: string } | null;
      /** Set when nothing was opened because this claim already had a market.
       *  The slug above is that market's: every caller then links the one that
       *  exists instead of minting a twin beside it. */
      existed?: true }
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
  /**
   * WHO OPENED IT, when that is somebody other than the claim's author.
   *
   * Lev'in karari: %2 marketi ACAN kisiye gider. Reply-tag akisinda acan kisi
   * ETIKETCIDIR; sourceUrl ise iddianin sahibini gosterir (provenance, kartta
   * gorunen alinti). Ikisi ayni sey degil ve bu alan olmadan para yanlis
   * kisiye gidiyordu: recordSurfacer handle'i sourceUrl'den turetiyor,
   * nameCreatorOnTaggedMarkets da zincirdeki creator'i o satirdan yaziyordu.
   * Bos birakildiginda eski davranis aynen surer (Telegram, admin, agent).
   */
  taggerHandle?: string | null;
  /**
   * WHO OPENED IT, WHEN THE OPENER IS NOT ON X AT ALL.
   *
   * taggerHandle above works because the reply-tag flow knows a handle and a
   * handle eventually meets a wallet: the person connects, and
   * nameCreatorOnTaggedMarkets writes their address on chain. An API caller
   * has neither. It has no device row, so nothing ever binds it to a wallet,
   * and the fee fell through to handleFromSourceUrl -- i.e. to the author of
   * the tweet, who did nothing but write a tweet. Somebody paying us to open a
   * market was paying to hand 2% to a stranger.
   *
   * A wallet given here IS the creator, written at mint time rather than named
   * later. That is strictly better than the handle path even where both would
   * work: no set_creator transaction, no window where the fee accrues to an
   * address nobody holds, nothing stranded if they never come back.
   *
   * Naming somebody else can only ever give money away, never take it, so this
   * needs no proof of ownership beyond being a well-formed pubkey.
   */
  creatorWallet?: string | null;
  category?: string;
  yesPct?: number;
  resolutionCriteria?: string | null;
  resolvability?: string | null;
  /** Set when the claim was about a token's price or market cap. The ticker is
   *  resolved to a specific token HERE, once, and frozen onto the market: see
   *  the block below. */
  priceClaim?: PriceClaim | null;
  /** The words the claim was graded from. Read ONLY to look for a contract
   *  address: a ticker is not an identity and an address is. */
  claimText?: string | null;
  /** extractClaim's short headline. Carried so the app can show the same
   *  punchy line the tweet does; the question stays the terms. */
  hook?: string | null;
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
  // Oran, PARAYI ALACAK kisiye gore belirlenir. Etiketci varsa odenecek kisi
  // odur; yoksa eski davranis (iddianin sahibi). Ikisini ayirmak, oranin
  // gercek ama alicinin bilinmedigi bir marketi mumkun kilardi: %2 kazanandan
  // kesilir ve hicbir zaman talep edilemezdi.
  const payeeHandle = input.taggerHandle ?? handleFromSourceUrl(sourceUrl);
  /* A WALLET OUTRANKS A HANDLE, because it is the thing the program can pay.
     Present, the fee is real and its recipient is already known; absent, the
     old handle rule stands unchanged for the bot, the admin and Telegram. */
  const creatorWallet = isValidPubkeyString(input.creatorWallet) ? input.creatorWallet : null;
  const creatorFeeBps = creatorWallet ? CREATOR_FEE_BPS_REAL : creatorFeeBpsForHandle(payeeHandle);

  /* PRICE CLAIMS GET THEIR TOKEN PINNED HERE, BEFORE ANYTHING IS MINTED.
     Three things happen in this block and each one is load-bearing.

     ONE: the ticker becomes a mint. Fifteen tokens answer to BULLSHIT on
     DexScreener right now, so a market that stored only "$BULLSHIT" would be
     settled later against whichever one happened to be biggest that day. The
     mint, the pool and the supply are decided once, in front of the people
     about to bet, and the settle path never looks the symbol up again.

     TWO: the window starts NOW, not at the start of whatever month the tweet
     said. Backdating it would let somebody tag a level the token already
     touched and open a market that was already decided, which is not a market.

     THREE: the criteria we write REPLACE the model's. extractClaim is told it
     may leave them empty for these, because the sources that show a memecoin's
     market cap are the ones it is forbidden to cite. If the token could not be
     pinned and the model left nothing, there is no rule to settle by and the
     market is refused rather than opened blind. */
  let priceCheck: PriceCheck | null = null;
  let criteria = resolutionCriteria;
  if (input.priceClaim) {
    const r = await resolvePriceClaim(
      input.priceClaim,
      { from: new Date().toISOString(), to: new Date(closeTime * 1000).toISOString() },
      { text: input.claimText ?? null },
    );
    if (r.ok) {
      priceCheck = r.check;
      criteria = r.sentence;
    } else if (!criteria) {
      /* THIS REFUSAL COST A REAL TAG, and the shape of the mistake is worth
         keeping. A claim about BTC reads as a price claim, correctly, and BTC
         is not a Solana token, so nothing could be pinned. Before the price
         path existed that same claim opened an ordinary citation-settled
         market; after it, the market was refused outright, because the model
         had been told it could leave the criteria empty and let this block
         write them. A new capability silently removed an old one.

         The prompt now asks for criteria ALWAYS, so this branch should be
         unreachable for anything a model produced. It stays as the guard it
         reads like: a market with no rule at all is the one thing that must
         never open. */
      return bad(422, `this price claim could not be pinned to a token and it carries no other rule: ${r.why}`);
    }
  }

  /* THE SAME TWO CHECKS AS normalize(), HERE BECAUSE THIS IS THE WALL.
     normalize() covers everything a model wrote. It does not cover
     /api/v1/markets or /api/community/create, which take `question` and
     `resolution_criteria` as free text from a caller. Every market in this
     product is born in this function, so this is the one place a rule that
     cannot settle cannot walk around.
     Run AFTER the price block above, because that block REPLACES the model's
     criteria with ones written from the pinned token, and those are the string
     the row stores and the oracle reads. Checking earlier would judge a
     sentence that never reaches the market. */
  const hedged = unsettleablePhrase(criteria ?? "") ?? unsettleablePhrase(question);
  if (hedged) return bad(422, `this market's own rule says it cannot settle (“${hedged}”), so it must not open`);
  const addressed = addressInQuestion(question);
  if (addressed) return bad(422, "the question names an address instead of the thing being predicted");

  /* ALREADY A MARKET? Then this is that market, and nothing is minted.
     Checked HERE rather than in the mention loop because the loop's own check
     is keyed on the source POST, which cannot see two different tweets making
     the same claim -- and that is precisely how the live board ended up with
     Saylor's "will BTC reach 100k" and @Bitcoin's "will BTC reach 100k" open
     beside each other, splitting one crowd across two pools. Every opener comes
     through this function, so every opener gets the check. */
  const openNow = await adminListCommunity().catch(() => [] as Awaited<ReturnType<typeof adminListCommunity>>);
  const twin = await findDuplicate(
    { question, closesAt: new Date(closeTime * 1000).toISOString(), priceCheck },
    openNow
      .filter((m) => !m.resolvedOutcome && !m.retiredAt)
      .map((m) => ({ slug: m.slug, question: m.question, closesAt: m.closesAt, priceCheck: m.priceCheck ?? null, createdAt: m.createdAt })),
  ).catch(() => null);
  if (twin) {
    void logExtraction("duplicate", question, { slug: twin.slug, question, existing: twin.question });
    return { ok: true, slug: twin.slug, marketId: 0, onchain: null, existed: true };
  }

  // The vault comes first. Written the other way round, a Solana failure
  // returned "was not published" to the caller while the row it had already
  // created went on being served by the feed: a market nobody could ever take a
  // side in, because the account the bet needs does not exist. Minting first
  // means the failure path writes nothing, so there is no orphan to clean up.
  const marketId = Date.now(); // unique-per-ms; also the on-chain market_id (u64)
  const lazy = input.mint === "on-demand";
  const minted = lazy
    ? null
    : await mintMarket({ marketId, question, closeTime, creator: creatorWallet,
        creatorFeeBps, protocolFeeBps: PROTOCOL_FEE_BPS_REAL,
        /* The rule goes on chain WITH the market, in the same transaction, or
           the commitment is worth nothing: a hash written afterwards is a hash
           written after somebody could have staked. "" when there are no
           criteria commits to nothing, which is the honest value.
           `criteria`, NOT `resolutionCriteria`: the price path replaces the
           caller's prose with criteria written from the pinned token a few
           lines above, and those are the ones this market actually settles by.
           Committing the pre-replacement text would pin a rule that is not the
           rule, which is worse than pinning none. */
        criteria: criteria ?? "" });
  if (!lazy && !minted) {
    return bad(502, "market could not be opened on Solana, so it has no vault and was not published");
  }

  const { slug } = await createCommunityMarket({ question, closeTime, category, yesPct, resolutionCriteria: criteria, resolvability, hook: input.hook ?? null, marketId, creatorFeeBps, priceCheck });
  if (minted) await setCommunityOnchain(slug, minted.pubkey, minted.signature);
  void logExtraction("publish", question, { slug, question, category, yesPct, closeTime, resolutionCriteria, resolvability });

  // Awaited, not fire-and-forget: this row is the thing being guaranteed, so a
  // market must not report success while its provenance silently failed to
  // land. recordSurfacer swallows its own oEmbed failures, so this waits on the
  // write and not on X.
  // handle ACIKCA veriliyor: verilmezse recordSurfacer onu sourceUrl'den
  // turetir, yani iddianin sahibini yazar ve zincirdeki creator o olur.
  await recordSurfacer(slug, { sourceUrl, handle: payeeHandle });
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
    /* Off the ROW, like the rate and the creator beside it. This route mints on
       demand, sometimes long after the row was written, and the row is the only
       place the rule has ever lived. */
    criteria: detail.resolutionCriteria ?? "",
    // The creator comes off the ROW, for exactly the reason the rate above
    // does. The claims route mints on demand, so this function is where an API
    // caller's market actually reaches the chain; a wallet passed at create
    // time and not stored would have been silently dropped here, and the fix
    // would have looked complete while doing nothing on the one route it was
    // written for. Still null for tag-driven markets: those name their creator
    // when the person connects, which is unchanged.
    creator: detail.creatorWallet, creatorFeeBps: detail.creatorFeeBps, protocolFeeBps: PROTOCOL_FEE_BPS_REAL,
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
      priceClaim: ex.price_claim,
      claimText,
      resolvability: ex.resolvability,
      hook: ex.hook || null,
      // The caller opened this market, so the caller is owed the 2%. Without
      // it the fee fell through to the author of the tweet, and an integrator
      // paying us to open markets was paying to hand a stranger a revenue
      // share. Optional: a caller who omits it gets exactly the old behaviour.
      creatorWallet: req.body?.creator_wallet != null ? String(req.body.creator_wallet) : null,
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
    url: `${APP_BASE_URL}/m/${slug}`,
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
  /* THE SLICE USED TO HAPPEN HERE, BEFORE ANYTHING WAS READ, so the page was
     whatever order the store handed back and the busiest market could sit on
     page two forever. Ordering by pool needs the pools, and the pools come from
     the batched chain read below, so a wider candidate set is taken first and
     cut to `limit` after the sort. The read is one call regardless of how many
     accounts are in it. */
  const CANDIDATES = Math.max(limit * 4, 60);
  const live = all.filter((m) => !m.resolvedOutcome && !m.retiredAt).slice(0, CANDIDATES);
  // One batched read for the whole page instead of one per row. The old shape
  // was the exact request pattern a public RPC throttles, and being throttled
  // did not slow this endpoint down, it published zeroes.
  const [states, openers, stakers, views] = await Promise.all([
    /* 4s WAS A RATE-LIMIT GENERATOR. This is the feed: every visitor, every
       load, every poll. Against a throttled RPC a short window means the cache
       is always cold exactly when a 429 arrives, so the stale fallback has
       nothing to serve and the card goes dark. A minute of staleness on a list
       of pools is invisible; a dark card is not, and the stake path reads
       fresh anyway. */
    readMarkets(live.map((m) => m.onchainPubkey).filter(Boolean) as string[], { maxAgeMs: 60_000 })
      .catch(() => new Map<string, MarketRead>()),
    // Who opened it: the handle the 2% is paid to, and the reason the market
    // exists. One query for the page, not one per row.
    surfacersFor(live.map((m) => m.slug)).catch(() => ({} as Record<string, SurfacerInfo>)),
    // Kac cuzdan girdi. Ayni sayfa icin tek sorgu, satir basina bir tane degil.
    stakerCounts(live.map((m) => m.slug)).catch(() => ({} as Record<string, number>)),
    // Only ever a tie-break between two empty markets. See viewCounts.
    viewCounts(live.map((m) => m.slug)).catch(() => ({} as Record<string, number>)),
  ]);
  const items = live.map((m) => {
    const r = m.onchainPubkey ? states.get(m.onchainPubkey) : { ok: false as const, reason: "absent" as const };
    const state = r?.ok ? r.state : null;
    // UNREADABLE IS NOT AN EMPTY POOL, AND THIS IS A PUBLIC FEED.
    //
    // `pool: {totalSol: 0}` for a market we simply could not reach is a
    // number nobody measured, published under our name, about somebody's
    // money. So the numbers go away entirely and oddsSource says why. A
    // consumer reading `pool.totalSol` blindly now throws, which is the loud
    // failure; reading a zero was the silent one.
    const unreadable = Boolean(r && !r.ok && r.reason === "unreadable");
    const yes = state?.totalYesLamports ?? 0, no = state?.totalNoLamports ?? 0;
    const total = yes + no;
    /* The rates are PER MARKET and frozen at creation: one with no creator to
       pay charges no creator fee, and a response-level constant overstates the
       takeout against it, which understates what its winners collect. */
    const odds = oddsFromPools(unreadable ? null : yes, unreadable ? null : no,
      { creatorBps: state?.creatorFeeBps ?? m.creatorFeeBps, protocolBps: PROTOCOL_FEE_BPS_REAL });
    return {
      slug: m.slug,
      question: m.question,
      url: `${APP_BASE_URL}/m/${m.slug}`,
      closesAt: m.closesAt,
      resolved: Boolean(m.resolvedOutcome),
      outcome: m.resolvedOutcome ?? null,
      hook: m.hook ?? null,
      taggedBy: openers[m.slug]?.handle ?? null,
      /* KAC KISI GIRDI -- BIZIM KAYDIMIZDAN, ZINCIRDEN DEGIL.
         chain_entry cuzdan basina tek satir tutuyor, yani bu insan sayar,
         bahis degil. Ama yalnizca onaylanmis islemler yaziliyor, o yuzden
         GERCEGIN ALTINDA kalabilir, ustunde asla. Bunu havuzun yaninda
         basan istemcinin kurali: sifirsa hic yazma. Dolu bir havuzun
         yaninda "0 in" yazmak, parayi yalanlamaktir. */
      stakers: stakers[m.slug] ?? 0,
      // Kartin @handle cipi bir profile degil, iddianin GELDIGI gonderiye
      // gidebilsin diye. Veri zaten yukarida okundu (surfacersFor), tek eksik
      // onu yayinlamakti. Istemci yazari URL'den cikarip handle ile
      // karsilastiriyor: ikisi ayni degilse cip profile gider, cunku taggedBy
      // ETIKETLEYENDIR ve sourceUrl baskasinin gonderisi olabilir.
      sourceUrl: openers[m.slug]?.sourceUrl ?? null,
      pool: unreadable ? null : { yesLamports: yes, noLamports: no, totalSol: total / 1e9 },
      /* ONE DEFINITION, in src/odds.ts, because this line and the card disagreed
         by 41 points on a live market. The clamp is what is gone: Math.min(99, ...)
         published a pool that was 100% one way as 99, a figure nobody's money made,
         and it read as a settled argument when what had actually happened was that
         nobody had taken the other side yet. "one-sided" says that plainly, and
         both clients already draw a null percentage correctly, so it costs no UI. */
      yesPct: odds.state === "priced" ? odds.yesPct : null,
      oddsSource: unreadable ? "unreadable" : odds.state === "priced" ? "vault" : odds.state,
      onchain: m.onchainPubkey ? { pubkey: m.onchainPubkey, explorer: explorerUrl(m.onchainPubkey) } : null,
      // PER MARKET, because the rates differ now: a market with no creator to
      // pay is minted at 0. The chain is the authority once minted; the row is
      // what it WILL be minted with. A single response-level constant quoted a
      // creator share against markets that charge none.
      creatorFeeBps: state?.creatorFeeBps ?? m.creatorFeeBps,
    };
  });
  /* BUSIEST FIRST, AND THE TIE-BREAKS ARE THE HONEST ONES.
     Pool is the signal a trader is actually looking for: a market with money in
     it is a market somebody disagreed about. Stakers comes next and quietly
     handles the unreadable case, where the pool reads as 0 but our own record
     knows wallets went in -- an RPC we could not reach must not demote a funded
     market below an empty one. Views break a tie only between markets that both
     have nothing in them, which is the one place attention is the best number
     available. Newest last, so a fresh market still outranks a stale twin. */
  items.sort((a, b) =>
    (b.pool?.totalSol ?? 0) - (a.pool?.totalSol ?? 0)
    || (b.stakers ?? 0) - (a.stakers ?? 0)
    || ((views[b.slug] ?? 0) - (views[a.slug] ?? 0))
    || String(b.closesAt ?? "").localeCompare(String(a.closesAt ?? "")));
  const page = items.slice(0, limit);

  res.json({
    ok: true, cluster: cluster(),
    // The DEFAULT rate, kept for callers that read it. Prefer the per-market
    // creatorFeeBps on each item above; this one cannot be right for every row.
    creatorFeeBps: CREATOR_FEE_BPS_REAL, protocolFeeBps: PROTOCOL_FEE_BPS_REAL,
    markets: page,
  });
});

/** One market, including who its creator fee is owed to. */
/* THE PAGE AND THE API SERVE THE SAME OBJECT.
 * Extracted so /m/:slug can put this payload INSIDE the html it already
 * sends, instead of shipping 137KB whose whole visible body is "Loading the
 * market..." and then asking for the content in a second round trip. The
 * question is in that html four times already (title, og:title, og:image:alt,
 * twitter:title) and in the body zero times. Measured: html done at 211ms,
 * content painted at 893ms, on a desktop connection, on the one page every
 * visitor from X lands on.
 *
 * One renderer stays: the client's. Server-rendering the markup as well would
 * put the same layout in two languages and let them drift, which is the bug
 * this audit already found between the card and the page. */
async function marketDetailPayload(slug: string): Promise<Record<string, unknown> | null> {
  const detail = await communityMarketDetail(slug);
  if (!detail) return null;
  const read = detail.onchainPubkey
    ? await readMarket(detail.onchainPubkey).catch((): MarketRead => ({ ok: false, reason: "unreadable", error: "read threw" }))
    : ({ ok: false, reason: "absent" } as MarketRead);
  const state = read.ok ? read.state : null;
  // See the list route above: an unreadable market publishes no pool at all
  // rather than a zero nobody measured.
  const unreadable = !read.ok && read.reason === "unreadable";
  // surfacersFor rather than surfacerFor: the batch shape is the one that
  // carries the ORIGINATING POST (url, text, author). A market IS a claim
  // somebody made on X, and the page that takes money against it has to let
  // the claim be checked at source, not reduce provenance to a handle.
  const src = (await surfacersFor([slug]).catch(() => ({} as Record<string, SurfacerInfo>)))[slug] ?? null;
  const heads = (await stakerCounts([slug]).catch(() => ({} as Record<string, number>)))[slug] ?? 0;
  const yes = state?.totalYesLamports ?? 0, no = state?.totalNoLamports ?? 0;
  const total = yes + no;
  /* The rates are PER MARKET and frozen at creation: one with no creator to
     pay charges no creator fee, and a response-level constant overstates the
     takeout against it, which understates what its winners collect. */
  const odds = oddsFromPools(unreadable ? null : yes, unreadable ? null : no,
    { creatorBps: state?.creatorFeeBps ?? detail.creatorFeeBps, protocolBps: PROTOCOL_FEE_BPS_REAL });
  return {
    ok: true,
    slug: detail.slug,
    question: detail.question,
    // Headline, not terms. A client may lead with this; `question` is still
    // the wording the stake is against and every surface must keep it.
    hook: detail.hook ?? null,
    // Bkz. liste ucundaki not: bizim kaydimizdan gelir, gercegin altinda
    // kalabilir, ve sifirsa dolu bir havuzun yaninda BASILMAZ.
    stakers: heads,
    url: `${APP_BASE_URL}/m/${detail.slug}`,
    closesAt: detail.closesAt,
    resolutionCriteria: detail.resolutionCriteria ?? null,
    resolved: Boolean(state?.resolved ?? detail.resolvedOutcome),
    outcome: state?.winningSide ?? detail.resolvedOutcome ?? null,
    pool: unreadable ? null : { yesLamports: yes, noLamports: no, totalSol: total / 1e9 },
    /* ONE DEFINITION, in src/odds.ts, because this line and the card disagreed
       by 41 points on a live market. The clamp is what is gone: Math.min(99, ...)
       published a pool that was 100% one way as 99, a figure nobody's money made,
       and it read as a settled argument when what had actually happened was that
       nobody had taken the other side yet. "one-sided" says that plainly, and
       both clients already draw a null percentage correctly, so it costs no UI. */
    yesPct: odds.state === "priced" ? odds.yesPct : null,
    oddsSource: unreadable ? "unreadable" : odds.state === "priced" ? "vault" : odds.state,
    taggedBy: src?.handle ?? null,
    // Null fields, never empty strings: the page decides whether to draw a
    // quoted card (text known) or just a link (only the url known).
    sourcePost: src && (src.sourceUrl || src.sourceText)
      ? { url: src.sourceUrl, text: src.sourceText, author: src.sourceAuthor }
      : null,
    // Read off the market, not from our constants. A market minted under a
    // different rate keeps it, and an agent that assumed today's numbers would
    // quote the wrong takeout for exactly the pools where it matters.
    creatorFeeBps: state?.creatorFeeBps ?? CREATOR_FEE_BPS_REAL,
    // BOTH HALVES FALL BACK THE SAME WAY. This read `?? 0` while the creator
    // half fell back to the real constant, so a market whose chain state could
    // not be read told the page the takeout was 2% when it is 4%: the market
    // page adds the two (public/app/market.html:688) and prints the sum right
    // above the buttons. Understating the house take by half, on the screen
    // where the bet is placed. An unreadable market is not a free one, and if
    // we are willing to guess one half from the constants we have to guess the
    // other from them too.
    protocolFeeBps: state?.protocolFeeBps ?? PROTOCOL_FEE_BPS_REAL,
    onchain: detail.onchainPubkey ? { pubkey: detail.onchainPubkey, explorer: explorerUrl(detail.onchainPubkey) } : null,
    cluster: cluster(),
  };
}

app.get("/api/v1/markets/:slug", async (req, res) => {
  const payload = await marketDetailPayload(req.params.slug);
  if (!payload) return res.status(404).json({ ok: false, error: "unknown market" });
  res.json(payload);
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
  const creatorWallet = req.body?.creator_wallet != null ? String(req.body.creator_wallet) : null;
  const out = await openMarketFromClaim({
    question: String(req.body?.question ?? ""),
    closeInput: req.body?.close_time ?? req.body?.closeTime,
    sourceUrl: req.body?.source_url != null ? String(req.body.source_url) : null,
    category: req.body?.category != null ? String(req.body.category) : undefined,
    yesPct: req.body?.yesPct != null ? Number(req.body.yesPct) : undefined,
    resolutionCriteria: req.body?.resolution_criteria != null ? String(req.body.resolution_criteria) : null,
    hook: req.body?.hook != null ? String(req.body.hook) : null,
    creatorWallet,
  });
  if (!out.ok) return res.status(out.status).json({ ok: false, error: out.error });
  // Recorded here and nowhere else: the market exists, so it cost us rent.
  recordHit(`v1create:${ip}`, 3600_000);
  recordHit("v1create:global", 86_400_000);
  res.json({
    ok: true, slug: out.slug, url: `${APP_BASE_URL}/m/${out.slug}`,
    onchain: out.onchain, cluster: cluster(),
    // The note names the ACTUAL payee. It said "the handle in source_url"
    // unconditionally, which becomes a false statement the moment a caller
    // names its own wallet -- and it is a statement about money.
    note: isValidPubkeyString(creatorWallet)
      ? `Anyone can now take a side with real SOL. ${(CREATOR_FEE_BPS_REAL / 100).toFixed(0)}% of the pool is reserved for ${creatorWallet}.`
      : `Anyone can now take a side with real SOL. ${(CREATOR_FEE_BPS_REAL / 100).toFixed(0)}% of the pool goes to the handle in source_url.`,
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
    hook: req.body?.hook != null ? String(req.body.hook) : null,
    creatorWallet: req.body?.creator_wallet != null ? String(req.body.creator_wallet) : null,
    // The lazy mint the bot has always used, reachable by hand. Every market
    // @oddiefun opens is born this way -- no vault until somebody actually
    // wants to stake -- but this route hard-required a mint, so an admin (or
    // anybody running the app with the chain off) could not open a market at
    // all. Same code path, same guarantees; opt-in per request, so the default
    // stays mint-first.
    mint: req.body?.mint === "on-demand" ? "on-demand" : undefined,
  });
  if (!out.ok) return res.status(out.status).json({ error: out.error, chainEnabled: isChainEnabled() });
  res.json({
    ok: true, slug: out.slug, marketId: out.marketId, url: `${APP_BASE_URL}/m/${out.slug}`,
    onchain: out.onchain, chainEnabled: isChainEnabled(), cluster: cluster(),
  });
});

// List community markets for the resolve control + a small chain-status readout.
// Explorer links (even for markets minted earlier) surface only while
// ONCHAIN_ENABLED is on; the underlying pubkeys stay stored regardless.
app.get("/api/community/list", requireAdmin, async (_req, res) => {
  const items = await adminListCommunity();
  /* THE ONLY NUMBERS THIS LIST CARRIED WERE THE DEAD ONES.
     yesTokens/noTokens/yesPlayers/noPlayers are SUM(market_call.tokens), and
     nothing has written market_call since the product stopped using play
     money, so the operator console read "YES 0 (0p) · NO 0 (0p)" over a market
     holding 0.2 SOL. The real pool is on chain and the real head count is in
     chain_entry, both of which /api/v1/markets already reads for the public
     feed. One batched read for the page, same as there. */
  const pubkeys = items.map((i) => i.onchainPubkey).filter(Boolean) as string[];
  const [states, heads] = await Promise.all([
    readMarkets(pubkeys, { maxAgeMs: 4_000 }).catch(() => new Map<string, MarketRead>()),
    stakerCounts(items.map((i) => i.slug)).catch(() => ({} as Record<string, number>)),
  ]);
  res.json({
    items: items.map((i) => {
      const r = i.onchainPubkey ? states.get(i.onchainPubkey) : undefined;
      const st = r?.ok ? r.state : null;
      // Unreadable is not empty: say so rather than publishing a zero nobody
      // measured, the same rule the public feed follows.
      const unreadable = Boolean(r && !r.ok && r.reason === "unreadable");
      const yes = st?.totalYesLamports ?? 0, no = st?.totalNoLamports ?? 0;
      return {
        ...i,
        explorer: onchainEnabled() && i.onchainPubkey ? explorerUrl(i.onchainPubkey) : null,
        poolSol: unreadable || !st ? null : (yes + no) / 1e9,
        yesSol: unreadable || !st ? null : yes / 1e9,
        noSol: unreadable || !st ? null : no / 1e9,
        bettors: heads[i.slug] ?? 0,
        unreadable,
      };
    }),
    chain: { enabled: isChainEnabled(), admin: await adminAddress(), balanceSol: await adminBalanceSol() },
  });
});

// The inside-the-market admin view: pool split, positions (with handles), and a
// payout preview for BOTH outcomes, so resolution is done with full visibility.
app.get("/api/community/market/:slug", requireAdmin, async (req, res) => {
  const detail = await communityMarketDetail(req.params.slug);
  if (!detail) return res.status(404).json({ error: "unknown community market" });

  /* THE SCREEN THAT SETTLES REAL MONEY WAS READING THE PLAY-MONEY TABLE.
     communityMarketDetail draws its positions from market_call, and nothing has
     written market_call since real SOL arrived. On a market holding 0.2 SOL
     this panel said "YES 0 tok (0 players)", "POSITIONS (0) — no positions
     yet", and, on the button that settles it, "resolve YES (pays 0 to 0)".
     The settlement itself was never wrong: resolve_market computes payouts from
     the chain. It was the PREVIEW that lied, which is worse in its own way,
     because the preview is the only thing the operator reads before deciding.
     Pool and payout come off the chain now. Who is in comes from chain_entry,
     and each wallet's stake from its own Position account, so a top-up or a
     sold seat shows its real size rather than the first stamp. */
  const pubkey = detail.onchainPubkey;
  const state = pubkey ? await readMarket(pubkey, { maxAgeMs: 4_000 }).catch(() => null) : null;
  const live = state?.ok ? state.state : null;
  /* NOT THERE YET IS NOT UNREADABLE, AND THIS PANEL SAID IT WAS.
     A market waits for its first bet before it exists on Solana, so there is
     nothing to read and that is the normal, healthy state. Folding it in with
     a failed RPC printed "could not read the chain just now, nothing below is
     safe to act on" over a market that was simply new, and withheld resolve
     for a danger that was not there. Three states, because there are three:
     no chain account, an account we could not reach, and a pool. */
  const notOnChain = !pubkey;
  const unreadable = Boolean(state && !state.ok && state.reason === "unreadable");

  const entries = pubkey ? await walletsInMarket(detail.slug).catch(() => []) : [];
  // An admin screen, so exactness is worth a round trip per wallet, but not an
  // unbounded number of them. Past the cap the list says what it left out.
  const CAP = 60;
  const shown = entries.slice(0, CAP);
  const stakes = new Map<string, { yes: number; no: number; claimed: boolean }>();
  if (pubkey && shown.length) {
    await Promise.all(shown.map(async (e) => {
      const r = await readPositions([pubkey], e.wallet).catch(() => null);
      const p = r?.get(pubkey);
      if (p?.ok && p.position) {
        stakes.set(e.wallet, { yes: p.position.amountYes, no: p.position.amountNo, claimed: p.position.claimed });
      }
    }));
  }

  const yesLam = live?.totalYesLamports ?? 0, noLam = live?.totalNoLamports ?? 0;
  const poolLam = yesLam + noLam;
  // Both fees are stored per market, so a rate change never reprices an open
  // pool; the preview has to use the market's own numbers, not today's.
  const feeBps = (detail.creatorFeeBps ?? CREATOR_FEE_BPS_REAL) + PROTOCOL_FEE_BPS_REAL;
  // A pool with no winners is refunded in full and takes no fee at all, which
  // is the program's rule (lib.rs: winning_total == 0 -> both fees zero).
  const payout = (winningLam: number) =>
    winningLam === 0 ? poolLam : poolLam - Math.floor((poolLam * feeBps) / 10_000);
  /* WHO WINS IS A QUESTION ONLY THE POSITION ACCOUNT CAN ANSWER.
     chain_entry keeps one row per wallet per market carrying the side of their
     FIRST stake, so a wallet sitting on both sides is filed under one of them.
     Counting winners from that said "pays 0.192 SOL to 0 wallets" on a market
     where the same wallet held 0.1 on each side: a payout with nobody to pay.
     Every participating wallet does appear in chain_entry exactly once, so the
     SET is complete and only the side is unreliable; the Position account has
     both legs, and chain_entry's side is the fallback when it cannot be read. */
  const holds = (w: string, side: "yes" | "no", stamped: "yes" | "no") => {
    const p = stakes.get(w);
    return p ? (side === "yes" ? p.yes > 0 : p.no > 0) : stamped === side;
  };
  const wallets = (side: "yes" | "no") =>
    new Set(entries.filter((e) => holds(e.wallet, side, e.side)).map((e) => e.wallet));
  const yesW = wallets("yes"), noW = wallets("no");

  const positions = shown.map((e) => ({
    wallet: e.wallet,
    short: e.wallet.slice(0, 4) + "…" + e.wallet.slice(-4),
    side: e.side,
    entryPct: e.entryPct,
    // The stamp is their FIRST stake; the Position account is what they hold
    // now, both legs, because a wallet is allowed to sit on both sides.
    firstSol: e.lamports / 1e9,
    yesSol: stakes.has(e.wallet) ? (stakes.get(e.wallet) as { yes: number }).yes / 1e9 : null,
    noSol: stakes.has(e.wallet) ? (stakes.get(e.wallet) as { no: number }).no / 1e9 : null,
    claimed: stakes.get(e.wallet)?.claimed ?? null,
  }));

  res.json({
    slug: detail.slug, question: detail.question, closesAt: detail.closesAt, yesPct: detail.yesPct, marketId: detail.marketId,
    resolvedOutcome: detail.resolvedOutcome, resolutionCriteria: detail.resolutionCriteria, resolvability: detail.resolvability,
    onchain: onchainEnabled() && pubkey
      ? { pubkey, explorer: explorerUrl(pubkey), signature: detail.onchainSig, minted: true }
      : { minted: false },
    pool: notOnChain ? { notOnChain: true, totalSol: 0 }
      : unreadable || !live ? { unreadable: true }
      : {
          yesSol: yesLam / 1e9, noSol: noLam / 1e9, totalSol: poolLam / 1e9,
          poolYesPct: poolLam > 0 ? Math.round((100 * yesLam) / poolLam) : null,
          walletsYes: yesW.size, walletsNo: noW.size,
        },
    // Nothing is on chain, so nothing can be owed: resolving closes the record
    // and pays nobody, which the buttons have to say rather than imply.
    preview: notOnChain ? { notOnChain: true }
      : unreadable || !live ? { unreadable: true }
      : {
          feePct: feeBps / 100,
          ifYes: { paysSol: payout(yesLam) / 1e9, winners: yesLam === 0 ? yesW.size + noW.size : yesW.size, refund: yesLam === 0 },
          ifNo: { paysSol: payout(noLam) / 1e9, winners: noLam === 0 ? yesW.size + noW.size : noW.size, refund: noLam === 0 },
        },
    positions,
    truncated: Math.max(0, entries.length - shown.length),
  });
});

// Manual resolution: mark resolved, then settle every open position on the slug.
/**
 * SETTLING A MARKET, IN ONE PLACE.
 *
 * This was the body of the admin resolve route, and it stayed there for as long
 * as a person was the only thing that could settle anything. The oracle sweep
 * needs the same tail -- the off-chain settlement, the on-chain resolve, the fee
 * log, the reply in the X thread -- and a second copy of it is a second set of
 * rules to keep in step, where the first thing to drift would be the one nobody
 * watches.
 *
 * Returns null when the market is unknown or already resolved, which the row
 * decides: markCommunityResolved latches on `resolved_outcome IS NULL`, so two
 * callers arriving together settle exactly once and the loser gets null.
 */
async function resolveCommunityMarket(slug: string, outcome: "yes" | "no"): Promise<{ settled: number } | null> {
  const ok = await markCommunityResolved(slug, outcome);
  if (!ok) return null;
  const settled = await settleMarket(slug, outcome);

  /* TELL THE PEOPLE WHOSE MONEY IT IS.
     Winning on chain told the winner nothing, anywhere: not X, not the app, not
     mail. The money sat in the vault and the only way to learn about it was to
     wander back to the profile unprompted. settleMarket above writes the
     settle_win notices of the play-money era, which hang off market_call, and
     nothing has written that table since the product stopped using play money.
     One insert off the entry stamps, no chain read, because the whole reason to
     store this is that a badge on every page cannot be a live position read.
     Best-effort: the money has already moved and no bookkeeping failure gets to
     hold up a settlement. */
  void walletsInMarket(slug)
    .then(async (entries) => {
      const wallets = entries.map((e) => e.wallet);
      const n = await recordPayoutNotices(slug, wallets);
      if (n > 0) console.log(JSON.stringify({ evt: "payout_notices", slug, outcome, people: n }));
      // The badge is the durable half and is written first; the push is the
      // half that reaches somebody who is not looking. One cannot wait on the
      // other, and neither may hold up a settlement.
      await pushPayoutNotice(slug, outcome, wallets);
    })
    .catch((e) => console.error("[payout] notice write failed (non-fatal):", (e as Error).message));
  // Settlement is announced on X (the resolution reply). The email path went
  // with Google sign-in, which had no door outside the retired feed.
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
      void resolveMarketOnChain(detail.onchainPubkey, outcome).then(async (r) => {
        if (!r.ok) {
          console.error(JSON.stringify({
            evt: "resolve_chain_gap", slug, outcome, reason: r.reason, error: r.error,
            onChainOutcome: r.onChainOutcome ?? null,
            fix: "npm run resolve-reconcile",
          }));
          return;
        }
        /* AN EMPTY MARKET IS CLOSED THE MOMENT IT CAN BE CLOSED.
           Rent is the largest fixed cost this product has and close_market is
           the only thing that ever gives it back, but it refuses any market
           that took a bet — so the one window where it works is a market nobody
           entered, once it is over. Resolving is what makes it over.
           Until now that residue was swept by hand, by a script nobody has run,
           so every ignored market was a permanent loss of both rents.
           Called unconditionally rather than behind our own emptiness check:
           closeMarketOnChain reads the chain, refuses on has-stakes before
           sending anything, and the program checks the vault balance again on
           its own side. One RPC read on a path that already does several, and
           no second copy of the rule to drift. */
        if (!detail.onchainPubkey) return;
        const closed = await closeMarketOnChain(detail.onchainPubkey).catch(() => null);
        if (closed?.ok) {
          console.log(JSON.stringify({
            evt: "market_rent_reclaimed", slug, lamports: closed.lamports, signature: closed.signature,
          }));
        }
      }).catch(() => {});
      // Real-money creator/protocol fee, logged as an audit trail of what the
      // program fixed at resolve. The fee instructions are real and proven
      // (npm run test-exit-path): claim_creator_fee and claim_protocol_fee both
      // pay, once each, to the creator and the authority. Read the vault total
      // straight from chain rather than trusting a stale value.
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
  void postResolution(slug, outcome, { baseUrl: APP_BASE_URL,
    dryRun: X_BOT_DRY_RUN,
    cardPng: async (s2, o) => {
      const { all } = await liveMarketData();
      const rec = await getSlug(s2, all);
      return rec ? renderCardPng(renderCard(rec.market, { settled: o, stakers: await cardStakers(s2), hook: await hookFor(s2).catch(() => null) })) : null;
    },
    uploadMedia: (png) => X.uploadMedia(png),
    postReply: (o) => X.postReply(o),
    postQuote: (o) => X.postTweet({ text: o.text, quoteTweetId: o.quoteTweetId, mediaIds: o.mediaIds }),
    /* THE VAULT, not the crowd table. chain_entry is a floor by its own
       documentation (it is written only on a confirmed send), so a stake we
       could not confirm reads there as nobody — and going quiet on that would
       be silence about a market holding real money. Null on any failure, which
       the announcement treats as "not empty" and posts. */
    poolLamports: async (s2: string) => {
      const d = await communityMarketDetail(s2).catch(() => null);
      if (!d?.onchainPubkey) return null;
      const st = await fetchMarketOnChain(d.onchainPubkey).catch(() => null);
      return st ? st.totalYesLamports + st.totalNoLamports : null;
    },
    // The same read, asked the question the announcement actually needs: not
    // how much is in the pool, but how much is on the side that won. A pool of
    // 0.1 SOL entirely on the losing side is a market with no winners, and the
    // total alone cannot tell you that.
    winningLamports: async (s2: string, outcome: "yes" | "no") => {
      const d = await communityMarketDetail(s2).catch(() => null);
      if (!d?.onchainPubkey) return null;
      const st = await fetchMarketOnChain(d.onchainPubkey).catch(() => null);
      if (!st) return null;
      return outcome === "yes" ? st.totalYesLamports : st.totalNoLamports;
    },
    log: (line, extra) => console.log(JSON.stringify({ evt: "x_resolution", line, ...extra })),
    // WHO IS OWED THE 2%, which is the OPENER. market_surfacer.handle is
    // written from `taggerHandle` at mint time precisely so the cut follows
    // whoever tagged the post rather than whoever wrote it, and this reads that
    // same row back.
    payeeHandle: async (s2: string) => (await surfacerFor(s2).catch(() => null))?.handle ?? null,
    payeeFeeLamports: async (s2: string) => {
      const d = await communityMarketDetail(s2).catch(() => null);
      if (!d?.onchainPubkey) return 0;
      const st = await fetchMarketOnChain(d.onchainPubkey).catch(() => null);
      return st?.creatorFeeLamports ?? 0;
    },
    /* THE CROWD, AS COUNTS AND ONE PRICE. Read off chain_entry, which is the
       table the real-money path actually writes; the operator's verdict
       worklist reads market_call, which nothing has written since the product
       stopped using play money, and that is why "resolution as content" has
       never once produced a post.
       entry_pct is the share THEIR side held just before their stake landed, so
       the MINIMUM among the winners is the keenest price anybody paid for the
       side that turned out to be right: low means early and alone. */
    crowd: async (s2: string, o: "yes" | "no") => {
      const entries = await walletsInMarket(s2).catch(() => []);
      const winners = entries.filter((e) => e.side === o);
      const best = winners.reduce<number | null>(
        (lo, e) => (lo === null || e.entryPct < lo ? e.entryPct : lo), null);
      return { stakers: entries.length, winners: winners.length, bestEntryPct: best };
    },
    /* The claim to quote. Null for a market that never came from X, which is
       not a failure: there is simply nothing to quote and the thread reply is
       the whole announcement. sourcePostKey does the parsing, so a Telegram
       source produces a `tg:` key here and is correctly skipped. */
    quoteTarget: async (s2: string) => {
      const info = (await surfacersFor([s2]).catch(() => ({} as Record<string, SurfacerInfo>)))[s2];
      const key = sourcePostKey(info?.sourceUrl ?? null);
      return key && key.startsWith("x:") ? key.slice(2) : null;
    },
  }).catch((e) => console.error("[resolution] announce failed:", (e as Error).message));

  return { settled: settled.length };
}

app.post("/api/community/resolve", requireAdmin, async (req, res) => {
  const slug = String(req.body?.slug ?? "");
  const outcome = req.body?.outcome;
  if (!slug || (outcome !== "yes" && outcome !== "no")) return res.status(400).json({ error: "slug and outcome (yes|no) required" });
  const out = await resolveCommunityMarket(slug, outcome);
  if (!out) return res.status(409).json({ error: "unknown or already-resolved community market" });
  res.json({ ok: true, slug, outcome, settled: out.settled });
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

// The single boolean the client gates every trace of this UI behind (the app
// shells probe /api/chain/status, then OddieChain.init). Under REGIME 1 it is
// the master flag alone:
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
 * The switch the whole client-side chain layer hangs off: the app shells
 * (public/app/market.html, you.html) probe this before OddieChain.init, so if
 * this route is absent the betting UI silently never exists.
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
  // The rate rides along so no page has to hard-code it. It is a POLICY
  // number, not a measurement of anybody: what a market opened by an X tag is
  // minted to pay its creator. The rate is written per market at creation and
  // never rewritten, so a change here can never reprice an open pool -- which
  // is exactly why the page must read it from the server rather than print a
  // constant that will drift.
  res.json({
    enabled: realStakesReady, cluster: cluster(),
    creatorFeeBps: CREATOR_FEE_BPS_REAL, protocolFeeBps: PROTOCOL_FEE_BPS_REAL,
  });
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
      // WHEN THIS ENDS, on the screen where the money moves.
      //
      // The market page has carried a countdown for a while and the sheet that
      // takes the bet has never said a word about it, so the last thing a
      // person sees before signing is silent on the one fact that decides when
      // they see their money again. Read from the MARKET account rather than
      // our row, for the same reason the fee rates are: this is the timestamp
      // the program will enforce.
      closeTime: state.closeTime,
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

  /**
   * WHAT THIS WALLET CAN ACTUALLY SPEND.
   *
   * The stake sheet offered fixed chips to a wallet whose balance it had never
   * read, so the commonest first-timer failure -- not enough SOL -- died at
   * preflight and was reported as "the market may have just closed or
   * settled". Public because it says nothing that is not already public on
   * chain: anyone can read any address's balance from any RPC. Rate-limited
   * like the other reads so it cannot be used to hammer our endpoint.
   */
  app.get("/api/chain/balance", async (req, res) => {
    const address = String(req.query.address ?? "");
    if (!isValidPubkeyString(address)) return res.status(400).json({ ok: false, error: "invalid address" });
    const lamports = await walletBalanceLamports(address);
    // null is "we could not read it", NOT zero. A zero here would grey out
    // every chip on a wallet that is merely unreachable.
    if (lamports === null) return res.json({ ok: false, reason: "unreadable" });
    res.json({ ok: true, lamports });
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
    if (!ready) {
      // WHOSE FAULT IT IS, SAID OUT LOUD.
      //
      // This used to answer "this market could not be opened on Solana" for
      // every cause, which blames the market. The most likely cause is our own
      // admin wallet running under its floor, and telling somebody their bet
      // failed because of the market they picked -- when the truth is we ran
      // out of rent money -- sends them to look for a problem that is not
      // theirs, and sends them away for good. chainHealth is cached, so this
      // costs nothing on the path that matters.
      const health = await chainHealth().catch(() => null);
      if (health?.state === "stopped") {
        return res.status(503).json({
          ok: false, reason: "mint-paused",
          error: "we cannot open new markets right now. This is on us, not on this market. Try again shortly.",
        });
      }
      return res.status(502).json({ ok: false, reason: "not-minted", error: "this market could not be opened on Solana" });
    }

    /**
     * EVERY RULE take_position ENFORCES, CHECKED HERE FIRST.
     *
     * This route used to consult only our own database's resolvedOutcome and
     * then hand over a signable transaction, while the program enforced
     * `clock < close_time` and nothing here checked it: anyone staking a market
     * past its on-chain close that our resolver had not caught up to was handed
     * a transaction guaranteed to revert. Measured: 3 of 15 live markets were
     * past close and unresolved, one by more than a month.
     *
     * It also mirrored a side rule that no longer exists. take_position accepts
     * both sides from one wallet now, so the check that used to live here would
     * be this server inventing a restriction the program does not have.
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
      // THE SIDE GUARD IS GONE, because the rule it mirrored is. take_position
      // accepts both sides from one wallet now, so refusing here would be this
      // server inventing a restriction the program does not have. What the
      // guard was actually for -- never handing over a transaction that is
      // guaranteed to revert -- is still done by the two checks above.
      const held = await fetchPosition(ready.pubkey, userPubkey).catch(() => null);
      if (held && held.claimed) {
        return res.status(409).json({ ok: false, reason: "already-resolved" });
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
    const candidates = (await openEntriesFor(userPubkey).catch(() => []))
      .filter((c) => Boolean(c.onchainPubkey));
    // Two batched reads for the whole page. This used to be TWO RPC calls per
    // candidate fired in parallel, which is the shape a public RPC throttles,
    // and being throttled did not slow the page down: it emptied it.
    const keys = candidates.map((c) => c.onchainPubkey as string);
    const [positions, states] = await Promise.all([
      readPositions(keys, userPubkey).catch(() => new Map()),
      readMarkets(keys, { maxAgeMs: 4_000 }).catch(() => new Map<string, MarketRead>()),
    ]);
    let unreadable = 0;
    const open = candidates.map((c) => {
      const pk = c.onchainPubkey as string;
      const pr = positions.get(pk);
      // "You hold nothing here" and "we could not check" are opposite facts
      // about this person's money. Only the first is silence; the second is
      // counted and returned so the page can say so.
      if (!pr || (!pr.ok && pr.reason === "unreadable")) { unreadable++; return null; }
      if (!pr.ok) return null;                                   // never staked, or claimed and closed
      const pos = pr.position;
      if (pos.lamports <= 0 || pos.claimed) return null;
      const mr = states.get(pk);
      const state = mr?.ok ? mr.state : null;
      // THE WAY OUT, surfaced where the money is. A market that was never
      // settled is the operator's failure, and the person holding a position in
      // it needs to see both that it exists and when they can take their stake
      // back without us. Null when the chain could not be read: an exit we
      // cannot verify must not be promised.
      const refund = state && !state.resolved
        ? { opensAt: refundOpensAt(state.closeTime), openNow: Math.floor(Date.now() / 1000) > refundOpensAt(state.closeTime) }
        : null;
      return {
        slug: c.slug, question: c.question, side: pos.side, lamports: pos.lamports,
        // Both legs, because side is null when a wallet holds each of them and
        // a page that only reads `side` would show nothing at all.
        amountYes: pos.amountYes, amountNo: pos.amountNo,
        entryPct: c.entryPct, closesAt: c.closesAt,
        explorer: explorerUrl(pk),
        // The pool as it stands, so the trader can see the line move against or
        // with them. Null when the market cannot be read rather than zero.
        pool: state ? { yes: state.totalYesLamports, no: state.totalNoLamports } : null,
        refund,
      };
    }).filter(Boolean);
    res.json({ ok: true, open, unreadable, cluster: cluster() });
  });

  app.get("/api/chain/claimable", async (req, res) => {
    const userPubkey = String(req.query.userPubkey ?? "");
    if (!isValidPubkeyString(userPubkey)) return res.status(400).json({ error: "invalid userPubkey" });
    const markets = await resolvedOnchainMarkets(40).catch(() => []);
    // One read for up to forty markets instead of forty. The market states come
    // with them because the number a winner is owed cannot be worked out from
    // the position alone: it is their share of the pool after both fees, and
    // only the market carries the pool and the fees.
    const [positions, states] = await Promise.all([
      readPositions(markets.map((m) => m.onchainPubkey), userPubkey).catch(() => new Map()),
      readMarkets(markets.map((m) => m.onchainPubkey), { maxAgeMs: 4_000 })
        .catch(() => new Map<string, MarketRead>()),
    ]);
    let unreadable = 0;
    const found = markets.map((m) => {
      const pr = positions.get(m.onchainPubkey);
      // Money this person already owns. An unreadable position dropped from
      // this list is a winner told they have nothing to collect because an RPC
      // blinked, so it is counted and returned instead of swallowed.
      if (!pr || (!pr.ok && pr.reason === "unreadable")) { unreadable++; return null; }
      if (!pr.ok) return null;
      const position = pr.position;
      if (position.claimed) return null;
      // A LOSING POSITION IS STILL CLAIMABLE, and dropping it here was costing
      // people money. claim_winnings pays a loser nothing (lib.rs: payout = 0
      // when the side missed) but the Position account carries `close = owner`,
      // so calling it returns the ~0.00147 SOL of rent the position has been
      // holding since the bet was placed. The program's own comment says this
      // is "the first reason a loser has ever had to come back and press the
      // button"; filtering them out here meant they never saw one.
      // THE WINNING LEG, not the side. A wallet can hold both, and `side` is
      // null when it does, so comparing it to the outcome quietly answered
      // "you lost" for somebody who was half right. That would have told a
      // winner their button returns rent only.
      const winningLeg = m.resolvedOutcome === "yes" ? position.amountYes : position.amountNo;
      const won = winningLeg > 0;
      /* WHAT THE BUTTON PAYS, WORKED OUT THE WAY THE PROGRAM WORKS IT OUT.
         Every screen where money moved said "your winnings are on the way" and
         never a figure, on the one product whose whole subject is the figure.
         This is claim_winnings' own arithmetic (lib.rs), not an approximation:
         nobody on the winning side means everyone is refunded in full and no
         fee was taken; otherwise it is the winning leg's share of the pool
         after both fees, floored, because the program floors it too.
         Null rather than a guess when the market could not be read: a number
         we did not measure, printed next to somebody's money, is the one thing
         this whole read layer exists to stop. */
      const ms = states.get(m.onchainPubkey);
      const mst = ms?.ok ? ms.state : null;
      let payoutLamports: number | null = null;
      if (mst) {
        const pool = mst.totalYesLamports + mst.totalNoLamports;
        const winningTotal = m.resolvedOutcome === "yes" ? mst.totalYesLamports : mst.totalNoLamports;
        payoutLamports = winningTotal === 0
          ? position.lamports
          : winningLeg === 0
            ? 0
            : Math.floor((winningLeg * (pool - mst.creatorFeeLamports - mst.protocolFeeLamports)) / winningTotal);
      }
      return {
        slug: m.slug, question: m.question, side: position.side,
        amountYes: position.amountYes, amountNo: position.amountNo,
        lamports: position.lamports, outcome: m.resolvedOutcome,
        // What pressing the button actually does, so the UI never has to guess.
        won, returns: won ? "winnings-and-rent" : "rent-only",
        payoutLamports,
        // A pool nobody backed is refunded whole, which is a different sentence
        // from winning and has to be able to say so.
        refund: mst ? (m.resolvedOutcome === "yes" ? mst.totalYesLamports : mst.totalNoLamports) === 0 : false,
      };
    });
    res.json({ ok: true, claimable: found.filter(Boolean), unreadable });
  });

  /**
   * THE SEAT SWAP. Three prepares and one read, and none of them touches the
   * vault: the buyer pays the seller directly, so `total_yes` and `total_no`
   * never move and the multiple every other staker is counting on is what it
   * was a block earlier.
   *
   * Every guard the program enforces is checked here FIRST, for the same reason
   * the stake route does it: a prepare that hands over a transaction certain to
   * revert costs the user a fee and manufactures the wallet's red banner
   * ourselves.
   */
  type SeatMarket =
    | { pubkey: string; closeTime: number }
    | { err: 404 | 409 | 503; reason: string; closeTime?: number };
  const openMarketForSeat = async (slug: string): Promise<SeatMarket> => {
    const detail = await communityMarketDetail(slug).catch(() => null);
    if (!detail?.onchainPubkey) return { err: 404 as const, reason: "not-minted" };
    if (detail.resolvedOutcome) return { err: 409 as const, reason: "already-resolved" };
    const state = await fetchMarketOnChain(detail.onchainPubkey).catch(() => null);
    if (!state) return { err: 503 as const, reason: "chain-unreachable" };
    if (state.resolved) return { err: 409 as const, reason: "already-resolved" };
    const now = Math.floor(Date.now() / 1000);
    if (state.closeTime > 0 && now >= state.closeTime) {
      return { err: 409 as const, reason: "closed", closeTime: state.closeTime };
    }
    return { pubkey: detail.onchainPubkey, closeTime: state.closeTime };
  };

  app.get("/api/chain/listings/:slug", async (req, res) => {
    const detail = await communityMarketDetail(String(req.params.slug)).catch(() => null);
    if (!detail?.onchainPubkey) return res.json({ ok: true, listings: [] });
    res.json({ ok: true, listings: await listingsFor(detail.onchainPubkey) });
  });

  app.post("/api/chain/listing/prepare", async (req, res) => {
    const slug = String(req.body?.slug ?? "");
    const sellerPubkey = String(req.body?.sellerPubkey ?? "");
    const side = req.body?.side;
    const lamports = Number(req.body?.lamports ?? 0);
    const expiresAt = Number(req.body?.expiresAt ?? 0);
    if (!isValidPubkeyString(sellerPubkey)) return res.status(400).json({ ok: false, reason: "invalid-seller" });
    if (side !== "yes" && side !== "no") return res.status(400).json({ ok: false, reason: "bad-side" });
    if (!Number.isInteger(lamports) || lamports <= 0) return res.status(400).json({ ok: false, reason: "bad-amount" });

    const m = await openMarketForSeat(slug);
    if ("err" in m) return res.status(m.err).json({ ok: false, ...m });

    // The program refuses a listing that outlives the market, so a UI that
    // offers "a week" on a market closing in three days would be handing over a
    // certain revert. Clamped rather than refused: the user asked to stand for
    // a while, and standing until close is the honest most we can give them.
    const now = Math.floor(Date.now() / 1000);
    const wanted = Number.isFinite(expiresAt) && expiresAt > now ? expiresAt : now + 86_400;
    const capped = Math.min(wanted, m.closeTime - 1);
    if (capped <= now) return res.status(409).json({ ok: false, reason: "closed", closeTime: m.closeTime });

    // The seat has to exist before we offer to sell it.
    const held = await fetchPosition(m.pubkey, sellerPubkey).catch(() => null);
    const leg = !held ? 0 : side === "yes" ? held.amountYes : held.amountNo;
    if (leg < lamports) return res.status(409).json({ ok: false, reason: "not-enough", held: leg });

    const txBase64 = await prepareListTx({ marketPubkey: m.pubkey, sellerPubkey, side, lamports, expiresAt: capped });
    if (!txBase64) return res.status(502).json({ ok: false, reason: "chain-unreachable" });
    res.json({ ok: true, txBase64, expiresAt: capped });
  });

  app.post("/api/chain/listing/cancel", async (req, res) => {
    const slug = String(req.body?.slug ?? "");
    const sellerPubkey = String(req.body?.sellerPubkey ?? "");
    if (!isValidPubkeyString(sellerPubkey)) return res.status(400).json({ ok: false, reason: "invalid-seller" });
    const detail = await communityMarketDetail(slug).catch(() => null);
    // Cancelling is the one of the three that must work on a CLOSED market too:
    // a seller whose offer never filled should always be able to take it down
    // and get their rent back, and the program allows it.
    if (!detail?.onchainPubkey) return res.status(404).json({ ok: false, reason: "not-minted" });
    const txBase64 = await prepareCancelListingTx({ marketPubkey: detail.onchainPubkey, sellerPubkey });
    if (!txBase64) return res.status(502).json({ ok: false, reason: "chain-unreachable" });
    res.json({ ok: true, txBase64 });
  });

  app.post("/api/chain/listing/take", async (req, res) => {
    const slug = String(req.body?.slug ?? "");
    const sellerPubkey = String(req.body?.sellerPubkey ?? "");
    const buyerPubkey = String(req.body?.buyerPubkey ?? "");
    if (!isValidPubkeyString(sellerPubkey)) return res.status(400).json({ ok: false, reason: "invalid-seller" });
    if (!isValidPubkeyString(buyerPubkey)) return res.status(400).json({ ok: false, reason: "invalid-buyer" });
    if (sellerPubkey === buyerPubkey) return res.status(409).json({ ok: false, reason: "self-fill" });

    const m = await openMarketForSeat(slug);
    if ("err" in m) return res.status(m.err).json({ ok: false, ...m });

    // Somebody else may have taken it between the page rendering and this call.
    const seats = await listingsFor(m.pubkey);
    const seat = seats.find((l) => l.seller === sellerPubkey);
    if (!seat) return res.status(409).json({ ok: false, reason: "seat-gone" });

    const txBase64 = await prepareTakeListingTx({ marketPubkey: m.pubkey, sellerPubkey, buyerPubkey });
    if (!txBase64) return res.status(502).json({ ok: false, reason: "chain-unreachable" });
    res.json({ ok: true, txBase64, lamports: seat.lamports, side: seat.side });
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
      // NO "lost" REFUSAL. This used to 409 before building anything, which
      // permanently forfeited the loser's rent deposit: the program is happy to
      // be called by a loser (payout 0, `close = owner` returns the rent), and
      // we were the only thing standing in the way. Worse, MIN_STAKE is 0.001
      // SOL and the rent is 0.00147, so the smallest allowed bet cost more to
      // hold than it staked and the product would not give the larger half
      // back. The caller is told which it is by /api/chain/claimable's
      // `returns` field, so the sheet can say "this returns your rent, you did
      // not win this one" instead of pretending it is a payout.
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
    const states = await readMarkets(markets.map((m) => m.onchainPubkey), { maxAgeMs: 5_000 })
      .catch(() => new Map<string, MarketRead>());
    let unreadable = 0;
    const owed = markets.map((m) => {
      const r = states.get(m.onchainPubkey);
      // Money owed TO the user. An unreadable market silently dropped from this
      // list is a fee they are never told about and therefore never claim, so
      // the omission is counted and returned rather than swallowed.
      if (!r || (!r.ok && r.reason === "unreadable")) { unreadable++; return null; }
      if (!r.ok) return null;
      const state = r.state;
      if (state.creatorFeeClaimed) return null;
      if (state.creatorFeeLamports <= 0) return null;      // nobody backed the winner
      if (state.creator !== creatorPubkey) return null;    // not theirs, or nobody's yet
      return { slug: m.slug, question: m.question, lamports: state.creatorFeeLamports, feeBps: state.creatorFeeBps };
    });
    res.json({ ok: true, fees: owed.filter(Boolean), unreadable });
  });

  /**
   * THE WAY OUT of a market nobody settled.
   *
   * Resolution is manual, so an unsettled market is the ordinary failure of an
   * operator being asleep rather than an exotic case, and until now the staker
   * had no door: the program's permissionless refund_after_deadline existed and
   * nothing in the product could reach it. Opens 30 days after close, pays back
   * the whole stake plus the position rent, and needs no authority signature.
   *
   * Every precondition the program enforces is checked HERE first, because a
   * prepare route that skips them answers 200 with a transaction that is certain
   * to revert, and then the wallet is the thing that looks broken.
   */
  app.post("/api/chain/refund/prepare", async (req, res) => {
    const slug = String(req.body?.slug ?? "");
    const userPubkey = String(req.body?.userPubkey ?? "");
    if (!isValidPubkeyString(userPubkey)) return res.status(400).json({ ok: false, reason: "invalid userPubkey" });
    const detail = await communityMarketDetail(slug).catch(() => null);
    if (!detail?.onchainPubkey) return res.status(404).json({ ok: false, reason: "no such market" });

    const state = await fetchMarketOnChain(detail.onchainPubkey).catch(() => null);
    // Unreadable is a refusal, never a shrug: the guards below are the reason
    // this route exists at all.
    if (!state) return res.status(503).json({ ok: false, reason: "chain-unreachable" });
    if (state.resolved) return res.status(409).json({ ok: false, reason: "resolved", hint: "claim instead" });

    const opensAt = refundOpensAt(state.closeTime);
    const now = Math.floor(Date.now() / 1000);
    if (now <= opensAt) {
      return res.status(409).json({ ok: false, reason: "not-yet-open", opensAt });
    }
    const pos = await fetchPosition(detail.onchainPubkey, userPubkey).catch(() => null);
    if (!pos) return res.status(409).json({ ok: false, reason: "no-position" });
    if (pos.claimed) return res.status(409).json({ ok: false, reason: "already-claimed" });

    const txBase64 = await prepareRefundTx({ marketPubkey: detail.onchainPubkey, userPubkey });
    if (!txBase64) return res.status(502).json({ ok: false, reason: "chain-unreachable" });
    res.json({ ok: true, txBase64, lamports: pos.lamports });
  });

  /**
   * ODDIE'S OWN 2%: what is owed, and the sweep that collects it.
   *
   * Admin-gated, because unlike the creator fee this is not a transaction we
   * hand to somebody's wallet: `claim_protocol_fee` is signed by the market's
   * AUTHORITY, which is this server's admin key. So the GET reports and the
   * POST actually moves money, with our own signature.
   *
   * This did not exist at all until now. Every resolve fixes the protocol fee
   * into the market and the money sits in the vault waiting for a pull, and
   * there was no puller: on devnet that was invisible because the numbers were
   * play, on mainnet it would have been 100% of the product's revenue accruing
   * into vaults with no door.
   *
   * NOTE FOR LATER, and it is a real constraint rather than a todo: the
   * program pays the AUTHORITY, so revenue lands in the hot key this server
   * signs with, not in a cold treasury. Moving it onward is a separate manual
   * step, and the sweep deliberately does not attempt it.
   */
  app.get("/api/admin/protocol-fees", requireAdmin, async (_req, res) => {
    const markets = await resolvedOnchainMarkets(40).catch(() => []);
    const states = await readMarkets(markets.map((m) => m.onchainPubkey)).catch(() => new Map<string, MarketRead>());
    let unreadable = 0;
    const rows = markets.map((m) => {
      const r = states.get(m.onchainPubkey);
      if (!r || (!r.ok && r.reason === "unreadable")) { unreadable++; return null; }
      if (!r.ok) return null;
      const state = r.state;
      if (state.protocolFeeClaimed || state.protocolFeeLamports <= 0) return null;
      return {
        slug: m.slug, question: m.question, onchainPubkey: m.onchainPubkey,
        lamports: state.protocolFeeLamports, feeBps: state.protocolFeeBps,
      };
    });
    const owed = rows.filter(Boolean) as Array<{ lamports: number }>;
    res.set("Cache-Control", "no-store").json({
      ok: true,
      totalLamports: owed.reduce((sum, r) => sum + r.lamports, 0),
      // A revenue total is a sum too. `unreadable` is how many resolved markets
      // this figure could not look at, so "we are owed X" is never mistaken for
      // "X is everything we are owed".
      unreadable,
      fees: owed,
    });
  });

  app.post("/api/admin/protocol-fees/sweep", requireAdmin, express.json(), async (req, res) => {
    // One market when asked for one, otherwise everything owed. Sequential on
    // purpose: these are signed sends from a single key, and firing them in
    // parallel races the same blockhash and the same nonce-free signer.
    const only = typeof req.body?.slug === "string" ? req.body.slug : null;
    const markets = (await resolvedOnchainMarkets(40).catch(() => []))
      .filter((m) => (only ? m.slug === only : true));
    const done: Array<{ slug: string; ok: boolean; lamports?: number; signature?: string | null; error?: string }> = [];
    for (const m of markets) {
      const r = await claimProtocolFee(m.onchainPubkey);
      if (r.alreadyClaimed) continue;                 // nothing to report, nothing moved
      if (!r.ok && /not resolved yet|unreadable/.test(r.error ?? "")) continue;
      done.push({ slug: m.slug, ok: r.ok, lamports: r.lamports, signature: r.signature ?? null, error: r.error });
    }
    res.set("Cache-Control", "no-store").json({
      ok: true,
      swept: done.filter((d) => d.ok).length,
      lamports: done.filter((d) => d.ok).reduce((s, d) => s + (d.lamports ?? 0), 0),
      results: done,
    });
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

    // The pool just moved. Any cached read of this market is now a number from
    // before the stake, so it is dropped rather than served for the rest of its
    // TTL to the very person who just changed it.
    if (stake) forgetMarket(stake.market);

    /**
     * BOOKKEEPING WAITS FOR CONFIRMATION. THE MONEY DOES NOT.
     *
     * submitSignedTx answers ok/confirmed:false when the send went out but the
     * confirmation could not be read, which is the right answer for the USER
     * (their transaction may well be landing, and telling them it failed would
     * be worse). It is the wrong basis for a ledger entry.
     *
     * Stamping an unconfirmed send credits the Genesis board with a funded
     * bettor and the score board with an entry for a transaction that may
     * never land, and it is farmable on purpose: send, let it die, keep the
     * credit. A missing stamp for a stake that did land is recoverable from
     * the signature below; a fabricated row on a public leaderboard is not.
     */
    if (stake && crowdBefore && out.confirmed !== true) {
      console.warn(JSON.stringify({
        evt: "chain_entry_unconfirmed", signature: out.signature ?? null,
        market: stake.market, wallet: stake.user, lamports: stake.lamports,
      }));
    }

    if (stake && crowdBefore && out.confirmed === true) {
      void slugForOnchainPubkey(stake.market).then(async (slug) => {
        if (!slug) return;
        await recordChainEntry({
          slug, wallet: stake.user, side: stake.side,
          entryPct: entryShareOf(crowdBefore, stake.side), lamports: stake.lamports,
        });
        // The Genesis board's ONLY number: a wallet that had never funded
        // anything before is a new human, credited to whoever's tag got them
        // here. The wallet's owner rides along so the ledger can enforce the
        // rule the page prints, "your own wallet never counts" — without it
        // anybody could fund their own market and score off it. Best-effort
        // like the stamp above: this is the money path, and bookkeeping must
        // never cost anybody their transaction.
        const walletOwner = await twitterHandleForWallet(stake.user).catch(() => null);
        await creditFundedBettor(slug, stake.user, walletOwner).catch((e) =>
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

  const permalink = `${APP_BASE_URL}/m/${slug}`;
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
    res.json({ settled });
  });
}

/**
 * The email leg of settlement outreach: every settled position whose owner has
 * a verified Google address gets exactly one message. Failures are logged and
 * swallowed — the tokens are already paid; mail is a courtesy, not a ledger.
 */

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
/**
 * THE ORACLE, ACTUALLY RUNNING.
 *
 * src/oracle has existed, been tested and been measured for a while, and
 * nothing in src/ imported it: only a hand-run script, its test and a backtest
 * did. So in production no market was ever closed by anything but a person
 * clicking resolve, while the landing said dated evidence closes it. This is
 * that wire.
 *
 * THREE SWITCHES, deliberately separate, and the same shape as the X bot's,
 * because they answer the same three questions:
 *
 *   ORACLE_ENABLED   the timer runs at all. Off by default, so a deploy that
 *                    happens to carry an API key does not start settling.
 *   ORACLE_DRY_RUN   defaults to TRUE. Every market is read, every gate is
 *                    applied, every decision is reached and RECORDED. It just
 *                    stops before settling. Not a mock: the thing worth
 *                    watching is the judgement, and a mocked decision shows
 *                    none of it.
 *   ORACLE_MAX_PER_SWEEP  most decisions cost a model call, so an unbounded
 *                    sweep is an unbounded bill: the first tick after a quiet
 *                    week would ask about every market closed since. Counts
 *                    markets ASKED ABOUT, so a board of held markets does not
 *                    consume it.
 *
 * The interval is slow on purpose. Settlement is not urgent -- a market closes
 * and the evidence appears over hours, not seconds -- and every tick that finds
 * nothing new still pays to find that out.
 */
const ORACLE_ENABLED = (process.env.ORACLE_ENABLED ?? "false").toLowerCase() === "true";
const ORACLE_DRY_RUN = (process.env.ORACLE_DRY_RUN ?? "true").toLowerCase() !== "false";
const ORACLE_MAX_PER_SWEEP = (() => {
  const raw = Number(process.env.ORACLE_MAX_PER_SWEEP ?? 5);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
})();
// Same NaN trap the X poll documents: Number("30m") is NaN, Math.max(_, NaN) is
// NaN, and Node coerces a NaN interval to ONE MILLISECOND. A value we cannot
// read is the default.
const ORACLE_POLL_MS = (() => {
  const raw = Number(process.env.ORACLE_POLL_MS ?? 1_800_000);
  if (!Number.isFinite(raw)) {
    console.error(`[oracle] ORACLE_POLL_MS=${JSON.stringify(process.env.ORACLE_POLL_MS)} is not a number. Using 1800000.`);
    return 1_800_000;
  }
  return Math.max(300_000, raw);
})();

let oracleSweepRunning = false;
async function sweepOracle(): Promise<void> {
  // Re-entrancy guard, not politeness: a sweep can hold the loop through
  // minutes of model calls, and two overlapping sweeps would ask about the same
  // markets twice and pay twice.
  if (oracleSweepRunning) return;
  oracleSweepRunning = true;
  try {
    const r = await oracleSweep({
      board: () => adminListCommunity(),
      criteria: async (slug) => {
        try {
          const d = await communityMarketDetail(slug);
          return { ok: true as const, criteria: d?.resolutionCriteria ?? null, priceCheck: d?.priceCheck ?? null };
        } catch (e) {
          return { ok: false as const, error: (e as Error).message };
        }
      },
      attempt: (slug) => oracleAttemptFor(slug),
      decide: (m, asOf) => decide(m, asOf),
      record: (d) => recordOracleDecision({
        slug: d.slug, settle: d.settle, gate: d.gate, reason: d.reason,
        confidence: d.proposal?.confidence ?? null,
        secondOpinion: d.secondOpinion ?? null,
        citations: d.audit?.citations ?? [],
        verified: d.audit?.verified ?? 0, undated: d.audit?.undated ?? 0, stale: d.audit?.stale ?? 0,
        absent: d.audit?.absent ?? 0, unreachable: d.audit?.unreachable ?? 0,
        paid: d.paid,
      }),
      // The SAME function the admin route calls, so the whole tail happens once
      // and in one place: off-chain settlement, the on-chain resolve, the fee
      // log and the reply in the X thread.
      settle: ORACLE_DRY_RUN ? null : async (slug, outcome) => Boolean(await resolveCommunityMarket(slug, outcome)),
      limit: ORACLE_MAX_PER_SWEEP,
      on: {
        decided: (d) => console.log(JSON.stringify({
          evt: "oracle_decision", slug: d.slug, gate: d.gate,
          settle: d.settle, dryRun: ORACLE_DRY_RUN, reason: d.reason,
        })),
        settled: (slug, outcome) => console.log(JSON.stringify({ evt: "oracle_settled", slug, outcome })),
        failed: (slug, outcome) => console.error(JSON.stringify({ evt: "oracle_settle_failed", slug, outcome })),
        unreadable: (slug, error) => console.error(JSON.stringify({ evt: "oracle_unreadable", slug, error })),
      },
    });
    // Logged every sweep, including the empty ones: a loop that only speaks
    // when it acts is a loop you cannot tell apart from a stopped one.
    console.log(JSON.stringify({
      evt: "oracle_sweep", seen: r.seen, decided: r.decided.length, held: r.held,
      unreadable: r.unreadable, truncated: r.truncated,
      settled: r.settled, failed: r.failed, dryRun: ORACLE_DRY_RUN,
    }));
  } catch (e) {
    console.error("[oracle] sweep failed:", (e as Error).message);
  } finally {
    oracleSweepRunning = false;
  }
}

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
  /* THE FLOOR IS 10 SECONDS, NOT 60, BECAUSE FREQUENCY IS FREE.
     X bills reads PER RESOURCE RETURNED ("Charged per resource returned in the
     response", docs.x.com/x-api/getting-started/pricing), and this poll sends
     since_id, so an idle sweep returns nothing and costs nothing. Polling more
     often does not cost more; it returns the same mention exactly once either
     way, and the 24h dedup window backstops that even if the cursor slips.
     What the floor protects is the rate limit, which is 300 requests per 15
     minutes in user context. 10s is 90 per 15 minutes, 30% of it, with room
     for retries. The old 60s floor was priced against a per-request billing
     model that does not exist. */
  return Math.max(10_000, raw);
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
        // Marketi acan kisi: %2 ona gider. sourceUrl iddianin sahibini
        // gosterir ve o baska biri olabilir.
        taggerHandle: input.taggerHandle ?? null,
        category: input.category,
        resolutionCriteria: input.resolutionCriteria,
        priceClaim: input.priceClaim ?? null,
        claimText: input.claimText ?? null,
        resolvability: input.resolvability,
        hook: input.hook ?? null,
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
      if (!rec) return null;
      /* THE SAME QUESTION THE TWO /card ROUTES ASK, and the only renderer that
         never asked it was this one: the card that goes to X under a stranger's
         tweet. Without `unpriced` the card quotes the seeded 50 as a hero
         percentage with "yes pays 2x" beside it, on a pool nobody has staked
         into. It states a price nobody set and a multiple the first staker will
         not receive, while the page it links to says "first in sets the odds"
         about the same market in the same tweet.
         marketPools degrades an unreadable chain to no price at all, which is
         the safe direction: it invites a stake instead of inventing odds. */
      return renderCardPng(renderCard(rec.market, {
        pools: await marketPools(slug),
        hook: await hookFor(slug).catch(() => null),
        stakers: await cardStakers(slug),
      }));
    },
    // One card for every unmarketable tag, so it is rasterised once for the
    // life of the process rather than per reply: nothing on it is per-tweet.
    teachPng: async () => (teachPngCache ??= renderCardPng(renderTeachCard())),
    refusalsUsed: (handle) => refusalRepliesTo(handle),
    spendMiss: (tweetId, handle) => spendTicketForMiss(tweetId, handle),
    alreadyTold: (handle, slug) => toldAboutMarket(handle, slug),
    uploadMedia: (png) => X.uploadMedia(png),
    postReply: (o) => X.postReply(o),
    // The Genesis season. A reply is a ticket: the balance is read before any
    // of the expensive work and charged only once the reply has gone out.
    ticketsLeft: (handle) => ticketsLeft(handle),
    spendTicket: (slug, tagger, source) => spendTicketForTag(slug, tagger, source),
    baseUrl: APP_BASE_URL, // the app host: the bot's link must not 301 through the apex
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
    /* A QUIET LOOP AND A STOPPED LOOP LOOK IDENTICAL.
       This logged only when there was something to look at, so a healthy bot
       with no new mentions writes nothing for hours and the only evidence it
       is alive is a boot line from whenever the container last restarted. That
       is the same failure the oracle sweep was given a heartbeat for. One line
       every ten minutes, and it costs nothing: the X read has already been
       paid for by the time we get here. */
    if (r.looked === 0) {
      console.log(JSON.stringify({ evt: "x_sweep", looked: 0, dryRun: sweepDeps(overrides).dryRun }));
    }
    if (r.looked > 0) {
      /* WHY, not just how many.
         This dropped `decisions` to keep the line short, and the line it kept
         says "skipped=5" without a word about what was skipped or why. The dry
         run exists for exactly one purpose, which is reading the bot's
         JUDGEMENT before trusting it with a voice, and the judgement was the
         part being thrown away.
         A histogram always: it is a handful of short words, bounded by the
         sweep cap, and it turns "skipped=5" into something a person can act on.
         The per-mention list only in DRY RUN, where somebody is actually
         reading, so a live loop does not print a paragraph every ten minutes. */
      const reasons: Record<string, number> = {};
      for (const d of r.decisions) {
        const why = String((d as { reason?: string }).reason ?? d.outcome);
        reasons[why] = (reasons[why] ?? 0) + 1;
      }
      const dryRun = sweepDeps(overrides).dryRun;
      console.log(JSON.stringify({
        evt: "x_sweep", ...r, decisions: dryRun ? r.decisions : undefined, reasons, dryRun,
      }));
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

if (ORACLE_ENABLED) {
  // Same shape as the bot's credential check below, and for the same reason: a
  // loop that starts without what it needs does not fail, it fails QUIETLY,
  // once per tick, in a log nobody reads. oracleAvailable also catches the case
  // that matters most here -- a key that works but a model that cannot search,
  // which would return an error gate for every market and record it.
  const avail = oracleAvailable();
  if (!avail.ok) {
    console.error(`[oracle] ORACLE_ENABLED is set but the oracle cannot run: ${avail.why}. The loop will not start.`);
  } else {
    setInterval(sweepOracle, ORACLE_POLL_MS).unref();
    // Not at boot. A deploy restarts the process, and a sweep that runs on
    // every restart turns a bad afternoon of deploys into a bill.
    setTimeout(sweepOracle, 120_000).unref();
    console.log(`[oracle] settle loop ON, every ${Math.round(ORACLE_POLL_MS / 60_000)}m, up to ${ORACLE_MAX_PER_SWEEP} per sweep, ${ORACLE_DRY_RUN ? "DRY RUN (nothing is settled)" : "SETTLING FOR REAL"} — ${avail.why}`);
  }
}

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
    `oddie on ${BASE_URL} (port ${PORT}) — inference ${inferenceProvider().anthropic ? "anthropic" : inferenceProvider().host} (${inferenceProvider().model}) — semantic matching ${semanticEnabled() ? "ON" : `OFF (set ${SEMANTIC_KEY_ENV} to enable)`}; claim extraction ${extractEnabled() ? "ON" : `OFF (set ${EXTRACT_KEY_ENV} to enable)`}; mail ${mailEnabled() ? "ON" : `DRY-RUN (set ${MAIL_KEY_ENV} to send)`}`,
  ),
);
