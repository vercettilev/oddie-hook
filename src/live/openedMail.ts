/**
 * THE OPERATOR HEARS ABOUT EVERY CALL AND MARKET A PERSON OPENS IN A STREAM'S
 * CHAT (Lev, 23 Nov: a mail to lev@oddie.fun whenever anybody opens a !call
 * or a market on a Twitch, Kick, X or YouTube stream), so a stream running
 * oddie is seen while it is still on.
 *
 * WHAT MAILS. A !call a person opened (a !call repeat once, at its first
 * round) and a market !oddie opened. Not oddie's own match calls (FACEIT, the
 * game, the picture) and not a repeat's later rounds: one stream would mail
 * every match and every round.
 *
 * NEVER IN THE WAY. The chat has heard its line before the mail is asked for,
 * the engine does not wait for it, and a mail that fails is a log line. The
 * mailer is src/mail.ts: without RESEND_API_KEY every mail is a dry run that
 * logs, so this runs safely before the key exists.
 *
 * WHERE AND HOW MANY. OPS_MAIL_TO (lev@oddie.fun when unset, "off" stops it),
 * at most OPS_MAIL_DAILY_MAX a UTC day (40): the mailer's free tier is 100 a
 * day. The last one that day says so, and the rest wait for the next day.
 */
import type { Platform } from "./calls.js";

export interface Opened {
  kind: "call" | "market";
  platform: Platform;
  channelId: string;
  /** The call's question, or the market's. */
  question: string;
  /** Who typed it, as the chat shows them. */
  by: string;
  /** The market's slug: its page. */
  slug?: string;
}

let sink: ((o: Opened) => void) | null = null;

/** Set once at boot (src/server.ts); null turns it off. */
export function setOpenedSink(f: ((o: Opened) => void) | null): void { sink = f; }

/** Where a call or a market opens. Never throws and never waits: the chat comes first. */
export function reportOpened(o: Opened): void {
  try { sink?.(o); } catch { /* a mail is never worth a chat line */ }
}

export interface ChannelInfo { slug: string; name: string | null }

const PLATFORM_NAME: Record<Platform, string> = { twitch: "Twitch", kick: "Kick", x: "X", youtube: "YouTube" };

/** Where the stream itself is watched. */
export function watchUrl(p: Platform, slug: string, channelId: string): string {
  if (p === "twitch") return `https://www.twitch.tv/${encodeURIComponent(slug)}`;
  if (p === "kick") return `https://kick.com/${encodeURIComponent(slug)}`;
  if (p === "x") return `https://x.com/${encodeURIComponent(slug)}`;
  return `https://www.youtube.com/channel/${encodeURIComponent(channelId)}/live`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The mail for one opening. `last`: the day's mails stop after this one. */
export function openedMail(o: Opened, ch: ChannelInfo | null, appBase: string, last = false): { subject: string; html: string } {
  const base = appBase.replace(/\/+$/, "");
  const slug = ch?.slug || o.channelId;
  const name = oneLine(ch?.name || slug);
  const platform = PLATFORM_NAME[o.platform];
  const question = oneLine(o.question);
  const by = oneLine(o.by) || "somebody";
  const what = o.kind === "market" ? "Market" : "Call";
  const subject = `${what} opened on ${clip(name, 40)} (${platform}): "${clip(question, 90)}"`;
  const links: Array<[string, string]> = [
    ["Watch the stream", watchUrl(o.platform, slug, o.channelId)],
    ...(o.kind === "market" && o.slug ? [["The market", `${base}/m/${encodeURIComponent(o.slug)}`] as [string, string]] : []),
    ["Channel page", `${base}/live/${o.platform}/${encodeURIComponent(slug)}`],
  ];
  const lead = o.kind === "market"
    ? `<b>${esc(by)}</b> opened a market in ${esc(name)}'s ${platform} chat:`
    : `<b>${esc(by)}</b> opened a call on ${esc(name)}'s ${platform} stream:`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:520px">
  <p style="margin:0 0 10px">${lead}</p>
  <p style="margin:0 0 16px;padding:10px 14px;border-left:4px solid #FCF604;background:#f6f6f6;font-weight:700">${esc(question)}</p>
  <p style="margin:0 0 16px">${links.map(([t, u]) => `<a href="${esc(u)}">${t}</a>`).join(" · ")}</p>${last ? `
  <p style="margin:0;color:#6B7A88;font-size:13px">That's today's last mail of these. The next ones come after 00:00 UTC.</p>` : ""}
</div>`;
  return { subject, html };
}

export interface OpenedMailerDeps {
  to: string;
  send(msg: { to: string; subject: string; html: string }): Promise<"sent" | "dry-run" | "failed">;
  channel(p: Platform, channelId: string): Promise<ChannelInfo | null>;
  appBase: string;
  dailyMax: number;
  now(): number;
  log(line: string, extra?: Record<string, unknown>): void;
}

const DAY_MS = 24 * 60 * 60_000;

/** The sink: one mail per opening, the day's count kept in memory. */
export function openedMailer(d: OpenedMailerDeps): (o: Opened) => void {
  let day = -1;
  let count = 0;
  return (o) => {
    const today = Math.floor(d.now() / DAY_MS);
    if (today !== day) { day = today; count = 0; }
    if (count >= d.dailyMax) {
      d.log("opened mail skipped: the day's mails are used", { kind: o.kind, platform: o.platform, channel: o.channelId });
      return;
    }
    count++;
    const last = count === d.dailyMax;
    void (async () => {
      const ch = await d.channel(o.platform, o.channelId).catch(() => null);
      const out = await d.send({ to: d.to, ...openedMail(o, ch, d.appBase, last) });
      d.log("opened mail", { kind: o.kind, platform: o.platform, channel: o.channelId, out });
    })().catch((e) => d.log("opened mail failed", { err: (e as Error).message }));
  };
}
