/**
 * oddie on Kick: the door a streamer walks through once, the webhook their
 * chat arrives on, the page their standings and markets live on, the wallet
 * their 2% goes to, and the clock that locks a call when its time is up. The
 * rules are in src/live/calls.ts and src/live/claims.ts; this file only
 * connects them to Kick.
 */
import express, { type Request, type Response, type Router } from "express";
import { randomBytes } from "node:crypto";
import {
  authorizeUrl, chatFromKick, exchangeCode, kickConfigured, kickPublicKey, me, myChannel, pkcePair,
  refreshTokens, sendChat, sendChatAsUser, subscribeToChannel, verifyKickSignature, WEBHOOK_MAX_AGE_MS, type KickTokens, kickStreamIsLive,
} from "./client.js";
import { handleChat, LIVE_COPY, lockDue, type LiveDeps, type Platform } from "../live/calls.js";
import { addChannelRoutes, type ChannelPayoutDeps } from "../live/channelRoutes.js";
import { notNow, paced, patiently } from "../live/pace.js";
import { openFromChat, type ChatMarketDeps } from "../live/claims.js";
import { ownerCookie, ownerKeyFromEnv, ownerToken } from "../live/owner.js";
import { kickChatSource, type ChannelMarket } from "../store/markets.js";
import { channelById, channelBySlug, liveStore, saveChannel, type LiveChannel } from "../store/live.js";

export interface KickRouteDeps {
  /** Where the app lives: the standings links and the OAuth redirect. */
  appBaseUrl: string;
  /** The page, already stamped for this deploy. */
  pageHtml(): string;
  /** The app's own gate, for the page. */
  pageOpen(req: Request): boolean;
  pageClosed(res: Response): void;
  log(line: string, extra?: Record<string, unknown>): void;
  /** Test seams: Kick's key, and the engine's hands. */
  publicKey?(): Promise<string>;
  engine?: LiveDeps;
  /** The market door's machinery, from the server (the same as X and Telegram). */
  markets?: Omit<ChatMarketDeps, "say" | "sourceFor">;
  /** Markets opened in a channel's chat, newest first, for its page. */
  channelMarkets?(channelId: string, limit: number): Promise<ChannelMarket[]>;
  /** Where a channel's 2% goes. Absent, the page never offers it. */
  payout?: KickPayoutDeps;
  /** Test seam: Kick's side of the sign-in. */
  signIn?: KickSignIn;
  /** The channel whose account speaks for oddie in every chat (its slug).
   *  Default KICK_VOICE_CHANNEL, else "oddiefun"; "" turns it off. */
  voice?: string;
}

/** A channel's 2% (src/live/channelRoutes.ts): the channel is the person kick:<id>. */
export type KickPayoutDeps = ChannelPayoutDeps;

/** Kick's side of a streamer signing in. A seam for the tests. */
export interface KickSignIn {
  exchangeCode(code: string, verifier: string, redirectUri: string): Promise<KickTokens>;
  me(token: string): Promise<{ userId: string; name: string; avatar: string | null }>;
  myChannel(token: string): Promise<{ slug: string }>;
  subscribe(token: string, broadcasterUserId: string): Promise<{ added: string[] }>;
}
const kickSignIn: KickSignIn = { exchangeCode, me, myChannel, subscribe: subscribeToChannel };

const pending = new Map<string, { verifier: string; at: number }>();
const seen = new Map<string, number>();
const SEEN_MAX = 5_000;

/** A token that works: refreshed a minute before it would not, or on demand. */
async function tokenFor(ch: LiveChannel, force = false): Promise<string> {
  if (!ch.accessToken) throw new Error("channel not connected");
  const stale = ch.tokenExpiresAt !== null && ch.tokenExpiresAt - Date.now() < 60_000;
  if ((force || stale) && ch.refreshToken) {
    const t = await refreshTokens(ch.refreshToken);
    await saveChannel({ ...ch, accessToken: t.accessToken, refreshToken: t.refreshToken ?? ch.refreshToken, tokenExpiresAt: t.expiresAt });
    return t.accessToken;
  }
  return ch.accessToken;
}

/** How a line reaches a Kick chat. A seam for the tests. */
export interface KickChat {
  bot(token: string, text: string, replyTo?: string): Promise<void>;
  user(token: string, channelId: string, text: string, replyTo?: string): Promise<void>;
}
const kickChat: KickChat = { bot: sendChat, user: sendChatAsUser };

/**
 * A NEW APP'S BOT CANNOT POST YET. Found on the first live test (29 Sep):
 * every bot line from the freshly made oddie app came back 404 "Not found",
 * and other developers report the same for new apps with no answer from
 * Kick. So a line goes out as the bot first and, on 404 or 400, as the
 * account that authorized us, which is what the chat:write scope grants.
 * A channel where the bot has failed once skips straight to that.
 */
const botCannotPost = new Set<string>();

/**
 * ONE VOICE IN EVERY CHAT. Speaking as the channel's own account meant that
 * in a stream oddie's answer arrived under the streamer's name: "oddiefun:
 * Market open..." in oddiefun's chat reads as the streamer typing it. So a
 * line goes out from oddie's own account (the voice channel, which authorized
 * us with chat:write like any other) into the channel it answers, the way any
 * viewer's line does. Where that is refused (followers-only chat, a ban), the
 * channel's own path takes over and the voice is tried again ten minutes on.
 * "Too quickly" is no refusal: the lines to a chat go out a second apart and a
 * 429 is waited out (src/live/pace.ts).
 */
const voiceCannotPost = new Map<string, number>();
const VOICE_RETRY_MS = 10 * 60_000;
const voiceSlugFrom = (d: { voice?: string }): string =>
  (d.voice ?? process.env.KICK_VOICE_CHANNEL ?? "oddiefun").trim().toLowerCase();

export function kickEngineDeps(d: Pick<KickRouteDeps, "appBaseUrl" | "log" | "markets" | "voice">, chat: KickChat = kickChat): LiveDeps {
  const base = d.appBaseUrl.replace(/\/+$/, "");
  const deliver = async (token: string, channelId: string, text: string, replyTo?: string) => {
    if (!botCannotPost.has(channelId)) {
      try { await chat.bot(token, text, replyTo); return; }
      catch (e) {
        const st = (e as { status?: number }).status;
        if (st !== 404 && st !== 400) throw e;
        botCannotPost.add(channelId);
        d.log("kick bot cannot post here, sending as the channel's account", { channel: channelId, status: st });
      }
    }
    await chat.user(token, channelId, text, replyTo);
  };
  const voiceSlug = voiceSlugFrom(d);
  /** True when oddie's own account said it. False hands the line on. */
  const sayAsVoice = async (channelId: string, text: string, replyTo?: string): Promise<boolean> => {
    if (!voiceSlug) return false;
    const failedAt = voiceCannotPost.get(channelId);
    if (failedAt !== undefined && Date.now() - failedAt < VOICE_RETRY_MS) return false;
    const voice = await channelBySlug("kick", voiceSlug).catch(() => null);
    // In its own chat the voice is the channel, and the channel's path is it.
    if (!voice?.active || !voice.accessToken || voice.channelId === channelId) return false;
    const send = async (force: boolean, reply?: string) => chat.user(await tokenFor(voice, force), channelId, text, reply);
    const st = (e: unknown) => (e as { status?: number }).status;
    try {
      try { await patiently(() => send(false, replyTo)); }
      catch (e) {
        if (st(e) === 401) await patiently(() => send(true, replyTo));
        // A reply may not reach across channels; the line itself still can.
        else if (replyTo && (st(e) === 400 || st(e) === 422)) await patiently(() => send(false));
        else throw e;
      }
      voiceCannotPost.delete(channelId);
      return true;
    } catch (e) {
      if (notNow(st(e))) {
        d.log("kick voice slowed down, this line goes as the channel's account", { channel: channelId, voice: voiceSlug, status: st(e) ?? null });
        return false;
      }
      voiceCannotPost.set(channelId, Date.now());
      d.log("kick voice cannot post here, sending as the channel's account", { channel: channelId, voice: voiceSlug, status: st(e) ?? null });
      return false;
    }
  };
  const say = (_p: Platform, channelId: string, text: string, replyTo?: string): Promise<void> => paced(`kick:${channelId}`, async () => {
    const ch = await channelById("kick", channelId);
    if (!ch?.active) return;
    if (await sayAsVoice(channelId, text, replyTo)) return;
    try { await deliver(await tokenFor(ch), channelId, text, replyTo); }
    catch (e) {
      // An expired token says 401: refresh once and say it again.
      if ((e as { status?: number }).status !== 401) throw e;
      await deliver(await tokenFor(ch, true), channelId, text, replyTo);
    }
  });
  const markets = d.markets;
  return {
    store: liveStore,
    now: () => Date.now(),
    say,
    // Is the channel live? The clock asks for channels with calls waiting, so a
    // stream's end can settle or cancel the moments only the room saw.
    streamLive: async (_p, channelId) => (kickConfigured() ? kickStreamIsLive(channelId) : null),
    market: markets ? (msg, claim) => openFromChat(msg, claim, {
      ...markets,
      sourceFor: (m) => kickChatSource(m.channelSlug || m.channelId, m.messageId),
      say: (m, text) => say("kick", m.channelId, text, m.messageId),
    }) : undefined,
    standingsUrl: async (_p, channelId) => {
      const ch = await channelById("kick", channelId).catch(() => null);
      return `${base}/live/kick/${encodeURIComponent(ch?.slug ?? channelId)}`;
    },
    log: d.log,
  };
}

export function kickRouter(d: KickRouteDeps): Router {
  const r = express.Router();
  const base = d.appBaseUrl.replace(/\/+$/, "");
  const redirectUri = `${base}/live/kick/callback`;
  const engine = d.engine ?? kickEngineDeps(d);
  const publicKey = d.publicKey ?? kickPublicKey;
  const kick = d.signIn ?? kickSignIn;
  const secure = base.startsWith("https:");

  /** A streamer adds oddie to their channel. */
  r.get("/live/kick/connect", (_req, res) => {
    if (!kickConfigured()) return res.status(503).type("text").send("oddie for Kick is almost here.");
    for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60_000) pending.delete(k);
    const state = randomBytes(16).toString("hex");
    const { verifier, challenge } = pkcePair();
    pending.set(state, { verifier, at: Date.now() });
    res.redirect(authorizeUrl({ state, challenge, redirectUri }));
  });

  r.get("/live/kick/callback", async (req, res) => {
    const state = String(req.query.state ?? "");
    const code = String(req.query.code ?? "");
    const p = pending.get(state);
    pending.delete(state);
    if (!p || !code || Date.now() - p.at > 10 * 60_000) return res.redirect(`${base}/live?kick=expired`);
    try {
      const t = await kick.exchangeCode(code, p.verifier, redirectUri);
      const [who, chan] = await Promise.all([kick.me(t.accessToken), kick.myChannel(t.accessToken)]);
      const before = await channelById("kick", who.userId).catch(() => null);
      const ch: LiveChannel = {
        platform: "kick", channelId: who.userId, slug: chan.slug, name: who.name, avatar: who.avatar,
        accessToken: t.accessToken, refreshToken: t.refreshToken, tokenExpiresAt: t.expiresAt, active: true,
      };
      await saveChannel(ch);
      await kick.subscribe(t.accessToken, ch.channelId).catch((e) => d.log("kick subscribe failed", { channel: ch.slug, err: (e as Error).message }));
      // Hello once. Signing in again to manage the 2% is not a second arrival.
      const fresh = !before?.active;
      if (fresh) {
        await engine.say("kick", ch.channelId, LIVE_COPY.hello)
          .catch((e) => d.log("kick hello not delivered", { channel: ch.slug, err: (e as Error).message }));
      }
      // Kick has just said which channel this browser is: the one proof the
      // wallet routes accept, carried where no stream can show it.
      const key = ownerKeyFromEnv();
      if (key) res.append("Set-Cookie", ownerCookie(ownerToken(ch.channelId, key), secure));
      d.log(fresh ? "kick channel connected" : "kick channel signed in", { channel: ch.slug });
      res.redirect(`${base}/live/kick/${encodeURIComponent(ch.slug)}${fresh ? "?connected=1" : ""}`);
    } catch (e) {
      d.log("kick connect failed", { err: (e as Error).message });
      res.redirect(`${base}/live?kick=failed`);
    }
  });

  /**
   * THE WEBHOOK. Raw body, because the signature is over the exact bytes.
   * Answered at once: Kick drops a subscription whose webhook keeps failing,
   * and the work that follows must never be the reason it does.
   */
  r.post("/live/kick/webhook", express.raw({ type: "*/*", limit: "256kb" }), async (req, res) => {
    const id = String(req.header("Kick-Event-Message-Id") ?? "");
    const ts = String(req.header("Kick-Event-Message-Timestamp") ?? "");
    const sig = String(req.header("Kick-Event-Signature") ?? "");
    const type = String(req.header("Kick-Event-Type") ?? "");
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const age = Date.now() - Date.parse(ts);
    const key = await publicKey().catch(() => null);
    if (!id || !sig || !key || !(age >= -60_000 && age <= WEBHOOK_MAX_AGE_MS) || !verifyKickSignature(key, id, ts, raw, sig)) {
      return res.status(401).end();
    }
    res.status(200).end();
    // Kick may deliver twice; a message is handled once.
    if (seen.has(id)) return;
    seen.set(id, Date.now());
    if (seen.size > SEEN_MAX) for (const k of [...seen.keys()].slice(0, SEEN_MAX / 2)) seen.delete(k);
    if (type !== "chat.message.sent") return;
    let body: unknown = null;
    try { body = JSON.parse(raw.toString("utf8")); } catch { return; }
    const msg = chatFromKick(body);
    if (!msg) return;
    // oddie's own lines come back through the feed too; they are never commands.
    if (msg.senderName.toLowerCase() === voiceSlugFrom(d)) msg.fromOddie = true;
    const action = await handleChat(msg, engine).catch((e) => { d.log("kick chat failed", { err: (e as Error).message }); return "error"; });
    // What a command did, never what anybody wrote: ordinary chat is not logged.
    if (action !== "chat" && action !== "own") d.log("kick chat command", { channel: msg.channelId, action, runner: msg.canRun });
  });

  /** The channel's page, its standings, and the streamer's 2%: shared with Twitch. */
  addChannelRoutes(r, "kick", d);

  return r;
}

/** The clock: every few seconds, calls whose time is up are locked and said. */
export function startLiveClock(d: Pick<KickRouteDeps, "appBaseUrl" | "log" | "markets" | "voice">, everyMs = 5_000): NodeJS.Timeout {
  const engine = kickEngineDeps(d);
  return setInterval(() => { void lockDue(engine).catch((e) => d.log("live clock failed", { err: (e as Error).message })); }, everyMs);
}
