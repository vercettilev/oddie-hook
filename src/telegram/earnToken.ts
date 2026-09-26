/**
 * A short-lived, single-purpose token: "this browser may link a wallet to
 * Telegram user N".
 *
 * WHY A TOKEN AT ALL. The link that lets somebody collect their 2% cannot be
 * posted in the group. A group message is public, and whoever opened it could
 * bind THEIR wallet to the opener's markets and take the fee. So the group
 * reply carries only a t.me deep link, Telegram authenticates whoever taps it
 * (the /start arrives in their own private chat, from their own user id), and
 * the bot answers there with a URL carrying this token. Somebody else tapping
 * the same deep link gets a token for THEIR id, which can only link a wallet to
 * their own markets.
 *
 * WHAT IT IS NOT. It proves who the Telegram user is; it proves nothing about
 * the wallet. That is the signature's job on the page, which the server checks
 * with the same verifier the X sign-in uses.
 *
 * Format: base64url(JSON {t, e}) "." base64url(HMAC-SHA256). The key is derived
 * from the bot token, which is secret and is exactly the thing this feature
 * cannot run without; rotating it invalidates every outstanding link.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Long enough to install Phantom and come back, short enough that a
 *  forwarded DM stops being usable quickly. */
export const EARN_TOKEN_TTL_MS = 30 * 60_000;

const b64u = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

export function earnKey(botToken: string): Buffer {
  return createHmac("sha256", botToken).update("oddie-tg-earn-v1").digest();
}

export function earnToken(tgUserId: number, key: Buffer, now = Date.now(), ttlMs = EARN_TOKEN_TTL_MS): string {
  const payload = b64u(JSON.stringify({ t: tgUserId, e: now + ttlMs }));
  const mac = b64u(createHmac("sha256", key).update(payload).digest());
  return `${payload}.${mac}`;
}

/** The Telegram user id the token was issued to, or null if it is forged,
 *  malformed or expired. Never throws. */
export function verifyEarnToken(token: string, key: Buffer, now = Date.now()): number | null {
  if (typeof token !== "string" || token.length > 400) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const want = createHmac("sha256", key).update(payload).digest();
  // Length first: timingSafeEqual throws on a mismatch, and a throw here would
  // be a different response time for a wrong length than for a wrong byte.
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let parsed: { t?: unknown; e?: unknown };
  try { parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  const t = Number(parsed.t), e = Number(parsed.e);
  if (!Number.isSafeInteger(t) || t <= 0 || !Number.isFinite(e)) return null;
  if (e <= now) return null;
  return t;
}
