/**
 * oddie on Twitch: the door a streamer walks through once, the webhook their
 * chat arrives on, and how a line gets back into it. The page, the standings
 * and the streamer's 2% are the same routes Kick uses (src/live/channelRoutes);
 * the rules are the engine's (src/live/calls.ts, src/live/claims.ts).
 */
import express, { type Router } from "express";
import { randomBytes } from "node:crypto";
import {
  appToken, authorizeUrl, chatFromTwitch, createPrediction, endPrediction, eventSubSecret, exchangeCode, me, pinChat, pinnedChat, refreshTokens, sendChat, streamInfo, streamIsLive, unpinChat,
  subscribeToChat, twitchConfigured, verifyTwitchSignature, WEBHOOK_MAX_AGE_MS, type TwitchTokens,
} from "./client.js";
import { handleChat, LIVE_COPY, type LiveCall, type LiveDeps, type Platform, type Side } from "../live/calls.js";
import { openFromChat, type ChatMarketDeps } from "../live/claims.js";
import { addChannelRoutes, type ChannelPageDeps } from "../live/channelRoutes.js";
import { notNow, paced, patiently } from "../live/pace.js";
import { counted } from "../live/lookups.js";
import { reportAlert } from "../live/openedMail.js";
import { ownerCookie, ownerKeyFromEnv, ownerToken } from "../live/owner.js";
import { creditInvite } from "../live/referrals.js";
import { botStateGet, botStateSet, twitchChatSource } from "../store/markets.js";
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
  /** The channel's own Predictions panel (src/twitch/client.ts). */
  predict?(token: string, broadcasterId: string, title: string, window: number): Promise<{ id: string; yes: string; no: string }>;
  endPredict?(token: string, broadcasterId: string, id: string, status: "RESOLVED" | "CANCELED", winningOutcomeId?: string): Promise<void>;
}
const twitchChat: TwitchChat = { send: sendChat, pinned: pinnedChat, pin: pinChat, unpin: unpinChat, predict: createPrediction, endPredict: endPrediction };

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
 * ONE VOICE IN EVERY CHAT, AND NEVER THE STREAMER'S, as on Kick (Lev, 25 Nov):
 * a line goes out from oddie's own account (the voice channel, once it has
 * signed in like any streamer). Where Twitch refuses it (a ban, followers-only,
 * a verified email the chat wants, AutoMod, a slow moment) the line used to go
 * out from the streamer's own account; now it is not said: the call still runs
 * and the answers still count, the log says why, and the operator gets a mail
 * with what fixes it, once a chat every six hours. The voice is tried again in
 * a chat ten minutes after it was refused there. A sign-in that no longer
 * works is told apart from a chat that will not take the voice: the voice
 * rests everywhere for ten minutes and the operator gets one mail every six
 * hours. "Too quickly" is no refusal: the lines to a chat go out a second
 * apart and a 429 is waited out (src/live/pace.ts).
 */
const voiceCannotPost = new Map<string, number>();
const VOICE_RETRY_MS = 10 * 60_000;
const VOICE_ALERT_GAP_MS = 6 * 60 * 60_000;
let voiceSignedOutAt: number | null = null;
let voiceAlertAt = 0;
/** The last mail about a chat that refused the voice, by channel; and about a voice not connected. */
const chatAlertAt = new Map<string, number>();
let voiceMissingAlertAt = 0;
/** Test seam: forget the chats that refused the voice, a lost sign-in, and the mails about them. */
export function _resetTwitchVoice(): void {
  voiceCannotPost.clear(); voiceSignedOutAt = null; voiceAlertAt = 0; chatAlertAt.clear(); voiceMissingAlertAt = 0;
}
/** What oddie's own account did with a line, and why not when it did not (as on Kick). */
interface VoiceTry {
  said: boolean;
  id: string | null;
  why?: "off" | "missing" | "resting" | "signed-out" | "slow" | "refused";
  err?: string;
}

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

/**
 * TWITCH'S OWN PREDICTIONS (Lev, 4 Nov). Twitch streamers already run
 * Predictions, where every viewer picks with a tap and channel points; asking
 * their chat to type !yes is a step back. So a call opened in a Twitch chat
 * opens there too, and oddie resolves it with the call's result, from the
 * screen like any call, or cancels it with the call. It needs
 * channel:manage:predictions: a channel that signed in before it was asked is
 * refused, is not asked again for six hours, and keeps its chat votes. Twitch
 * titles stop at 45 characters, so a longer question runs in chat only.
 */
export const PREDICTION_TITLE_MAX = 45;
/** A call with no length: five minutes to predict, the way streamers set their own. Chat answers stay open into the game. */
export const PREDICTION_WINDOW_S = 5 * 60;
const predictRefused = new Map<string, number>();
const predictionKey = (callId: string) => `twitch_prediction:${callId}`;
/** Test seam. */
export function _resetPredictions(): void { predictRefused.clear(); }

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
  /**
   * Say it as `from`: the line's id, when Twitch gives one. A REPLY TWITCH WILL
   * NOT TAKE goes once more as a line of its own. Live on 1 Nov: a result, said
   * as a reply to the line that opened its market, came back 400 "Message
   * cannot be replied to" from oddie's account, which was benched for ten
   * minutes over it, and again from the channel's; neither of that night's two
   * results reached the chat. A result names its market, so it reads the same
   * without the thread. Only a 400: a ban or a drop refuses the account, not
   * the reply.
   */
  const as = async (from: LiveChannel, channelId: string, text: string, replyTo?: string): Promise<string | null> =>
    remember((await withToken(from, async (t) => {
      try { return await chat.send(t, channelId, from.channelId, text, replyTo); }
      catch (e) {
        if (!replyTo || status(e) !== 400) throw e;
        d.log("twitch reply refused, the line goes on its own", { channel: channelId, sender: from.slug, err: (e as Error).message.slice(0, 200) });
        return chat.send(t, channelId, from.channelId, text);
      }
    })) || null);
  /** oddie's own account says it in a streamer's chat, or says why it did not. */
  const sayAsVoice = async (channelId: string, text: string, replyTo?: string): Promise<VoiceTry> => {
    if (!voiceLogin) return { said: false, id: null, why: "off" };
    if (voiceSignedOutAt !== null && Date.now() - voiceSignedOutAt < VOICE_RETRY_MS) return { said: false, id: null, why: "signed-out" };
    const failedAt = voiceCannotPost.get(channelId);
    if (failedAt !== undefined && Date.now() - failedAt < VOICE_RETRY_MS) return { said: false, id: null, why: "resting" };
    // A store that does not answer is an outage, said as one, never a voice that is not there.
    const voice = await channelBySlug("twitch", voiceLogin);
    if (!voice?.active || !voice.accessToken) return { said: false, id: null, why: "missing" };
    try {
      const id = await patiently(() => as(voice, channelId, text, replyTo));
      voiceCannotPost.delete(channelId); voiceSignedOutAt = null;
      return { said: true, id };
    } catch (e) {
      // The message carries Twitch's drop reason (followers-only, a verified
      // email the channel requires, a ban), which is the one thing worth knowing.
      const err = ((e as Error)?.message ?? String(e)).slice(0, 200);
      // The sign-in itself, not this chat: a 401 after a fresh token, or a token Twitch will not refresh.
      if (status(e) === 401 || (/^twitch token /.test((e as Error)?.message ?? "") && !notNow(status(e)))) {
        voiceSignedOutAt = Date.now();
        d.log("twitch voice is signed out, oddie says nothing on Twitch until it signs in again", { channel: channelId, voice: voiceLogin, status: status(e) ?? null, err });
        if (Date.now() - voiceAlertAt >= VOICE_ALERT_GAP_MS) {
          voiceAlertAt = Date.now();
          reportAlert({
            title: `Oddie's Twitch voice (${voiceLogin}) is signed out`,
            text: `${voiceLogin} can no longer post in Twitch chats (${err}). Until it signs in again, oddie says nothing in Twitch chats: calls still open and answers still count. Sign in to Twitch as ${voiceLogin}, then open the link below once.`,
            link: ["Sign it in again", `${base}/live/twitch/connect`],
          });
        }
        return { said: false, id: null, why: "signed-out", err };
      }
      if (notNow(status(e))) {
        d.log("twitch voice slowed down", { channel: channelId, voice: voiceLogin, status: status(e) ?? null, err });
        return { said: false, id: null, why: "slow", err };
      }
      voiceCannotPost.set(channelId, Date.now());
      d.log("twitch voice cannot post here", { channel: channelId, voice: voiceLogin, status: status(e) ?? null, err });
      return { said: false, id: null, why: "refused", err };
    }
  };
  /** A line nobody may say for oddie in this chat: not said, the log says why, and the operator hears what fixes it. */
  const quiet = (ch: LiveChannel, v: VoiceTry) => {
    d.log("twitch line not said, oddie's own account cannot speak here", { channel: ch.channelId, why: v.why ?? null });
    const who = ch.name || ch.slug;
    if (v.why === "refused" && Date.now() - (chatAlertAt.get(ch.channelId) ?? 0) >= VOICE_ALERT_GAP_MS) {
      chatAlertAt.set(ch.channelId, Date.now());
      reportAlert({
        title: `Oddie can't talk in ${who}'s Twitch chat`,
        text: `Twitch refused ${voiceLogin}'s line in ${who}'s chat (${v.err ?? "no reason given"}). Until ${voiceLogin} can post there, oddie says nothing in that chat: calls still open and answers still count. Most often the chat is followers-only or wants a verified email or phone: sign in to Twitch as ${voiceLogin}, follow the channel below and add what its chat asks for.`,
        link: ["Open the channel", `https://www.twitch.tv/${encodeURIComponent(ch.slug)}`],
      });
    }
    if (v.why === "missing" && Date.now() - voiceMissingAlertAt >= VOICE_ALERT_GAP_MS) {
      voiceMissingAlertAt = Date.now();
      reportAlert({
        title: `Oddie's Twitch voice (${voiceLogin}) is not connected`,
        text: `oddie speaks in Twitch chats only as ${voiceLogin}, and ${voiceLogin} is not connected. Until it is, oddie says nothing in Twitch chats: calls still open and answers still count. Sign in to Twitch as ${voiceLogin}, then open the link below once.`,
        link: ["Connect it", `${base}/live/twitch/connect`],
      });
    }
  };
  const say = (_p: Platform, channelId: string, text: string, replyTo?: string): Promise<string | void> => paced(`twitch:${channelId}`, async () => {
    const ch = await channelById("twitch", channelId);
    if (!ch?.active) return;
    const voice = await sayAsVoice(channelId, text, replyTo);
    if (voice.said) return voice.id ?? undefined;
    quiet(ch, voice);
    return undefined;
  });
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
  const predictionOpen = async (call: LiveCall, minutes: number | null): Promise<"opened" | "too-long" | null> => {
    if (!chat.predict) return null;
    const title = call.question.trim();
    if (title.length > PREDICTION_TITLE_MAX) return "too-long";
    const refusedAt = predictRefused.get(call.channelId);
    if (refusedAt !== undefined && Date.now() - refusedAt < PIN_RETRY_MS) return null;
    const ch = await channelById("twitch", call.channelId).catch(() => null);
    if (!ch?.active || !ch.accessToken) return null;
    const window = Math.max(30, Math.min(1800, minutes === null ? PREDICTION_WINDOW_S : minutes * 60));
    try {
      const p = await withToken(ch, (t) => chat.predict!(t, call.channelId, title, window));
      await botStateSet(predictionKey(call.id), JSON.stringify(p));
      d.log("twitch prediction opened", { channel: call.channelId, call: call.id, window });
      return "opened";
    } catch (e) {
      if (status(e) === 401 || status(e) === 403) {
        predictRefused.set(call.channelId, Date.now());
        d.log("twitch prediction refused, the channel signs in again to allow it", { channel: call.channelId, status: status(e) ?? null, err: (e as Error).message.slice(0, 200) });
        return null;
      }
      // Another prediction running, or a channel Twitch has not given predictions: the call goes on in chat.
      d.log("twitch prediction not opened", { channel: call.channelId, call: call.id, status: status(e) ?? null, err: (e as Error).message.slice(0, 200) });
      return null;
    }
  };
  const predictionEnd = async (call: LiveCall, outcome: Side | null): Promise<void> => {
    if (!chat.endPredict) return;
    const kept = await botStateGet(predictionKey(call.id)).catch(() => null);
    if (!kept) return;
    let p: { id: string; yes: string; no: string };
    try { p = JSON.parse(kept); } catch { return; }
    const ch = await channelById("twitch", call.channelId).catch(() => null);
    if (!ch?.accessToken) return;
    try {
      await withToken(ch, (t) => chat.endPredict!(t, call.channelId, p.id, outcome ? "RESOLVED" : "CANCELED", outcome === "yes" ? p.yes : outcome === "no" ? p.no : undefined));
      d.log("twitch prediction ended", { channel: call.channelId, call: call.id, outcome: outcome ?? "canceled" });
    } catch (e) {
      // The streamer ended it by hand, or Twitch already canceled it: nothing left to do.
      d.log("twitch prediction not ended", { channel: call.channelId, call: call.id, status: status(e) ?? null, err: (e as Error).message.slice(0, 200) });
    }
    await botStateSet(predictionKey(call.id), "").catch(() => {});
  };
  /**
   * Is the channel live: counted, so a Twitch that stops answering is told
   * (src/live/lookups.ts). A Twitch that is not set up is asked here all the
   * same, as it always was, and what comes back is ours to mend, not Twitch
   * gone quiet: not counted.
   */
  const lookup = <T>(channelId: string, ask: () => Promise<T>): Promise<T> =>
    (twitchConfigured() ? counted("twitch", channelId, d.log, ask) : ask());
  const markets = d.markets;
  return {
    store: liveStore,
    now: () => Date.now(),
    say,
    pin,
    unpin,
    predictionOpen,
    predictionEnd,
    streamLive: async (_p, channelId) => lookup(channelId, async () => streamIsLive(await appToken(), channelId)),
    streamGame: async (_p, channelId) => lookup(channelId, async () => streamInfo(await appToken(), channelId)),
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
      // undefined, not null, when the read fails: only a channel we know was
      // never here is a first connect, which an invite may claim.
      const before = await channelById("twitch", who.userId).catch(() => undefined);
      // A channel new to oddie starts without real markets (Lev, 5 Nov): it was
      // promised Twitch predictions, and its streamer turns markets on with
      // !markets on. One that was here before keeps what it had: a save only
      // sets this on a new row.
      const ch: LiveChannel = {
        platform: "twitch", channelId: who.userId, slug: who.login, name: who.name, avatar: who.avatar,
        accessToken: t.accessToken, refreshToken: t.refreshToken, tokenExpiresAt: t.expiresAt, active: true,
        markets: false,
      };
      await saveChannel(ch);
      // A first connect through another channel's invite (src/live/referrals.ts).
      await creditInvite(req.headers.cookie, ch, before === null, d.log);
      const secret = secretOf();
      if (secret) {
        await tw.subscribe(ch.channelId, callback, secret)
          .catch((e) => d.log("twitch subscribe failed", { channel: ch.slug, err: (e as Error).message }));
      }
      // Hello once. Signing in again to manage the 2% is not a second arrival.
      const fresh = !before?.active;
      if (fresh) {
        const withMarkets = before ? before.markets !== false : false;
        await engine.say("twitch", ch.channelId, withMarkets ? LIVE_COPY.hello : LIVE_COPY.helloCalls)
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
  // The player above the call while the channel is on air (src/live/channelRoutes.ts).
  addChannelRoutes(r, "twitch", { ...d, streamLive: d.streamLive ?? (async (c) => (twitchConfigured() ? counted("twitch", c, d.log, async () => streamIsLive(await appToken(), c)) : null)) });
  return r;
}
