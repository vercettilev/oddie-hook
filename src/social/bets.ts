/**
 * When a stake lands, the people it concerns hear about it.
 *
 * WHY THIS EXISTS. No market here has ever had two sides: every stake so far
 * sat alone, and nobody on the other side was ever told there was anything to
 * take. The moment a stake lands is the moment to say so, to the room the
 * market came from and to the people already in it. It is also the first
 * event of the social layer, so what is recorded here is what a follow feed
 * will read later.
 *
 * WHO HEARS WHAT.
 *   - The Telegram group the market was opened in: a reply under the tag,
 *     "Someone just took YES with 0.5 SOL. NO is wide open.", with a button.
 *   - Everybody on the OTHER side of this stake: "someone took the other side
 *     of your bet", in the app, and by Telegram or push when we can reach them.
 *   - The opener: a bet came into your market, which is their 2% growing.
 *
 * A NAME ONLY BY CHOICE. The stake is "Someone" unless its owner turned on
 * "show my name" on their profile. Then Telegram hears their Telegram @handle
 * (a name Telegram verified), or failing that their oddie name WITHOUT an @: an
 * @ in Telegram is a mention, and an oddie name there could point at a
 * stranger who happens to own it. The lock-screen push never names anybody.
 *
 * THE PHONE BUZZES AT MOST EVERY HALF HOUR PER MARKET. The in-app list gets
 * every event; the group and the private messages get the first stake on each
 * side (the one that matters: a market getting its other side) and after that
 * only a pool that has grown by half, no sooner than thirty minutes on.
 */
import type { BetNotice } from "../store/markets.js";
import { solText } from "../telegram/resolution.js";

export interface BetLanded {
  slug: string;
  /** The wallet that staked. Never printed. */
  wallet: string;
  side: "yes" | "no";
  lamports: number;
  /** The pool just before this stake landed. */
  before: { yes: number; no: number };
}

/** The last time this market was announced, and the pool it announced. */
export interface Pacing { at: number; pool: number }

export const BROADCAST_GAP_MS = 30 * 60_000;
const other = (s: "yes" | "no"): "yes" | "no" => (s === "yes" ? "no" : "yes");
const after = (e: BetLanded) => ({
  yes: e.before.yes + (e.side === "yes" ? e.lamports : 0),
  no: e.before.no + (e.side === "no" ? e.lamports : 0),
});

/** Whether this stake is worth a group message and a buzz. */
export function shouldBroadcast(e: BetLanded, last: Pacing | null, now: number): boolean {
  // The first stake on a side is always news: the first stake of the market,
  // or the market getting its other side, which is the whole point.
  if (e.before[e.side] === 0) return true;
  if (!last) return true;
  const pool = e.before.yes + e.before.no + e.lamports;
  return now - last.at >= BROADCAST_GAP_MS && pool >= last.pool * 1.5;
}

/** How a staker is named in Telegram: see the header. */
export function tgWho(name: { username: string | null; tgHandle: string | null } | null): string {
  if (name?.tgHandle) return `@${name.tgHandle.replace(/^@+/, "")}`;
  if (name?.username) return name.username;
  return "Someone";
}

/** The group message. */
export function groupText(e: BetLanded, who = "Someone"): string {
  const side = e.side.toUpperCase();
  const opp = other(e.side).toUpperCase();
  const a = after(e);
  const amt = `${solText(e.lamports)} SOL`;
  const oppAfter = a[other(e.side)];
  if (e.before[e.side] === 0 && oppAfter === 0) return `${who} just took ${side} with ${amt}. ${opp} is wide open.`;
  if (e.before[e.side] === 0) {
    return `${who} just took ${side} with ${amt}. Both sides are in: ${solText(a.yes)} SOL on YES, ${solText(a.no)} SOL on NO.`;
  }
  if (oppAfter === 0) return `${who} just added ${amt} to ${side}. ${solText(a[e.side])} SOL on ${side}, and ${opp} is wide open.`;
  return `${who} just added ${amt} to ${side}. The pool: ${solText(a.yes)} SOL on YES, ${solText(a.no)} SOL on NO.`;
}

/** To somebody on the other side of this stake. */
export function counterText(e: BetLanded, headline: string, url: string, who = "Someone"): string {
  return `${who} took the other side of your bet on “${headline}”: ${solText(e.lamports)} SOL on ${e.side.toUpperCase()}.\n\n${url}`;
}

/** To the person who opened the market. */
export function openerText(e: BetLanded, headline: string, url: string, feeBps: number, who = "Someone"): string {
  const pool = e.before.yes + e.before.no + e.lamports;
  const earn = feeBps > 0 ? `, and you earn ${feeBps / 100}% of it when it settles` : "";
  const from = who === "Someone" ? "" : ` from ${who}`;
  return `${solText(e.lamports)} SOL just came in on ${e.side.toUpperCase()}${from} in your market “${headline}”. The pool is ${solText(pool)} SOL${earn}.\n\n${url}`;
}

export interface BetNotifyDeps {
  now(): number;
  market(slug: string): Promise<{ headline: string; url: string; feeBps: number } | null>;
  /** The opener's wallet (their 2%) and Telegram id, when known. */
  opener(slug: string): Promise<{ wallet: string | null; tgUserId: number | null } | null>;
  walletsOnSide(slug: string, side: "yes" | "no"): Promise<string[]>;
  /** Writes each notice once and returns only the new ones. */
  record(list: BetNotice[]): Promise<BetNotice[]>;
  tgUserForWallet(wallet: string): Promise<number | null>;
  /** Groups the bot is in where this market was announced, and the tag there. */
  groupThreads(slug: string): Promise<Array<{ chatId: number; messageId: number }>>;
  pacing: { get(slug: string): Promise<Pacing | null>; set(slug: string, p: Pacing): Promise<void> };
  sendGroup(o: { chatId: number; replyTo: number; text: string; url: string }): Promise<void>;
  dm(userId: number, text: string): Promise<void>;
  push(wallets: string[], payload: { title: string; body: string; url: string; tag: string }): Promise<void>;
  /** The staker's chosen name, only when they turned "show my name" on. */
  nameFor?(wallet: string): Promise<{ username: string | null; tgHandle: string | null } | null>;
  dryRun?: boolean;
  log(line: string, extra?: Record<string, unknown>): void;
}

export interface BetNotifyOutcome { notices: number; broadcast: boolean; groups: number; dms: number }

/**
 * Best-effort from end to end: the stake has already landed and nothing here
 * may touch it. One failed delivery never stops the next.
 */
export async function onBetLanded(e: BetLanded, deps: BetNotifyDeps): Promise<BetNotifyOutcome> {
  const out: BetNotifyOutcome = { notices: 0, broadcast: false, groups: 0, dms: 0 };
  const m = await deps.market(e.slug).catch(() => null);
  if (!m) return out;
  const [opener, others] = await Promise.all([
    deps.opener(e.slug).catch(() => null),
    deps.walletsOnSide(e.slug, other(e.side)).catch(() => [] as string[]),
  ]);

  // Everybody on the other side, except the person who just staked (a wallet
  // holds one side per market, but a relay retried is the same person).
  const counter = [...new Set(others)].filter((w) => w && w !== e.wallet);
  const openerWallet = opener?.wallet && opener.wallet !== e.wallet ? opener.wallet : null;
  const notices: BetNotice[] = [
    ...counter.map((w): BetNotice => ({ wallet: w, kind: "counter", slug: e.slug, actor: e.wallet, side: e.side, lamports: e.lamports })),
    ...(openerWallet ? [{ wallet: openerWallet, kind: "opened_bet" as const, slug: e.slug, actor: e.wallet, side: e.side, lamports: e.lamports }] : []),
  ];
  const fresh = notices.length ? await deps.record(notices).catch(() => [] as BetNotice[]) : [];
  out.notices = fresh.length;

  const last = await deps.pacing.get(e.slug).catch(() => null);
  const now = deps.now();
  if (!shouldBroadcast(e, last, now)) {
    deps.log("bet noted, not broadcast", { slug: e.slug, notices: out.notices });
    return out;
  }
  out.broadcast = true;
  // Paced BEFORE sending: two stakes landing together must not both decide
  // they are the first announcement.
  await deps.pacing.set(e.slug, { at: now, pool: e.before.yes + e.before.no + e.lamports }).catch(() => {});

  const say = async (what: string, fn: () => Promise<void>): Promise<boolean> => {
    if (deps.dryRun) { deps.log(`dry-run ${what}`, { slug: e.slug }); return false; }
    try { await fn(); return true; } catch (err) {
      deps.log(`${what} not delivered`, { slug: e.slug, err: (err as Error).message });
      return false;
    }
  };

  const who = tgWho(deps.nameFor ? await deps.nameFor(e.wallet).catch(() => null) : null);
  const text = groupText(e, who);
  for (const g of await deps.groupThreads(e.slug).catch(() => [])) {
    if (await say("group ping", () => deps.sendGroup({ chatId: g.chatId, replyTo: g.messageId, text, url: m.url }))) out.groups++;
  }

  // Private messages and pushes follow the same pacing, and only for people
  // this stake actually concerns.
  const freshCounter = fresh.filter((n) => n.kind === "counter").map((n) => n.wallet);
  for (const w of freshCounter) {
    const tg = await deps.tgUserForWallet(w).catch(() => null);
    if (tg && await say("counter dm", () => deps.dm(tg, counterText(e, m.headline, m.url, who)))) out.dms++;
  }
  if (freshCounter.length) {
    await deps.push(freshCounter, {
      title: "oddie", body: `Someone took the other side of your bet on “${m.headline}”.`, url: m.url, tag: `counter:${e.slug}`,
    }).catch(() => {});
  }
  // The opener hears it unless the stake is their own. One with no wallet yet
  // has no in-app notice to key on, but can still be told on Telegram, and
  // being told their market is filling is the best reason to choose one.
  const openerIsBettor = Boolean(opener?.wallet && opener.wallet === e.wallet);
  const tellOpener = !openerIsBettor
    && (fresh.some((n) => n.kind === "opened_bet") || (!opener?.wallet && Boolean(opener?.tgUserId)));
  if (tellOpener) {
    const tg = opener?.tgUserId ?? (openerWallet ? await deps.tgUserForWallet(openerWallet).catch(() => null) : null);
    if (tg && await say("opener dm", () => deps.dm(tg, openerText(e, m.headline, m.url, m.feeBps, who)))) out.dms++;
    if (openerWallet) {
      await deps.push([openerWallet], {
        title: "oddie", body: `A bet came into your market “${m.headline}”.`, url: m.url, tag: `opened:${e.slug}`,
      }).catch(() => {});
    }
  }
  deps.log("bet broadcast", { slug: e.slug, groups: out.groups, dms: out.dms, notices: out.notices });
  return out;
}
