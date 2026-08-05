// The source post behind a market, read from X's public oEmbed endpoint.
//
// Why this exists: a market on Oddie is created by someone replying @oddiefun
// under a real post, and that provenance is the product's strongest
// differentiator — it is what makes a market a piece of social content rather
// than an exchange listing. Until now we stored only the post's URL and its
// author's handle, so the card could say "tagged by @x" but could never show
// the claim being argued about. This fetches the text so the card can.
//
// oEmbed is used deliberately over the X API: it needs no key, no OAuth app and
// no per-request auth, and it only ever returns data for a PUBLIC post. If the
// post is private, deleted, or the endpoint is unreachable, we get nothing and
// the card falls back to what it showed before. Never blocks anything.

const OEMBED = "https://publish.twitter.com/oembed";
const TIMEOUT_MS = 6000;

export interface SourcePost {
  /** The post's own text, tags and links stripped, entities decoded. */
  text: string;
  /** Display name of the author ("Hoops Analyst"), not the @handle. */
  authorName: string | null;
}

/** Minimal, targeted entity decoding — oEmbed returns a small, known set. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&mdash;/g, "—").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // LAST — otherwise it would re-open the others
}

/**
 * Pull the post text out of oEmbed's `html`, which looks like:
 *   <blockquote ...><p lang="en" dir="ltr">TEXT</p>&mdash; Name (@handle)
 *   <a href="...">March 21, 2006</a></blockquote>
 *
 * Only the FIRST <p> is the post; everything after it is X's own attribution
 * line and must not be shown as if the author wrote it.
 */
export function extractPostText(html: string): string {
  const m = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  if (!m) return "";
  return decodeEntities(
    m[1]
      .replace(/<br\s*\/?>/gi, " ")   // in-post line breaks -> spaces; the card is 2-3 lines
      .replace(/<[^>]+>/g, ""),        // links/spans inside the post -> their text
  ).replace(/\s+/g, " ").trim();
}

/**
 * Fetch the source post for a status URL. Returns null on ANY failure — a
 * deleted post, a protected account, a rate limit, an outage. Callers treat
 * null as "no preview available", never as an error worth surfacing.
 */
export async function fetchSourcePost(statusUrl: string): Promise<SourcePost | null> {
  if (!/^https?:\/\/(www\.)?(twitter|x)\.com\/[^/]+\/status\/\d+/i.test(statusUrl)) return null;
  try {
    const url = `${OEMBED}?url=${encodeURIComponent(statusUrl)}&omit_script=1&dnt=true`;
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { html?: string; author_name?: string };
    const text = extractPostText(body.html ?? "");
    if (!text) return null;
    return { text, authorName: body.author_name ?? null };
  } catch {
    return null;
  }
}
