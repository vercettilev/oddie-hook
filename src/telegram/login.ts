/**
 * "Continue with Telegram": signing a browser in through the bot's own chat.
 *
 * WHY NOT TELEGRAM'S LOGIN WIDGET. It asks for a phone number the first time
 * in every browser. The people here already have the bot open, so the sign-in
 * goes through it instead: the browser gets a one-time link to the bot, the bot
 * asks "sign in on Chrome on macOS? code 4821", one tap on the button signs
 * that browser in. Starting the bot is also what lets it message them later,
 * which is half the reason to sign in at all.
 *
 * THE TAP IS THE CONSENT, AND IT IS NOT OPTIONAL. Opening the link alone must
 * never sign anybody in: a link made in somebody else's browser, sent to you as
 * "look at my market", would otherwise put your Telegram name on their browser.
 * So the bot shows what is asking (the browser and a code the page also shows)
 * and nothing happens until the person who opened it presses Yes. The browser
 * is linked at that tap, on the server, so it works even if the page that
 * asked was closed in the meantime.
 *
 * In memory on purpose: a pending sign-in lives ten minutes, a deploy that
 * drops one costs a person a second tap, and nothing here is worth a table.
 */
import { randomBytes, randomInt } from "node:crypto";

export const TG_LOGIN_TTL_MS = 10 * 60_000;
const MAX_PENDING = 2_000;

export interface TgLoginUser { id: number; username?: string; first_name: string }

interface Pending {
  nonce: string;
  deviceId: string;
  code: string;
  /** What is asking, in words a person recognises: "Chrome on macOS". */
  asking: string;
  at: number;
  /** Who opened the link in Telegram; only they may confirm. */
  askedBy: number | null;
  done: { handle: string | null } | null;
}

const pending = new Map<string, Pending>();

function sweep(now: number): void {
  for (const [k, p] of pending) if (now - p.at > TG_LOGIN_TTL_MS) pending.delete(k);
}

/** A browser asks to sign in. The nonce goes into the t.me link, the code is
 *  shown on the page and repeated by the bot. */
export function startTgLogin(deviceId: string, asking: string, now = Date.now()): { nonce: string; code: string } {
  sweep(now);
  if (pending.size >= MAX_PENDING) pending.clear();
  const nonce = randomBytes(16).toString("hex");
  const code = String(randomInt(1000, 10000));
  pending.set(nonce, { nonce, deviceId, code, asking: asking.slice(0, 60), at: now, askedBy: null, done: null });
  return { nonce, code };
}

/** The bot received /start login_<nonce> from this person. Returns what to
 *  show them, or null when the link is unknown or expired. The first person to
 *  open it is the only one who can confirm it. */
export function askTgLogin(nonce: string, user: TgLoginUser, now = Date.now()): { code: string; asking: string } | null {
  const p = pending.get(nonce);
  if (!p || now - p.at > TG_LOGIN_TTL_MS || p.done) return null;
  if (p.askedBy !== null && p.askedBy !== user.id) return null;
  p.askedBy = user.id;
  return { code: p.code, asking: p.asking };
}

/** The Yes tap. Returns the browser to sign in, once, or null. */
export function confirmTgLogin(nonce: string, user: TgLoginUser, now = Date.now()): { deviceId: string } | null {
  const p = pending.get(nonce);
  if (!p || now - p.at > TG_LOGIN_TTL_MS || p.done) return null;
  if (p.askedBy !== user.id) return null;
  p.done = { handle: user.username ?? null };
  return { deviceId: p.deviceId };
}

/** What the page polls. Only the browser that asked can read its own sign-in. */
export function tgLoginStatus(nonce: string, deviceId: string, now = Date.now()):
  { status: "waiting" | "asked" | "done" | "expired"; handle?: string | null } {
  const p = pending.get(nonce);
  if (!p || p.deviceId !== deviceId || now - p.at > TG_LOGIN_TTL_MS) return { status: "expired" };
  if (p.done) return { status: "done", handle: p.done.handle };
  return { status: p.askedBy === null ? "waiting" : "asked" };
}

/** "Chrome on macOS", from a User-Agent. Good enough to recognise, never used
 *  for anything but the words in the bot's question. */
export function describeBrowser(ua: string): string {
  const b = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "a browser";
  const os = /iPhone|iPad|iPod/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${b} on ${os}` : b;
}

/** Test seam. */
export function _resetTgLogins(): void { pending.clear(); }
