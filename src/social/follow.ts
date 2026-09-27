/**
 * When somebody you follow does something, you hear about it.
 *
 * Two things are worth following: a person opening a market (always public:
 * its page names its opener) and a person taking a side (only while they show
 * their name). An open is news the moment it happens, because a new market is
 * an invitation; a side taken is paced, at most one message per person you
 * follow per half hour, because somebody busy would otherwise be spam.
 *
 * In Telegram a person is named by their Telegram @handle, or their oddie name
 * without an @: an @ there is a mention, and an oddie name could point at a
 * stranger who owns it. A browser push names them with the @ that is theirs
 * on oddie; they chose to be public, and following them was a choice too.
 */
import type { SocialEvent } from "../store/markets.js";
import { solText } from "../telegram/resolution.js";

export const FOLLOW_PING_GAP_MS = 30 * 60_000;

export interface FollowNotifyDeps {
  now(): number;
  followersOf(actor: string): Promise<string[]>;
  /** The actor as the public may see them, or null when they may not be shown:
   *  no username, or a side taken while their name is hidden. */
  actor(actor: string, kind: SocialEvent["kind"]): Promise<{ username: string; tgHandle: string | null } | null>;
  market(slug: string): Promise<{ headline: string; url: string } | null>;
  /** A follower's Telegram id, when they signed in with Telegram. */
  tgUserFor(canonical: string): Promise<number | null>;
  pushTo(canonical: string, payload: { title: string; body: string; url: string; tag: string }): Promise<void>;
  pacing: { get(key: string): Promise<number | null>; set(key: string, at: number): Promise<void> };
  dm(userId: number, text: string): Promise<void>;
  dryRun?: boolean;
  log(line: string, extra?: Record<string, unknown>): void;
}

export function followText(e: Pick<SocialEvent, "kind" | "side" | "lamports">, who: string, headline: string, url: string): string {
  if (e.kind === "open") return `${who} just opened a market: “${headline}”\n\n${url}`;
  const amt = typeof e.lamports === "number" ? ` with ${solText(e.lamports)} SOL` : "";
  return `${who} just took ${(e.side ?? "").toUpperCase()} on “${headline}”${amt}.\n\n${url}`;
}

export async function notifyFollowers(e: SocialEvent, deps: FollowNotifyDeps): Promise<{ told: number }> {
  const out = { told: 0 };
  const who = await deps.actor(e.actor, e.kind).catch(() => null);
  if (!who) return out;
  const m = await deps.market(e.slug).catch(() => null);
  if (!m) return out;
  const followers = (await deps.followersOf(e.actor).catch(() => [] as string[])).filter((f) => f !== e.actor);
  const now = deps.now();
  const inTelegram = who.tgHandle ? `@${who.tgHandle.replace(/^@+/, "")}` : who.username;
  for (const f of followers) {
    // A side taken is paced per follower and per person followed; a market
    // opened is never held back.
    if (e.kind === "bet") {
      const key = `followping:${f}:${e.actor}`;
      const last = await deps.pacing.get(key).catch(() => null);
      if (last !== null && now - last < FOLLOW_PING_GAP_MS) continue;
      await deps.pacing.set(key, now).catch(() => {});
    }
    if (deps.dryRun) { deps.log("dry-run follow ping", { follower: f, kind: e.kind }); continue; }
    const tg = await deps.tgUserFor(f).catch(() => null);
    if (tg) {
      try { await deps.dm(tg, followText(e, inTelegram, m.headline, m.url)); out.told++; }
      catch (err) { deps.log("follow dm not delivered", { err: (err as Error).message }); }
    }
    await deps.pushTo(f, {
      title: "oddie",
      body: followText(e, `@${who.username}`, m.headline, "").trim(),
      url: m.url, tag: `follow:${e.kind}:${e.slug}`,
    }).catch(() => {});
  }
  return out;
}
