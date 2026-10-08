/**
 * oddie on Twitch: the door a streamer walks through once, the webhook their
 * chat arrives on, and how a line gets back into it. The page, the standings
 * and the streamer's 2% are the same routes Kick uses (src/live/channelRoutes);
 * the rules are the engine's (src/live/calls.ts, src/live/claims.ts).
 */
import express, { type Router } from "express";
import { randomBytes } from "node:crypto";
import {
  appToken, authorizeUrl, chatFromTwitch, eventSubSecret, exchangeCode, me, pinChat, pinnedChat, refreshTokens, sendChat, unpinChat,
  subscribeToChat, twitchConfigured, verifyTwitchSignature, WEBHOOK_MAX_AGE_MS, type TwitchTokens,
} from "./client.js";
import { handleChat, LIVE_COPY, type LiveDeps, type Platform } from "../live/calls.js";
import { openFromChat, type ChatMarketDeps } from "../live/claims.js";
import { addChannelRoutes, type ChannelPageDeps } from "../live/channelRoutes.js";
import { ownerCookie, ownerKeyFromEnv, ownerToken } from "../live/owner.js";
import { twitchChatSource } from "../store/markets.js";
import { channelById, channelBySlug, liveStore, saveChannel, type LiveChannel } from "../store/live.js";

export interface TwitchRouteDeps extends ChannelPageDeps {
  appBaseUrl: string;
  /** The market door's machinery, from the server (the same as Kick's). */
  markets?: Omit<ChatMarketDeps, "say" | "sourceFor">;
  /** Test seams. */
  signIn?: TwitchSignIn;
  chat?: TwitchChat;
  engine?: LiveDeps;
  secret?: () => string | null;
  /** The channel whose account speaks for oddie in every chat (its login).
   *  Default TWITCH_VOICE_CHANNEL, else "oddiefun"; "" turns it off. */
  voice?: string;
}

/** Twitch's side of a streamer signing in. */
export interface TwitchSignIn {
  exchangeCode(code: string, redirectUri: string): Promise<TwitchTokens>;
  me(token: string): Promise<{ userId: string; login: string; name: string; avatar: string | null }>;
  subscribe(broadcasterUserId: string, callback: string, secret: string): Promise<{ added: boolean }>;
}
const twitchSignIn: TwitchSignIn = {
  exchangeCode, me,
  subscribe: async (id, callback, secret) => subscribeToChat(await appToken(), id, callback, secret),
};

/** How a line reaches a Twitch chat, and how a call's line is pinned there. */
export interface TwitchChat {
  send(token: string, broadcasterId: string, senderId: string, text: string, replyTo?: string): Promise<string | null | void>;
  pinned?(token: string, broadcasterId: string, moderatorId: string): Promise<string | null>;
  pin?(token: string, broadcasterId: string, moderatorId: string, messageId: string): Promise<void>;
  unpin?(token: string, broadcasterId: string, moderatorId: string, messageId: string): Promise<void>;
}
const twitchChat: TwitchChat = { send: sendChat, pinned: pinnedChat, pin: pinChat, unpin: unpinChat };

const pending = new Map<string, number>();
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

/**
 * ONE VOICE IN EVERY CHAT, as on Kick: a line goes out from oddie's own
 * account (the voice channel, once it has signed in like any streamer) so it
 * never reads as the streamer typing. Where that is refused (a ban,
 * followers-only, AutoMod) the streamer's own account says it, and the voice
 * is tried again ten minutes on.
 */
const voiceCannotPost = new Map<string, number>();
const VOICE_RETRY_MS = 10 * 60_000;

/**
 * PINS. A call's line is pinned with the streamer's own token (they are a
 * moderator of their own chat), never over a pin the channel made itself: only
 * into an empty spot or over oddie's own last one. A channel that signed in
 * before pins were asked for is refused; it is not asked again for six hours,
 * and its calls still get the reminder.
 */
const pinnedByUs = new Map<string, string>();
/** Lines oddie sent, by id: one that comes back through the chat feed is oddie's own. */
const sentByUs = new Set<string>();
const SENT_MAX = 2_000;
function remember(id: string | null): string | null {
  if (!id) return id;
  sentByUs.add(id);
  if (sentByUs.size > SENT_MAX) for (const k of [...sentByUs].slice(0, SENT_MAX / 2)) sentByUs.delete(k);
  return id;
}
const pinRefused = new Map<string, number>();
const PIN_RETRY_MS = 6 * 60 * 60_000;

export function twitchEngineDeps(d: Pick<TwitchRouteDeps, "appBaseUrl" | "log" | "markets" | "voice">, chat: TwitchChat = twitchChat): LiveDeps {
  const base = d.appBaseUrl.replace(/\/+$/, "");
  const voiceLogin = (d.voice ?? process.env.TWITCH_VOICE_CHANNEL ?? "oddiefun").trim().toLowerCase();
  const status = (e: unknown) => (e as { status?: number }).status;
  /** Act with `from`'s token, refreshing it once on a 401. */
  const withToken = async <T>(from: LiveChannel, f: (token: string) => Promise<T>): Promise<T> => {
    try { return await f(await tokenFor(from)); }
    catch (e) {
      if (status(e) !== 401) throw e;
      return f(await tokenFor(from, true));
    }
  };
  /** Say it as `from`: the line's id, when Twitch gives one. */
  const as = async (from: LiveChannel, channelId: string, text: string, replyTo?: string): Promise<string | null> =>
    remember((await withToken(from, (t) => chat.send(t, channelId, from.channelId, text, replyTo))) || null);
  const sayAsVoice = async (channelId: string, text: string, replyTo?: string): Promise<{ said: boolean; id: string | null }> => {
    const no = { said: false, id: null };
    if (!voiceLogin) return no;
    const failedAt = voiceCannotPost.get(channelId);
    if (failedAt !== undefined && Date.now() - failedAt < VOICE_RETRY_MS) return no;
    const voice = await channelBySlug("twitch", voiceLogin).catch(() => null);
    if (!voice?.active || !voice.accessToken || voice.channelId === channelId) return no;
    try { const id = await as(voice, channelId, text, replyTo); voiceCannotPost.delete(channelId); return { said: true, id }; }
    catch (e) {
      voiceCannotPost.set(channelId, Date.now());
      // The message carries Twitch's drop reason (followers-only, a verified
      // email the channel requires, a ban), which is the one thing worth knowing.
      d.log("twitch voice cannot post here, sending as the channel's account", { channel: channelId, voice: voiceLogin, status: status(e) ?? null, err: (e as Error).message.slice(0, 200) });
      return no;
    }
  };
  const say = async (_p: Platform, channelId: string, text: string, replyTo?: string): Promise<string | void> => {
    const ch = await channelById("twitch", channelId);
    if (!ch?.active) return;
    const voice = await sayAsVoice(channelId, text, replyTo);
    if (voice.said) return voice.id ?? undefined;
    return (await as(ch, channelId, text, replyTo)) ?? undefined;
  };
  const pin = async (_p: Platform, channelId: string, messageId: string): Promise<void> => {
    if (!chat.pin) return;
    const refusedAt = pinRefused.get(channelId);
    if (refusedAt !== undefined && Date.now() - refusedAt < PIN_RETRY_MS) return;
    const ch = await channelById("twitch", channelId);
    if (!ch?.active || !ch.accessToken) return;
    try {
      const there = chat.pinned ? await withToken(ch, (t) => chat.pinned!(t, channelId, channelId)) : null;
      if (there && there !== pinnedByUs.get(channelId)) {
        d.log("twitch pin skipped, the channel has its own pin", { channel: channelId });
        return;
      }
      await withToken(ch, (t) => chat.pin!(t, channelId, channelId, messageId));
      pinnedByUs.set(channelId, messageId);
    } catch (e) {
      if (status(e) === 401 || status(e) === 403) {
        pinRefused.set(channelId, Date.now());
        d.log("twitch pin refused, the channel signs in again to allow it", { channel: channelId, status: status(e) ?? null, err: (e as Error).message.slice(0, 200) });
        return;
      }
      throw e;
    }
  };
  const unpin = async (_p: Platform, channelId: string): Promise<void> => {
    const id = pinnedByUs.get(channelId);
    if (!id || !chat.unpin) return;
    pinnedByUs.delete(channelId);
    const ch = await channelById("twitch", channelId);
    if (!ch?.active || !ch.accessToken) return;
    // A pin that already ran out is fine: the line is down either way.
    await withToken(ch, (t) => chat.unpin!(t, channelId, channelId, id)).catch(() => {});
  };
  const markets = d.markets;
  return {
    store: liveStore,
    now: () => Date.now(),
    say,
    pin,
    unpin,
    market: markets ? (msg, claim) => openFromChat(msg, claim, {
      ...markets,
      sourceFor: (m) => twitchChatSource(m.channelSlug || m.channelId, m.messageId),
      say: async (m, text) => { await say("twitch", m.channelId, text, m.messageId); },
    }) : undefined,
    standingsUrl: async (_p, channelId) => {
      const ch = await channelById("twitch", channelId).catch(() => null);
      return `${base}/live/twitch/${encodeURIComponent(ch?.slug ?? channelId)}`;
    },
    log: d.log,
  };
}

export function twitchRouter(d: TwitchRouteDeps): Router {
  const r = express.Router();
  const base = d.appBaseUrl.replace(/\/+$/, "");
  const redirectUri = `${base}/live/twitch/callback`;
  const voiceLogin = (d.voice ?? process.env.TWITCH_VOICE_CHANNEL ?? "oddiefun").trim().toLowerCase();
  const callback = `${base}/live/twitch/webhook`;
  const engine = d.engine ?? twitchEngineDeps(d, d.chat);
  const tw = d.signIn ?? twitchSignIn;
  const secretOf = d.secret ?? eventSubSecret;
  const secure = base.startsWith("https:");

  /** A streamer adds oddie to their channel. */
  r.get("/live/twitch/connect", (_req, res) => {
    if (!d.signIn && !twitchConfigured()) return res.status(503).type("text").send("oddie for Twitch is almost here.");
    for (const [k, at] of pending) if (Date.now() - at > 10 * 60_000) pending.delete(k);
    const state = randomBytes(16).toString("hex");
    pending.set(state, Date.now());
    res.redirect(authorizeUrl({ state, redirectUri }));
  });

  r.get("/live/twitch/callback", async (req, res) => {
    const state = String(req.query.state ?? "");
    const code = String(req.query.code ?? "");
    const at = pending.get(state);
    pending.delete(state);
    // Declining on Twitch's screen comes back with ?error=access_denied.
    if (at === undefined || !code || Date.now() - at > 10 * 60_000) return res.redirect(`${base}/live?twitch=${req.query.error ? "declined" : "expired"}`);
    try {
      const t = await tw.exchangeCode(code, redirectUri);
      const who = await tw.me(t.accessToken);
      const before = await channelById("twitch", who.userId).catch(() => null);
      const ch: LiveChannel = {
        platform: "twitch", channelId: who.userId, slug: who.login, name: who.name, avatar: who.avatar,
        accessToken: t.accessToken, refreshToken: t.refreshToken, tokenExpiresAt: t.expiresAt, active: true,
      };
      await saveChannel(ch);
      const secret = secretOf();
      if (secret) {
        await tw.subscribe(ch.channelId, callback, secret)
          .catch((e) => d.log("twitch subscribe failed", { channel: ch.slug, err: (e as Error).message }));
      }
      // Hello once. Signing in again to manage the 2% is not a second arrival.
      const fresh = !before?.active;
      if (fresh) {
        await engine.say("twitch", ch.channelId, LIVE_COPY.hello)
          .catch((e) => d.log("twitch hello not delivered", { channel: ch.slug, err: (e as Error).message }));
      }
      const key = ownerKeyFromEnv("twitch");
      if (key) res.append("Set-Cookie", ownerCookie(ownerToken(ch.channelId, key), secure, undefined, "twitch"));
      d.log(fresh ? "twitch channel connected" : "twitch channel signed in", { channel: ch.slug });
      res.redirect(`${base}/live/twitch/${encodeURIComponent(ch.slug)}${fresh ? "?connected=1" : ""}`);
    } catch (e) {
      d.log("twitch connect failed", { err: (e as Error).message });
      res.redirect(`${base}/live?twitch=failed`);
    }
  });

  /**
   * THE WEBHOOK. Raw body: the signature is over the exact bytes. Answered at
   * once, because Twitch revokes a subscription whose webhook is slow or keeps
   * failing, and the work that follows must never be the reason.
   */
  r.post("/live/twitch/webhook", express.raw({ type: "*/*", limit: "256kb" }), async (req, res) => {
    const id = String(req.header("Twitch-Eventsub-Message-Id") ?? "");
    const ts = String(req.header("Twitch-Eventsub-Message-Timestamp") ?? "");
    const sig = String(req.header("Twitch-Eventsub-Message-Signature") ?? "");
    const type = String(req.header("Twitch-Eventsub-Message-Type") ?? "");
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const secret = secretOf();
    const age = Date.now() - Date.parse(ts);
    if (!id || !sig || !secret || !(age >= -60_000 && age <= WEBHOOK_MAX_AGE_MS) || !verifyTwitchSignature(secret, id, ts, raw, sig)) {
      return res.status(403).end();
    }
    let body: { challenge?: string; subscription?: { status?: string; condition?: { broadcaster_user_id?: string } }; event?: unknown } = {};
    try { body = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).end(); }
    if (type === "webhook_callback_verification") {
      const challenge = String(body.challenge ?? "");
      return res.status(200).type("text/plain").set("Content-Length", String(Buffer.byteLength(challenge))).send(challenge);
    }
    res.status(204).end();
    if (type === "revocation") {
      // The streamer took oddie off, or Twitch gave up on us. Either way this
      // chat is no longer ours to answer.
      const chId = String(body.subscription?.condition?.broadcaster_user_id ?? "");
      const ch = chId ? await channelById("twitch", chId).catch(() => null) : null;
      if (ch) await saveChannel({ ...ch, active: false }).catch(() => {});
      d.log("twitch subscription revoked", { channel: chId, status: body.subscription?.status ?? null });
      return;
    }
    if (type !== "notification") return;
    // Twitch may deliver twice; a message is handled once.
    if (seen.has(id)) return;
    seen.set(id, Date.now());
    if (seen.size > SEEN_MAX) for (const k of [...seen.keys()].slice(0, SEEN_MAX / 2)) seen.delete(k);
    const msg = chatFromTwitch(body.event);
    if (!msg) return;
    // oddie's own lines come back too: from its account, or a line it sent as
    // the channel when its account could not post.
    if (msg.senderName.toLowerCase() === voiceLogin || sentByUs.has(msg.messageId)) msg.fromOddie = true;
    const action = await handleChat(msg, engine).catch((e) => { d.log("twitch chat failed", { err: (e as Error).message }); return "error"; });
    // What a command did, never what anybody wrote: ordinary chat is not logged.
    if (action !== "chat" && action !== "own") d.log("twitch chat command", { channel: msg.channelId, action, runner: msg.canRun });
  });

  /** The channel's page, its standings, and the streamer's 2%: shared with Kick. */
  addChannelRoutes(r, "twitch", d);
  return r;
}
