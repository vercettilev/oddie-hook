/**
 * YouTube, spoken to directly. Documented at developers.google.com/youtube/v3
 * (read 12 Oct 2026):
 *
 *   A streamer signs in with Google once, with youtube.readonly. That names
 *   their channel and proves it is theirs; oddie keeps no token of theirs.
 *
 *   oddie's own channel (the voice: YOUTUBE_VOICE_CHANNEL, default "oddiefun")
 *   signs in once more, with youtube.force-ssl and offline access. Its token
 *   reads every chat oddie is in and writes oddie's lines, so a line in any
 *   chat comes from oddie's account, never the streamer's.
 *
 *   A channel's stream is found without the streamer: its public feed
 *   (youtube.com/feeds/videos.xml) names its newest videos, and videos.list
 *   says which one is live and where its chat is (activeLiveChatId).
 *
 *   The chat is read over ONE long connection (liveChatMessages.streamList; the
 *   REST path is /liveChat/messages/stream), never polled: polling every few
 *   seconds is what runs a project out of its daily units within a stream.
 *
 *   A line goes out with liveChatMessages.insert, at most 200 characters.
 *
 * QUOTA. A project gets 10,000 units a day, reset at midnight Pacific; the
 * published costs are videos.list 1, liveChatMessages.insert 20 and the stream
 * 5 per connection. Writing is the cost: about 500 lines a day across every
 * YouTube channel, until Google raises the quota.
 *
 * NO MONEY IN THE CHAT. YouTube removes content that directs viewers to online
 * gambling Google has not approved (policy in force since 19 March 2025), so
 * on YouTube oddie runs votes only and posts no links (src/live/calls.ts,
 * votesOnly).
 */
import type { ChatMessage } from "../live/calls.js";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/youtube/v3";
const FEED = "https://www.youtube.com/feeds/videos.xml";
export const STREAMER_SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"];
export const VOICE_SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"];
/** The longest line YouTube's chat takes. */
export const CHAT_MAX = 200;
const TIMEOUT_MS = 10_000;

/** The app and its secret, from Google Cloud. */
export function youtubeConfigured(): boolean {
  return Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET);
}

/** The handle of oddie's own channel, without the @. "" turns the voice off. */
export function voiceHandle(): string {
  return (process.env.YOUTUBE_VOICE_CHANNEL ?? "oddiefun").trim().replace(/^@/, "").toLowerCase();
}

export interface YouTubeTokens { accessToken: string; refreshToken: string | null; expiresAt: number | null }

export function authorizeUrl(o: { state: string; redirectUri: string; voice: boolean }): string {
  const q = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID ?? "",
    redirect_uri: o.redirectUri,
    response_type: "code",
    scope: (o.voice ? VOICE_SCOPES : STREAMER_SCOPES).join(" "),
    state: o.state,
    include_granted_scopes: "true",
    // Only oddie's own account keeps a token; a streamer's sign-in is used once.
    access_type: o.voice ? "offline" : "online",
    // A channel can live on a brand account: let the streamer pick it. The voice
    // is asked to consent again, which is what makes Google send a refresh token.
    prompt: o.voice ? "consent select_account" : "select_account",
  });
  return `${AUTH}?${q}`;
}

/** An error with what YouTube said: the HTTP status and its reason ("quotaExceeded", "liveChatEnded"). */
export class YouTubeError extends Error {
  constructor(message: string, public status: number, public reason: string) { super(message); }
}

function reasonOf(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { errors?: Array<{ reason?: string }>; status?: string; message?: string } };
    return String(j.error?.errors?.[0]?.reason ?? j.error?.status ?? j.error?.message ?? "").slice(0, 80);
  } catch { return body.replace(/\s+/g, " ").slice(0, 80); }
}

async function failure(res: Response, what: string): Promise<YouTubeError> {
  const reason = reasonOf(await res.text().catch(() => ""));
  return new YouTubeError(`youtube ${what} ${res.status} ${reason}`.trim(), res.status, reason);
}

async function tokenCall(params: Record<string, string>): Promise<YouTubeTokens> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.YOUTUBE_CLIENT_ID ?? "", client_secret: process.env.YOUTUBE_CLIENT_SECRET ?? "", ...params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw await failure(res, "token");
  const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("youtube token: no access_token");
  return {
    accessToken: j.access_token, refreshToken: j.refresh_token ?? null,
    expiresAt: typeof j.expires_in === "number" ? Date.now() + j.expires_in * 1000 : null,
  };
}

export const exchangeCode = (code: string, redirectUri: string): Promise<YouTubeTokens> =>
  tokenCall({ grant_type: "authorization_code", code, redirect_uri: redirectUri });

/** A refresh does not bring a new refresh token: the one there is stays. */
export const refreshTokens = (refreshToken: string): Promise<YouTubeTokens> =>
  tokenCall({ grant_type: "refresh_token", refresh_token: refreshToken });

async function api<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw await failure(res, `${method} ${path.split("?")[0]}`);
  return (res.status === 204 ? {} : await res.json()) as T;
}

export interface YouTubeChannel { channelId: string; handle: string; name: string; avatar: string | null }

/** The channel of the account that just signed in: its id, handle (no @), title and picture. */
export async function me(token: string): Promise<YouTubeChannel> {
  const j = await api<{ items?: Array<{ id: string; snippet?: { title?: string; customUrl?: string; thumbnails?: { default?: { url?: string } } } }> }>(
    token, "GET", "/channels?part=snippet&mine=true");
  const c = j.items?.[0];
  if (!c) throw new Error("youtube channels: this account has no channel");
  // A channel without a handle is known by its UC… id.
  const handle = String(c.snippet?.customUrl ?? "").replace(/^@/, "").trim();
  return { channelId: String(c.id), handle: handle || String(c.id), name: c.snippet?.title || handle || String(c.id), avatar: c.snippet?.thumbnails?.default?.url || null };
}

/** The newest videos on a channel, newest first, from its public feed. No token, no quota. */
export async function recentVideoIds(channelId: string, n = 3): Promise<string[]> {
  const res = await fetch(`${FEED}?channel_id=${encodeURIComponent(channelId)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw await failure(res, "feed");
  const xml = await res.text();
  return [...xml.matchAll(/<yt:videoId>([\w-]{11})<\/yt:videoId>/g)].map((m) => m[1]).slice(0, n);
}

export interface LiveVideo { videoId: string; channelId: string; state: "live" | "upcoming" | "none"; liveChatId: string | null }

/** Which of these videos is live, and its chat: one call for up to fifty, 1 unit. */
export async function videosLive(token: string, ids: string[]): Promise<LiveVideo[]> {
  const out: LiveVideo[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const j = await api<{ items?: Array<{ id: string; snippet?: { channelId?: string; liveBroadcastContent?: string }; liveStreamingDetails?: { activeLiveChatId?: string } }> }>(
      token, "GET", `/videos?part=snippet,liveStreamingDetails&id=${ids.slice(i, i + 50).map(encodeURIComponent).join(",")}`);
    for (const v of j.items ?? []) {
      const s = v.snippet?.liveBroadcastContent;
      out.push({
        videoId: String(v.id), channelId: String(v.snippet?.channelId ?? ""),
        state: s === "live" || s === "upcoming" ? s : "none",
        liveChatId: v.liveStreamingDetails?.activeLiveChatId ?? null,
      });
    }
  }
  return out;
}

/** One line in a live chat, from the account the token belongs to: its id. */
export async function sendChat(token: string, liveChatId: string, text: string): Promise<string | null> {
  const j = await api<{ id?: string }>(token, "POST", "/liveChat/messages?part=snippet", {
    snippet: { liveChatId, type: "textMessageEvent", textMessageDetails: { messageText: text.slice(0, CHAT_MAX) } },
  });
  return j.id ? String(j.id) : null;
}

export interface YouTubeChatItem {
  id?: string;
  snippet?: { type?: string; publishedAt?: string; authorChannelId?: string; displayMessage?: string; textMessageDetails?: { messageText?: string } };
  authorDetails?: { channelId?: string; displayName?: string; isChatOwner?: boolean; isChatModerator?: boolean };
}
export interface ChatPage { items?: YouTubeChatItem[]; nextPageToken?: string; offlineAt?: string }

/**
 * Whole JSON objects out of a stream of text, however it is framed: one per
 * line, inside an array that streams in ("[{..},\n{..}]"), or one object
 * pretty-printed over many lines. A chunk can end anywhere, even inside a
 * string; what is still open waits for the next chunk.
 */
export function jsonSplitter(): { push(chunk: string): unknown[] } {
  let buf = "", scan = 0, depth = 0, start = -1, inStr = false, esc = false;
  return {
    push(chunk: string): unknown[] {
      buf += chunk;
      const out: unknown[] = [];
      for (let i = scan; i < buf.length; i++) {
        const ch = buf[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { if (depth > 0) inStr = true; continue; }
        if (ch === "{") { if (depth === 0) start = i; depth++; continue; }
        if (ch === "}" && depth > 0) {
          depth--;
          if (depth === 0) {
            try { out.push(JSON.parse(buf.slice(start, i + 1))); } catch { /* not an object after all */ }
            start = -1;
          }
        }
      }
      // Keep only the object still being read, and where the scan stopped in it.
      if (depth === 0) { buf = ""; scan = 0; }
      else { buf = buf.slice(start); start = 0; scan = buf.length; }
      return out;
    },
  };
}

/**
 * Read a chat over its one long connection until the connection ends: every
 * page as it arrives (the first ones are the chat's recent history). Returns
 * the token to resume from, and whether the chat ended with the stream.
 */
export async function streamChat(token: string, liveChatId: string, pageToken: string | null, onPage: (p: ChatPage) => Promise<void> | void, signal: AbortSignal): Promise<{ pageToken: string | null; offline: boolean }> {
  const q = new URLSearchParams({ liveChatId, part: "id,snippet,authorDetails", maxResults: "500" });
  if (pageToken) q.set("pageToken", pageToken);
  const res = await fetch(`${API}/liveChat/messages/stream?${q}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal });
  if (!res.ok || !res.body) throw await failure(res, "chat stream");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const split = jsonSplitter();
  let next = pageToken, offline = false;
  const take = async (objs: unknown[]) => {
    for (const o of objs) {
      const p = o as ChatPage;
      if (p.nextPageToken) next = p.nextPageToken;
      if (p.offlineAt) offline = true;
      await onPage(p);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    await take(split.push(dec.decode(value, { stream: true })));
  }
  await take(split.push(dec.decode()));
  return { pageToken: next, offline };
}

/**
 * A chat item as the engine reads it: text messages only (a Super Chat or a
 * membership is not a command). The owner and moderators run calls; a line
 * from oddie's own channel is oddie's.
 */
export function chatFromYouTube(item: unknown, ch: { channelId: string; slug: string }, voiceChannelId: string | null): ChatMessage | null {
  const it = item as YouTubeChatItem | null;
  if (!it?.id || it.snippet?.type !== "textMessageEvent") return null;
  const text = String(it.snippet.textMessageDetails?.messageText ?? it.snippet.displayMessage ?? "").replace(/\s+/g, " ").trim();
  const a = it.authorDetails ?? {};
  const sender = String(a.channelId ?? it.snippet.authorChannelId ?? "");
  if (!text || !sender) return null;
  return {
    platform: "youtube",
    channelId: ch.channelId,
    messageId: String(it.id),
    senderId: sender,
    // YouTube shows handles now ("@name"): the standings show the name.
    senderName: String(a.displayName ?? "").replace(/^@/, "").trim() || sender,
    canRun: Boolean(a.isChatOwner || a.isChatModerator),
    text,
    replyText: null,
    channelSlug: ch.slug,
    fromOddie: voiceChannelId !== null && sender === voiceChannelId,
  };
}

/**
 * A line longer than the chat takes, cut into lines that each read whole: at
 * the end of a sentence when one ends late enough, else between words.
 */
export function splitForChat(text: string, max = CHAT_MAX): string[] {
  let rest = String(text ?? "").replace(/\s+/g, " ").trim();
  const out: string[] = [];
  while (rest.length > max) {
    const w = rest.slice(0, max + 1);
    const end = Math.max(w.lastIndexOf(". "), w.lastIndexOf("? "), w.lastIndexOf("! "));
    let cut: number;
    if (end >= max * 0.4) cut = end + 1;            // keep the full stop
    else { const sp = w.lastIndexOf(" "); cut = sp > 0 ? sp : max; }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
