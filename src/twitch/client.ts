/**
 * Twitch, spoken to directly. Documented at dev.twitch.tv:
 *
 *   OAuth authorization code at id.twitch.tv; a streamer authorizes oddie once
 *   with user:read:chat and user:bot (their chat may be read by oddie's app),
 *   channel:bot (oddie's app is a bot in their channel) and user:write:chat
 *   (a line can go out as them when nothing else can).
 *
 *   Chat arrives as EventSub `channel.chat.message` webhooks. A webhook
 *   subscription is made with the APP access token (client credentials), and
 *   for that type Twitch requires user:read:chat and user:bot from the reading
 *   user and channel:bot from the broadcaster: one streamer's sign-in grants
 *   all three, so the streamer reads their own chat. Every request is signed:
 *   HMAC-SHA256 over message id + timestamp + raw body with our secret,
 *   "sha256=<hex>" in Twitch-Eventsub-Message-Signature.
 *
 *   oddie answers with POST /helix/chat/messages. That takes a user access
 *   token with user:write:chat; with user:bot or channel:bot in it the line
 *   carries Twitch's chat bot badge.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChatMessage } from "../live/calls.js";

const API = "https://api.twitch.tv/helix";
const ID = "https://id.twitch.tv/oauth2";
export const TWITCH_SCOPES = ["user:read:chat", "user:write:chat", "user:bot", "channel:bot"];
const TIMEOUT_MS = 10_000;

/** All three: the app, its secret, and the secret our webhooks are signed with. */
export function twitchConfigured(): boolean {
  return Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET && eventSubSecret());
}

/** Twitch wants 10 to 100 ASCII characters. Anything else is no secret at all. */
export function eventSubSecret(): string | null {
  const s = process.env.TWITCH_EVENTSUB_SECRET ?? "";
  return /^[\x21-\x7e]{10,100}$/.test(s) ? s : null;
}

export interface TwitchTokens { accessToken: string; refreshToken: string | null; expiresAt: number | null }

export function authorizeUrl(o: { state: string; redirectUri: string }): string {
  const q = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID ?? "",
    redirect_uri: o.redirectUri,
    response_type: "code",
    scope: TWITCH_SCOPES.join(" "),
    state: o.state,
  });
  return `${ID}/authorize?${q}`;
}

async function tokenCall(params: Record<string, string>): Promise<TwitchTokens & { raw: { expires_in?: number } }> {
  const res = await fetch(`${ID}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.TWITCH_CLIENT_ID ?? "", client_secret: process.env.TWITCH_CLIENT_SECRET ?? "", ...params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`twitch token ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("twitch token: no access_token");
  return {
    accessToken: j.access_token, refreshToken: j.refresh_token ?? null,
    expiresAt: typeof j.expires_in === "number" ? Date.now() + j.expires_in * 1000 : null,
    raw: j,
  };
}

export const exchangeCode = (code: string, redirectUri: string): Promise<TwitchTokens> =>
  tokenCall({ grant_type: "authorization_code", code, redirect_uri: redirectUri });

export const refreshTokens = (refreshToken: string): Promise<TwitchTokens> =>
  tokenCall({ grant_type: "refresh_token", refresh_token: refreshToken });

/** The app's own token, for EventSub. Cached until a minute before it expires. */
let appCache: { token: string; until: number } | null = null;
export async function appToken(): Promise<string> {
  if (appCache && Date.now() < appCache.until) return appCache.token;
  const t = await tokenCall({ grant_type: "client_credentials" });
  appCache = { token: t.accessToken, until: (t.expiresAt ?? Date.now() + 3_600_000) - 60_000 };
  return t.accessToken;
}

async function api<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`, "client-id": process.env.TWITCH_CLIENT_ID ?? "", accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`twitch ${method} ${path} ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (res.status === 204 ? {} : await res.json()) as T;
}

/** The streamer who just authorized: id, login (the name in twitch.tv/<login>), display name, picture. */
export async function me(token: string): Promise<{ userId: string; login: string; name: string; avatar: string | null }> {
  const j = await api<{ data?: Array<{ id: string; login: string; display_name?: string; profile_image_url?: string }> }>(token, "GET", "/users");
  const u = j.data?.[0];
  if (!u) throw new Error("twitch users: empty");
  return { userId: String(u.id), login: u.login, name: u.display_name || u.login, avatar: u.profile_image_url || null };
}

/**
 * Their chat, delivered to our webhook, once. A streamer signs in again to
 * manage their 2%; a second subscription to the same chat is refused by
 * Twitch with 409, which is the answer "already there".
 */
export async function subscribeToChat(app: string, broadcasterUserId: string, callback: string, secret: string): Promise<{ added: boolean }> {
  try {
    await api(app, "POST", "/eventsub/subscriptions", {
      type: "channel.chat.message", version: "1",
      condition: { broadcaster_user_id: broadcasterUserId, user_id: broadcasterUserId },
      transport: { method: "webhook", callback, secret },
    });
    return { added: true };
  } catch (e) {
    if ((e as { status?: number }).status === 409) return { added: false };
    throw e;
  }
}

/** One line in a channel's chat, from the account the token belongs to. */
export async function sendChat(token: string, broadcasterId: string, senderId: string, message: string, replyTo?: string): Promise<void> {
  const j = await api<{ data?: Array<{ is_sent?: boolean; drop_reason?: { code?: string; message?: string } | null }> }>(token, "POST", "/chat/messages", {
    broadcaster_id: broadcasterId, sender_id: senderId, message: message.slice(0, 500),
    ...(replyTo ? { reply_parent_message_id: replyTo } : {}),
  });
  const r = j.data?.[0];
  // A 200 can still be a line Twitch did not deliver (AutoMod, followers-only).
  if (r && r.is_sent === false) {
    const err = new Error(`twitch chat dropped: ${r.drop_reason?.code ?? "unknown"}`) as Error & { status?: number };
    err.status = 422;
    throw err;
  }
}

/* ---------------------------------------------------------- webhooks -- */

/** HMAC-SHA256 over id + timestamp + body, compared in constant time. */
export function verifyTwitchSignature(secret: string, messageId: string, timestamp: string, rawBody: Buffer | string, header: string): boolean {
  const want = "sha256=" + createHmac("sha256", secret).update(messageId + timestamp).update(rawBody).digest("hex");
  const a = Buffer.from(want), b = Buffer.from(String(header ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A webhook older than this is refused: a replayed request is not a message. */
export const WEBHOOK_MAX_AGE_MS = 10 * 60_000;

interface TwitchChatEvent {
  broadcaster_user_id: string; broadcaster_user_login: string;
  chatter_user_id: string; chatter_user_login: string;
  message_id: string; message: { text: string };
  badges?: Array<{ set_id?: string }>;
  reply?: { parent_message_body?: string } | null;
  source_broadcaster_user_id?: string | null;
}

/** A `channel.chat.message` event as the engine reads it. The owner is the
 *  chatter who is the broadcaster; a moderator carries the badge. */
export function chatFromTwitch(event: unknown): ChatMessage | null {
  const e = event as Partial<TwitchChatEvent> | null;
  if (!e || typeof e.message?.text !== "string" || !e.chatter_user_id || !e.broadcaster_user_id || !e.message_id) return null;
  // Shared chat: a line typed in ANOTHER channel shows up here too. It belongs
  // to that channel, which hears it there; answering it here would be twice.
  if (e.source_broadcaster_user_id && e.source_broadcaster_user_id !== e.broadcaster_user_id) return null;
  const owner = e.chatter_user_id === e.broadcaster_user_id;
  const mod = (e.badges ?? []).some((b) => b?.set_id === "moderator" || b?.set_id === "broadcaster");
  // A reply arrives as "@name original text"; the mention is never the claim.
  const reply = typeof e.reply?.parent_message_body === "string" ? e.reply.parent_message_body.trim() : null;
  const text = e.message.text.replace(/\s+/g, " ").trim();
  return {
    platform: "twitch",
    channelId: String(e.broadcaster_user_id),
    messageId: String(e.message_id),
    senderId: String(e.chatter_user_id),
    senderName: String(e.chatter_user_login ?? ""),
    canRun: owner || mod,
    text: reply && text.startsWith("@") ? text.replace(/^@\S+\s*/, "") : text,
    replyText: reply,
    channelSlug: e.broadcaster_user_login ?? undefined,
  };
}
