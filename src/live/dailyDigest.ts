/**
 * THE MORNING SUMMARY (Lev, 26 Nov: "her sabah tek bir özet maili"). Calls
 * now open in connected streams with nobody at the keyboard
 * (src/live/autoCall.ts), so one mail at 09:00 Istanbul (06:00 UTC) says what
 * the 24 hours before it did: who went live, every call opened (who opened
 * it, its answers, how it ended), and every chat that refused Lev's line. A
 * week of them shows which calls get answers.
 *
 * Once a day: the day it went out is kept (bot_state) before it is sent, so a
 * deploy around 06:00 never sends it twice. A server that was down at 06:00
 * sends it when it is back, the same 24 hours.
 *
 * What the store cannot say (who went live, Lev's own lines) is kept as it
 * happens, the last two days of it, in one bot_state row.
 */
import type { Platform } from "./calls.js";
import type { DigestCall } from "../store/live.js";

/** 06:00 UTC: 09:00 in Istanbul, which keeps no summer time. */
export const DIGEST_HOUR_UTC = 6;
const DAY_MS = 24 * 60 * 60_000;
const KEEP_MS = 2 * DAY_MS;
const KEEP_MAX = 400;
/** A call Lev's account opened this close to an auto line in the same chat was that line's. */
const AUTO_MATCH_MS = 3 * 60_000;

export interface DigestEvent {
  kind: "live" | "auto-said" | "auto-refused";
  platform: Platform;
  channelId: string;
  at: number;
  /** auto-said: the line; auto-refused: the platform's reason. */
  text?: string;
}

/** The events kept between mails: one JSON row, written one event at a time. */
export function digestEvents(d: { get(): Promise<string | null>; set(v: string): Promise<void>; now(): number }) {
  let chain: Promise<void> = Promise.resolve();
  const read = async (): Promise<DigestEvent[]> => {
    try {
      const v = JSON.parse((await d.get()) ?? "[]");
      return Array.isArray(v) ? (v as DigestEvent[]) : [];
    } catch { return []; }
  };
  return {
    record(e: DigestEvent): Promise<void> {
      chain = chain.then(async () => {
        const cut = d.now() - KEEP_MS;
        const all = (await read()).filter((x) => x.at >= cut);
        all.push(e);
        await d.set(JSON.stringify(all.slice(-KEEP_MAX)));
      }).catch(() => {});
      return chain;
    },
    async between(since: number, until: number): Promise<DigestEvent[]> {
      return (await read()).filter((x) => x.at >= since && x.at < until);
    },
  };
}

const PLATFORM: Record<Platform, string> = { kick: "Kick", twitch: "Twitch", x: "X", youtube: "YouTube" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const ist = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Istanbul", hour: "2-digit", minute: "2-digit" });
const istDay = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Istanbul", day: "numeric", month: "short" });
const time = (t: number) => ist.format(new Date(t));

/** Who opened it, as Lev reads it. */
export function openerOf(c: DigestCall, autoSaid: DigestEvent[], from: string): string {
  if (c.openedById === "oddie") return "oddie (match)";
  if (c.openedById !== null && c.openedById === c.channelId) return "the streamer";
  if ((c.openedByName ?? "").toLowerCase() === from.toLowerCase()) {
    const auto = autoSaid.some((e) => e.platform === c.platform && e.channelId === c.channelId && Math.abs(c.openedAt - e.at) < AUTO_MATCH_MS);
    return auto ? "your account, by itself" : "you";
  }
  return `a mod (${oneLine(c.openedByName ?? "") || "unknown"})`;
}

const resultOf = (c: DigestCall) =>
  c.canceledAt !== null ? "cancelled" : c.outcome === "yes" ? "YES" : c.outcome === "no" ? "NO" : "no result yet";

export interface DigestInput {
  since: number;
  until: number;
  calls: DigestCall[];
  events: DigestEvent[];
  channel(p: Platform, channelId: string): Promise<{ slug: string; name: string | null } | null>;
  /** Lev's login, the same on every platform. */
  from: string;
}

/** The mail: totals in the subject, then who went live, the calls, the refusals. */
export async function digestMail(i: DigestInput): Promise<{ subject: string; html: string }> {
  const named = new Map<string, string>();
  const nameOf = async (p: Platform, id: string, fallback?: { slug: string; name: string | null }) => {
    const k = `${p}:${id}`;
    if (!named.has(k)) {
      const ch = fallback ?? (await i.channel(p, id).catch(() => null));
      named.set(k, oneLine(ch?.name || ch?.slug || id));
    }
    return named.get(k)!;
  };
  const lives = i.events.filter((e) => e.kind === "live").sort((a, b) => a.at - b.at);
  const autoSaid = i.events.filter((e) => e.kind === "auto-said");
  const refused = i.events.filter((e) => e.kind === "auto-refused").sort((a, b) => a.at - b.at);
  const answers = i.calls.reduce((n, c) => n + c.yes + c.no, 0);
  const streams = new Set(lives.map((e) => `${e.platform}:${e.channelId}`)).size;
  const subject = `Oddie, the last 24 hours: ${streams} stream${streams === 1 ? "" : "s"} went live, ${i.calls.length} call${i.calls.length === 1 ? "" : "s"}, ${answers} answer${answers === 1 ? "" : "s"}`;

  const section = (title: string, rows: string[]) => rows.length === 0 ? "" : `
  <p style="margin:16px 0 6px;font-weight:700">${title}</p>
  <ul style="margin:0;padding-left:18px">${rows.map((r) => `<li style="margin:0 0 6px">${r}</li>`).join("")}</ul>`;
  const liveRows: string[] = [];
  for (const e of lives) liveRows.push(`${time(e.at)} · <b>${esc(await nameOf(e.platform, e.channelId))}</b> (${PLATFORM[e.platform]})`);
  const callRows: string[] = [];
  for (const c of i.calls) {
    const who = openerOf(c, autoSaid, i.from);
    callRows.push(`${time(c.openedAt)} · <b>${esc(await nameOf(c.platform, c.channelId, { slug: c.slug, name: c.name }))}</b> (${PLATFORM[c.platform]}): `
      + `"${esc(oneLine(c.question))}" · opened by ${esc(who)} · ${c.yes} yes, ${c.no} no · <b>${resultOf(c)}</b>`);
  }
  const refusedRows: string[] = [];
  for (const e of refused) refusedRows.push(`${time(e.at)} · <b>${esc(await nameOf(e.platform, e.channelId))}</b> (${PLATFORM[e.platform]}): ${esc(oneLine(e.text ?? ""))}`);
  const quiet = lives.length === 0 && i.calls.length === 0 && refused.length === 0;
  const span = `${istDay.format(new Date(i.since))} ${time(i.since)} to ${istDay.format(new Date(i.until))} ${time(i.until)}, Istanbul time`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:620px">
  <p style="margin:0 0 10px">The last 24 hours on Oddie (${span}).</p>${quiet ? `
  <p style="margin:0">Quiet: no connected stream went live and no call was opened.</p>` : ""}${section("Went live", liveRows)}${section("Calls", callRows)}${section("Chats that refused your line", refusedRows)}
</div>`;
  return { subject, html };
}

/** Today's 06:00 UTC, for the moment `now`. */
export function digestTimeFor(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), DIGEST_HOUR_UTC);
}

export interface DigestSendDeps {
  now(): number;
  lastDay(): Promise<string | null>;
  setLastDay(day: string): Promise<void>;
  build(since: number, until: number): Promise<{ subject: string; html: string }>;
  send(m: { to: string; subject: string; html: string }): Promise<"sent" | "dry-run" | "failed">;
  to: string;
  log(line: string, extra?: Record<string, unknown>): void;
}

/** Sends the summary when 06:00 UTC has come and today's has not gone; true when it did. */
export async function sendDigestIfDue(d: DigestSendDeps): Promise<boolean> {
  const now = d.now();
  const at = digestTimeFor(now);
  if (now < at) return false;
  const day = new Date(at).toISOString().slice(0, 10);
  if ((await d.lastDay()) === day) return false;
  await d.setLastDay(day);
  const m = await d.build(at - DAY_MS, at);
  const out = await d.send({ to: d.to, ...m });
  d.log("morning summary", { day, out });
  return true;
}
