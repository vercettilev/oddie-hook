/**
 * oddie in X live chat: the door a streamer walks through once, the stream
 * that carries every connected streamer's chat, and how a line gets back in.
 * The page and the standings are the routes every platform shares
 * (src/live/channelRoutes); the rules are the engine's (src/live/calls.ts),
 * run votes only, as on YouTube: no market, no 2%, no link.
 *
 * THE STREAMER DOES ONE THING: signs in with X at /live/x/connect and allows
 * oddie to read their broadcasts' chat (broadcast.read). From then on every
 * broadcast they own sends its chat here; nothing per stream, nothing
 * installed. Told to us by X (Mike Rosinsky, 15 Oct 2026): broadcast chat
 * events are free when the broadcaster authorizes the app with OAuth 2.0.
 *
 * HOW CHAT ARRIVES. One subscription per streamer to the X Activity API's
 * `broadcast.chat` (and `broadcast.start`/`broadcast.end`, which say when a
 * stream is on air), created with the streamer's own token, delivered over
 * the app's one persistent stream (GET /2/activity/stream, app bearer). No
 * webhook: nothing to register, no CRC to answer.
 *
 * HOW A LINE GOES OUT. POST /2/broadcasts/{id}/chat as @oddiefun, on the reply
 * bot's own token (src/x/client.ts). ONE CHAIN FOR @ODDIEFUN: X revokes an
 * account's earlier tokens for this app the moment it consents again, and on
 * 16 Oct a second chain for this file killed the reply bot's (every refresh
 * then failed with invalid_request). So /live/x/voice asks for everything the
 * bot needs plus broadcast.write, and its token becomes the bot's.
 *
 * Both sign-ins come back through the callback X already knows,
 * /api/auth/twitter/callback: server.ts hands this file the states it issued.
 */
import express, { type Response, type Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { handleChat, type ChatMessage, type LiveDeps } from "../live/calls.js";
import { accessToken, adoptTokens, botUserId, BOT_SCOPES, xConfigured } from "./client.js";
import { addChannelRoutes, type ChannelPageDeps } from "../live/channelRoutes.js";
import { paced, patiently } from "../live/pace.js";
import { channelById, liveStore, saveChannel } from "../store/live.js";
import { botStateGet, botStateSet } from "../store/markets.js";
import { splitForChat } from "../youtube/client.js";

const API = "https://api.x.com/2";
const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
/** users.read cannot be asked for without tweet.read. offline.access keeps the
 *  token alive past two hours, for subscribing again later. */
const STREAMER_SCOPE = "tweet.read users.read broadcast.read offline.access";
/** X's limit for one chat line. */
export const X_CHAT_MAX = 140;
const CHAT_EVENTS = ["broadcast.chat", "broadcast.start", "broadcast.end"] as const;

const clientId = () => process.env.TWITTER_CLIENT_ID ?? "";
const clientSecret = () => process.env.TWITTER_CLIENT_SECRET ?? "";
const appBearer = () => process.env.X_APP_BEARER_TOKEN ?? "";
/** oddie's own account on X, the one every line goes out from. */
export const xVoiceHandle = (): string => (process.env.X_LIVE_VOICE ?? "oddiefun").replace(/^@/, "").toLowerCase();
/** Accounts that run calls in every connected stream's chat as its host does,
 *  so a streamer busy playing never has to type the !call (Lev, 26 Oct, before
 *  Showdown's first stream). By user id, which never passes to someone else as
 *  a handle can: Lev's own @levvercetti unless X_LIVE_OPERATORS lists others. */
const xOperators = (): string[] => (process.env.X_LIVE_OPERATORS ?? "1218142562483085313").split(",").map((s) => s.trim()).filter(Boolean);

/** Everything missing, named, so the boot log says what to set. */
export function xLiveMissing(): string[] {
  const out: string[] = [];
  if (!clientId()) out.push("TWITTER_CLIENT_ID");
  if (!clientSecret()) out.push("TWITTER_CLIENT_SECRET");
  if (!appBearer()) out.push("X_APP_BEARER_TOKEN");
  return out;
}
export const xLiveConfigured = (): boolean => xLiveMissing().length === 0;

/* ---------------------------------------------------------------- api -- */

export interface XTokens { accessToken: string; refreshToken: string | null; expiresAt: number }
export interface XUser { id: string; username: string; name: string | null; avatar: string | null }
export interface XActivityEvent {
  event_uuid?: string; created_at?: string; event_type?: string;
  filter?: { user_id?: string };
  payload?: Record<string, unknown>;
}

export class XLiveError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) { super(message); this.name = "XLiveError"; }
}

async function call<T>(url: string, init: RequestInit & { token: string }, what: string): Promise<T> {
  const { token, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: { authorization: `Bearer ${token}`, ...(rest.body ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) },
    signal: rest.signal ?? AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => null) as T & { errors?: Array<{ message?: string; title?: string; detail?: string }>; title?: string; detail?: string } | null;
  if (!res.ok) {
    const e = body?.errors?.[0];
    throw new XLiveError(res.status, `${what} ${res.status}: ${e?.message ?? e?.detail ?? e?.title ?? body?.detail ?? body?.title ?? "unknown"}`, body);
  }
  return body as T;
}

async function tokenRequest(form: Record<string, string>): Promise<XTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${clientId()}:${clientSecret()}`).toString("base64")}`,
    },
    body: new URLSearchParams({ ...form, client_id: clientId() }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await res.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) throw new XLiveError(res.status, `x token ${res.status}: ${j.error_description ?? j.error ?? "no access_token"}`);
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? null, expiresAt: Date.now() + (j.expires_in ?? 7200) * 1000 };
}

/** Everything oddie asks of X here, in one place: the tests replace it. */
export interface XLiveApi {
  exchangeCode(code: string, verifier: string, redirectUri: string): Promise<XTokens>;
  me(token: string): Promise<XUser>;
  /** One Activity API subscription for this user. "duplicate" when it already exists. */
  subscribe(token: string, userId: string, eventType: string): Promise<string>;
  /** A line into a live broadcast's chat; the message id X gives back, if any. */
  sendChat(token: string, broadcastId: string, text: string, replyTo?: string): Promise<string | null>;
  /** The app's activity stream, one event at a time, until it closes or `signal` aborts. */
  stream(onEvent: (e: XActivityEvent) => Promise<void> | void, signal: AbortSignal): Promise<void>;
}

/** Nothing arrives for this long (X sends a blank keep-alive line now and then): the connection is dead. */
const STREAM_SILENCE_MS = 90_000;

export const xLiveApi: XLiveApi = {
  exchangeCode: (code, verifier, redirectUri) => tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }),
  async me(token) {
    const j = await call<{ data?: { id?: string; username?: string; name?: string; profile_image_url?: string } }>(
      `${API}/users/me?user.fields=profile_image_url`, { token }, "x users/me");
    if (!j.data?.id || !j.data.username) throw new XLiveError(502, "x users/me: no user");
    return { id: j.data.id, username: j.data.username, name: j.data.name ?? null, avatar: j.data.profile_image_url ?? null };
  },
  async subscribe(token, userId, eventType) {
    try {
      const j = await call<{ data?: { subscription_id?: string; subscription?: { subscription_id?: string } } }>(`${API}/activity/subscriptions`, {
        token, method: "POST", body: JSON.stringify({ event_type: eventType, filter: { user_id: userId }, tag: `oddie ${eventType}` }),
      }, `x subscribe ${eventType}`);
      return j.data?.subscription?.subscription_id ?? j.data?.subscription_id ?? "created";
    } catch (e) {
      if (/duplicate/i.test(JSON.stringify((e as XLiveError).body ?? "")) || /duplicate/i.test((e as Error).message)) return "duplicate";
      throw e;
    }
  },
  async sendChat(token, broadcastId, text, replyTo) {
    const j = await call<{ data?: { success?: boolean; timestamp?: string } }>(`${API}/broadcasts/${encodeURIComponent(broadcastId)}/chat`, {
      token, method: "POST", body: JSON.stringify(replyTo ? { text, reply_to: replyTo } : { text }),
    }, "x broadcast chat");
    return j.data?.timestamp ?? null;
  },
  async stream(onEvent, signal) {
    const res = await fetch(`${API}/activity/stream`, { headers: { authorization: `Bearer ${appBearer()}` }, signal });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new XLiveError(res.status, `x activity stream ${res.status}: ${text.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let quiet: ReturnType<typeof setTimeout> | null = null;
    const hush = () => { if (quiet) clearTimeout(quiet); quiet = setTimeout(() => void reader.cancel().catch(() => {}), STREAM_SILENCE_MS); };
    hush();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hush();
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;   // keep-alive
          let j: { data?: XActivityEvent } | null = null;
          try { j = JSON.parse(line); } catch { continue; }
          if (j?.data) await onEvent(j.data);
        }
      }
    } finally { if (quiet) clearTimeout(quiet); }
  },
};

/* -------------------------------------------------------------- state -- */

type Log = (line: string, extra?: Record<string, unknown>) => void;
const status = (e: unknown) => (e as { status?: number }).status;

/** The broadcast each streamer is live in now, from its start event or its first chat line. */
const liveIn = new Map<string, string>();
/** Streamers whose last broadcast was seen ending. */
const ended = new Set<string>();
/** Events already handled: the stream may hand one over twice around a reconnect. */
const seenEvents = new Set<string>();
const SEEN_MAX = 10_000;
/** A chat line older than this when it arrives is history, not a command now. */
const STALE_MS = 2 * 60_000;
/** Each streamer's page name, looked up once. */
const slugOf = new Map<string, string>();
/** Each live streamer's picture: the live thumbnail broadcast.start hands over,
 *  a full frame renewed about every two seconds (measured 16 Oct). Kept in the
 *  store too, so a restart mid-stream still has it; gone when the stream ends. */
const thumbOf = new Map<string, string>();
const thumbKey = (channelId: string) => `x_live_thumb:${channelId}`;

/** The picture of a streamer's live broadcast now, as a URL, or null (src/games/screen.ts). */
export async function xThumbnail(channelId: string): Promise<string | null> {
  if (!liveIn.has(channelId) && ended.has(channelId)) return null;
  const known = thumbOf.get(channelId);
  if (known) return known;
  const stored = await botStateGet(thumbKey(channelId)).catch(() => null);
  if (stored) thumbOf.set(channelId, stored);
  return stored || null;
}

/** Streamers who send the same stream to Twitch at once, by X user id and
 *  Twitch login (Lev, 27 Oct). Aleksa's first X broadcast through Restream
 *  never sent broadcast.start, so there was no thumbnail to read, while its
 *  chat came in; the same picture was live on Twitch, read there as a full
 *  frame. X_TWITCH_TWINS lists them as id:login, comma separated. */
const xTwitchTwins = (): Map<string, string> => new Map(
  (process.env.X_TWITCH_TWINS ?? "1084242319:aleksaflamingo").split(",")
    .map((pair) => pair.split(":").map((s) => s.trim()))
    .filter(([id, login, rest]) => rest === undefined && /^\d+$/.test(id ?? "") && /^\w{3,25}$/.test(login ?? ""))
    .map(([id, login]) => [id, login.toLowerCase()] as [string, string]),
);
export const xTwitchTwin = (channelId: string): string | null => xTwitchTwins().get(channelId) ?? null;
/** Streamers whose picture came from Twitch, said once in the log. */
const twinSaid = new Set<string>();

/** The picture the screen reads for an X stream: its live thumbnail, or the
 *  same stream's Twitch frame when X never said where its thumbnail is. */
export async function xPicture(
  channelId: string,
  d: { fetchPicture: (url: string) => Promise<Buffer | null>; twitchFrame?: (login: string) => Promise<Buffer | null>; log?: Log },
): Promise<Buffer | null> {
  if (!liveIn.has(channelId) && ended.has(channelId)) return null;
  const url = await xThumbnail(channelId);
  const own = url ? await d.fetchPicture(url).catch(() => null) : null;
  if (own) return own;
  const login = xTwitchTwin(channelId);
  if (!login || !d.twitchFrame) return null;
  const jpeg = await d.twitchFrame(login).catch(() => null);
  if (jpeg && !twinSaid.has(channelId)) { twinSaid.add(channelId); d.log?.("x picture from twitch", { channel: channelId, login }); }
  return jpeg;
}

/** Test seam. */
export function _resetXLive(): void {
  liveIn.clear(); ended.clear(); seenEvents.clear(); slugOf.clear(); thumbOf.clear(); pending.clear(); finished.clear(); twinSaid.clear();
}
/** Test seam: the broadcast a streamer is live in, as oddie knows it. */
export const _liveIn = (channelId: string): string | undefined => liveIn.get(channelId);

/* -------------------------------------------------------------- voice -- */

/** @oddiefun, as the bot holds it: one token chain for replies and live chat. */
export interface XVoice {
  /** Set up at all (the bot's client, user id and seed). */
  ready(): boolean;
  /** A token that speaks as @oddiefun; `force` refreshes it. */
  token(force?: boolean): Promise<string>;
  /** @oddiefun's user id: its own lines coming back are never commands. */
  userId(): string | null;
  /** A fresh consent from /live/x/voice becomes the account's one chain. */
  adopt(t: { accessToken: string; refreshToken: string; expiresAt: number }): Promise<void>;
}
export const botVoice: XVoice = {
  ready: () => xConfigured(),
  token: (force) => accessToken(force),
  userId: () => botUserId() || null,
  adopt: (t) => adoptTokens(t),
};

async function withVoice<T>(voice: XVoice, f: (token: string) => Promise<T>): Promise<T> {
  try { return await f(await voice.token()); }
  catch (e) {
    if (status(e) !== 401) throw e;
    return f(await voice.token(true));
  }
}

/* ------------------------------------------------------------- engine -- */

/**
 * The engine's hands on X. Every line goes out from @oddiefun into the
 * broadcast the streamer is live in, cut to X's 140 characters, a second
 * apart. No pins, no market, no link: X's live chat refuses any line with a
 * link in it (400 "message cannot contain urls", Lev's live on 16 Oct), and a
 * market is nothing without its link. So X Live runs votes, settled by the
 * streamer or off the screen (src/live/screenCalls.ts).
 */
export function xEngineDeps(d: { log: Log }, api: XLiveApi = xLiveApi, voice: XVoice = botVoice): LiveDeps {
  const say = async (_p: unknown, channelId: string, text: string, replyTo?: string): Promise<string | void> => {
    const broadcast = liveIn.get(channelId);
    if (!broadcast) return;   // off air: no chat to say it in
    if (!voice.ready()) { d.log("x voice not set up, line not said", { channel: channelId }); return; }
    let first: string | null = null;
    for (const [i, line] of splitForChat(text, X_CHAT_MAX).entries()) {
      const id = await paced(`x:${channelId}`, () => patiently(() => withVoice(voice, (t) => api.sendChat(t, broadcast, line, i === 0 ? replyTo : undefined))));
      first ??= id;
    }
    return first ?? undefined;
  };
  return {
    store: liveStore,
    now: () => Date.now(),
    say,
    standingsUrl: async () => "",
    streamLive: async (_p, channelId) => (liveIn.has(channelId) ? true : ended.has(channelId) ? false : null),
    votesOnly: true,
    log: d.log,
  };
}

/* ------------------------------------------------------------- stream -- */

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** A broadcast.chat event as the engine reads a chat line, or null when it is not one. */
export function chatFromX(ev: XActivityEvent, ch: { slug: string } | null, voiceId: string | null): ChatMessage | null {
  const owner = str(ev.filter?.user_id);
  const p = ev.payload ?? {};
  const author = ((p.author as { data?: Record<string, unknown> } | undefined)?.data) ?? {};
  const messageId = str(p.message_id), text = str(p.message), senderId = str(author.id);
  if (!owner || !messageId || !text || !senderId) return null;
  return {
    platform: "x",
    channelId: owner,
    messageId,
    senderId,
    senderName: str(author.username) ?? senderId,
    // X reports the host as is_moderator false in their own broadcast.
    canRun: senderId === owner || p.is_moderator === true || xOperators().includes(senderId),
    text,
    channelSlug: ch?.slug,
    fromOddie: voiceId !== null && senderId === voiceId,
  };
}

/* HOW OFTEN AN X STREAM'S PICTURE CHANGES. broadcast.start hands over a live
   thumbnail URL. Whether it can stand in for frames (a moment read off the
   stream, as src/live/frameCalls.ts does on Twitch and Kick) depends on how
   often it is refreshed, which X does not document. So for the first minutes
   of a broadcast it is fetched on a beat and every change is logged. */
const probing = new Set<string>();
export async function probeThumbnail(url: string, broadcast: string, log: Log, o: {
  everyMs?: number; forMs?: number; fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void>;
} = {}): Promise<{ fetches: number; changes: number }> {
  const everyMs = o.everyMs ?? 15_000, forMs = o.forMs ?? 5 * 60_000;
  const get = o.fetcher ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (probing.has(broadcast)) return { fetches: 0, changes: 0 };
  probing.add(broadcast);
  let fetches = 0, changes = 0, last = "", lastAt = 0;
  const gaps: number[] = [];
  try {
    for (let t = 0; t <= forMs; t += everyMs) {
      if (t) await sleep(everyMs);
      try {
        const res = await get(url, { signal: AbortSignal.timeout(10_000) });
        const body = Buffer.from(await res.arrayBuffer());
        fetches++;
        const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
        if (fetches === 1) log("x thumbnail first", { broadcast, status: res.status, bytes: body.length, type: res.headers.get("content-type"), cache: res.headers.get("cache-control"), modified: res.headers.get("last-modified") });
        if (hash !== last) {
          if (last) { changes++; gaps.push(Math.round((t - lastAt) / 1000)); log("x thumbnail changed", { broadcast, atSecond: Math.round(t / 1000), bytes: body.length }); }
          last = hash; lastAt = t;
        }
      } catch (e) { log("x thumbnail not read", { broadcast, err: (e as Error).message.slice(0, 120) }); }
    }
  } finally { probing.delete(broadcast); }
  log("x thumbnail probe done", { broadcast, fetches, changes, everySeconds: everyMs / 1000, gapsSeconds: gaps.join(",") || null });
  return { fetches, changes };
}

/** One event off the stream. */
export async function onXEvent(ev: XActivityEvent, w: { engine: LiveDeps; log: Log; now?: () => number; voice?: XVoice }): Promise<string> {
  const id = str(ev.event_uuid);
  if (id) {
    if (seenEvents.has(id)) return "seen";
    seenEvents.add(id);
    if (seenEvents.size > SEEN_MAX) for (const k of [...seenEvents].slice(0, SEEN_MAX / 2)) seenEvents.delete(k);
  }
  const owner = str(ev.filter?.user_id);
  if (!owner) return "ignored";
  const broadcast = str(ev.payload?.broadcast_id);
  switch (ev.event_type) {
    case "broadcast.start":
      if (broadcast) liveIn.set(owner, broadcast);
      ended.delete(owner);
      // The live thumbnail X hands over: logged to learn how often it changes,
      // the way to read a moment off an X stream (frames) without scraping.
      w.log("x broadcast on air", { channel: owner, broadcast, thumbnail: str(ev.payload?.thumbnail_url) });
      {
        const thumb = str(ev.payload?.thumbnail_url);
        if (thumb && /^https:\/\//i.test(thumb)) {
          thumbOf.set(owner, thumb);
          await botStateSet(thumbKey(owner), thumb).catch(() => {});
        }
      }
      return "start";
    case "broadcast.end":
      if (!broadcast || liveIn.get(owner) === broadcast) liveIn.delete(owner);
      ended.add(owner);
      thumbOf.delete(owner);
      await botStateSet(thumbKey(owner), "").catch(() => {});
      w.log("x broadcast ended", { channel: owner, broadcast });
      return "end";
    case "broadcast.chat": {
      // A chat line is proof the broadcast is on air, even when its start was missed.
      if (broadcast) { liveIn.set(owner, broadcast); ended.delete(owner); }
      const at = Date.parse(str(ev.created_at) ?? "");
      if (Number.isFinite(at) && at < (w.now ?? Date.now)() - STALE_MS) return "stale";
      let slug = slugOf.get(owner);
      if (!slug) {
        const ch = await channelById("x", owner).catch(() => null);
        if (!ch?.active) return "unknown-channel";
        slug = ch.slug;
        slugOf.set(owner, slug);
      }
      const msg = chatFromX(ev, { slug }, (w.voice ?? botVoice).userId());
      if (!msg) return "unreadable";
      const action = await handleChat(msg, w.engine).catch((e) => { w.log("x chat failed", { err: (e as Error).message }); return "error"; });
      // What a command did, never what anybody wrote: ordinary chat is not logged.
      if (action !== "chat" && action !== "own") w.log("x chat command", { channel: owner, action, runner: msg.canRun });
      return action;
    }
    default:
      return "ignored";
  }
}

/**
 * The app's one activity stream, kept open: every connected streamer's chat
 * comes over it. Reconnects with a growing wait; X allows few connections at
 * once, so a refusal for too many (a deploy's old instance still holding one)
 * waits a full minute.
 */
export function startXStream(w: { engine: LiveDeps; log: Log; api?: XLiveApi; voice?: XVoice }): () => void {
  const api = w.api ?? xLiveApi;
  const stop = new AbortController();
  void (async () => {
    let backoff = 2_000;
    while (!stop.signal.aborted) {
      const t0 = Date.now();
      try {
        w.log("x activity stream connecting");
        await api.stream((ev) => onXEvent(ev, { engine: w.engine, log: w.log, voice: w.voice }).then(() => {}), stop.signal);
        if (stop.signal.aborted) break;
        w.log("x activity stream closed, reconnecting", { seconds: Math.round((Date.now() - t0) / 1000) });
      } catch (e) {
        if (stop.signal.aborted) break;
        w.log("x activity stream dropped", { status: status(e) ?? null, err: (e as Error).message.slice(0, 200) });
        if (status(e) === 429) backoff = Math.max(backoff, 60_000);
      }
      // A connection that lived a while was healthy: start the waits over.
      if (Date.now() - t0 > 5 * 60_000) backoff = 2_000;
      await new Promise<void>((ok) => { const t = setTimeout(ok, backoff); stop.signal.addEventListener("abort", () => { clearTimeout(t); ok(); }, { once: true }); });
      backoff = Math.min(backoff * 2, 5 * 60_000);
    }
  })();
  return () => stop.abort();
}

/* ------------------------------------------------------------- router -- */

interface Pending { kind: "streamer" | "voice"; verifier: string; at: number }
const pending = new Map<string, Pending>();
const PENDING_TTL_MS = 10 * 60_000;
/* Where each finished sign-in sent the person. X's return can load twice (16 Oct,
   live: the second load found its state spent and fell through to the site's
   own sign-in, which said "expired" over a connection that had worked). */
const finished = new Map<string, { at: number; to: string }>();

export interface XLiveRouteDeps extends ChannelPageDeps {
  appBaseUrl: string;
  /** The callback X already knows: /api/auth/twitter/callback on the public base. */
  redirectUri: string;
  /** Test seams. */
  api?: XLiveApi;
  voice?: XVoice;
}

export function xLiveRouter(d: XLiveRouteDeps): { router: Router; callback(state: string, query: Record<string, unknown>, res: Response): Promise<boolean> } {
  const r = express.Router();
  const base = d.appBaseUrl.replace(/\/+$/, "");
  const api = d.api ?? xLiveApi;
  const voice = d.voice ?? botVoice;
  const ready = () => Boolean(d.api) || xLiveConfigured();

  const authorize = (kind: Pending["kind"]) => (_req: express.Request, res: Response) => {
    if (!ready()) return res.status(503).type("text").send("oddie for X live is almost here.");
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [k, p] of pending) if (p.at < cutoff) pending.delete(k);
    const verifier = randomBytes(48).toString("base64url");
    const state = `xl_${randomBytes(24).toString("base64url")}`;
    pending.set(state, { kind, verifier, at: Date.now() });
    const q = new URLSearchParams({
      response_type: "code", client_id: clientId() || "test", redirect_uri: d.redirectUri,
      scope: kind === "voice" ? BOT_SCOPES : STREAMER_SCOPE, state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    });
    res.redirect(`${AUTHORIZE_URL}?${q}`);
  };

  /** A streamer, once: sign in with X and allow oddie to read your broadcasts' chat. */
  r.get("/live/x/connect", authorize("streamer"));
  /** oddie's own account: the one token the reply bot and X live chat both speak with. */
  r.get("/live/x/voice", authorize("voice"));

  /** The states this file issued (they start xl_), back through X's one registered callback. False: not ours. */
  async function callback(state: string, query: Record<string, unknown>, res: Response): Promise<boolean> {
    const done = finished.get(state);
    if (done && Date.now() - done.at < PENDING_TTL_MS) { res.redirect(done.to); return true; }
    const p = pending.get(state);
    // One of ours that this process never saw (a restart in between): try again from /live.
    if (!p) { res.redirect(`${base}/live?x=expired`); return true; }
    pending.delete(state);
    const go = (to: string) => {
      for (const [k, f] of finished) if (Date.now() - f.at > PENDING_TTL_MS) finished.delete(k);
      finished.set(state, { at: Date.now(), to });
      res.redirect(to);
    };
    const fail = (why: string) => go(`${base}/live?x=${why}`);
    if (typeof query.error === "string") { fail("declined"); return true; }
    const code = typeof query.code === "string" ? query.code : "";
    if (!code || Date.now() - p.at > PENDING_TTL_MS) { fail("expired"); return true; }
    try {
      const t = await api.exchangeCode(code, p.verifier, d.redirectUri);
      const who = await api.me(t.accessToken);
      const id = voice.userId();
      const isVoice = id ? who.id === id : who.username.toLowerCase() === xVoiceHandle();
      if (p.kind === "voice" && !isVoice) {
        d.log("x voice sign-in by another account, refused", { handle: who.username });
        fail("voice"); return true;
      }
      // oddie's own account at the streamers' door would trade its writing token
      // for a reading one (16 Oct, live: the browser was still signed in as
      // @oddiefun). Nothing is saved; the person is told to switch accounts.
      if (p.kind === "streamer" && isVoice) {
        d.log("x streamer door used by oddie's own account, nothing changed", { handle: who.username });
        fail("is-voice"); return true;
      }
      if (p.kind === "voice") {
        if (!t.refreshToken) {
          d.log("x voice consent came back WITHOUT a refresh token, nothing changed", { handle: who.username });
          fail("failed"); return true;
        }
        // The consent that just happened revoked the account's older tokens:
        // this one is now the bot's and the chat's.
        await voice.adopt({ accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt });
        d.log("x voice connected: replies and X live chat share this token", { handle: who.username });
        go(`${base}/live/x/${encodeURIComponent(who.username)}?voice=1`);
        return true;
      }
      await saveChannel({
        platform: "x", channelId: who.id, slug: who.username, name: who.name, avatar: who.avatar,
        accessToken: t.accessToken, refreshToken: t.refreshToken, tokenExpiresAt: t.expiresAt, active: true,
      });
      slugOf.set(who.id, who.username);
      // Chat is the one that matters; start and end only say when the stream is on air.
      const subs: Record<string, string> = {};
      for (const ev of CHAT_EVENTS) {
        try { subs[ev] = await api.subscribe(t.accessToken, who.id, ev); }
        catch (e) {
          d.log("x subscription failed", { handle: who.username, event: ev, status: status(e) ?? null, err: (e as Error).message.slice(0, 200) });
          if (ev === "broadcast.chat") { fail("subscribe"); return true; }
        }
      }
      d.log("x channel connected", { handle: who.username, ...subs });
      // Votes only, so no wallet to offer: the page says how to start one.
      go(`${base}/live/x/${encodeURIComponent(who.username)}?added=1`);
    } catch (e) {
      d.log("x connect failed", { status: status(e) ?? null, err: (e as Error).message.slice(0, 200) });
      fail("failed");
    }
    return true;
  }

  /** The channel's page and its standings: shared with every platform. */
  addChannelRoutes(r, "x", d);
  return { router: r, callback };
}
