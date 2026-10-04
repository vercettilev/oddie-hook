/**
 * The Room hears about every market, wherever it was opened.
 *
 * WHY. The Room (t.me/oddieroom) exists to find the other side of a bet. A
 * market opened under a tweet or in a Kick chat used to stay where it was
 * born: its bet pings and its result went only to the Telegram messages that
 * had tagged it, and a market opened on X had none. So the one room built to
 * take the other side never saw most of the markets that needed it.
 *
 * HOW. One message in the Room per new market, then a ledger row keyed
 * `tg:<room>:<message>` exactly like the row a tag in a group writes. That row
 * is all the rest of the system needs: tgThreadsForSlug returns it, so every
 * later bet ping ("NO is wide open.") and the settlement post arrive as replies
 * to this announcement, through the code that already serves group tags.
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
  /** Writes the ledger row that makes this message a thread of the market. */
  record(key: string, slug: string): Promise<void>;
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
    const sent = await deps.send(deps.chatId, roomText(m.headline, openedOn(m.sourceUrl)), m.url);
    // Recorded after the send, because the key IS the sent message. A record
    // that fails leaves an announcement with no pings under it, which is the
    // old behaviour, not a broken one.
    await deps.record(`tg:${deps.chatId}:${sent.message_id}`, m.slug);
    return "announced";
  } catch (err) {
    deps.log("room announcement not delivered", { slug: m.slug, err: (err as Error).message });
    return "failed";
  }
}
