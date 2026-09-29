/**
 * "THIS BROWSER IS THE STREAMER'S": a signed cookie, set at the one moment we
 * know it (the end of Kick's own sign-in, where Kick has just told us which
 * channel authorized) and read only by the routes that act for a channel:
 * where its 2% goes.
 *
 * WHY A COOKIE, AND NEVER A LINK. Telegram's earn link carries its token in
 * the URL because it arrives in a private chat. A streamer's screen is the
 * opposite of private: the address bar is on stream. A token in it would let
 * anybody watching point the channel's 2% at their own wallet. So it travels
 * only as an HttpOnly cookie, which no script on the page can read and no
 * stream can show.
 *
 * WHAT IT IS NOT. It proves which Kick channel signed in; it proves nothing
 * about a wallet. That is the signature's job, checked by the same verifier as
 * every other wallet sign-in.
 *
 * Format: base64url(JSON {c, e}) "." base64url(HMAC-SHA256), the Telegram earn
 * token's shape with the channel id as a string. The key is derived from the
 * secret the live tokens are sealed with (LIVE_TOKEN_KEY, or the Kick client
 * secret), so rotating it signs every streamer out.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const OWNER_COOKIE = "oddie_kick_owner";
/** A week: long enough to add oddie one evening and link a wallet another,
 *  short enough that a forgotten browser stops speaking for the channel. */
export const OWNER_TTL_MS = 7 * 86_400_000;

const CHANNEL_ID = /^[A-Za-z0-9_-]{1,40}$/;
const b64u = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

export function ownerKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("oddie-kick-owner-v1").digest();
}

/** The key from the environment, or null where Kick is not set up. */
export function ownerKeyFromEnv(): Buffer | null {
  const raw = process.env.LIVE_TOKEN_KEY || process.env.KICK_CLIENT_SECRET;
  return raw ? ownerKey(raw) : null;
}

export function ownerToken(channelId: string, key: Buffer, now = Date.now(), ttlMs = OWNER_TTL_MS): string {
  if (!CHANNEL_ID.test(channelId)) throw new Error("not a channel id");
  const payload = b64u(JSON.stringify({ c: channelId, e: now + ttlMs }));
  const mac = b64u(createHmac("sha256", key).update(payload).digest());
  return `${payload}.${mac}`;
}

/** The channel the token was issued to, or null if it is forged, malformed or
 *  expired. Never throws. */
export function verifyOwnerToken(token: string, key: Buffer, now = Date.now()): string | null {
  if (typeof token !== "string" || token.length > 400) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const want = createHmac("sha256", key).update(payload).digest();
  // Length first: timingSafeEqual throws on a mismatch.
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let parsed: { c?: unknown; e?: unknown };
  try { parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  const c = parsed.c, e = Number(parsed.e);
  if (typeof c !== "string" || !CHANNEL_ID.test(c) || !Number.isFinite(e) || e <= now) return null;
  return c;
}

/** The Set-Cookie line. Host-only (no Domain), sent only to the channel API,
 *  and never on a request another site starts (SameSite=Lax). */
export function ownerCookie(token: string, secure: boolean, maxAgeMs = OWNER_TTL_MS): string {
  return `${OWNER_COOKIE}=${token}; Path=/api/live/kick; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
