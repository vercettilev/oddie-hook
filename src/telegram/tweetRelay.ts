/**
 * @oddiefun's own posts, relayed into the Room.
 *
 * WHAT. Every post the account writes by hand: not a reply, not a retweet, not
 * a quote. The bot posts as @oddiefun too, and everything IT posts is a reply
 * (to a tag) or a quote (a result), so "none of those" is exactly the posts a
 * person wrote. X drops replies and retweets before they reach us; quotes are
 * dropped here.
 *
 * HOW IT LOOKS. The post's text, then its link on its own line, so Telegram
 * unfurls the card (with the image or the video's still) under it. No button:
 * a button turns the link preview off (sendMessage), and the preview is the
 * point.
 *
 * THE CURSOR. The id of the last post handled, in bot_state. It advances only
 * over posts actually handled, oldest first, and stops at a send that failed,
 * so a Telegram outage delays a post instead of skipping it. The first run
 * with no cursor records where the timeline is and sends nothing: switching
 * the relay on must not dump the account's history into the Room.
 */

import type { OwnTweet } from "../x/client.js";

/** Telegram refuses a message past 4096 characters; long posts are cut short
 *  of it, and the link under them carries the rest. */
const MAX_TEXT = 3500;

export const ROOM_TWEETS_CURSOR = "room_tweets_since_id";

export interface RelayDeps {
  chatId: number | null;
  /** The account's handle, without the @, for the post's link. */
  handle: string;
  ownTweets(sinceId: string | null): Promise<OwnTweet[]>;
  cursorGet(): Promise<string | null>;
  cursorSet(id: string): Promise<void>;
  send(chatId: number, text: string): Promise<void>;
  log(msg: string, extra?: Record<string, unknown>): void;
}

export interface RelayResult {
  outcome: "off" | "primed" | "relayed";
  posted: number;
  skipped: number;
  /** A send failed; the cursor stopped before it and the next run retries. */
  stalled: boolean;
}

const unescape = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** The post as a person reads it: real links instead of t.co, the post's own
 *  media links gone (the preview shows the media), entities unescaped. */
export function relayText(t: Pick<OwnTweet, "id" | "text" | "urls">, handle: string): string {
  let text = t.text;
  for (const u of t.urls) {
    const own = new RegExp(`/status/${t.id}/(photo|video)/`).test(u.expanded);
    text = text.split(u.url).join(own ? "" : u.expanded);
  }
  text = unescape(text).replace(/[ \t]+\n/g, "\n").trim();
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT).trimEnd()}…`;
  const link = `https://x.com/${handle}/status/${t.id}`;
  return text ? `${text}\n\n${link}` : link;
}

/** Ids are decimal strings longer than a double holds exactly: order by
 *  length, then digits. */
const byIdAsc = (a: OwnTweet, b: OwnTweet): number =>
  a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export async function relayOwnTweets(deps: RelayDeps): Promise<RelayResult> {
  if (deps.chatId === null) return { outcome: "off", posted: 0, skipped: 0, stalled: false };
  const since = await deps.cursorGet();
  const posts = [...(await deps.ownTweets(since))].sort(byIdAsc);

  if (since === null) {
    if (posts.length) await deps.cursorSet(posts[posts.length - 1].id);
    return { outcome: "primed", posted: 0, skipped: posts.length, stalled: false };
  }

  let cursor: string | null = null, posted = 0, skipped = 0, stalled = false;
  for (const t of posts) {
    if (t.quotedId || t.repliedToId) { skipped++; cursor = t.id; continue; }
    try {
      await deps.send(deps.chatId, relayText(t, deps.handle));
      posted++;
      cursor = t.id;
    } catch (err) {
      deps.log("tweet not relayed to the Room", { id: t.id, err: (err as Error).message });
      stalled = true;
      break;
    }
  }
  if (cursor) await deps.cursorSet(cursor);
  return { outcome: "relayed", posted, skipped, stalled };
}
