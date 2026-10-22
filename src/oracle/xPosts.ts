// The X accounts a market's rule names, read on X itself.
//
// WHY. An organizer that runs a tournament, a launch or a giveaway announces
// the result on its own X account, and often nowhere else: Showdown names its
// champions on X and Discord. The page-reading audit cannot read X (a post
// renders its text in JavaScript, so it comes back "unreachable"), and a fresh
// post is rarely in a search index yet. A market whose rule said "per the
// official announcement on the @company X account" could therefore never
// settle, however plainly the account had posted the answer.
//
// So when the rule names an account, that account's posts since shortly
// before the close are read through the X API and handed to the proposer, and
// a citation of an X post is checked through the API rather than by fetching
// the page (audit.ts).
//
// ONLY THE ACCOUNTS THE RULE NAMES COUNT. Anyone can post anything on X; a
// rule that settled from any post would settle from whoever tweeted first.
// The rule named its source before anybody bet, so that source, and no other
// account, is evidence. Never our own account: oddie announcing an outcome is
// not evidence of it.

export interface XPost {
  id: string;
  handle: string;
  /** The address the proposer cites and the audit checks. */
  url: string;
  text: string;
  createdAt: string | null;
}

export interface XPostReader {
  /** One post, or null when it is gone or hidden. Throws when X did not answer. */
  post(id: string): Promise<{ text: string; createdAt: string | null; authorHandle: string | null } | null>;
  /** An account's own posts since `sinceIso`, newest first. */
  account(handle: string, sinceIso: string, max: number): Promise<Array<{ id: string; text: string; createdAt: string | null }>>;
}

/** Our own account: never a source. */
const OWN = new Set(["oddiefun"]);
/** A rule names one or two sources; more is a list of people, not a source. */
const MAX_SOURCES = 3;
/** Posts read per account per decision. X bills each one. */
const MAX_POSTS = 40;
/** How far before the close an announcement is still looked for: a result
 *  can be posted the moment the event ends, which is often before the market's
 *  own close. */
const LOOKBACK_MS = 7 * 86_400_000;

/** The X accounts a rule names, as "@handle" or an x.com / twitter.com address. */
export function xSourcesIn(criteria: string): string[] {
  const out: string[] = [];
  const add = (h: string) => {
    const k = h.toLowerCase();
    if (!OWN.has(k) && !out.some((x) => x.toLowerCase() === k)) out.push(h);
  };
  const text = String(criteria ?? "");
  // "@Showdown_TCG", not the "@" inside an email address.
  for (const m of text.matchAll(/(?<![\w@.])@([A-Za-z0-9_]{1,15})\b/g)) add(m[1]);
  for (const m of text.matchAll(/\b(?:x|twitter)\.com\/(?!i\/|intent\/|search|hashtag\/|home\b)([A-Za-z0-9_]{1,15})\b/gi)) add(m[1]);
  return out.slice(0, MAX_SOURCES);
}

/** The post an x.com / twitter.com status address points at. `handle` is null
 *  for the /i/status/ form, which names no account. */
export function xStatusUrl(url: string): { handle: string | null; id: string } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!/^(www\.|mobile\.)?(x|twitter)\.com$/i.test(u.hostname)) return null;
  const named = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})(?:\/|$)/.exec(u.pathname);
  if (named && named[1].toLowerCase() !== "i") return { handle: named[1], id: named[2] };
  const bare = /^\/i\/(?:web\/)?status\/(\d{1,25})(?:\/|$)/.exec(u.pathname);
  return bare ? { handle: null, id: bare[1] } : null;
}

const liveReader: XPostReader = {
  async post(id) {
    const x = await import("../x/client.js");
    if (!x.xConfigured()) throw new Error("X is not configured on this server");
    return x.postForAudit(id);
  },
  async account(handle, sinceIso, max) {
    const x = await import("../x/client.js");
    if (!x.xConfigured()) throw new Error("X is not configured on this server");
    return x.accountPosts(handle, sinceIso, max);
  },
};

let reader: XPostReader = liveReader;
/** Test seam: the rules get exercised without X deciding whether the suite passes. */
export function _setXPostReader(r: XPostReader | null): void {
  reader = r ?? liveReader;
}
export const xPostReader = (): XPostReader => reader;

/**
 * The named accounts' posts from a week before the close until now, for the
 * proposer to read. Never throws: an account X will not show us is simply not
 * there, and the market falls back to what search finds.
 */
export async function xPostsFor(sources: string[], closeTime: string | null, now = Date.now()): Promise<XPost[]> {
  const close = closeTime ? Date.parse(closeTime) : NaN;
  const since = new Date((Number.isFinite(close) ? close : now) - LOOKBACK_MS).toISOString();
  const out: XPost[] = [];
  for (const handle of sources.slice(0, MAX_SOURCES)) {
    const posts = await reader.account(handle, since, MAX_POSTS).catch(() => []);
    for (const p of posts) {
      out.push({ id: p.id, handle, url: `https://x.com/${handle}/status/${p.id}`, text: p.text, createdAt: p.createdAt });
    }
  }
  return out;
}

/** One read at boot, through the same two calls the oracle makes, of our own
 *  account (an owned read, the cheapest kind), so the log says whether a rule
 *  that names an X account can be settled from here. */
export async function probeXPostReader(log: (line: Record<string, unknown>) => void, handle = "oddiefun"): Promise<void> {
  try {
    const posts = await reader.account(handle, new Date(Date.now() - 30 * 86_400_000).toISOString(), 5);
    const first = posts[0];
    const post = first ? await reader.post(first.id) : null;
    log({ evt: "x_post_reader", ok: Boolean(post), posts: posts.length, newest: first?.createdAt ?? null, author: post?.authorHandle ?? null, dated: Boolean(post?.createdAt) });
  } catch (e) {
    log({ evt: "x_post_reader", ok: false, why: (e as Error).message.slice(0, 200) });
  }
}
