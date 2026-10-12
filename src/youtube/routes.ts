/**
 * oddie on YouTube: the door a streamer walks through once, the watcher that
 * finds their stream and reads its chat, and how a line gets back into it.
 * The page and the standings are the routes every platform shares
 * (src/live/channelRoutes); the rules are the engine's (src/live/calls.ts),
 * run votes only: no market, no 2%, no link (see src/youtube/client.ts).
 *
 * THE STREAMER DOES THREE THINGS, ONCE: signs in with Google (that names the
 * channel), adds @oddiefun as a moderator in YouTube Studio (so oddie's lines
 * are never held back or slowed), and goes live. Nothing is installed and
 * nothing is typed to start: the watcher sees the stream and oddie joins.
 */
import express, { type Router } from "express";
import { randomBytes } from "node:crypto";
import {
  authorizeUrl, chatFromYouTube, exchangeCode, me, recentVideoIds, refreshTokens, sendChat, splitForChat, streamChat, videosLive,
  voiceHandle, youtubeConfigured, type ChatPage, type LiveVideo, type YouTubeChannel, type YouTubeTokens,
} from "./client.js";
import { handleChat, LIVE_COPY, type LiveDeps } from "../live/calls.js";
import { addChannelRoutes, type ChannelPageDeps } from "../live/channelRoutes.js";
import { paced, patiently } from "../live/pace.js";
import { ownerCookie, ownerKeyFromEnv, ownerToken } from "../live/owner.js";
import { channelById, channelBySlug, liveStore, saveChannel, type LiveChannel } from "../store/live.js";

/** Everything oddie asks of Google, in one place: the tests replace it. */
export interface YouTubeApi {
  exchangeCode(code: string, redirectUri: string): Promise<YouTubeTokens>;
  me(token: string): Promise<YouTubeChannel>;
  refreshTokens(refreshToken: string): Promise<YouTubeTokens>;
  recentVideoIds(channelId: string): Promise<string[]>;
  videosLive(token: string, ids: string[]): Promise<LiveVideo[]>;
  streamChat(token: string, liveChatId: string, pageToken: string | null, onPage: (p: ChatPage) => Promise<void> | void, signal: AbortSignal): Promise<{ pageToken: string | null; offline: boolean }>;
  sendChat(token: string, liveChatId: string, text: string): Promise<string | null>;
}
export const youtubeApi: YouTubeApi = { exchangeCode, me, refreshTokens, recentVideoIds, videosLive, streamChat, sendChat };

export interface YouTubeRouteDeps extends ChannelPageDeps {
  appBaseUrl: string;
  /** Test seam. */
  api?: YouTubeApi;
}

type Log = (line: string, extra?: Record<string, unknown>) => void;
const status = (e: unknown) => (e as { status?: number }).status;
const reason = (e: unknown) => String((e as { reason?: string }).reason ?? "");
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((ok) => {
  const t = setTimeout(ok, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); ok(); }, { once: true });
});

/* ------------------------------------------------------------- state -- */

/** Where each live channel's chat is right now: the watcher sets it, say() reads it. */
const liveChats = new Map<string, { videoId: string; liveChatId: string }>();
/** What the watcher last saw: on air or not. Absent: not looked at yet. */
const onAir = new Map<string, boolean>();
/** Channels that signed in for the first time: they hear hello on their first stream, since there is no chat before it. */
const greetOnLive = new Set<string>();
/** Lines oddie sent, by id: one that comes back through the stream is oddie's own. */
const sentByUs = new Set<string>();
const SENT_MAX = 2_000;
/** After YouTube said the day's quota is spent, oddie stops asking until this time. */
let quotaRestUntil = 0;
const QUOTA_REST_MS = 60 * 60_000;

interface Reader {
  channelId: string; slug: string; liveChatId: string;
  abort: AbortController; startedAt: number; seen: Set<string>; pageToken: string | null; done: boolean;
}
const readers = new Map<string, Reader>();
const SEEN_MAX = 5_000;

/** Test seam. */
export function _resetYouTube(): void {
  for (const r of readers.values()) r.abort.abort();
  readers.clear(); liveChats.clear(); onAir.clear(); greetOnLive.clear(); sentByUs.clear(); quotaRestUntil = 0;
}
/** Test seam: the chats the watcher is reading now. */
export const _readers = (): Array<{ channelId: string; liveChatId: string; done: boolean }> =>
  [...readers.values()].map((r) => ({ channelId: r.channelId, liveChatId: r.liveChatId, done: r.done }));

/* ------------------------------------------------------------- voice -- */

/** oddie's own channel, when it has signed in with a token that lasts. */
async function voiceChannel(): Promise<LiveChannel | null> {
  const handle = voiceHandle();
  if (!handle) return null;
  const ch = await channelBySlug("youtube", handle).catch(() => null);
  return ch?.active && ch.refreshToken ? ch : null;
}

/** A token that works: refreshed a minute before it would not, or on demand. */
async function voiceToken(api: YouTubeApi, ch: LiveChannel, force = false): Promise<string> {
  const stale = !ch.accessToken || ch.tokenExpiresAt === null || ch.tokenExpiresAt - Date.now() < 60_000;
  if ((force || stale) && ch.refreshToken) {
    const t = await api.refreshTokens(ch.refreshToken);
    const next: LiveChannel = { ...ch, accessToken: t.accessToken, refreshToken: t.refreshToken ?? ch.refreshToken, tokenExpiresAt: t.expiresAt };
    await saveChannel(next);
    Object.assign(ch, next);
    return t.accessToken;
  }
  if (!ch.accessToken) throw new Error("youtube voice has no token");
  return ch.accessToken;
}

/** Act with the voice's token, refreshing it once on a 401. */
async function withVoice<T>(api: YouTubeApi, ch: LiveChannel, f: (token: string) => Promise<T>): Promise<T> {
  try { return await f(await voiceToken(api, ch)); }
  catch (e) {
    if (status(e) !== 401) throw e;
    return f(await voiceToken(api, ch, true));
  }
}

const spent = (e: unknown) => ["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded"].includes(reason(e));

/* ------------------------------------------------------------ engine -- */

/**
 * The engine's hands on YouTube. Every line goes out from oddie's channel into
 * the chat the watcher found, cut to YouTube's 200 characters, a second apart.
 * No pins (the API has none for a bot), no market, and no link in any line.
 */
export function youtubeEngineDeps(d: { log: Log }, api: YouTubeApi = youtubeApi): LiveDeps {
  const say = async (_p: unknown, channelId: string, text: string): Promise<string | void> => {
    const chat = liveChats.get(channelId);
    if (!chat) return;   // off air: there is no chat to say it in
    if (Date.now() < quotaRestUntil) return;
    const voice = await voiceChannel();
    if (!voice) { d.log("youtube voice not connected, line not said", { channel: channelId }); return; }
    let first: string | null = null;
    for (const line of splitForChat(text)) {
      try {
        const id = await paced(`youtube:${channelId}`, () => patiently(() => withVoice(api, voice, (t) => api.sendChat(t, chat.liveChatId, line))));
        if (id) { sentByUs.add(id); if (sentByUs.size > SENT_MAX) for (const k of [...sentByUs].slice(0, SENT_MAX / 2)) sentByUs.delete(k); }
        first ??= id;
      } catch (e) {
        if (spent(e) && reason(e) !== "rateLimitExceeded") {
          quotaRestUntil = Date.now() + QUOTA_REST_MS;
          d.log("youtube quota spent, oddie rests for an hour", { channel: channelId });
        }
        throw e;
      }
    }
    return first ?? undefined;
  };
  return {
    store: liveStore,
    now: () => Date.now(),
    say,
    standingsUrl: async () => "",
    streamLive: async (_p, channelId) => (onAir.has(channelId) ? onAir.get(channelId)! : null),
    votesOnly: true,
    log: d.log,
  };
}

/* ----------------------------------------------------------- watcher -- */

/** One page of a chat: what is new and was said after oddie arrived goes to the engine. */
async function readPage(r: Reader, p: ChatPage, voiceId: string, engine: LiveDeps, log: Log): Promise<void> {
  for (const it of p.items ?? []) {
    const id = it?.id;
    if (!id || r.seen.has(id)) continue;
    r.seen.add(id);
    if (r.seen.size > SEEN_MAX) for (const k of [...r.seen].slice(0, SEEN_MAX / 2)) r.seen.delete(k);
    // The first pages are the chat's recent history: what was said before oddie
    // arrived is not a command now.
    const at = Date.parse(it.snippet?.publishedAt ?? "");
    if (Number.isFinite(at) && at < r.startedAt - 5_000) continue;
    const msg = chatFromYouTube(it, { channelId: r.channelId, slug: r.slug }, voiceId);
    if (!msg) continue;
    if (sentByUs.has(msg.messageId)) msg.fromOddie = true;
    const action = await handleChat(msg, engine).catch((e) => { log("youtube chat failed", { err: (e as Error).message }); return "error"; });
    // What a command did, never what anybody wrote: ordinary chat is not logged.
    if (action !== "chat" && action !== "own") log("youtube chat command", { channel: r.channelId, action, runner: msg.canRun });
  }
}

/** One live chat, read over its long connection until the stream ends or the watcher stops it. */
function startReader(api: YouTubeApi, voice: LiveChannel, ch: { channelId: string; slug: string }, liveChatId: string, engine: LiveDeps, log: Log, now: number): Reader {
  const r: Reader = { channelId: ch.channelId, slug: ch.slug, liveChatId, abort: new AbortController(), startedAt: now, seen: new Set(), pageToken: null, done: false };
  readers.set(ch.channelId, r);
  void (async () => {
    let backoff = 2_000;
    while (!r.abort.signal.aborted) {
      try {
        const end = await withVoice(api, voice, (t) => api.streamChat(t, liveChatId, r.pageToken, (p) => readPage(r, p, voice.channelId, engine, log), r.abort.signal));
        r.pageToken = end.pageToken;
        if (end.offline) { r.done = true; log("youtube chat ended with the stream", { channel: r.channelId }); break; }
        backoff = 2_000;
        await sleep(1_000, r.abort.signal);   // the connection closed with the chat still on: open it again
      } catch (e) {
        if (r.abort.signal.aborted) break;
        const why = reason(e);
        if (status(e) === 404 || ["liveChatEnded", "liveChatNotFound", "liveChatDisabled", "forbidden"].includes(why)) {
          r.done = true;
          log("youtube chat closed", { channel: r.channelId, status: status(e) ?? null, reason: why });
          break;
        }
        if (spent(e) && why !== "rateLimitExceeded") {
          r.done = true;
          quotaRestUntil = Date.now() + QUOTA_REST_MS;
          log("youtube quota spent, the chat waits an hour", { channel: r.channelId });
          break;
        }
        log("youtube chat stream dropped, reconnecting", { channel: r.channelId, status: status(e) ?? null, err: (e as Error).message.slice(0, 160) });
        await sleep(backoff, r.abort.signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  })();
  return r;
}

function stopReader(r: Reader): void {
  r.abort.abort();
  if (readers.get(r.channelId) === r) readers.delete(r.channelId);
}

/**
 * The watcher's pass, once a minute: each connected channel's newest videos
 * from its public feed, one videos.list for all of them (1 unit), and for a
 * channel on air its chat read over one connection. A channel that went off
 * air has its reader stopped; one that went live for the first time since it
 * signed in hears hello.
 */
export async function watchYouTube(w: { engine: LiveDeps; log: Log; api?: YouTubeApi; now?: () => number }): Promise<{ live: number; reading: number }> {
  const api = w.api ?? youtubeApi;
  const now = (w.now ?? Date.now)();
  if (now < quotaRestUntil) return { live: 0, reading: readers.size };
  const voice = await voiceChannel();
  // Without oddie's own channel nothing can be read or said.
  if (!voice) return { live: 0, reading: 0 };
  const handle = voiceHandle();
  const chans = (await liveStore.channels().catch(() => []))
    .filter((c) => c.platform === "youtube" && c.slug.toLowerCase() !== handle && c.channelId !== voice.channelId);
  const idsOf = new Map<string, string[]>();
  for (const c of chans) {
    idsOf.set(c.channelId, await api.recentVideoIds(c.channelId).catch((e) => {
      w.log("youtube feed not read", { channel: c.channelId, err: (e as Error).message.slice(0, 160) });
      return [] as string[];
    }));
  }
  const ids = [...new Set([...idsOf.values()].flat())];
  let videos: LiveVideo[] = [];
  if (ids.length) {
    try { videos = await withVoice(api, voice, (t) => api.videosLive(t, ids)); }
    catch (e) {
      if (spent(e) && reason(e) !== "rateLimitExceeded") { quotaRestUntil = now + QUOTA_REST_MS; w.log("youtube quota spent, the watcher waits an hour"); }
      else w.log("youtube videos not read", { err: (e as Error).message.slice(0, 160) });
      // Nothing known: the readers stay as they are.
      return { live: 0, reading: readers.size };
    }
  }
  const liveOf = new Map<string, LiveVideo>();
  for (const v of videos) if (v.state === "live" && v.liveChatId) liveOf.set(v.channelId, v);
  let live = 0;
  for (const c of chans) {
    const v = liveOf.get(c.channelId);
    onAir.set(c.channelId, Boolean(v));
    const r = readers.get(c.channelId);
    if (!v) {
      liveChats.delete(c.channelId);
      if (r) { stopReader(r); w.log("youtube stream off air", { channel: c.channelId }); }
      continue;
    }
    live++;
    liveChats.set(c.channelId, { videoId: v.videoId, liveChatId: v.liveChatId! });
    // A reader for this chat that is still reading stays; a new stream (or one that stopped) gets a new one.
    if (r && r.liveChatId === v.liveChatId && !r.done) continue;
    if (r) stopReader(r);
    startReader(api, voice, { channelId: c.channelId, slug: c.slug }, v.liveChatId!, w.engine, w.log, now);
    w.log("youtube stream on air, oddie joins its chat", { channel: c.channelId, video: v.videoId });
    if (greetOnLive.delete(c.channelId)) {
      await w.engine.say("youtube", c.channelId, LIVE_COPY.helloVotes)
        .catch((e) => w.log("youtube hello not delivered", { channel: c.channelId, err: (e as Error).message.slice(0, 160) }));
    }
  }
  return { live, reading: readers.size };
}

/* ------------------------------------------------------------ router -- */

const pending = new Map<string, { at: number; voice: boolean }>();

export function youtubeRouter(d: YouTubeRouteDeps): Router {
  const r = express.Router();
  const base = d.appBaseUrl.replace(/\/+$/, "");
  const redirectUri = `${base}/live/youtube/callback`;
  const api = d.api ?? youtubeApi;
  const secure = base.startsWith("https:");

  const begin = (voice: boolean) => (_req: express.Request, res: express.Response) => {
    if (!d.api && !youtubeConfigured()) return res.status(503).type("text").send("oddie for YouTube is almost here.");
    for (const [k, p] of pending) if (Date.now() - p.at > 10 * 60_000) pending.delete(k);
    const state = randomBytes(16).toString("hex");
    pending.set(state, { at: Date.now(), voice });
    res.redirect(authorizeUrl({ state, redirectUri, voice }));
  };
  /** A streamer adds oddie to their channel. */
  r.get("/live/youtube/connect", begin(false));
  /** oddie's own channel, once: the account every line goes out from. */
  r.get("/live/youtube/voice", begin(true));

  r.get("/live/youtube/callback", async (req, res) => {
    const state = String(req.query.state ?? "");
    const code = String(req.query.code ?? "");
    const p = pending.get(state);
    pending.delete(state);
    // Declining on Google's screen comes back with ?error=access_denied.
    if (!p || !code || Date.now() - p.at > 10 * 60_000) return res.redirect(`${base}/live?youtube=${req.query.error ? "declined" : "expired"}`);
    try {
      const t = await api.exchangeCode(code, redirectUri);
      const who = await api.me(t.accessToken);
      const isVoice = p.voice && !!voiceHandle() && who.handle.toLowerCase() === voiceHandle();
      const before = await channelById("youtube", who.channelId).catch(() => null);
      // A streamer's token was for their name and is not kept. oddie's own
      // channel keeps its token; signed in again through the streamer door, it
      // keeps the one it had.
      const keep = isVoice ? t : { accessToken: before?.accessToken ?? null, refreshToken: before?.refreshToken ?? null, expiresAt: before?.tokenExpiresAt ?? null };
      const ch: LiveChannel = {
        platform: "youtube", channelId: who.channelId, slug: who.handle, name: who.name, avatar: who.avatar,
        accessToken: keep.accessToken, refreshToken: keep.refreshToken, tokenExpiresAt: keep.expiresAt, active: true,
      };
      await saveChannel(ch);
      if (isVoice) {
        d.log(t.refreshToken ? "youtube voice connected" : "youtube voice connected WITHOUT a refresh token, sign in at /live/youtube/voice again", { channel: ch.slug });
        return res.redirect(`${base}/live/youtube/${encodeURIComponent(ch.slug)}?voice=1`);
      }
      // Hello once, on the first stream: signing in again is not a second arrival.
      const fresh = !before?.active;
      if (fresh) greetOnLive.add(ch.channelId);
      const key = ownerKeyFromEnv("youtube");
      if (key) res.append("Set-Cookie", ownerCookie(ownerToken(ch.channelId, key), secure, undefined, "youtube"));
      d.log(fresh ? "youtube channel connected" : "youtube channel signed in", { channel: ch.slug });
      res.redirect(`${base}/live/youtube/${encodeURIComponent(ch.slug)}${fresh ? "?connected=1" : ""}`);
    } catch (e) {
      d.log("youtube connect failed", { err: (e as Error).message });
      res.redirect(`${base}/live?youtube=failed`);
    }
  });

  /** The channel's page and its standings: shared with Kick and Twitch. */
  addChannelRoutes(r, "youtube", d);
  return r;
}
