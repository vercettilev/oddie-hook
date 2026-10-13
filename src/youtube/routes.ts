/**
 * oddie on YouTube: the door a streamer walks through once, the watcher that
 * finds their stream and reads its chat, and how a line gets back into it.
 * The page and the standings are the routes every platform shares
 * (src/live/channelRoutes); the rules are the engine's (src/live/calls.ts),
 * run votes only: no market, no 2%, no link (see src/youtube/client.ts).
 *
 * THE STREAMER DOES TWO THINGS: pastes their channel's link on /live, and goes
 * live. Nobody signs in to Google but oddie's own channel, and nothing is
 * installed: the watcher sees the stream and oddie joins its chat.
 *
 * ANYBODY CAN PASTE A LINK, so a pasted channel never hears oddie uninvited:
 * oddie says nothing in a chat until the channel's owner or one of its mods has
 * used a command there. Votes are the whole of it on YouTube (no money, no
 * link), so a channel needs no proof of who pasted it beyond that.
 */
import express, { type Router } from "express";
import { randomBytes } from "node:crypto";
import {
  authorizeUrl, channelLookup, chatFromYouTube, exchangeCode, me, parseChannelRef, recentVideoIds, refreshTokens, sendChat, splitForChat,
  streamChat, uploadsVideoIds, videosLive, voiceHandle, youtubeConfigured, type ChannelRef, type ChatPage, type LiveVideo, type YouTubeChannel,
  type YouTubeTokens,
} from "./client.js";
import { handleChat, type LiveDeps } from "../live/calls.js";
import { addChannelRoutes, type ChannelPageDeps } from "../live/channelRoutes.js";
import { paced, patiently } from "../live/pace.js";
import { channelById, channelBySlug, liveStore, saveChannel, type LiveChannel } from "../store/live.js";

/** Everything oddie asks of Google, in one place: the tests replace it. */
export interface YouTubeApi {
  exchangeCode(code: string, redirectUri: string): Promise<YouTubeTokens>;
  me(token: string): Promise<YouTubeChannel>;
  channelLookup(token: string, ref: ChannelRef): Promise<YouTubeChannel | null>;
  refreshTokens(refreshToken: string): Promise<YouTubeTokens>;
  recentVideoIds(channelId: string): Promise<string[]>;
  uploadsVideoIds(token: string, channelId: string): Promise<string[]>;
  videosLive(token: string, ids: string[]): Promise<LiveVideo[]>;
  streamChat(token: string, liveChatId: string, pageToken: string | null, onPage: (p: ChatPage) => Promise<void> | void, signal: AbortSignal): Promise<{ pageToken: string | null; offline: boolean }>;
  sendChat(token: string, liveChatId: string, text: string): Promise<string | null>;
}
export const youtubeApi: YouTubeApi = { exchangeCode, me, channelLookup, refreshTokens, recentVideoIds, uploadsVideoIds, videosLive, streamChat, sendChat };

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
/** Channels whose owner or a mod has used a command: oddie speaks in their chat. */
const awake = new Set<string>();
/**
 * What each video was when last asked. A video that is neither live nor
 * coming up is a recording, and a recording never goes live: it is not asked
 * about again, so a channel costs nothing between its streams.
 */
const videoState = new Map<string, LiveVideo["state"]>();
const VIDEOS_MAX = 20_000;
/**
 * When each channel's newest videos were last looked up, and what they were.
 * Looking costs a unit while the public feed is down, so a channel is looked
 * at every few minutes; a video already known to be live or coming up is
 * still asked about every pass.
 */
const looked = new Map<string, { at: number; ids: string[] }>();
const lookEveryMs = () => (process.env.YOUTUBE_LOOK_MS === undefined ? 5 * 60_000 : Math.max(0, Number(process.env.YOUTUBE_LOOK_MS) || 0));
let feedDownSaidAt = 0;
/** Lines oddie sent, by id: one that comes back through the stream is oddie's own. */
const sentByUs = new Set<string>();
const SENT_MAX = 2_000;
/** After YouTube said the day's quota is spent, oddie stops asking until this time. */
let quotaRestUntil = 0;
const QUOTA_REST_MS = 60 * 60_000;

/*
 * WHAT A STRANGER CAN SPEND. Adding a channel and checking one ask YouTube with
 * oddie's quota and anybody can call them, so they share a small daily budget
 * of their own (the quota's day starts at midnight Pacific) and a pace per
 * caller. The streams oddie is already in can never be starved by them.
 */
const PUBLIC_UNITS_PER_DAY = 600;
let publicDay = "", publicSpent = 0;
function spendPublic(units: number, now: number): boolean {
  const day = new Date(now - 8 * 3_600_000).toISOString().slice(0, 10);
  if (day !== publicDay) { publicDay = day; publicSpent = 0; }
  if (publicSpent + units > PUBLIC_UNITS_PER_DAY) return false;
  publicSpent += units;
  return true;
}
const addsBy = new Map<string, number[]>();
const ADD_WINDOW_MS = 10 * 60_000;
const ADDS_PER_WINDOW = 6;
function addAllowed(who: string, now: number): boolean {
  const recent = (addsBy.get(who) ?? []).filter((t) => now - t < ADD_WINDOW_MS);
  const ok = recent.length < ADDS_PER_WINDOW;
  if (ok) recent.push(now);
  if (addsBy.size > 5_000) addsBy.clear();
  addsBy.set(who, recent);
  return ok;
}
/** How many channels oddie watches on YouTube at most, oddie's own not counted. */
const maxChannels = () => Math.max(1, Math.floor(Number(process.env.YOUTUBE_MAX_CHANNELS) || 10));
/** A check reads a chat this long, one check at a time. */
const checkReadMs = () => Math.max(10, Math.floor(Number(process.env.YOUTUBE_CHECK_MS) || 12_000));
const CHECK_GAP_MS = 20_000;
let lastCheckAt = 0;

interface Reader {
  channelId: string; slug: string; liveChatId: string;
  abort: AbortController; startedAt: number; seen: Set<string>; pageToken: string | null; done: boolean;
}
const readers = new Map<string, Reader>();
const SEEN_MAX = 5_000;

/** Test seam. */
export function _resetYouTube(): void {
  for (const r of readers.values()) r.abort.abort();
  readers.clear(); liveChats.clear(); onAir.clear(); awake.clear(); videoState.clear(); looked.clear(); sentByUs.clear(); quotaRestUntil = 0;
  addsBy.clear(); publicDay = ""; publicSpent = 0; lastCheckAt = 0; feedDownSaidAt = 0;
}

/** A channel's newest videos: its public feed (free), or its uploads playlist (1 unit) while the feed is down. */
async function newestVideos(api: YouTubeApi, voice: LiveChannel, channelId: string, log: Log): Promise<{ ids: string[]; source: "feed" | "uploads" }> {
  try { return { ids: await api.recentVideoIds(channelId), source: "feed" }; }
  catch (e) {
    if (Date.now() - feedDownSaidAt > 60 * 60_000) {
      feedDownSaidAt = Date.now();
      log("youtube feed down, reading uploads playlists instead", { status: status(e) ?? null });
    }
    return { ids: await withVoice(api, voice, (t) => api.uploadsVideoIds(t, channelId)), source: "uploads" };
  }
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
    // Until the owner or a mod has used a command here, only they reach the
    // engine: a viewer in a chat somebody merely pasted cannot make oddie talk.
    const asleep = !awake.has(r.channelId);
    if (asleep && !msg.canRun && !msg.fromOddie) continue;
    const action = await handleChat(msg, engine).catch((e) => { log("youtube chat failed", { err: (e as Error).message }); return "error"; });
    const command = action !== "chat" && action !== "own" && action !== "error";
    if (asleep && msg.canRun && command) { awake.add(r.channelId); log("youtube chat woke oddie", { channel: r.channelId, action }); }
    // What a command did, never what anybody wrote: ordinary chat is not logged.
    if (action !== "chat" && action !== "own") log("youtube chat command", { channel: r.channelId, action, runner: msg.canRun });
  }
}

/** One live chat, read over its long connection until the stream ends or the watcher stops it. */
function startReader(api: YouTubeApi, voice: LiveChannel, ch: { channelId: string; slug: string }, liveChatId: string, engine: LiveDeps, log: Log, now: number): Reader {
  const r: Reader = { channelId: ch.channelId, slug: ch.slug, liveChatId, abort: new AbortController(), startedAt: now, seen: new Set(), pageToken: null, done: false };
  readers.set(ch.channelId, r);
  /* WHAT READING COSTS. Every connection is 5 units, and over REST YouTube
     closes one after about ten seconds (measured 13 Oct 2026), so a chat is
     read over many. Counted here and said every half hour and at the end, so
     the units a stream really takes are in the log. */
  let conns = 0, openMs = 0, since = Date.now();
  const tally = (why: string) => {
    if (conns) log("youtube chat reading", { channel: r.channelId, why, connections: conns, units: conns * 5, avgSeconds: Math.round(openMs / conns / 100) / 10, minutes: Math.round((Date.now() - since) / 60_000) });
    conns = 0; openMs = 0; since = Date.now();
  };
  void (async () => {
    let backoff = 2_000;
    while (!r.abort.signal.aborted) {
      const t0 = Date.now();
      try {
        const end = await withVoice(api, voice, (t) => api.streamChat(t, liveChatId, r.pageToken, (p) => readPage(r, p, voice.channelId, engine, log), r.abort.signal));
        conns++; openMs += Date.now() - t0;
        if (Date.now() - since > 30 * 60_000) tally("half hour");
        r.pageToken = end.pageToken;
        if (end.offline) { r.done = true; tally("stream ended"); log("youtube chat ended with the stream", { channel: r.channelId }); break; }
        backoff = 2_000;
        await sleep(2_000, r.abort.signal);   // the connection closed with the chat still on: open it again
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
    tally(r.done ? "closed" : "stopped");
  })();
  return r;
}

function stopReader(r: Reader): void {
  r.abort.abort();
  if (readers.get(r.channelId) === r) readers.delete(r.channelId);
}

/**
 * The watcher's pass, once a minute: each connected channel's newest videos
 * from its public feed, one videos.list for those that may be live (1 unit, and
 * none at all when every one is a known recording), and for a channel on air
 * its chat read over one connection. A channel that went off air has its
 * reader stopped. Nobody is greeted: oddie's first line in a chat answers the
 * owner's or a mod's first command.
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
    const last = looked.get(c.channelId);
    if (last && now - last.at < lookEveryMs()) { idsOf.set(c.channelId, last.ids); continue; }
    try {
      const { ids } = await newestVideos(api, voice, c.channelId, w.log);
      looked.set(c.channelId, { at: now, ids });
      idsOf.set(c.channelId, ids);
    } catch (e) {
      if (spent(e) && reason(e) !== "rateLimitExceeded") {
        quotaRestUntil = now + QUOTA_REST_MS;
        w.log("youtube quota spent, the watcher waits an hour");
        return { live: 0, reading: readers.size };
      }
      w.log("youtube videos of a channel not read", { channel: c.channelId, err: (e as Error).message.slice(0, 160) });
      idsOf.set(c.channelId, last?.ids ?? []);
    }
  }
  const ids = [...new Set([...idsOf.values()].flat())].filter((id) => videoState.get(id) !== "none");
  let videos: LiveVideo[] = [];
  if (ids.length) {
    try { videos = await withVoice(api, voice, (t) => api.videosLive(t, ids)); }
    catch (e) {
      if (spent(e) && reason(e) !== "rateLimitExceeded") { quotaRestUntil = now + QUOTA_REST_MS; w.log("youtube quota spent, the watcher waits an hour"); }
      else w.log("youtube videos not read", { err: (e as Error).message.slice(0, 160) });
      // Nothing known: the readers stay as they are.
      return { live: 0, reading: readers.size };
    }
    // One YouTube does not answer for (removed, or made private) is done too.
    const answered = new Map(videos.map((v) => [v.videoId, v.state] as const));
    for (const id of ids) videoState.set(id, answered.get(id) ?? "none");
    if (videoState.size > VIDEOS_MAX) for (const k of [...videoState.keys()].slice(0, VIDEOS_MAX / 2)) videoState.delete(k);
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
    // A vote still open from before (a restart, a new stream) means the owner
    // already brought oddie in: its viewers can answer straight away.
    if (!awake.has(c.channelId) && await w.engine.store.current("youtube", c.channelId).catch(() => null)) awake.add(c.channelId);
    startReader(api, voice, { channelId: c.channelId, slug: c.slug }, v.liveChatId!, w.engine, w.log, now);
    w.log("youtube stream on air, oddie joins its chat", { channel: c.channelId, video: v.videoId });
  }
  return { live, reading: readers.size };
}

/* ------------------------------------------------------------ router -- */

const pending = new Map<string, { at: number }>();

/** A channel oddie is in, as the store keeps it, from what YouTube said; a token it had stays. */
async function keepChannel(found: YouTubeChannel, tokens: YouTubeTokens | null): Promise<{ before: LiveChannel | null }> {
  const before = await channelById("youtube", found.channelId).catch(() => null);
  await saveChannel({
    platform: "youtube", channelId: found.channelId, slug: found.handle, name: found.name, avatar: found.avatar,
    accessToken: tokens ? tokens.accessToken : before?.accessToken ?? null,
    refreshToken: tokens ? tokens.refreshToken : before?.refreshToken ?? null,
    tokenExpiresAt: tokens ? tokens.expiresAt : before?.tokenExpiresAt ?? null,
    active: true,
  });
  return { before };
}

export function youtubeRouter(d: YouTubeRouteDeps): Router {
  const r = express.Router();
  const base = d.appBaseUrl.replace(/\/+$/, "");
  const redirectUri = `${base}/live/youtube/callback`;
  const api = d.api ?? youtubeApi;
  const ready = () => d.api || youtubeConfigured();

  /** A streamer adds oddie by pasting their link on /live: this old address leads there. */
  r.get("/live/youtube/connect", (_req, res) => res.redirect(`${base}/live#youtube`));

  /** oddie's own channel, once: the account every line goes out from. */
  r.get("/live/youtube/voice", (_req, res) => {
    if (!ready()) return res.status(503).type("text").send("oddie for YouTube is almost here.");
    for (const [k, p] of pending) if (Date.now() - p.at > 10 * 60_000) pending.delete(k);
    const state = randomBytes(16).toString("hex");
    pending.set(state, { at: Date.now() });
    res.redirect(authorizeUrl({ state, redirectUri }));
  });

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
      const isVoice = !!voiceHandle() && who.handle.toLowerCase() === voiceHandle();
      // Only oddie's own channel keeps a token. Another channel signed in at this
      // door is added the way a pasted link adds it.
      await keepChannel(who, isVoice ? t : null);
      if (isVoice) {
        d.log(t.refreshToken ? "youtube voice connected" : "youtube voice connected WITHOUT a refresh token, sign in at /live/youtube/voice again", { channel: who.handle });
        return res.redirect(`${base}/live/youtube/${encodeURIComponent(who.handle)}?voice=1`);
      }
      d.log("youtube channel added at oddie's own door", { channel: who.handle });
      res.redirect(`${base}/live/youtube/${encodeURIComponent(who.handle)}?added=1`);
    } catch (e) {
      d.log("youtube connect failed", { err: (e as Error).message });
      res.redirect(`${base}/live?youtube=failed`);
    }
  });

  /**
   * A streamer pastes their channel's link: oddie looks it up and watches it
   * from then on. Answers with the channel's page, or with which of a short list
   * of things to tell the streamer (`error`): link, voice, busy, full, soon,
   * retry.
   */
  r.post("/live/youtube/add", express.json({ limit: "4kb" }), async (req, res) => {
    const ref = parseChannelRef(String((req.body as { channel?: unknown } | undefined)?.channel ?? ""));
    if (!ref) return res.status(400).json({ ok: false, error: "link" });
    const voice = ready() ? await voiceChannel() : null;
    if (!voice) return res.status(503).json({ ok: false, error: "soon" });
    const now = Date.now();
    if (!addAllowed(req.ip ?? "", now) || !spendPublic(ref.by === "video" ? 2 : 1, now)) return res.status(429).json({ ok: false, error: "busy" });
    let found: YouTubeChannel | null;
    try { found = await withVoice(api, voice, (t) => api.channelLookup(t, ref)); }
    catch (e) {
      d.log("youtube channel lookup failed", { err: (e as Error).message.slice(0, 160) });
      return res.status(502).json({ ok: false, error: "retry" });
    }
    if (!found) return res.status(404).json({ ok: false, error: "link" });
    if (found.channelId === voice.channelId) return res.status(400).json({ ok: false, error: "voice" });
    const was = await channelById("youtube", found.channelId).catch(() => null);
    if (!was?.active) {
      const n = (await liveStore.channels().catch(() => [])).filter((c) => c.platform === "youtube" && c.channelId !== voice.channelId).length;
      if (n >= maxChannels()) {
        d.log("youtube channel limit reached", { limit: maxChannels() });
        return res.status(429).json({ ok: false, error: "full" });
      }
    }
    try { await keepChannel(found, null); }
    catch (e) {
      d.log("youtube channel not saved", { channel: found.handle, err: (e as Error).message.slice(0, 160) });
      return res.status(500).json({ ok: false, error: "retry" });
    }
    d.log(was?.active ? "youtube channel added again" : "youtube channel added", { channel: found.handle });
    res.json({ ok: true, slug: found.handle, url: `/live/youtube/${encodeURIComponent(found.handle)}?added=1` });
  });

  /**
   * Can oddie see this channel's stream and read its chat? A short look, the
   * way the watcher would take it: the channel's newest videos (or the stream
   * link pasted), which one is live, and its chat read for a few seconds.
   * Answers with counts only, never what anybody wrote. One look at a time.
   */
  r.get("/live/youtube/check", async (req, res) => {
    const ref = parseChannelRef(String(req.query.channel ?? ""));
    if (!ref) return res.status(400).json({ ok: false, error: "link" });
    const voice = ready() ? await voiceChannel() : null;
    if (!voice) return res.status(503).json({ ok: false, error: "soon" });
    const now = Date.now();
    if (now - lastCheckAt < CHECK_GAP_MS || !spendPublic(8, now)) return res.status(429).json({ ok: false, error: "busy" });
    lastCheckAt = now;
    try {
      const found = await withVoice(api, voice, (t) => api.channelLookup(t, ref));
      if (!found) return res.status(404).json({ ok: false, error: "link" });
      const seen = ref.by === "video" ? { ids: [ref.id], source: "link" as const } : await newestVideos(api, voice, found.channelId, d.log);
      const ids = seen.ids;
      const videos = ids.length ? await withVoice(api, voice, (t) => api.videosLive(t, ids)) : [];
      const v = videos.find((x) => x.state === "live" && x.liveChatId && x.channelId === found.channelId);
      let chat: { pages: number; items: number; readable: number; ms: number } | null = null;
      if (v) {
        const t0 = Date.now(), stop = new AbortController();
        const timer = setTimeout(() => stop.abort(), checkReadMs());
        let pages = 0, items = 0, readable = 0;
        try {
          await withVoice(api, voice, (t) => api.streamChat(t, v.liveChatId!, null, (pg) => {
            pages++;
            for (const it of pg.items ?? []) {
              items++;
              if (chatFromYouTube(it, { channelId: found.channelId, slug: found.handle }, voice.channelId)) readable++;
            }
          }, stop.signal));
        } catch (e) { if (!stop.signal.aborted) throw e; }
        finally { clearTimeout(timer); }
        chat = { pages, items, readable, ms: Date.now() - t0 };
      }
      d.log("youtube check", { channel: found.handle, source: seen.source, videos: ids.length, live: v?.videoId ?? null, pages: chat?.pages ?? null, items: chat?.items ?? null, readable: chat?.readable ?? null, ms: chat?.ms ?? null });
      res.json({ ok: true, channel: { handle: found.handle, name: found.name }, source: seen.source, videos: ids.length, live: v ? { videoId: v.videoId } : null, chat });
    } catch (e) {
      d.log("youtube check failed", { err: (e as Error).message.slice(0, 160) });
      res.status(502).json({ ok: false, error: "retry", reason: reason(e) || null });
    }
  });

  /** The channel's page and its standings: shared with Kick and Twitch. */
  addChannelRoutes(r, "youtube", d);
  return r;
}
