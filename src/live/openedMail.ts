/**
 * THE OPERATOR'S MAIL. Lev hears at lev@oddie.fun the moments a stream
 * running oddie needs him, while the stream is still on.
 *
 * OPENED (Lev, 23 Nov: a mail whenever anybody opens a !call or a market on a
 * Twitch, Kick, X or YouTube stream). A !call a person opened (a !call repeat
 * once, at its first round) and a market !oddie opened. Not oddie's own match
 * calls (FACEIT, the game, the picture) and not a repeat's later rounds: one
 * stream would mail every match and every round.
 *
 * LIVE (Lev, 24 Nov). A connected channel just went live, on any platform, so
 * Lev can be in its chat while it is on: on X he opens the calls himself (an
 * operator there, src/x/live.ts), elsewhere he nudges the streamer. Every
 * active channel is asked every two minutes (src/server.ts). The first pass
 * after a boot only learns who is on already, a read that failed changes
 * nothing, and one channel mails at most once in two hours, so a stream that
 * drops and comes back is not a new one.
 *
 * SETTLED (Lev, 24 Nov: every result can be a post). A call a person opened
 * has its result, read off the screen, given by the streamer or a mod, or by
 * the price. The mail says who called it, says when chat voted the other way
 * (the result worth posting first), and links the call's card, which is one
 * tap from a post (src/live/callPage.ts), and the picture the screen settled
 * it on. Canceled calls and oddie's own match calls do not mail.
 *
 * NEVER IN THE WAY. The chat has heard its line before the mail is asked for,
 * nothing waits for it, and a mail that fails is a log line. The mailer is
 * src/mail.ts: without RESEND_API_KEY every mail is a dry run that logs.
 *
 * ALERT (24 Nov). Something only the operator can mend, like oddie's Kick
 * voice signing out (src/kick/routes.ts): what broke and the link to fix it.
 *
 * WHERE AND HOW MANY. OPS_MAIL_TO (lev@oddie.fun when unset, "off" stops it),
 * at most OPS_MAIL_DAILY_MAX (40) of each kind a UTC day, so a busy day of one
 * kind never silences the others. The last one of a kind that day says so.
 */
import { chatVotedOf, type Platform, type Side } from "./calls.js";
import { callPath } from "./callPage.js";

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

export interface WentLive {
  kind: "live";
  platform: Platform;
  channelId: string;
}

export interface Settled {
  kind: "settled";
  platform: Platform;
  channelId: string;
  callId: string;
  question: string;
  outcome: Side;
  /** What settled it: the picture, the streamer or a mod, or the price. */
  source: "screen" | "streamer" | "price";
  /** The streamer or mod who did, as the chat shows them. */
  by?: string;
  right: number;
  total: number;
  /** Who called it, first in first. */
  winners: string[];
  /** The screen's picture was kept: the mail links it. */
  frame: boolean;
}

/** Something the operator has to fix by hand (src/kick/routes.ts: the Kick voice signed out). */
export interface Alert {
  kind: "alert";
  title: string;
  text: string;
  /** What to open to fix it: [label, url]. */
  link?: [string, string];
}

export type OpsEvent = Opened | WentLive | Settled | Alert;

let sink: ((e: OpsEvent) => void) | null = null;

/** Set once at boot (src/server.ts); null turns it off. */
export function setOpsSink(f: ((e: OpsEvent) => void) | null): void { sink = f; }

/** Never throws and never waits: the chat comes first. */
function emit(e: OpsEvent): void {
  try { sink?.(e); } catch { /* a mail is never worth a chat line */ }
}

/** Where a call or a market opens. */
export function reportOpened(o: Opened): void { emit(o); }
/** A channel the watcher saw go live. */
export function reportLive(l: Omit<WentLive, "kind">): void { emit({ kind: "live", ...l }); }
/** Where a call a person opened gets its result. */
export function reportSettled(s: Omit<Settled, "kind">): void { emit({ kind: "settled", ...s }); }
/** Where something breaks that only the operator can mend. */
export function reportAlert(a: Omit<Alert, "kind">): void { emit({ kind: "alert", ...a }); }

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

interface Where { base: string; slug: string; name: string; platform: string }

function where(p: Platform, channelId: string, ch: ChannelInfo | null, appBase: string): Where {
  const slug = ch?.slug || channelId;
  return { base: appBase.replace(/\/+$/, ""), slug, name: oneLine(ch?.name || slug), platform: PLATFORM_NAME[p] };
}

/** The one layout every mail shares: a lead, the question set apart, the links. */
function page(lead: string, quote: string | null, extra: string | null, links: Array<[string, string]>, last: boolean): string {
  return `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:520px">
  <p style="margin:0 0 10px">${lead}</p>${quote === null ? "" : `
  <p style="margin:0 0 16px;padding:10px 14px;border-left:4px solid #FCF604;background:#f6f6f6;font-weight:700">${esc(quote)}</p>`}${extra === null ? "" : `
  <p style="margin:0 0 16px">${extra}</p>`}
  <p style="margin:0 0 16px">${links.map(([t, u]) => `<a href="${esc(u)}">${t}</a>`).join(" · ")}</p>${last ? `
  <p style="margin:0;color:#6B7A88;font-size:13px">That's today's last mail of these. The next ones come after 00:00 UTC.</p>` : ""}
</div>`;
}

/** The mail for one opening. `last`: the day's mails of this kind stop after this one. */
export function openedMail(o: Opened, ch: ChannelInfo | null, appBase: string, last = false): { subject: string; html: string } {
  const w = where(o.platform, o.channelId, ch, appBase);
  const question = oneLine(o.question);
  const by = oneLine(o.by) || "somebody";
  const what = o.kind === "market" ? "Market" : "Call";
  const subject = `${what} opened on ${clip(w.name, 40)} (${w.platform}): "${clip(question, 90)}"`;
  const links: Array<[string, string]> = [
    ["Watch the stream", watchUrl(o.platform, w.slug, o.channelId)],
    ...(o.kind === "market" && o.slug ? [["The market", `${w.base}/m/${encodeURIComponent(o.slug)}`] as [string, string]] : []),
    ["Channel page", `${w.base}/live/${o.platform}/${encodeURIComponent(w.slug)}`],
  ];
  const lead = o.kind === "market"
    ? `<b>${esc(by)}</b> opened a market in ${esc(w.name)}'s ${w.platform} chat:`
    : `<b>${esc(by)}</b> opened a call on ${esc(w.name)}'s ${w.platform} stream:`;
  return { subject, html: page(lead, question, null, links, last) };
}

/** The mail for a channel that just went live. */
export function liveMail(l: WentLive, ch: ChannelInfo | null, appBase: string, last = false): { subject: string; html: string } {
  const w = where(l.platform, l.channelId, ch, appBase);
  const subject = `${clip(w.name, 60)} is live on ${w.platform}`;
  const lead = `<b>${esc(w.name)}</b> just went live on ${w.platform}.`;
  // On X Lev is an operator in every connected chat; elsewhere the streamer or a mod opens.
  const what = l.platform === "x"
    ? "You can open calls in this chat yourself: type !call and a question."
    : "A call opens when they or a mod type !call and a question.";
  const links: Array<[string, string]> = [
    ["Watch the stream", watchUrl(l.platform, w.slug, l.channelId)],
    ["Channel page", `${w.base}/live/${l.platform}/${encodeURIComponent(w.slug)}`],
  ];
  return { subject, html: page(lead, null, what, links, last) };
}

/** The mail for a call a person opened that has its result. */
export function settledMail(s: Settled, ch: ChannelInfo | null, appBase: string, last = false): { subject: string; html: string } {
  const w = where(s.platform, s.channelId, ch, appBase);
  const question = oneLine(s.question);
  const result = s.outcome === "yes" ? "YES" : "NO";
  const subject = `Call settled on ${clip(w.name, 40)} (${w.platform}): ${result}, "${clip(question, 80)}"`;
  const who = s.source === "screen" ? "The screen" : s.source === "price" ? "The price" : `<b>${esc(oneLine(s.by ?? "") || "A mod")}</b>`;
  const lead = `${who} settled it <b>${result}</b> on ${esc(w.name)}'s ${w.platform} stream:`;
  const names = s.winners.map((n) => oneLine(n)).filter(Boolean);
  const shown = names.slice(0, 8).map((n) => `@${esc(n)}`).join(" ");
  const more = names.length > 8 ? ` and ${names.length - 8} more` : "";
  // The room voted the other way (chatVoted): the result that makes a post.
  const voted = chatVotedOf(s.outcome, s.right, s.total);
  const against = voted && voted !== s.outcome ? `<b>Chat voted ${voted}.</b> ` : "";
  const called = against + (s.total === 0 ? "Nobody answered."
    : s.right === 0 ? `Nobody called it. ${s.total} answered.`
    : `${s.right} of ${s.total} called it: ${shown}${more}`);
  // The card's page is the channel's page with the card on top, so it stands in for that link here.
  const links: Array<[string, string]> = [
    ["The card", w.base + callPath(s.platform, w.slug, s.callId)],
    ...(s.frame ? [["What Oddie saw", `${w.base}/api/live/${s.platform}/${encodeURIComponent(w.slug)}/frame/${encodeURIComponent(s.callId)}`] as [string, string]] : []),
    ["Watch the stream", watchUrl(s.platform, w.slug, s.channelId)],
  ];
  return { subject, html: page(lead, question, called, links, last) };
}

/** The mail for something the operator has to fix. */
export function alertMail(a: Alert, last = false): { subject: string; html: string } {
  return { subject: oneLine(a.title), html: page(esc(a.text), null, null, a.link ? [a.link] : [], last) };
}

/** Any event's mail. */
export function opsMail(e: OpsEvent, ch: ChannelInfo | null, appBase: string, last = false): { subject: string; html: string } {
  if (e.kind === "alert") return alertMail(e, last);
  if (e.kind === "live") return liveMail(e, ch, appBase, last);
  if (e.kind === "settled") return settledMail(e, ch, appBase, last);
  return openedMail(e, ch, appBase, last);
}

export interface OpsMailerDeps {
  to: string;
  send(msg: { to: string; subject: string; html: string }): Promise<"sent" | "dry-run" | "failed">;
  channel(p: Platform, channelId: string): Promise<ChannelInfo | null>;
  appBase: string;
  /** Per kind: opened, live and settled each count their own. */
  dailyMax: number;
  now(): number;
  log(line: string, extra?: Record<string, unknown>): void;
}

const DAY_MS = 24 * 60 * 60_000;

/** The sink: one mail per event, each kind's count for the day kept in memory. */
export function opsMailer(d: OpsMailerDeps): (e: OpsEvent) => void {
  const counts = new Map<string, { day: number; n: number }>();
  return (e) => {
    const label = e.kind === "alert" ? "alert mail" : e.kind === "live" ? "live mail" : e.kind === "settled" ? "settled mail" : "opened mail";
    const where = e.kind === "alert" ? {} : { platform: e.platform, channel: e.channelId };
    const today = Math.floor(d.now() / DAY_MS);
    let c = counts.get(label);
    if (!c || c.day !== today) { c = { day: today, n: 0 }; counts.set(label, c); }
    if (c.n >= d.dailyMax) {
      d.log(`${label} skipped: the day's mails are used`, { kind: e.kind, ...where });
      return;
    }
    c.n++;
    const last = c.n === d.dailyMax;
    void (async () => {
      const ch = e.kind === "alert" ? null : await d.channel(e.platform, e.channelId).catch(() => null);
      const out = await d.send({ to: d.to, ...opsMail(e, ch, d.appBase, last) });
      d.log(label, { kind: e.kind, ...where, out });
    })().catch((err) => d.log(`${label} failed`, { err: (err as Error).message }));
  };
}

export interface WentLiveDeps {
  channels(): Promise<Array<{ platform: Platform; channelId: string }>>;
  /** True, false, or null when the platform could not say. */
  streamLive(p: Platform, channelId: string): Promise<boolean | null>;
  now(): number;
  report(c: { platform: Platform; channelId: string }): void;
  /** One channel mails at most once in this long. */
  quietMs?: number;
}

const QUIET_MS = 2 * 60 * 60_000;

/**
 * One pass over every active channel; it returns how many went live. The
 * first pass only learns who is on. After it, a channel goes live when it
 * reads live and was not known to be: off before, never read, or (on X,
 * where nothing is known until a broadcast starts) unknown.
 */
export function wentLiveWatcher(d: WentLiveDeps): () => Promise<number> {
  const seen = new Map<string, { live: boolean | null; mailedAt: number | null }>();
  const quiet = d.quietMs ?? QUIET_MS;
  let warm = false;
  return async () => {
    const chans = await d.channels();
    let n = 0;
    for (const ch of chans) {
      const k = `${ch.platform}:${ch.channelId}`;
      const live = await d.streamLive(ch.platform, ch.channelId).catch(() => null);
      const prev = seen.get(k);
      if (!warm) { seen.set(k, { live, mailedAt: null }); continue; }
      // A read that failed changes nothing.
      if (live === null) { if (!prev) seen.set(k, { live: null, mailedAt: null }); continue; }
      let mailedAt = prev?.mailedAt ?? null;
      if (live && prev?.live !== true) {
        const now = d.now();
        if (mailedAt === null || now - mailedAt >= quiet) {
          d.report({ platform: ch.platform, channelId: ch.channelId });
          mailedAt = now;
          n++;
        }
      }
      seen.set(k, { live, mailedAt });
    }
    warm = true;
    return n;
  };
}
