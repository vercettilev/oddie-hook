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
  refreshTokens, sendChat, sendChatAsUser, subscribeToChannel, verifyKickSignature, WEBHOOK_MAX_AGE_MS, type KickTokens, kickStreamInfo, kickStreamIsLive,
} from "./client.js";
import { handleChat, LIVE_COPY, lockDue, type LiveDeps, type Platform } from "../live/calls.js";
import { addChannelRoutes, type ChannelPayoutDeps } from "../live/channelRoutes.js";
import { notNow, paced, patiently } from "../live/pace.js";
import { counted } from "../live/lookups.js";
import { reportAlert } from "../live/openedMail.js";
import { openFromChat, type ChatMarketDeps } from "../live/claims.js";
import { ownerCookie, ownerKeyFromEnv, ownerToken } from "../live/owner.js";
import { creditInvite } from "../live/referrals.js";
import { kickChatSource, type ChannelMarket } from "../store/markets.js";
import { channelById, channelBySlug, liveStore, saveChannel, type LiveChannel } from "../store/live.js";

export interface KickRouteDeps {
  /** Where the app lives: the standings links and the OAuth redirect. */
  appBaseUrl: string;
  /** The page, already stamped for this deploy. */
  pageHtml(): string;
  /** The overlay for OBS (public/app/overlay.html). Absent: no overlay route. */
  overlayHtml?(): string;
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
 * LEV'S OWN LINE (src/live/autoCall.ts): his account says it in a connected
 * chat, as he types it himself, on his own token, refreshed once on a 401. It
 * comes back through the feed as his line (only the voice's name is oddie's
 * own), so the engine runs it as it runs his.
 */
export async function kickSayAsOperator(fromSlug: string, channelId: string, text: string, chat: KickChat = kickChat): Promise<void> {
  const from = await channelBySlug("kick", fromSlug);
  if (!from?.active || !from.accessToken) throw new Error(`${fromSlug} is not connected on Kick`);
  try {
    await chat.user(await tokenFor(from), channelId, text);
  } catch (e) {
    if ((e as { status?: number }).status !== 401) throw e;
    await chat.user(await tokenFor(from, true), channelId, text);
  }
}

/**
 * A NEW APP'S BOT CANNOT POST YET. Found on the first live test (29 Sep):
 * every bot line from the freshly made oddie app came back 404 "Not found",
 * and other developers report the same for new apps with no answer from
 * Kick. The bot is oddie's own and never a person, so it is still asked
 * first; on 404 or 400 it is benched in that channel and not asked there
 * again. The account that authorized us is no longer the next step: in a
 * streamer's chat that account is the streamer (see ONE VOICE below).
 */
const botCannotPost = new Set<string>();

/**
 * A REPLY KICK WILL NOT TAKE goes once more as a line of its own: a line sent
 * as a reply that comes back 400 or 422. A reply may not reach across
 * channels (oddie's account answering in another's chat), and on Twitch it
 * may not reach an older line: live on 1 Nov a market's result, said as a
 * reply to the line that opened it, was refused there from both accounts and
 * never reached the chat (src/twitch/routes.ts). A refusal of the line itself
 * goes to the caller, as before.
 */
async function replyOrAlone(send: (replyTo?: string) => Promise<void>, replyTo?: string, refused?: (status: number) => void): Promise<void> {
  try { await send(replyTo); }
  catch (e) {
    const st = (e as { status?: number }).status;
    if (!replyTo || (st !== 400 && st !== 422)) throw e;
    refused?.(st);
    await send();
  }
}

/**
 * ONE VOICE IN EVERY CHAT, AND NEVER THE STREAMER'S (Lev, 25 Nov). A line goes
 * out from oddie's own account (the voice channel, which authorized us with
 * chat:write like any other) into the channel it answers, the way any viewer's
 * line does. Where Kick refused that (a followers-only chat, chat rules not
 * accepted, a ban, a slow moment), the line used to go out from the streamer's
 * own account instead: every line oddie said in IsaacBeast's chat on 24-25 Nov,
 * the call's opening and its "canceled, no points" among them, read as Isaac
 * typing it (his chat was followers-only, and oddiefun's own chat box there
 * stayed locked until it followed him). Lev: oddie never speaks in a
 * streamer's name. So a line oddie's account cannot say is not said: the
 * call still runs and the answers still count, the log says why, and the
 * operator gets a mail with what fixes it, once a chat every six hours. Only
 * oddie's own bot (src/kick/client.ts sendChat) may still say it. The voice
 * is tried again in a chat ten minutes after it was refused there. "Too
 * quickly" is no refusal: the lines to a chat go out a second apart and a 429
 * is waited out (src/live/pace.ts).
 */
const voiceCannotPost = new Map<string, number>();
const VOICE_RETRY_MS = 10 * 60_000;
/**
 * THE VOICE SIGNED OUT (24 Nov). oddiefun's own Kick sign-in can lapse: its
 * token no longer refreshes, or a fresh one is refused. Read as a slow moment,
 * it went unnoticed (IsaacBeast's chat, 23-24 Nov: three lines out of three).
 * So a lost sign-in is told apart from a chat that will not take the voice:
 * the voice rests in every chat for ten minutes instead of asking Kick again
 * on each line, the reason is in the log, and the operator gets one mail every
 * six hours until oddiefun signs in again at /live/kick/connect.
 */
let voiceSignedOutAt: number | null = null;
let voiceAlertAt = 0;
const VOICE_ALERT_GAP_MS = 6 * 60 * 60_000;
/** The last mail about a chat that refused the voice, by channel; and about a voice not connected. */
const chatAlertAt = new Map<string, number>();
let voiceMissingAlertAt = 0;
/**
 * A CHAT THAT TAKES NO LINKS (26 Nov, IsaacBeast's). A streamer can block
 * links in their chat, and Kick then answers a line with one 400
 * {"data":"NO_LINKS_ERROR"}: the call's opening ("Standings: <page>") and its
 * result ("Card: <page>") were refused, the voice was benched and the
 * operator mailed to follow the channel, which was already followed. The line
 * is said again without its links instead, and every line in that chat from
 * then on goes out without them. A line with no link refused all the same is
 * a refusal like any other.
 */
const noLinks = new Set<string>();
const linkRefused = (e: unknown): boolean =>
  (e as { status?: number }).status === 400 && /NO_LINKS_ERROR/.test((e as Error)?.message ?? "");
/** A line without its links: the page after "Standings:" or "Card:", and any other address. */
export function withoutLinks(text: string): string {
  return text.replace(/(?:\.\s*|\s+)(?:Standings|Card):\s*\S+/g, "").replace(/\s*https?:\/\/\S+/g, "").trim();
}
/** Test seam: forget the chats that refused the voice, a lost sign-in, and the mails about them. */
export function _resetKickVoice(): void {
  voiceCannotPost.clear(); voiceSignedOutAt = null; voiceAlertAt = 0; chatAlertAt.clear(); voiceMissingAlertAt = 0; noLinks.clear();
}
const voiceSlugFrom = (d: { voice?: string }): string =>
  (d.voice ?? process.env.KICK_VOICE_CHANNEL ?? "oddiefun").trim().toLowerCase();

/** What oddie's own account did with a line, and why not when it did not. */
interface VoiceTry {
  said: boolean;
  /** off: no voice set. missing: not connected. resting: refused in this chat a moment ago.
   *  signed-out: Kick took its sign-in away. slow: Kick said "not now". refused: this chat will not take it. */
  why?: "off" | "missing" | "resting" | "signed-out" | "slow" | "refused";
  err?: string;
}

export function kickEngineDeps(d: Pick<KickRouteDeps, "appBaseUrl" | "log" | "markets" | "voice">, chat: KickChat = kickChat): LiveDeps {
  const base = d.appBaseUrl.replace(/\/+$/, "");
  /** The line from oddie's own bot, which is never a person: true when it said it.
   *  The token only lets the bot into that chat; the line is the bot's, not the token's owner's. */
  const sayAsBot = async (token: string, channelId: string, text: string, replyTo?: string): Promise<boolean> => {
    if (botCannotPost.has(channelId)) return false;
    const refused = (st: number) => d.log("kick reply refused, the line goes on its own", { channel: channelId, status: st });
    // A reply the bot may not make is no reason to bench it: only the line is.
    try { await replyOrAlone((r) => chat.bot(token, text, r), replyTo, refused); return true; }
    catch (e) {
      const st = (e as { status?: number }).status;
      if (st !== 404 && st !== 400) throw e;
      botCannotPost.add(channelId);
      d.log("kick bot cannot post here", { channel: channelId, status: st });
      return false;
    }
  };
  const voiceSlug = voiceSlugFrom(d);
  /** oddie's own account says it in a streamer's chat, or says why it did not. */
  const sayAsVoice = async (channelId: string, text: string, replyTo?: string): Promise<VoiceTry> => {
    if (!voiceSlug) return { said: false, why: "off" };
    if (voiceSignedOutAt !== null && Date.now() - voiceSignedOutAt < VOICE_RETRY_MS) return { said: false, why: "signed-out" };
    const failedAt = voiceCannotPost.get(channelId);
    if (failedAt !== undefined && Date.now() - failedAt < VOICE_RETRY_MS) return { said: false, why: "resting" };
    // A store that does not answer is an outage, said as one, never a voice that is not there.
    const voice = await channelBySlug("kick", voiceSlug);
    if (!voice?.active || !voice.accessToken) return { said: false, why: "missing" };
    let line = noLinks.has(channelId) ? withoutLinks(text) : text;
    const send = async (force: boolean) => {
      const token = await tokenFor(voice, force);
      await replyOrAlone((r) => patiently(() => chat.user(token, channelId, line, r)), replyTo);
    };
    const st = (e: unknown) => (e as { status?: number }).status;
    // An expired token says 401: refresh once and say it again, reply and all.
    const sendRefreshed = async () => {
      try { await send(false); }
      catch (e) {
        if (st(e) !== 401) throw e;
        await send(true);
      }
    };
    try {
      try { await sendRefreshed(); }
      catch (e) {
        if (!linkRefused(e) || withoutLinks(line) === line) throw e;
        noLinks.add(channelId);
        line = withoutLinks(line);
        d.log("kick chat takes no links, oddie says it without them", { channel: channelId });
        await sendRefreshed();
      }
      voiceCannotPost.delete(channelId);
      voiceSignedOutAt = null;
      return { said: true };
    } catch (e) {
      const err = ((e as Error)?.message ?? String(e)).slice(0, 160);
      // The sign-in itself, not this chat: a token Kick will not refresh, or a fresh one refused.
      const signedOut = st(e) === 401 || (/^kick token /.test((e as Error)?.message ?? "") && !notNow(st(e)));
      if (signedOut) {
        voiceSignedOutAt = Date.now();
        d.log("kick voice is signed out, oddie says nothing on Kick until it signs in again", { channel: channelId, voice: voiceSlug, status: st(e) ?? null, err });
        if (Date.now() - voiceAlertAt >= VOICE_ALERT_GAP_MS) {
          voiceAlertAt = Date.now();
          reportAlert({
            title: `Oddie's Kick voice (${voiceSlug}) is signed out`,
            text: `${voiceSlug} can no longer post in Kick chats (${err}). Until it signs in again, oddie says nothing in Kick chats: calls still open and answers still count. Sign in to Kick as ${voiceSlug}, then open the link below once.`,
            link: ["Sign it in again", `${base}/live/kick/connect`],
          });
        }
        return { said: false, why: "signed-out", err };
      }
      if (notNow(st(e))) {
        d.log("kick voice slowed down", { channel: channelId, voice: voiceSlug, status: st(e) ?? null, err });
        return { said: false, why: "slow", err };
      }
      voiceCannotPost.set(channelId, Date.now());
      d.log("kick voice cannot post here", { channel: channelId, voice: voiceSlug, status: st(e) ?? null, err });
      return { said: false, why: "refused", err };
    }
  };
  /** A line nobody may say for oddie in this chat: not said, the log says why, and the operator hears what fixes it. */
  const quiet = (ch: LiveChannel, v: VoiceTry) => {
    d.log("kick line not said, oddie's own account cannot speak here", { channel: ch.channelId, why: v.why ?? null });
    const who = ch.name || ch.slug;
    if (v.why === "refused" && Date.now() - (chatAlertAt.get(ch.channelId) ?? 0) >= VOICE_ALERT_GAP_MS) {
      chatAlertAt.set(ch.channelId, Date.now());
      reportAlert({
        title: `Oddie can't talk in ${who}'s Kick chat`,
        text: `Kick refused ${voiceSlug}'s line in ${who}'s chat (${v.err ?? "no reason given"}). Until ${voiceSlug} can post there, oddie says nothing in that chat: calls still open and answers still count. Most often the chat is followers-only or has rules to accept: sign in to Kick as ${voiceSlug}, open the channel below, follow it and accept its chat rules if asked.`,
        link: ["Open the channel", `https://kick.com/${encodeURIComponent(ch.slug)}`],
      });
    }
    if (v.why === "missing" && Date.now() - voiceMissingAlertAt >= VOICE_ALERT_GAP_MS) {
      voiceMissingAlertAt = Date.now();
      reportAlert({
        title: `Oddie's Kick voice (${voiceSlug}) is not connected`,
        text: `oddie speaks in Kick chats only as ${voiceSlug}, and ${voiceSlug} is not connected. Until it is, oddie says nothing in Kick chats: calls still open and answers still count. Sign in to Kick as ${voiceSlug}, then open the link below once.`,
        link: ["Connect it", `${base}/live/kick/connect`],
      });
    }
  };
  const say = (_p: Platform, channelId: string, text: string, replyTo?: string): Promise<void> => paced(`kick:${channelId}`, async () => {
    const ch = await channelById("kick", channelId);
    if (!ch?.active) return;
    const v = await sayAsVoice(channelId, text, replyTo);
    if (v.said) return;
    const send = async (force: boolean) => sayAsBot(await tokenFor(ch, force), channelId, noLinks.has(channelId) ? withoutLinks(text) : text, replyTo);
    let said: boolean;
    try { said = await send(false); }
    catch (e) {
      // An expired token says 401: refresh once and say it again.
      if ((e as { status?: number }).status !== 401) throw e;
      said = await send(true);
    }
    if (!said) quiet(ch, v);
  });
  const markets = d.markets;
  return {
    store: liveStore,
    now: () => Date.now(),
    say,
    // Is the channel live? The clock asks for channels with calls waiting, so a
    // stream's end can settle or cancel the moments only the room saw. Counted,
    // so a Kick that stops answering is told (src/live/lookups.ts); a Kick that
    // is not set up is not asked, and not counted.
    streamLive: async (_p, channelId) => (kickConfigured() ? counted("kick", channelId, d.log, () => kickStreamIsLive(channelId)) : null),
    streamGame: async (_p, channelId) => (kickConfigured() ? counted("kick", channelId, d.log, () => kickStreamInfo(channelId)) : null),
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
      // undefined, not null, when the read fails: only a channel we know was
      // never here is a first connect, which an invite may claim.
      const before = await channelById("kick", who.userId).catch(() => undefined);
      const ch: LiveChannel = {
        platform: "kick", channelId: who.userId, slug: chan.slug, name: who.name, avatar: who.avatar,
        accessToken: t.accessToken, refreshToken: t.refreshToken, tokenExpiresAt: t.expiresAt, active: true,
      };
      await saveChannel(ch);
      // A first connect through another channel's invite (src/live/referrals.ts).
      await creditInvite(req.headers.cookie, ch, before === null, d.log);
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
  // The player above the call while the channel is on air (src/live/channelRoutes.ts).
  addChannelRoutes(r, "kick", { ...d, streamLive: async (c) => (kickConfigured() ? counted("kick", c, d.log, () => kickStreamIsLive(c)) : null) });

  return r;
}

/** The clock: every few seconds, calls whose time is up are locked and said. */
export function startLiveClock(d: Pick<KickRouteDeps, "appBaseUrl" | "log" | "markets" | "voice">, everyMs = 5_000): NodeJS.Timeout {
  const engine = kickEngineDeps(d);
  return setInterval(() => { void lockDue(engine).catch((e) => d.log("live clock failed", { err: (e as Error).message })); }, everyMs);
}
