/**
 * A CALL IN EVERY CONNECTED STREAM (Lev, 26 Nov: "bağlı olan bizi bağlamış
 * olan yayıncıları hangi platformda olursa olsun lev gidip relevant bir call
 * açsın bundan sonra"). A streamer busy playing never types the !call, so a
 * connected chat where nobody opens one never sees oddie work. Lev's own
 * account runs calls in every connected chat (the operators: src/x/live.ts,
 * src/kick/client.ts, src/twitch/client.ts); this says the one he would type
 * when nobody is there to type it.
 *
 * WHEN. A connected channel goes live (the went-live watcher, every two
 * minutes: src/live/openedMail.ts). AUTO_CALL_AFTER_MS later it is still
 * live, no call is open or waiting in it, and none was opened since it went
 * live: then one line, once for that stream. Lev's own channel never gets one.
 *
 * WHAT. What is on decides it, and each is a call the engine settles by itself:
 *  - GTA: `will <name> die in the next 15 minutes?`, the timed death call the
 *    screen settles (src/games/screen.ts deathWindowOf), where the screen is
 *    read (the channel's matchCalls);
 *  - a crypto or trading stream: `will BTC close the hour green?`, or the next
 *    hour when this one has under 20 minutes left (src/live/priceCall.ts);
 *  - anything else: `will we hit N viewers in the next 30 minutes?`, N three
 *    tenths above the count now (src/live/viewerCall.ts).
 * Each is checked by the parser that will read it, so a name the grammar
 * cannot take falls through to the next.
 *
 * HOW IT GOES OUT. As Lev's account, into the chat, the way he types it
 * himself (AUTO_CALL_FROM, his login on both, levvercetti): it comes back
 * through the chat feed as his line, and the engine opens it as it opens his.
 * Kick and Twitch only: X takes a chat line only on a token with
 * broadcast.write, which his sign-in does not carry, and YouTube has no
 * operator. Where a chat refuses his line, Lev hears what fixes it, once a
 * channel in six hours.
 */
import type { Platform } from "./calls.js";
import { deathWindowOf } from "../games/screen.js";
import { parsePriceCall } from "./priceCall.js";
import { parseViewerCall } from "./viewerCall.js";

export const AUTO_CALL_AFTER_MS = 10 * 60_000;
export const AUTO_CALL_PLATFORMS: ReadonlySet<Platform> = new Set<Platform>(["kick", "twitch"]);
/** A call opened this long before the stream was seen live is still this stream's. */
export const AUTO_CALL_OPENED_SLACK_MS = 5 * 60_000;
/** At most one mail a channel in this long about a chat that refused the line. */
const ALERT_GAP_MS = 6 * 60 * 60_000;
const GTA = /\bgta\b|grand theft auto/i;
const CRYPTO = /crypto|trading|stocks|forex|finance/i;

/** The call that fits what is on, as Lev would type it; null when none does. */
export function chooseCall(c: { name: string; game: string | null; viewers: number | null; matchCalls: boolean; now: number }): string | null {
  const game = c.game ?? "";
  if (GTA.test(game) && c.matchCalls) {
    const q = `will ${c.name} die in the next 15 minutes?`;
    if (deathWindowOf(q, c.name) !== null) return `!call ${q}`;
  }
  if (CRYPTO.test(game)) {
    const left = 60 - new Date(c.now).getUTCMinutes();
    const q = left >= 20 ? "will BTC close the hour green?" : "will BTC close the next hour green?";
    if (parsePriceCall(q)) return `!call ${q}`;
  }
  if (c.viewers !== null && c.viewers > 0) {
    const n = Math.max(c.viewers + 2, Math.ceil(c.viewers * 1.3));
    const q = `will we hit ${n} viewers in the next 30 minutes?`;
    if (parseViewerCall(q)) return `!call ${q}`;
  }
  return null;
}

export interface AutoCallDeps {
  channel(p: Platform, channelId: string): Promise<{ slug: string; name: string | null; matchCalls?: boolean } | null>;
  stream(p: Platform, channelId: string): Promise<{ live: boolean; game: string | null; viewers?: number | null } | null>;
  unsettled(p: Platform, channelId: string): Promise<unknown[]>;
  openedSince(p: Platform, channelId: string, since: number): Promise<number>;
  /** Lev's account says it in that chat; it throws when the platform refuses. */
  say(p: Platform, channelId: string, text: string): Promise<void>;
  /** Lev's login, the same on every platform: his own channel never gets one. */
  from: string;
  now(): number;
  log(line: string, extra?: Record<string, unknown>): void;
  alert?(a: { title: string; text: string; link?: [string, string] }): void;
  afterMs?: number;
}

const PLATFORM: Record<Platform, string> = { kick: "Kick", twitch: "Twitch", x: "X", youtube: "YouTube" };
const channelPage = (p: Platform, slug: string): string =>
  p === "twitch" ? `https://www.twitch.tv/${encodeURIComponent(slug)}` : `https://kick.com/${encodeURIComponent(slug)}`;

export function autoCaller(d: AutoCallDeps): { wentLive(c: { platform: Platform; channelId: string }): void; tick(): Promise<number> } {
  const due = new Map<string, { platform: Platform; channelId: string; liveAt: number }>();
  const alertedAt = new Map<string, number>();
  const after = d.afterMs ?? AUTO_CALL_AFTER_MS;
  let ticking = false;
  return {
    wentLive(c) {
      if (!AUTO_CALL_PLATFORMS.has(c.platform)) return;
      due.set(`${c.platform}:${c.channelId}`, { platform: c.platform, channelId: c.channelId, liveAt: d.now() });
    },
    async tick() {
      if (ticking) return 0;
      ticking = true;
      let said = 0;
      try {
        for (const [k, w] of [...due]) {
          if (d.now() - w.liveAt < after) continue;
          due.delete(k);
          const where = { platform: w.platform, channel: w.channelId };
          try {
            const ch = await d.channel(w.platform, w.channelId);
            if (!ch || ch.slug.toLowerCase() === d.from.toLowerCase()) continue;
            const s = await d.stream(w.platform, w.channelId);
            if (!s?.live) { d.log("auto call skipped: the stream is not on", where); continue; }
            if ((await d.unsettled(w.platform, w.channelId)).length > 0) { d.log("auto call skipped: a call is open", where); continue; }
            if ((await d.openedSince(w.platform, w.channelId, w.liveAt - AUTO_CALL_OPENED_SLACK_MS)) > 0) {
              d.log("auto call skipped: this stream had a call", where);
              continue;
            }
            const text = chooseCall({ name: ch.name || ch.slug, game: s.game, viewers: s.viewers ?? null, matchCalls: ch.matchCalls !== false, now: d.now() });
            if (!text) { d.log("auto call skipped: nothing fits", { ...where, game: s.game }); continue; }
            try {
              await d.say(w.platform, w.channelId, text);
            } catch (e) {
              const err = ((e as Error)?.message ?? String(e)).slice(0, 200);
              d.log("auto call refused", { ...where, from: d.from, err });
              if (d.alert && d.now() - (alertedAt.get(k) ?? -Infinity) >= ALERT_GAP_MS) {
                alertedAt.set(k, d.now());
                const who = ch.name || ch.slug;
                const fix = w.platform === "kick"
                  ? `On Kick, sign in as ${d.from}, follow the channel and accept its chat rules.`
                  : `On Twitch, sign in as ${d.from}, follow the channel and add what its chat asks for.`;
                d.alert({
                  title: `${d.from} can't open a call in ${who}'s ${PLATFORM[w.platform]} chat`,
                  text: `${PLATFORM[w.platform]} refused ${d.from}'s line in ${who}'s chat (${err}). ${fix} Their next stream tries again.`,
                  link: ["Open the channel", channelPage(w.platform, ch.slug)],
                });
              }
              continue;
            }
            d.log("auto call said", { ...where, text, game: s.game });
            said++;
          } catch (e) {
            d.log("auto call failed", { ...where, err: ((e as Error)?.message ?? String(e)).slice(0, 200) });
          }
        }
      } finally {
        ticking = false;
      }
      return said;
    },
  };
}
