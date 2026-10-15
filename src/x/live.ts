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
 * HOW A LINE GOES OUT. POST /2/broadcasts/{id}/chat as @oddiefun, with a token
 * oddie's own account grants once at /live/x/voice (broadcast.write). That
 * token lives on oddie's own row in live_channel, sealed, and is separate from
 * the reply bot's (src/x/client.ts), so neither can rotate the other's away.
 *
 * Both sign-ins come back through the callback X already knows,
 * /api/auth/twitter/callback: server.ts hands this file the states it issued.
 */
import express, { type Response, type Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { handleChat, type ChatMessage, type LiveDeps } from "../live/calls.js";
import { addChannelRoutes, type ChannelPageDeps } from "../live/channelRoutes.js";
import { paced, patiently } from "../live/pace.js";
import { channelById, channelBySlug, liveStore, saveChannel, type LiveChannel } from "../store/live.js";
import { splitForChat } from "../youtube/client.js";

const API = "https://api.x.com/2";
const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
/** users.read cannot be asked for without tweet.read. offline.access keeps the
 *  token alive past two hours, for subscribing again later. */
const STREAMER_SCOPE = "tweet.read users.read broadcast.read offline.access";
const VOICE_SCOPE = "tweet.read users.read broadcast.read broadcast.write offline.access";
/** X's limit for one chat line. */
export const X_CHAT_MAX = 140;
const CHAT_EVENTS = ["broadcast.chat", "broadcast.start", "broadcast.end"] as const;

const clientId = () => process.env.TWITTER_CLIENT_ID ?? "";
const clientSecret = () => process.env.TWITTER_CLIENT_SECRET ?? "";
const appBearer = () => process.env.X_APP_BEARER_TOKEN ?? "";
/** oddie's own account on X, the one every line goes out from. */
export const xVoiceHandle = (): string => (process.env.X_LIVE_VOICE ?? "oddiefun").replace(/^@/, "").toLowerCase();

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
  refreshTokens(refreshToken: string): Promise<XTokens>;
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
  refreshTokens: (refreshToken) => tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }),
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

/** Test seam. */
export function _resetXLive(): void {
  liveIn.clear(); ended.clear(); seenEvents.clear(); slugOf.clear(); pending.clear(); voiceRefresh = null;
}
/** Test seam: the broadcast a streamer is live in, as oddie knows it. */
export const _liveIn = (channelId: string): string | undefined => liveIn.get(channelId);

/* -------------------------------------------------------------- voice -- */

/** oddie's own account, once it has granted a token that lasts. */
async function voiceChannel(): Promise<LiveChannel | null> {
  const ch = await channelBySlug("x", xVoiceHandle()).catch(() => null);
  return ch?.active && ch.refreshToken ? ch : null;
}

/* X rotates the refresh token on every refresh and kills the old one, so two
   refreshes at once leave one of them holding a dead token. One at a time. */
let voiceRefresh: Promise<string> | null = null;

async function voiceToken(api: XLiveApi, ch: LiveChannel, force = false): Promise<string> {
  const stale = !ch.accessToken || ch.tokenExpiresAt === null || ch.tokenExpiresAt - Date.now() < 60_000;
  if (!(force || stale)) return ch.accessToken!;
  voiceRefresh ??= (async () => {
    // Read again: another refresh may have just written a newer token.
    const now = (await channelById("x", ch.channelId).catch(() => null)) ?? ch;
    if (!force && now.accessToken && now.tokenExpiresAt !== null && now.tokenExpiresAt - Date.now() >= 60_000) {
      Object.assign(ch, now);
      return now.accessToken;
    }
    if (!now.refreshToken) throw new Error("x voice has no refresh token");
    const t = await api.refreshTokens(now.refreshToken);
    const next: LiveChannel = { ...now, accessToken: t.accessToken, refreshToken: t.refreshToken ?? now.refreshToken, tokenExpiresAt: t.expiresAt };
    await saveChannel(next);
    Object.assign(ch, next);
    return t.accessToken;
  })().finally(() => { voiceRefresh = null; });
  return voiceRefresh;
}

async function withVoice<T>(api: XLiveApi, ch: LiveChannel, f: (token: string) => Promise<T>): Promise<T> {
  try { return await f(await voiceToken(api, ch)); }
  catch (e) {
    if (status(e) !== 401) throw e;
    return f(await voiceToken(api, ch, true));
  }
}

/* ------------------------------------------------------------- engine -- */

/**
 * The engine's hands on X. Every line goes out from @oddiefun into the
 * broadcast the streamer is live in, cut to X's 140 characters, a second
 * apart. No pins, no market, no link.
 */
export function xEngineDeps(d: { log: Log }, api: XLiveApi = xLiveApi): LiveDeps {
  const say = async (_p: unknown, channelId: string, text: string, replyTo?: string): Promise<string | void> => {
    const broadcast = liveIn.get(channelId);
    if (!broadcast) return;   // off air: no chat to say it in
    const voice = await voiceChannel();
    if (!voice) { d.log("x voice not connected, line not said", { channel: channelId }); return; }
    let first: string | null = null;
    for (const [i, line] of splitForChat(text, X_CHAT_MAX).entries()) {
      const id = await paced(`x:${channelId}`, () => patiently(() => withVoice(api, voice, (t) => api.sendChat(t, broadcast, line, i === 0 ? replyTo : undefined))));
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
    canRun: senderId === owner || p.is_moderator === true,
    text,
    channelSlug: ch?.slug,
    fromOddie: voiceId !== null && senderId === voiceId,
  };
}

/** One event off the stream. */
export async function onXEvent(ev: XActivityEvent, w: { engine: LiveDeps; log: Log; now?: () => number }): Promise<string> {
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
      w.log("x broadcast on air", { channel: owner, broadcast });
      return "start";
    case "broadcast.end":
      if (!broadcast || liveIn.get(owner) === broadcast) liveIn.delete(owner);
      ended.add(owner);
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
      const voice = await voiceChannel();
      const msg = chatFromX(ev, { slug }, voice?.channelId ?? null);
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
export function startXStream(w: { engine: LiveDeps; log: Log; api?: XLiveApi }): () => void {
  const api = w.api ?? xLiveApi;
  const stop = new AbortController();
  void (async () => {
    let backoff = 2_000;
    while (!stop.signal.aborted) {
      const t0 = Date.now();
      try {
        w.log("x activity stream connecting");
        await api.stream((ev) => onXEvent(ev, { engine: w.engine, log: w.log }).then(() => {}), stop.signal);
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

export interface XLiveRouteDeps extends ChannelPageDeps {
  appBaseUrl: string;
  /** The callback X already knows: /api/auth/twitter/callback on the public base. */
  redirectUri: string;
  /** Test seam. */
  api?: XLiveApi;
}

export function xLiveRouter(d: XLiveRouteDeps): { router: Router; callback(state: string, query: Record<string, unknown>, res: Response): Promise<boolean> } {
  const r = express.Router();
  const base = d.appBaseUrl.replace(/\/+$/, "");
  const api = d.api ?? xLiveApi;
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
      scope: kind === "voice" ? VOICE_SCOPE : STREAMER_SCOPE, state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    });
    res.redirect(`${AUTHORIZE_URL}?${q}`);
  };

  /** A streamer, once: sign in with X and allow oddie to read your broadcasts' chat. */
  r.get("/live/x/connect", authorize("streamer"));
  /** oddie's own account, once: the token every line goes out with. */
  r.get("/live/x/voice", authorize("voice"));

  /** The states this file issued, back through X's one registered callback. False: not ours. */
  async function callback(state: string, query: Record<string, unknown>, res: Response): Promise<boolean> {
    const p = pending.get(state);
    if (!p) return false;
    pending.delete(state);
    const fail = (why: string) => res.redirect(`${base}/live?x=${why}`);
    if (typeof query.error === "string") { fail("declined"); return true; }
    const code = typeof query.code === "string" ? query.code : "";
    if (!code || Date.now() - p.at > PENDING_TTL_MS) { fail("expired"); return true; }
    try {
      const t = await api.exchangeCode(code, p.verifier, d.redirectUri);
      const who = await api.me(t.accessToken);
      const isVoice = who.username.toLowerCase() === xVoiceHandle();
      if (p.kind === "voice" && !isVoice) {
        d.log("x voice sign-in by another account, refused", { handle: who.username });
        fail("voice"); return true;
      }
      await saveChannel({
        platform: "x", channelId: who.id, slug: who.username, name: who.name, avatar: who.avatar,
        accessToken: t.accessToken, refreshToken: t.refreshToken, tokenExpiresAt: t.expiresAt, active: true,
      });
      slugOf.set(who.id, who.username);
      if (p.kind === "voice") {
        d.log(t.refreshToken ? "x voice connected" : "x voice connected WITHOUT a refresh token, sign in at /live/x/voice again", { handle: who.username });
        res.redirect(`${base}/live/x/${encodeURIComponent(who.username)}?voice=1`);
        return true;
      }
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
      res.redirect(`${base}/live/x/${encodeURIComponent(who.username)}?added=1`);
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
