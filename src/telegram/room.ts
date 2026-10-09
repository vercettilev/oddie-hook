/**
 * The Room hears about every market, wherever it was opened, and nothing else.
 *
 * WHY. The Room (t.me/oddieroom) exists to find the other side of a bet. A
 * market opened under a tweet or in a Kick chat used to stay where it was
 * born, so the one room built to take the other side never saw most of the
 * markets that needed it.
 *
 * A FEED, NOT A THREAD. One message in the Room per new market, and that is
 * all it ever gets. The Room is read-only, so it should read as a list of open
 * calls. The announcement used to be recorded as a thread of the market (a
 * `tg:<room>:<message>` ledger row), which made every bet ping ("NO is wide
 * open.") and the settlement post land under it too, and the feed filled up
 * with follow-ups. It is no longer recorded: tgThreadsForSlug never returns
 * the Room, so pings and results stay in the chats where the market was
 * argued, and the button on the announcement is where anyone follows it.
 *
 * WHAT IT SAYS. The market and where it was opened, never who opened it. A
 * person shows up only when they did something in public and chose to be
 * named, and an announcement in a public group is not that choice.
 *
 * WHAT IT SKIPS. A market tagged inside the Room itself already has its thread
 * there; announcing it again would put two copies under one argument.
 */

export const ROOM_USERNAME = "oddieroom";
const DEFAULT_ROOM_CHAT_ID = -1004355810770;

/** The Room's chat id, or null when announcing is switched off. Set
 *  TELEGRAM_ROOM_CHAT_ID to another id to move it, or to "off" to stop it. */
export function roomChatId(env: Record<string, string | undefined> = process.env): number | null {
  const raw = (env.TELEGRAM_ROOM_CHAT_ID ?? "").trim();
  if (raw.toLowerCase() === "off") return null;
  if (!raw) return DEFAULT_ROOM_CHAT_ID;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n < 0 ? n : null;
}

/** True when the market's source is a message in the Room itself. */
export function isRoomSource(sourceUrl: string | null | undefined, chatId: number | null): boolean {
  if (!sourceUrl) return false;
  let u: URL;
  try { u = new URL(sourceUrl); } catch { return false; }
  if (u.hostname.replace(/^www\./, "").toLowerCase() !== "t.me") return false;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() === ROOM_USERNAME) return true;
  const internal = chatId !== null && String(chatId).startsWith("-100") ? String(chatId).slice(4) : null;
  return parts[0] === "c" && internal !== null && parts[1] === internal;
}

/** Where a market came from, in the word people use for the app. */
export function openedOn(sourceUrl: string | null | undefined): string | null {
  const s = String(sourceUrl ?? "").trim();
  if (!s) return null;
  if (/^kick(-chat)?:/i.test(s)) return "Kick";
  let host: string;
  try { host = new URL(s).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; }
  if (["x.com", "twitter.com", "mobile.twitter.com", "fixupx.com", "fxtwitter.com", "vxtwitter.com"].includes(host)) return "X";
  if (host === "t.me") return "Telegram";
  if (host === "kick.com") return "Kick";
  return null;
}

export function roomText(headline: string, where: string | null): string {
  const title = headline.trim();
  return where ? `${title}\nOpened on ${where}. Pick a side.` : `${title}\nPick a side.`;
}

export interface RoomDeps {
  chatId: number | null;
  send(chatId: number, text: string, url: string): Promise<{ message_id: number }>;
  log(msg: string, extra?: Record<string, unknown>): void;
}

export type RoomOutcome = "announced" | "off" | "room-source" | "failed";

export async function announceToRoom(
  deps: RoomDeps,
  m: { slug: string; headline: string; url: string; sourceUrl: string | null },
): Promise<RoomOutcome> {
  if (deps.chatId === null || !m.slug || !m.headline.trim()) return "off";
  if (isRoomSource(m.sourceUrl, deps.chatId)) return "room-source";
  try {
    await deps.send(deps.chatId, roomText(m.headline, openedOn(m.sourceUrl)), m.url);
    return "announced";
  } catch (err) {
    deps.log("room announcement not delivered", { slug: m.slug, err: (err as Error).message });
    return "failed";
  }
}
