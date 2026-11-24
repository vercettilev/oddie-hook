/**
 * A SETTLED CALL'S OWN PAGE (Lev, 24 Nov): /live/<platform>/<slug>/call/<id>.
 *
 * The card (src/card/renderCalledItCard.ts) was a picture behind a link on the
 * channel's page, and a picture's address shows as a bare link on X. This is
 * the address that carries it: the channel's page with the card on top, and in
 * the HTML a crawler fetches the tags that make X, Telegram and Discord draw
 * the card under the post. The page's "Post on X" opens a post already
 * written, from the call's own numbers and nothing else.
 *
 * THE POST'S WORDS (the voice Lev picked on 12 Nov): the first line is the
 * story, in plain words; the stream comes last. "Chat voted no" is said only
 * when it is exactly true (chatVoted). A post never starts with @, which X
 * reads as a reply, and only an X channel is tagged: a Kick or Twitch name
 * with an @ in front would tag whoever holds that handle on X.
 */
import { chatVoted, type Platform, type Side } from "./calls.js";

export interface SharedCall { question: string; outcome: Side; yes: number; no: number }
export interface SharedChannel { slug: string; name: string | null }

const WHERE: Record<Platform, string> = { kick: "Kick", twitch: "Twitch", youtube: "YouTube", x: "X" };
/** The longest question a post quotes: the rest of it and the link still fit X's 280. */
const POST_QUESTION_MAX = 150;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** Whose stream it was, as a post says it. */
function streamOf(platform: Platform, ch: SharedChannel): string {
  if (platform === "x") return `@${ch.slug.replace(/^@+/, "")}'s stream`;
  return `${oneLine(ch.name || ch.slug).replace(/@/g, "")}'s ${WHERE[platform]} stream`;
}

/** The post a settled call opens with, before its link. */
export function callPost(c: SharedCall, platform: Platform, ch: SharedChannel): string {
  const q = clip(oneLine(c.question), POST_QUESTION_MAX);
  const voted = chatVoted(c);
  const on = streamOf(platform, ch);
  if (voted && voted !== c.outcome) return `Chat voted ${voted} on "${q}"\n\nIt was ${c.outcome}.\n\nOn ${on}.`;
  return `"${q}"\n\n${c.outcome === "yes" ? "Yes" : "No"}, on ${on}.`;
}

/** X's own compose window, with the post written and the call's page as its link. */
export const postIntentUrl = (text: string, pageUrl: string): string =>
  `https://x.com/intent/post?text=${enc(text)}&url=${enc(pageUrl)}`;
/** encodeURIComponent leaves the apostrophe alone, and "@name's stream" has one: some link readers end a link there. */
const enc = (s: string): string => encodeURIComponent(s).replace(/'/g, "%27");

/** Where a settled call lives, and where its card does. `base` is the app's own address. */
export const callPath = (platform: Platform, slug: string, callId: string): string =>
  `/live/${platform}/${encodeURIComponent(slug)}/call/${callId}`;
export const cardPath = (platform: Platform, slug: string, callId: string, version: number): string =>
  `/api/live/${platform}/${encodeURIComponent(slug)}/card/${callId}.png?v=${version}`;

/** The channel page's HTML with the call's tags in its head: what a crawler reads. */
export function callPageHtml(shell: string, c: SharedCall, platform: Platform, ch: SharedChannel, pageUrl: string, cardUrl: string): string {
  const q = oneLine(c.question);
  const title = `${c.outcome.toUpperCase()}: ${q}`;
  const voted = chatVoted(c);
  const name = oneLine(ch.name || ch.slug);
  const desc = `${voted && voted !== c.outcome ? `Chat voted ${voted}. ` : ""}Settled on ${name}'s ${WHERE[platform]} stream.`;
  const tags = [
    `<link rel="canonical" href="${esc(pageUrl)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="oddie">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(pageUrl)}">`,
    `<meta property="og:image" content="${esc(cardUrl)}">`,
    `<meta property="og:image:type" content="image/png">`,
    `<meta property="og:image:width" content="2000">`,
    `<meta property="og:image:height" content="1125">`,
    `<meta property="og:image:alt" content="${esc(title)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`,
    `<meta name="twitter:image" content="${esc(cardUrl)}">`,
  ].join("\n");
  // A function, so a "$&" in a question is never read as a pattern.
  return shell.replace("<title>oddie</title>", () => `<title>${esc(title)} · oddie</title>\n${tags}`);
}
