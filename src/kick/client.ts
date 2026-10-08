/**
 * Kick, spoken to directly. Documented at docs.kick.com:
 *
 *   OAuth 2.1 with PKCE at id.kick.com; a streamer authorizes oddie once with
 *   chat:write (the bot may post in their chat), events:subscribe (their chat
 *   reaches us as webhooks), user:read and channel:read (who they are and
 *   their channel's slug).
 *
 *   Chat arrives as `chat.message.sent` webhooks, signed with Kick's RSA key
 *   over "messageId.timestamp.body". Unsigned or stale requests are refused.
 *
 *   oddie answers with POST /public/v1/chat, type "bot": the message goes to
 *   the channel the token belongs to, as the app's bot.
 */
import { createHash, createVerify, randomBytes } from "node:crypto";
import type { ChatMessage } from "../live/calls.js";

const API = "https://api.kick.com/public/v1";
const ID = "https://id.kick.com";
export const KICK_SCOPES = ["user:read", "channel:read", "chat:write", "events:subscribe"];
const TIMEOUT_MS = 10_000;

export function kickConfigured(): boolean {
  return Boolean(process.env.KICK_CLIENT_ID && process.env.KICK_CLIENT_SECRET);
}

export interface KickTokens { accessToken: string; refreshToken: string | null; expiresAt: number | null }

/** PKCE, as the spec has it: a random verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizeUrl(o: { state: string; challenge: string; redirectUri: string }): string {
  const q = new URLSearchParams({
    client_id: process.env.KICK_CLIENT_ID ?? "",
    response_type: "code",
    redirect_uri: o.redirectUri,
    state: o.state,
    scope: KICK_SCOPES.join(" "),
    code_challenge: o.challenge,
    code_challenge_method: "S256",
  });
  return `${ID}/oauth/authorize?${q}`;
}

async function tokenCall(params: Record<string, string>): Promise<KickTokens> {
  const res = await fetch(`${ID}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.KICK_CLIENT_ID ?? "", client_secret: process.env.KICK_CLIENT_SECRET ?? "", ...params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`kick token ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("kick token: no access_token");
  return {
    accessToken: j.access_token, refreshToken: j.refresh_token ?? null,
    expiresAt: typeof j.expires_in === "number" ? Date.now() + j.expires_in * 1000 : null,
  };
}

/** The app's own token (client credentials), for reading public data. Cached until a minute before it expires. */
let appCache: { token: string; until: number } | null = null;
export async function kickAppToken(): Promise<string> {
  if (appCache && Date.now() < appCache.until) return appCache.token;
  const t = await tokenCall({ grant_type: "client_credentials" });
  appCache = { token: t.accessToken, until: (t.expiresAt ?? Date.now() + 3_600_000) - 60_000 };
  return t.accessToken;
}

/** Is the channel live now? /livestreams answers with one row for a live channel
 *  and none for one that is not (checked against the live API, 8 Oct). */
export async function kickStreamIsLive(broadcasterUserId: string): Promise<boolean> {
  const res = await fetch(`${API}/livestreams?broadcaster_user_id=${encodeURIComponent(broadcasterUserId)}&limit=1`, {
    headers: { authorization: `Bearer ${await kickAppToken()}`, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`kick livestreams ${res.status}`);
  const j = (await res.json()) as { data?: unknown[] };
  return (j.data?.length ?? 0) > 0;
}

export const exchangeCode = (code: string, verifier: string, redirectUri: string): Promise<KickTokens> =>
  tokenCall({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri });

export const refreshTokens = (refreshToken: string): Promise<KickTokens> =>
  tokenCall({ grant_type: "refresh_token", refresh_token: refreshToken });

async function api<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`kick ${method} ${path} ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (res.status === 204 ? {} : await res.json()) as T;
}

/** The streamer who just authorized: their id, name and picture. */
export async function me(token: string): Promise<{ userId: string; name: string; avatar: string | null }> {
  const j = await api<{ data?: Array<{ user_id: number; name: string; profile_picture?: string }> }>(token, "GET", "/users");
  const u = j.data?.[0];
  if (!u) throw new Error("kick users: empty");
  return { userId: String(u.user_id), name: u.name, avatar: u.profile_picture || null };
}

/** Their channel's slug, the name in kick.com/<slug>. */
export async function myChannel(token: string): Promise<{ slug: string }> {
  const j = await api<{ data?: Array<{ slug: string }> }>(token, "GET", "/channels");
  const c = j.data?.[0];
  if (!c?.slug) throw new Error("kick channels: empty");
  return { slug: c.slug };
}

export const KICK_EVENTS = [{ name: "chat.message.sent", version: 1 }, { name: "livestream.status.updated", version: 1 }];

/**
 * Their chat, and whether they are live, delivered to our webhook: only the
 * events not already there. A streamer signs in again to manage their 2%, and
 * Kick does not say what a second subscription to the same event does; if it
 * were a second delivery, every line in their chat would be answered twice.
 * A list that cannot be read subscribes to everything, as a first connect does.
 */
export async function subscribeToChannel(token: string, broadcasterUserId?: string): Promise<{ added: string[] }> {
  let have = new Set<string>();
  try {
    const q = broadcasterUserId ? `?broadcaster_user_id=${encodeURIComponent(broadcasterUserId)}` : "";
    const j = await api<{ data?: Array<{ event?: string; method?: string }> }>(token, "GET", `/events/subscriptions${q}`);
    have = new Set((j.data ?? []).filter((s) => !s.method || s.method === "webhook").map((s) => String(s.event)));
  } catch { /* unread: subscribe to all of them */ }
  const events = KICK_EVENTS.filter((e) => !have.has(e.name));
  if (events.length) await api(token, "POST", "/events/subscriptions", { method: "webhook", events });
  return { added: events.map((e) => e.name) };
}

/** One line in the channel the token belongs to, as oddie's bot. */
export async function sendChat(token: string, content: string, replyTo?: string): Promise<void> {
  await api(token, "POST", "/chat", {
    type: "bot", content: content.slice(0, 500), ...(replyTo ? { reply_to_message_id: replyTo } : {}),
  });
}

/** The same line as the account that authorized us, into a given channel. */
export async function sendChatAsUser(token: string, broadcasterUserId: string, content: string, replyTo?: string): Promise<void> {
  await api(token, "POST", "/chat", {
    type: "user", broadcaster_user_id: Number(broadcasterUserId), content: content.slice(0, 500),
    ...(replyTo ? { reply_to_message_id: replyTo } : {}),
  });
}

/* ---------------------------------------------------------- webhooks -- */

let keyCache: { pem: string; at: number } | null = null;

/** Kick's public key, fetched once an hour. */
export async function kickPublicKey(): Promise<string> {
  if (keyCache && Date.now() - keyCache.at < 3_600_000) return keyCache.pem;
  const res = await fetch(`${API}/public-key`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`kick public-key ${res.status}`);
  const text = await res.text();
  let pem = text;
  try { const j = JSON.parse(text) as { data?: { public_key?: string } }; if (j.data?.public_key) pem = j.data.public_key; } catch { /* plain PEM */ }
  keyCache = { pem, at: Date.now() };
  return pem;
}

/** RSA-SHA256 over "messageId.timestamp.body", base64 signature. */
export function verifyKickSignature(publicKeyPem: string, messageId: string, timestamp: string, rawBody: Buffer | string, signatureB64: string): boolean {
  try {
    const v = createVerify("RSA-SHA256");
    v.update(`${messageId}.${timestamp}.`);
    v.update(rawBody);
    v.end();
    return v.verify(publicKeyPem, Buffer.from(signatureB64, "base64"));
  } catch { return false; }
}

/** A webhook older than this is refused: a replayed request is not a message. */
export const WEBHOOK_MAX_AGE_MS = 10 * 60_000;

interface KickSender { user_id: number; username: string; identity?: { badges?: Array<{ type?: string }> } | null }
interface KickChatEvent {
  message_id: string; broadcaster: KickSender & { channel_slug?: string }; sender: KickSender; content: string;
  replies_to?: { message_id?: string; content?: string } | null;
}
const noEmotes = (s: string): string => s.replace(/\[emote:\d+:[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();

/** A `chat.message.sent` payload as the engine reads it. The owner is the
 *  sender whose id is the broadcaster's; a moderator carries the badge. */
export function chatFromKick(body: unknown): ChatMessage | null {
  const e = body as Partial<KickChatEvent> | null;
  if (!e || typeof e.content !== "string" || !e.sender || !e.broadcaster || !e.message_id) return null;
  const owner = e.sender.user_id === e.broadcaster.user_id;
  const mod = (e.sender.identity?.badges ?? []).some((b) => b?.type === "moderator" || b?.type === "broadcaster");
  return {
    platform: "kick",
    channelId: String(e.broadcaster.user_id),
    messageId: String(e.message_id),
    senderId: String(e.sender.user_id),
    senderName: String(e.sender.username ?? ""),
    canRun: owner || mod,
    // Emotes arrive inline as [emote:id:name]; they are never part of a command.
    text: noEmotes(e.content),
    replyText: typeof e.replies_to?.content === "string" ? noEmotes(e.replies_to.content) : null,
    channelSlug: e.broadcaster.channel_slug ?? undefined,
  };
}
