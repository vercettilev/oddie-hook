/**
 * A stream's page on oddie and the streamer's 2%, for any platform.
 *
 * Kick shipped these routes first; Twitch needs exactly the same ones, so they
 * live here and each platform's router adds only what is its own (sign-in,
 * webhook, how a line reaches its chat). The path carries the platform:
 * /live/<platform>/<slug>, /api/live/<platform>/..., and the owner cookie is
 * per platform too (src/live/owner.ts), so a Kick channel id is never taken
 * for a Twitch one.
 */
import express, { type Request, type Response, type Router } from "express";
import { consumeChallenge, issueChallenge, verifyWalletSignature, WALLET_ADDRESS } from "../auth/wallet.js";
import { weekStart, yesPct, type Platform } from "./calls.js";
import { cookieValue, ownerCookieName, ownerKeyFromEnv, verifyOwnerToken } from "./owner.js";
import type { ChannelMarket } from "../store/markets.js";
import { callFrame, channelBySlug, channelStandings, liveStore, recentCalls, streaksFor, type StandingRow } from "../store/live.js";
import { faceitConfigured } from "../games/faceit.js";
import { gsiConfig } from "../games/gsi.js";
import { GSI_STALE_MS } from "./gameCalls.js";

/**
 * A CHANNEL'S 2%, from the server: the same person store, challenge and
 * verifier the Telegram link uses. The channel is the person <platform>:<id>.
 */
export interface ChannelPayoutDeps {
  /** The site named in the message the wallet signs: the server's own rule. */
  domain(req: Request): string;
  wallet(personId: string): Promise<string | null>;
  setWallet(personId: string, wallet: string): Promise<void>;
  /** Every market opened in the channel's chat. */
  openedSlugs(channelId: string): Promise<string[]>;
  /** Point those markets at the wallet: on the row before a mint, on chain after. */
  nameMarkets(channelId: string, wallet: string): Promise<{ onRow: number; onChain: number; seen: number }>;
}

export interface ChannelPageDeps {
  /** Where the app lives: the URL the game's config file posts to. */
  appBaseUrl: string;
  pageHtml(): string;
  /** The overlay for OBS (public/app/overlay.html). Absent: no overlay route. */
  overlayHtml?(): string;
  pageOpen(req: Request): boolean;
  pageClosed(res: Response): void;
  log(line: string, extra?: Record<string, unknown>): void;
  /** Markets opened in a channel's chat, newest first, for its page. */
  channelMarkets?(channelId: string, limit: number): Promise<ChannelMarket[]>;
  /** Where a channel's 2% goes. Absent, the page never offers it. */
  payout?: ChannelPayoutDeps;
}

const CHANNEL_URL: Record<Platform, (slug: string) => string> = {
  kick: (s) => `https://kick.com/${s}`,
  twitch: (s) => `https://www.twitch.tv/${s}`,
  // A YouTube channel's slug is its handle, or its UC… id when it has none.
  youtube: (s) => (/^UC[\w-]{22}$/.test(s) ? `https://www.youtube.com/channel/${s}` : `https://www.youtube.com/@${s}`),
  x: (s) => `https://x.com/${s}`,
};

/** The channel this browser signed in as on this platform, or null. */
export function ownerOf(platform: Platform, req: Request): string | null {
  const key = ownerKeyFromEnv(platform);
  const token = cookieValue(req.headers.cookie, ownerCookieName(platform));
  return key && token ? verifyOwnerToken(token, key) : null;
}

export function addChannelRoutes(r: Router, platform: Platform, d: ChannelPageDeps): void {
  /* The page is polled every few seconds by everybody watching it, and the
     markets under it change when somebody opens one: read a channel's list at
     most every fifteen seconds. */
  const marketCache = new Map<string, { at: number; rows: ChannelMarket[] }>();
  const marketsOf = async (channelId: string): Promise<ChannelMarket[]> => {
    if (!d.channelMarkets) return [];
    const hit = marketCache.get(channelId);
    if (hit && Date.now() - hit.at < 15_000) return hit.rows;
    const rows = await d.channelMarkets(channelId, 10).catch(() => hit?.rows ?? []);
    marketCache.set(channelId, { at: Date.now(), rows });
    return rows;
  };

  /** A channel's page on oddie, and what it reads. */
  r.get(`/live/${platform}/:slug`, (req, res, next) => {
    // The sign-in and webhook paths are the platform router's own.
    if (["connect", "callback", "webhook", "voice"].includes(req.params.slug)) return next();
    if (!d.pageOpen(req)) return d.pageClosed(res);
    res.set("Cache-Control", "no-cache").type("html").send(d.pageHtml());
  });

  /** The call on the picture: a transparent page for an OBS browser source. */
  r.get(`/live/${platform}/:slug/overlay`, (req, res) => {
    if (!d.overlayHtml) return res.status(404).type("text").send("no overlay");
    if (!d.pageOpen(req)) return d.pageClosed(res);
    res.set("Cache-Control", "no-cache").set("X-Robots-Tag", "noindex, nofollow").type("html").send(d.overlayHtml());
  });

  /* THE GAME'S CONFIG FILE (src/games/gsi.ts): one download for the channel's
     owner, with a token made on the first ask. The game posts to /api/gsi/<token>. */
  r.get(`/live/${platform}/:slug/gsi.cfg`, async (req, res) => {
    const ch = await channelBySlug(platform, req.params.slug).catch(() => null);
    if (!ch) return res.status(404).type("text").send("unknown channel");
    if (ownerOf(platform, req) !== ch.channelId) return res.status(401).type("text").send("sign in with your channel first");
    const token = await liveStore.gsiToken(platform, ch.channelId, true).catch(() => null);
    if (!token) return res.status(503).type("text").send("try again");
    const base = d.appBaseUrl.replace(/\/+$/, "");
    res.set("Cache-Control", "no-store").set("Content-Disposition", 'attachment; filename="gamestate_integration_oddie.cfg"')
      .type("text/plain").send(gsiConfig(`${base}/api/gsi/${token}`, token));
  });

  /* THE STREAMER'S CS2 ACCOUNT, from their own page. oddie finds it by name
     (src/live/gameCalls.ts); this is for a name that differs, and for "not me".
     Owner cookie only, like the wallet. An empty nickname unlinks and stops
     oddie looking. */
  r.post(`/api/live/${platform}/faceit`, express.json({ limit: "2kb" }), async (req, res) => {
    const channelId = ownerOf(platform, req);
    if (!channelId) return res.status(401).json({ ok: false, reason: "sign-in" });
    const games = faceitConfigured();
    if (!games) return res.status(503).json({ ok: false, reason: "no-faceit" });
    const nick = String(req.body?.nick ?? "").trim().replace(/^@/, "").slice(0, 40);
    if (!nick) {
      await liveStore.setFaceit(platform, channelId, null);
      return res.json({ ok: true, faceit: null });
    }
    const p = await games.player(nick).catch(() => null);
    if (!p) return res.status(404).json({ ok: false, reason: "not-found" });
    await liveStore.setFaceit(platform, channelId, { id: p.id, nick: p.nick });
    d.log("faceit linked from the page", { platform, channel: channelId, nick: p.nick });
    res.json({ ok: true, faceit: { nick: p.nick, cs2: p.playsCs2 } });
  });

  r.get(`/api/live/${platform}/:slug`, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const ch = await channelBySlug(platform, req.params.slug).catch(() => null);
    if (!ch) return res.status(404).json({ error: "unknown" });
    const [unsettled, recent, standings, standingsWeek] = await Promise.all([
      liveStore.unsettled(platform, ch.channelId).catch(() => []),
      recentCalls(platform, ch.channelId, 10).catch(() => []),
      channelStandings(platform, ch.channelId, 20).catch(() => [] as StandingRow[]),
      channelStandings(platform, ch.channelId, 20, { since: weekStart(Date.now()) }).catch(() => [] as StandingRow[]),
    ]);
    // Each name's run of right calls, for the 🔥 next to it (Lev, 16 Oct).
    const runs = await streaksFor([...standings, ...standingsWeek].map((s) => ({ platform, userId: s.userId }))).catch(() => new Map<string, number>());
    const row = (s: StandingRow, i: number) => ({ rank: i + 1, username: s.username, points: s.points, right: s.right, calls: s.calls,
      streak: runs.get(`${platform}:${s.userId}`) ?? 0 });
    const current = unsettled.find((c) => c.lockedAt === null) ?? null;
    const tallies = await Promise.all(unsettled.map((c) => liveStore.tally(c.id).catch(() => ({ yes: 0, no: 0 }))));
    const tallyOf = (id: string) => tallies[unsettled.findIndex((c) => c.id === id)] ?? { yes: 0, no: 0 };
    const tally = current ? tallyOf(current.id) : null;
    const markets = await marketsOf(ch.channelId);
    // Only to the streamer's own browser: where their 2% goes, and how many
    // markets pay it.
    const owner = d.payout && ownerOf(platform, req) === ch.channelId
      ? await Promise.all([
        d.payout.wallet(`${platform}:${ch.channelId}`).catch(() => null),
        d.payout.openedSlugs(ch.channelId).catch(() => [] as string[]),
      ]).then(([wallet, slugs]) => ({
        wallet, markets: slugs.length,
        // Their stream's two things: the overlay for OBS, and the CS2 account oddie reads matches from.
        overlayPath: `/live/${platform}/${encodeURIComponent(ch.slug)}/overlay`,
        faceit: ch.faceitNick ? { nick: ch.faceitNick } : null,
        faceitAvailable: !!faceitConfigured(),
        // The game's own feed: the config to download, and whether the game is talking right now.
        gsi: { cfgPath: `/live/${platform}/${encodeURIComponent(ch.slug)}/gsi.cfg`, talking: ch.gsiSeenAt != null && Date.now() - ch.gsiSeenAt < GSI_STALE_MS, seenAt: ch.gsiSeenAt ?? null },
      }))
      : null;
    res.json({
      platform, slug: ch.slug, name: ch.name, avatar: ch.avatar, url: CHANNEL_URL[platform](ch.slug),
      ...(owner ? { owner } : {}),
      markets: markets.map((m) => ({ slug: m.slug, question: m.question, hook: m.hook, closesAt: m.closesAt, outcome: m.outcome })),
      current: current && tally ? {
        question: current.question, closesAt: new Date(current.closesAt).toISOString(), timed: current.timed,
        locked: current.timed && Date.now() >= current.closesAt, yes: tally.yes, no: tally.no, yesPct: yesPct(tally),
      } : null,
      // Locked, answers in, the result still to come: a new call took the room.
      waiting: unsettled.filter((c) => c.lockedAt !== null).map((c) => {
        const t = tallyOf(c.id);
        return { question: c.question, yes: t.yes, no: t.no, yesPct: yesPct(t) };
      }),
      recent: recent.filter((c) => c.settledAt !== null).map((c) => ({
        question: c.question, outcome: c.outcome, yes: c.yes, no: c.no, points: c.points,
        settledAt: c.settledAt ? new Date(c.settledAt).toISOString() : null,
        // The picture oddie settled it on, when the screen did (src/live/screenCalls.ts).
        frame: c.frame ? `/api/live/${platform}/${encodeURIComponent(ch.slug)}/frame/${c.id}` : null,
      })),
      standings: standings.map(row),
      standingsWeek: standingsWeek.map(row),
    });
  });

  /* WHAT ODDIE SAW (Lev, 27 Oct, after Dibs asked how a settle can be
     checked): the picture a call was settled on, served as it was read. A
     settled picture never changes, so it can be kept anywhere. */
  r.get(`/api/live/${platform}/:slug/frame/:id`, async (req, res) => {
    const ch = await channelBySlug(platform, req.params.slug).catch(() => null);
    const f = ch ? await callFrame(platform, ch.channelId, req.params.id).catch(() => null) : null;
    if (!f) return res.status(404).json({ error: "unknown" });
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.type("image/jpeg").send(f.jpeg);
  });

  /* ------------------------------------------------ the streamer's 2% --
   * Every market opened in a channel's chat pays that channel 2% of its pool
   * (src/live/claims.ts). Collecting it takes a wallet named as the markets'
   * creator, and naming one takes two proofs: which channel (the owner cookie,
   * set only at the end of the platform's own sign-in) and which wallet (a
   * signature on the same challenge every wallet sign-in uses, bound to
   * <platform>:<channel>). */
  r.post(`/api/live/${platform}/wallet/challenge`, express.json({ limit: "4kb" }), (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!d.payout) return res.status(503).json({ error: "off" });
    const channelId = ownerOf(platform, req);
    if (!channelId) return res.status(401).json({ error: "signin" });
    const address = String(req.body?.address ?? "");
    if (!WALLET_ADDRESS.test(address)) return res.status(400).json({ error: "bad address" });
    const { nonce, message } = issueChallenge(`${platform}:${channelId}`, address, d.payout.domain(req));
    res.json({ nonce, message });
  });

  r.post(`/api/live/${platform}/wallet/link`, express.json({ limit: "4kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    const pay = d.payout;
    if (!pay) return res.status(503).json({ error: "off" });
    const channelId = ownerOf(platform, req);
    if (!channelId) return res.status(401).json({ error: "signin" });
    const address = String(req.body?.address ?? "");
    const nonce = String(req.body?.nonce ?? "");
    const sigHex = String(req.body?.signature ?? "");
    if (!WALLET_ADDRESS.test(address)) return res.status(400).json({ error: "bad address" });
    if (!/^[0-9a-fA-F]{128}$/.test(sigHex)) return res.status(400).json({ error: "bad signature" });
    const binding = `${platform}:${channelId}`;
    const challenge = consumeChallenge(nonce, binding);
    if (!challenge) return res.status(400).json({ error: "challenge expired" });
    // The address is signed into the message; a different one now means this
    // is not the exchange that was started.
    if (!challenge.message.includes(address)) return res.status(400).json({ error: "address mismatch" });
    if (!verifyWalletSignature(address, challenge.message, Buffer.from(sigHex, "hex"))) {
      d.log(`${platform} payout refused`, { channel: channelId, reason: "bad_signature" });
      return res.status(401).json({ error: "signature did not verify" });
    }
    await pay.setWallet(binding, address);
    const slugs = await pay.openedSlugs(channelId).catch(() => [] as string[]);
    res.json({ ok: true, wallet: address, markets: slugs.length });
    // After the answer: naming on chain is a transaction per market.
    void pay.nameMarkets(channelId, address)
      .then((n) => d.log(`${platform} payout linked`, { channel: channelId, ...n }))
      .catch((e) => d.log(`${platform} payout naming failed`, { channel: channelId, err: (e as Error).message }));
  });

  /* A failure inside the wallet never reaches us on its own: the page stops
     before its next request. So the page says what broke, as Telegram's does;
     the cookie keeps this to streamers who were really in the flow. */
  r.post(`/api/live/${platform}/wallet/fail`, express.json({ limit: "2kb" }), (req, res) => {
    const channelId = ownerOf(platform, req);
    if (!channelId) return res.status(401).end();
    const clip = (v: unknown, n: number): string | null => (v == null ? null : String(v).replace(/[\r\n]+/g, " ").slice(0, n));
    d.log(`${platform} payout stopped`, {
      channel: channelId, stage: clip(req.body?.stage, 16), code: clip(req.body?.code, 16), msg: clip(req.body?.msg, 200),
    });
    res.status(204).end();
  });
}
