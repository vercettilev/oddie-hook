/**
 * A STREAMER WHO BRINGS A STREAMER (Lev, 3 Nov 2026): the channel whose
 * invite link a new channel joined through earns part of Oddie's own fee on
 * the new channel's markets, for a while.
 *
 * WHAT IT PAYS, AND FROM WHERE. Every pool pays 4%: 2% to the channel the
 * market was opened in (src/live/claims.ts) and 2% to Oddie, both fixed on
 * chain by resolve_market. The referrer's part comes out of Oddie's 2% only,
 * as logRealFee recorded it (recordedProtocolFees in src/store/markets.ts),
 * never worked out again from a rate: the program caps the fee at the losing
 * side and takes nothing from a one-sided pool. Only Kick and Twitch chats
 * open markets, so a referred X or YouTube channel earns its referrer nothing.
 *
 * NOTHING HERE SENDS SOL. The ledger says what is owed to whom; the admin pays
 * by hand and records it (POST /api/admin/referrals/payout). Paying it out
 * automatically would be a transfer from the house's wallet, decided
 * somewhere else, never in this file.
 *
 * WHICH CHANNEL INVITED. The invite link (/live/invite/<platform>/<slug>)
 * leaves a cookie naming the channel and sends the visitor to /live, and the
 * first connect ever of a new channel reads it. One referral per channel,
 * never changed: a reconnect is not a new channel, and the table's key says
 * the rest (src/store/referrals.ts).
 */
import express, { type Request, type Router } from "express";
import { WALLET_ADDRESS } from "../auth/wallet.js";
import type { Platform } from "./calls.js";
import { cookieValue, ownerCookie, ownerKeyFromEnv, ownerToken } from "./owner.js";
import { PROTOCOL_FEE_BPS_REAL } from "../store/economy.js";
import {
  claimMention, logRealFee, personWallet, recordedProtocolFees, settleMention, streamOpenedMarkets, STORE_PERSISTENT, type StreamPlatform,
} from "../store/markets.js";
import { channelById, channelBySlug, saveChannel } from "../store/live.js";
import {
  allReferrals, recordPayout, referralPayouts, referralsBy, saveReferral, type Referral, type ReferralPayout,
} from "../store/referrals.js";

/* ------------------------------------------------------------ the terms --
   One place for the numbers. Lev approved the referral on 3 Nov and has not
   confirmed these: change them here and nowhere else. A referral keeps the
   terms of the day it was made (they are written on its row), so a change
   reprices only the channels that join after it. */

/** The referrer's part of Oddie's protocol fee, in basis points: 2500 is a
 *  quarter of it, 0.5% of a pool at today's 2% fee. */
export const REFERRAL_SHARE_BPS = 2500;
/** Markets opened in the new channel within this many days of its first connect count. */
export const REFERRAL_DAYS = 180;
/** How long a browser remembers the invite it opened. */
export const REFERRAL_COOKIE_DAYS = 30;
export const REFERRAL_COOKIE = "oddie_ref";
/** The platforms whose chats open markets that pay a fee (src/live/claims.ts).
 *  X Live and YouTube run votes only: no pool, so no fee to share. */
export const MONEY_PLATFORMS: ReadonlySet<Platform> = new Set<Platform>(["kick", "twitch"]);

const DAY_MS = 86_400_000;
const pctOf = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`;
const spanOf = (days: number): string =>
  days % 30 === 0 ? (days === 30 ? "1 month" : `${days / 30} months`) : days === 1 ? "1 day" : `${days} days`;
/** The one line of terms on the owner's card, said from the numbers above.
 *  Lev's wording (3 Nov): short, because no surface buries anybody in detail. */
export const inviteTerms = (shareBps = REFERRAL_SHARE_BPS, days = REFERRAL_DAYS): string =>
  `You get ${pctOf((PROTOCOL_FEE_BPS_REAL * shareBps) / 10_000)} of every pool in their chat for ${spanOf(days)}.`;

/* ----------------------------------------------------------- the cookie -- */

const PLATFORMS: readonly Platform[] = ["kick", "twitch", "youtube", "x"];
/** A channel id as every platform gives one (the owner cookie's rule): never a dot, the cookie's separator. */
const CHANNEL_ID = /^[A-Za-z0-9_-]{1,40}$/;
/** How far ahead of this clock an invite may say it was opened: two servers never agree to the second. */
const SKEW_MS = 5 * 60_000;

/**
 * <platform>.<channel id>.<when it was opened, ms in base 36>.
 *
 * NOT SIGNED, ON PURPOSE. It names a channel whose invite link is public, so a
 * cookie somebody writes by hand says no more than opening that link would.
 * What is checked is its shape and its days here, and at the connect that the
 * channel it names exists and is not the one connecting.
 */
export function referralCookieValue(platform: Platform, channelId: string, now = Date.now()): string {
  if (!PLATFORMS.includes(platform) || !CHANNEL_ID.test(channelId)) throw new Error("not a channel");
  return `${platform}.${channelId}.${now.toString(36)}`;
}

/** The invite a cookie names, or null when it is malformed, from the future or past its days. Never throws. */
export function parseReferralCookie(value: string | null | undefined, now = Date.now()): { platform: Platform; channelId: string; at: number } | null {
  if (typeof value !== "string" || value.length > 80) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [platform, channelId, opened] = parts as [string, string, string];
  if (!PLATFORMS.includes(platform as Platform) || !CHANNEL_ID.test(channelId) || !/^[0-9a-z]{1,11}$/.test(opened)) return null;
  const at = parseInt(opened, 36);
  if (!Number.isSafeInteger(at) || at > now + SKEW_MS || now - at > REFERRAL_COOKIE_DAYS * DAY_MS) return null;
  return { platform: platform as Platform, channelId, at };
}

/**
 * The Domain a cookie needs where the landing and the app are two hosts: X's
 * one registered callback comes back to the landing's host
 * (/api/auth/twitter/callback) while the channel pages live on the app's.
 * The preview cookie in server.ts follows the same rule. Elsewhere (localhost,
 * tests) none: the cookie stays on its own host.
 */
export function sharedCookieDomain(baseUrl: string): string | null {
  let host = "";
  try { host = new URL(baseUrl).hostname; } catch { return null; }
  return /(^|\.)oddie\.fun$/.test(host) ? ".oddie.fun" : null;
}

/** The Set-Cookie line. HttpOnly, sent on a sign-in coming back from Kick,
 *  Twitch, X or Google (SameSite=Lax lets a top-level return carry it), on
 *  every path a connect ends on. */
export function referralCookie(value: string, secure: boolean, domain: string | null = null): string {
  return `${REFERRAL_COOKIE}=${value}; Path=/; Max-Age=${REFERRAL_COOKIE_DAYS * 86_400}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}${domain ? `; Domain=${domain}` : ""}`;
}

export const invitePath = (platform: Platform, slug: string): string => `/live/invite/${platform}/${encodeURIComponent(slug)}`;

/* ---------------------------------------------------------- the connect -- */

export type InviteOutcome = "recorded" | "no-cookie" | "bad-cookie" | "not-new" | "self" | "unknown-referrer" | "already" | "error";
type Log = (line: string, extra?: Record<string, unknown>) => void;

/**
 * At the end of a platform's own connect: a channel connecting for the first
 * time ever, through another channel's invite, is that channel's referral.
 * Never throws: an invite is never the reason a connect fails.
 *
 * `firstEver` is the platform's own read from before it saved the channel:
 * there was no row for it. A read that failed is not a first, so an existing
 * channel is never handed to whichever invite sits in the browser.
 */
export async function creditInvite(
  cookieHeader: string | undefined,
  joined: { platform: Platform; channelId: string; slug: string },
  firstEver: boolean,
  log?: Log,
  now = Date.now(),
): Promise<InviteOutcome> {
  const raw = cookieValue(cookieHeader, REFERRAL_COOKIE);
  if (raw === null) return "no-cookie";
  const ref = parseReferralCookie(raw, now);
  const outcome = await (async (): Promise<InviteOutcome> => {
    if (!ref) return "bad-cookie";
    if (!firstEver) return "not-new";
    if (ref.platform === joined.platform && ref.channelId === joined.channelId) return "self";
    const by = await channelById(ref.platform, ref.channelId);
    if (!by) return "unknown-referrer";
    // The same name on another platform is taken for the same streamer: their
    // own Kick bringing their own Twitch is no referral.
    if (by.slug.toLowerCase() === joined.slug.toLowerCase()) return "self";
    const wrote = await saveReferral({
      platform: joined.platform, channelId: joined.channelId, referrerPlatform: ref.platform, referrerId: ref.channelId,
      at: now, shareBps: REFERRAL_SHARE_BPS, days: REFERRAL_DAYS,
    });
    return wrote ? "recorded" : "already";
  })().catch(() => "error" as const);
  log?.("invite at connect", { platform: joined.platform, channel: joined.slug, outcome, by: ref ? `${ref.platform}:${ref.channelId}` : null });
  return outcome;
}

/* ----------------------------------------------------------- the ledger -- */

/** A market opened in a referred channel's chat, and the protocol fee its resolve recorded (null: none yet). */
export interface LedgerMarket { slug: string; openedAt: number; protocolFeeLamports: number | null }
export interface LedgerLine extends LedgerMarket { counted: boolean; shareLamports: number }

/** The window: from the referred channel's first connect, for the referral's days. */
export const windowEnd = (r: Pick<Referral, "at" | "days">): number => r.at + r.days * DAY_MS;
export const inWindow = (r: Pick<Referral, "at" | "days">, openedAt: number): boolean => openedAt >= r.at && openedAt < windowEnd(r);

/**
 * The referrer's part of one market's recorded fee: whole lamports, rounded
 * down, as the program rounds every payout. In BigInt, so a large fee times
 * the share can never pass what a double holds exactly. No recorded fee, no
 * part.
 */
export function shareOf(protocolFeeLamports: number | null | undefined, shareBps: number): number {
  if (typeof protocolFeeLamports !== "number" || !Number.isSafeInteger(protocolFeeLamports) || protocolFeeLamports <= 0) return 0;
  if (!Number.isSafeInteger(shareBps) || shareBps <= 0) return 0;
  return Number((BigInt(protocolFeeLamports) * BigInt(Math.min(shareBps, 10_000))) / 10_000n);
}

/** What one referral has earned, market by market. Pure: the reads are the caller's. */
export function referralEarnings(r: Referral, markets: LedgerMarket[]): { lines: LedgerLine[]; earnedLamports: number } {
  const pays = MONEY_PLATFORMS.has(r.platform);
  const lines = markets.map((m) => {
    const counted = pays && inWindow(r, m.openedAt);
    return { ...m, counted, shareLamports: counted ? shareOf(m.protocolFeeLamports, r.shareBps) : 0 };
  });
  return { lines, earnedLamports: lines.reduce((s, l) => s + l.shareLamports, 0) };
}

export interface ReferrerLedger {
  platform: Platform; channelId: string;
  referrals: Array<Referral & { until: number; earnedLamports: number; markets: LedgerLine[] }>;
  payouts: ReferralPayout[];
  earnedLamports: number; paidLamports: number; owedLamports: number;
}

const isMoney = (p: Platform): p is StreamPlatform & Platform => MONEY_PLATFORMS.has(p);

/** The ledger, by referrer: one channel's (`only`, always answered even when
 *  it brought nobody), or every referrer's. */
export async function referralLedger(only?: { platform: Platform; channelId: string }): Promise<ReferrerLedger[]> {
  const [refs, payouts] = await Promise.all([
    only ? referralsBy(only.platform, only.channelId) : allReferrals(),
    referralPayouts(only),
  ]);
  // Only a chat that opens markets is read: the others have none to count.
  const opened = await Promise.all(refs.map((r) => (isMoney(r.platform) ? streamOpenedMarkets(r.platform, r.channelId) : [])));
  const fees = await recordedProtocolFees([...new Set(opened.flat().map((m) => m.slug))]);
  const by = new Map<string, ReferrerLedger>();
  const of = (platform: Platform, channelId: string): ReferrerLedger => {
    const k = `${platform}:${channelId}`;
    let l = by.get(k);
    if (!l) { l = { platform, channelId, referrals: [], payouts: [], earnedLamports: 0, paidLamports: 0, owedLamports: 0 }; by.set(k, l); }
    return l;
  };
  if (only) of(only.platform, only.channelId);
  refs.forEach((r, i) => {
    const e = referralEarnings(r, (opened[i] ?? []).map((m) => ({ ...m, protocolFeeLamports: fees.get(m.slug) ?? null })));
    const l = of(r.referrerPlatform, r.referrerId);
    l.referrals.push({ ...r, until: windowEnd(r), earnedLamports: e.earnedLamports, markets: e.lines });
    l.earnedLamports += e.earnedLamports;
  });
  for (const p of payouts) {
    const l = of(p.referrerPlatform, p.referrerId);
    l.payouts.push(p);
    l.paidLamports += p.lamports;
  }
  for (const l of by.values()) l.owedLamports = l.earnedLamports - l.paidLamports;
  return [...by.values()];
}

/* -------------------------------------------------------- the owner card -- */

/** What the owner's card shows (src/live/channelRoutes.ts, public/app/live.html). */
export interface InviteCard {
  /** The invite, from the site's root: the page puts its own origin in front. */
  path: string;
  terms: string;
  /** Channels that joined through it. */
  brought: number;
  /** Their part so far, and how much of it the admin has sent. */
  earnedLamports: number; paidLamports: number;
  /** Where it is paid: the wallet the channel's 2% goes to, when there is one. */
  wallet: string | null;
}

export async function inviteCard(ch: { platform: Platform; channelId: string; slug: string }): Promise<InviteCard> {
  const [ledger, wallet] = await Promise.all([
    referralLedger({ platform: ch.platform, channelId: ch.channelId }),
    personWallet(`${ch.platform}:${ch.channelId}`).catch(() => null),
  ]);
  const mine = ledger[0];
  return {
    path: invitePath(ch.platform, ch.slug), terms: inviteTerms(), brought: mine?.referrals.length ?? 0,
    earnedLamports: mine?.earnedLamports ?? 0, paidLamports: mine?.paidLamports ?? 0, wallet,
  };
}

/* ------------------------------------------------------------- the routes -- */

export interface ReferralRouteDeps {
  /** Where the app lives: the cookie is Secure when it is https. */
  appBaseUrl: string;
  /** The cookie's Domain where the landing and the app are two hosts (sharedCookieDomain). */
  cookieDomain?: string | null;
  /** The server's own admin check: the token every admin route takes. */
  adminOk(req: Request): boolean;
  /** The admin's page (public/referrals.html). */
  adminHtml(): string;
  log: Log;
  /** LIVE_DEV_SEED=1: a connect without the platform, for trying invites
   *  locally. Never with a database, whatever this says. */
  dev?: boolean;
}

/** A Solana transaction signature, as the admin pastes it. */
const TX_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const iso = (ms: number): string => new Date(ms).toISOString();

export function referralRouter(d: ReferralRouteDeps): Router {
  const r = express.Router();
  const secure = d.appBaseUrl.startsWith("https:");

  /** The invite: remember who sent it, then the page with every Add button. */
  r.get("/live/invite/:platform/:slug", async (req, res) => {
    res.set("Cache-Control", "no-store").set("X-Robots-Tag", "noindex, nofollow");
    const platform = req.params.platform as Platform;
    const ch = PLATFORMS.includes(platform) ? await channelBySlug(platform, req.params.slug).catch(() => null) : null;
    if (ch) res.append("Set-Cookie", referralCookie(referralCookieValue(ch.platform, ch.channelId), secure, d.cookieDomain ?? null));
    d.log("invite opened", { platform: String(req.params.platform).slice(0, 12), channel: ch?.slug ?? null });
    res.redirect(302, "/live");
  });

  /** The admin's page: what is owed to whom, and a payout recorded by hand. */
  r.get("/live/referrals", (_req, res) => {
    res.set("Cache-Control", "no-store").set("X-Robots-Tag", "noindex, nofollow").type("html").send(d.adminHtml());
  });

  r.get("/api/admin/referrals", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!d.adminOk(req)) return res.status(401).json({ error: "admin token required" });
    const ledger = await referralLedger().catch(() => null);
    if (!ledger) return res.status(503).json({ error: "unavailable" });
    const named = async (platform: Platform, channelId: string) => {
      const ch = await channelById(platform, channelId).catch(() => null);
      return { platform, channelId, slug: ch?.slug ?? null, name: ch?.name ?? null };
    };
    const referrers = await Promise.all(ledger.map(async (l) => ({
      referrer: `${l.platform}:${l.channelId}`, ...(await named(l.platform, l.channelId)),
      wallet: await personWallet(`${l.platform}:${l.channelId}`).catch(() => null),
      brought: l.referrals.length, earnedLamports: l.earnedLamports, paidLamports: l.paidLamports, owedLamports: l.owedLamports,
      referrals: await Promise.all(l.referrals.map(async (x) => ({
        ...(await named(x.platform, x.channelId)), at: iso(x.at), until: iso(x.until), shareBps: x.shareBps, days: x.days,
        earns: MONEY_PLATFORMS.has(x.platform), earnedLamports: x.earnedLamports,
        markets: x.markets.map((m) => ({ slug: m.slug, openedAt: iso(m.openedAt), protocolFeeLamports: m.protocolFeeLamports, counted: m.counted, shareLamports: m.shareLamports })),
      }))),
      payouts: l.payouts.map((p) => ({ id: p.id, lamports: p.lamports, wallet: p.wallet, tx: p.tx, note: p.note, at: iso(p.at) })),
    })));
    referrers.sort((a, b) => b.owedLamports - a.owedLamports || b.earnedLamports - a.earnedLamports || b.brought - a.brought);
    const sum = (k: "earnedLamports" | "paidLamports" | "owedLamports") => referrers.reduce((s, x) => s + x[k], 0);
    res.json({
      ok: true,
      terms: { shareBps: REFERRAL_SHARE_BPS, days: REFERRAL_DAYS, cookieDays: REFERRAL_COOKIE_DAYS, line: inviteTerms() },
      totals: { earnedLamports: sum("earnedLamports"), paidLamports: sum("paidLamports"), owedLamports: sum("owedLamports") },
      referrers,
    });
  });

  /**
   * A payout the admin already sent, recorded. Never a send: the SOL moved in
   * the admin's own wallet before this was called. Refused above what is
   * owed, so an extra zero is caught here rather than in the books, and a
   * transaction already recorded is refused by the table.
   */
  r.post("/api/admin/referrals/payout", express.json({ limit: "4kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!d.adminOk(req)) return res.status(401).json({ error: "admin token required" });
    const who = /^(kick|twitch|youtube|x):([A-Za-z0-9_-]{1,40})$/.exec(String(req.body?.referrer ?? ""));
    if (!who) return res.status(400).json({ error: "referrer" });
    const lamports = Number(req.body?.lamports);
    if (!Number.isSafeInteger(lamports) || lamports <= 0) return res.status(400).json({ error: "lamports" });
    const given = String(req.body?.wallet ?? "").trim();
    if (given && !WALLET_ADDRESS.test(given)) return res.status(400).json({ error: "wallet" });
    const tx = String(req.body?.tx ?? "").trim();
    if (tx && !TX_SIGNATURE.test(tx)) return res.status(400).json({ error: "tx" });
    const note = String(req.body?.note ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);
    const referrer = { platform: who[1] as Platform, channelId: who[2] };
    const [mine] = await referralLedger(referrer).catch(() => [] as ReferrerLedger[]);
    if (!mine) return res.status(503).json({ error: "unavailable" });
    if (lamports > mine.owedLamports) return res.status(409).json({ error: "more-than-owed", owedLamports: mine.owedLamports });
    const wallet = given || await personWallet(`${referrer.platform}:${referrer.channelId}`).catch(() => null);
    const p = await recordPayout({ referrerPlatform: referrer.platform, referrerId: referrer.channelId, lamports, wallet, tx: tx || null, note: note || null })
      .catch(() => undefined);
    if (p === undefined) return res.status(503).json({ error: "unavailable" });
    if (p === null) return res.status(409).json({ error: "tx-recorded" });
    d.log("referral payout recorded", { referrer: `${referrer.platform}:${referrer.channelId}`, lamports, tx: p.tx });
    res.json({ ok: true, payout: { ...p, at: iso(p.at) }, owedLamports: mine.owedLamports - lamports });
  });

  /* TRYING IT LOCALLY, with no Kick, Twitch, X or Google to sign in with.
     What a platform's callback does once the platform has said which channel
     this is (save it, credit the invite, leave the owner cookie), and a
     market opened in a channel's chat whose resolve fixed a fee. The memory
     store only: with a database these routes do not exist, flag or no flag,
     because an owner cookie for any channel is a key to where its 2% goes. */
  if (d.dev && !STORE_PERSISTENT) {
    r.get("/live/_dev/connect/:platform/:slug", async (req, res) => {
      const platform = req.params.platform as Platform;
      const slug = String(req.params.slug).replace(/[^A-Za-z0-9_]/g, "").slice(0, 30);
      if (!PLATFORMS.includes(platform) || !slug) return res.status(404).type("text").send("unknown platform or name");
      const channelId = `dev-${slug.toLowerCase()}`;
      const before = await channelById(platform, channelId);
      await saveChannel({ platform, channelId, slug, name: slug, avatar: null, accessToken: null, refreshToken: null, tokenExpiresAt: null, active: true });
      await creditInvite(req.headers.cookie, { platform, channelId, slug }, before === null, d.log);
      const key = ownerKeyFromEnv(platform);
      if (key) res.append("Set-Cookie", ownerCookie(ownerToken(channelId, key), secure, undefined, platform));
      res.redirect(302, `/live/${platform}/${encodeURIComponent(slug)}`);
    });
    r.get("/live/_dev/market/:platform/:slug", async (req, res) => {
      const platform = req.params.platform as Platform;
      const ch = PLATFORMS.includes(platform) ? await channelBySlug(platform, req.params.slug) : null;
      if (!ch) return res.status(404).type("text").send("connect it first: /live/_dev/connect/<platform>/<name>");
      // Oddie's 2% of a 1 SOL pool unless ?fee= says otherwise, in lamports.
      const fee = Math.max(0, Math.floor(Number(req.query.fee ?? 20_000_000) || 0));
      const market = `dev-market-${Date.now().toString(36)}`;
      const key = `${platform}:${ch.channelId}:${market}`;
      await claimMention(key, "dev");
      await settleMention(key, "replied", { slug: market, reason: "opened" });
      await logRealFee(market, fee * 50, 200, { creator: fee, protocol: fee });
      d.log("dev market opened and resolved", { platform, channel: ch.slug, market, protocolFee: fee });
      res.redirect(302, `/live/${platform}/${encodeURIComponent(ch.slug)}`);
    });
  }

  return r;
}
