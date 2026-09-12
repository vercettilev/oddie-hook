/**
 * The X API v2 client, user context, exactly the four calls the bot makes.
 *
 * No SDK. The surface is small (one read, one write, one media upload, one
 * token refresh) and every X library we would pull in wraps the same four
 * fetches in a dependency that has to be trusted with a credential that can
 * post as @oddiefun. Four fetches are cheaper to audit than that.
 *
 * AUTH, AND THE TRAP THAT DEFINES THIS FILE.
 *
 * The bot authenticates as a USER (itself), not as an app: v2 write endpoints
 * refuse app-only bearer tokens. That means OAuth 2.0 with `offline.access`,
 * which yields a refresh token, and here is the part that bites:
 *
 *   X rotates the refresh token on EVERY refresh and invalidates the old one.
 *
 * So a refresh token pasted into an env var is correct exactly once. The
 * moment the first refresh succeeds, the value in Railway is dead, and the
 * next cold start authenticates with a revoked token and the bot goes
 * silently offline until somebody redoes the consent screen by hand. The fix
 * is that the env var is only ever a SEED: the first refresh writes the new
 * token to `bot_state` and every refresh after that reads and writes there.
 *
 * This is also why the loop refuses to run for real without a database. A
 * rotation written to an in-memory map is a rotation lost at the next deploy.
 */

import { botStateGet, botStateSet, PERSISTENT } from "../store/markets.js";

const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const API = "https://api.x.com/2";
/** Media upload is not on api.x.com/2 and has no v2 equivalent for this flow. */
// The v2 one-shot upload. The v1.1 endpoint this used to call
// (upload.twitter.com/1.1/media/upload.json) was SUNSET on 9 June 2025 and the
// call had never once run for real, because the bot has been in dry run since
// the day it was written: every card would have failed to attach and every
// reply would have quietly gone out as bare text.
//
// One-shot rather than the initialize/append/finalize flow: X reserved this
// path for images and subtitles when it retired the `command` parameter, and
// our cards are ~150KB PNGs. Chunking them would be ceremony.
const UPLOAD_URL = "https://api.x.com/2/media/upload";

const REFRESH_KEY = "x_refresh_token";
export const SINCE_KEY = "x_since_id";

/** The seed. Read once, on the first refresh, and never authoritative after. */
const SEED_REFRESH = process.env.X_BOT_REFRESH_TOKEN;
const CLIENT_ID = process.env.TWITTER_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.TWITTER_CLIENT_SECRET ?? "";
/** The bot's own numeric user id. Mentions are read from a per-user path. */
const BOT_USER_ID = process.env.X_BOT_USER_ID ?? "";

export const xConfigured = (): boolean =>
  Boolean(CLIENT_ID && CLIENT_SECRET && BOT_USER_ID && (SEED_REFRESH || !PERSISTENT));

/** Everything missing, named, so a misconfigured deploy says so once and stops. */
export function xMissing(): string[] {
  const out: string[] = [];
  if (!CLIENT_ID) out.push("TWITTER_CLIENT_ID");
  if (!CLIENT_SECRET) out.push("TWITTER_CLIENT_SECRET");
  if (!BOT_USER_ID) out.push("X_BOT_USER_ID");
  if (!SEED_REFRESH) out.push("X_BOT_REFRESH_TOKEN");
  return out;
}

export class XError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) {
    super(message);
    this.name = "XError";
  }
}

/* --------------------------------------------------------------- tokens ---- */

interface Access { token: string; expiresAt: number }
let cached: Access | null = null;

/** Refresh a minute early. A token that expires mid-flight costs a retry. */
const SKEW_MS = 60_000;

/** Which seed produced the token now in the store. Written beside it so a NEW
 *  seed can be told apart from the one already spent. */
const SEED_KEY = "x_refresh_seed";

async function currentRefreshToken(): Promise<string> {
  const stored = await botStateGet(REFRESH_KEY);

  /* A NEW SEED BEATS A STORED TOKEN, and without this rule re-authorising the
     bot is impossible.
     The store wins normally, and it has to: X rotates the refresh token on
     every use and revokes the previous one, so the env var is a seed that dies
     the first time it is spent. But that made the documented recovery a lie.
     When the stored token goes bad - revoked, scope changed, the account
     re-authorised to add media.write - the fix is to run scripts/x-authorize.ts
     again and paste the new seed, and the new seed was then never read, because
     the dead stored token still won. The bot failed with the same
     invalid_request forever and the only cure was deleting a database row by
     hand, which nothing in the repo told anyone to do.
     So the seed is remembered next to the token. A seed that does not match the
     recorded one is a deliberate re-authorisation and takes precedence. */
  if (SEED_REFRESH) {
    const seedUsed = await botStateGet(SEED_KEY);
    if (seedUsed !== SEED_REFRESH) {
      await botStateSet(SEED_KEY, SEED_REFRESH);
      await botStateSet(REFRESH_KEY, SEED_REFRESH);
      return SEED_REFRESH;
    }
  }

  const token = stored ?? SEED_REFRESH;
  if (!token) throw new XError(0, "no refresh token: set X_BOT_REFRESH_TOKEN once, then it rotates itself");
  return token;
}

/**
 * Exchange the refresh token for an access token, and persist the rotated
 * refresh token BEFORE returning.
 *
 * Order matters. If the access token were returned first and the write
 * happened after, a crash in between would leave us holding a refresh token X
 * has already invalidated, with no record of the one it replaced it with, and
 * the only recovery is a human redoing the consent screen.
 */
async function refresh(): Promise<Access> {
  const refreshToken = await currentRefreshToken();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      // X requires HTTP Basic for confidential clients on this endpoint;
      // sending the secret in the body is rejected with invalid_client.
      authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    // invalid_grant here almost always means the stored token was already
    // spent (two processes refreshing at once, or a restart mid-rotation).
    // Say so, because "401" alone sends people to the wrong place.
    const hint = body.error === "invalid_grant"
      ? " (the stored refresh token was already used or revoked; re-authorise once with scripts/x-authorize.ts)"
      : "";
    throw new XError(res.status, `token refresh failed: ${body.error ?? res.status}${hint}`, body);
  }
  if (body.refresh_token && body.refresh_token !== refreshToken) {
    await botStateSet(REFRESH_KEY, body.refresh_token);
  }
  return { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 7200) * 1000 };
}

export async function accessToken(force = false): Promise<string> {
  if (!force && cached && cached.expiresAt - SKEW_MS > Date.now()) return cached.token;
  cached = await refresh();
  return cached.token;
}

/** Test seam: drop the cached access token. */
export function _resetTokenCache(): void { cached = null; }

/* ------------------------------------------------------------- requests ---- */

async function call<T>(path: string, init: RequestInit = {}, retryOn401 = true): Promise<T> {
  const token = await accessToken();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });
  if (res.status === 401 && retryOn401) {
    // One retry with a forced refresh. A 401 on a token we believed valid is
    // the normal shape of a revoked-early token, and it is worth exactly one
    // more attempt before giving up on this poll.
    cached = null;
    return call<T>(path, init, false);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new XError(res.status, `x ${init.method ?? "GET"} ${path} -> ${res.status}`, body);
  }
  return body as T;
}

/* ------------------------------------------------------------- mentions ---- */

export interface Mention {
  id: string;
  text: string;
  authorId: string;
  authorHandle: string | null;
  /** The tweet this mention is a reply to, which is the claim being tagged. */
  repliedToId: string | null;
  createdAt: string | null;
}

interface MentionsResponse {
  data?: Array<{
    id: string; text: string; author_id: string; created_at?: string;
    referenced_tweets?: Array<{ type: string; id: string }>;
  }>;
  includes?: { users?: Array<{ id: string; username: string }> };
  meta?: { newest_id?: string; result_count?: number };
}

/**
 * Mentions of the bot, newest first, since the last one we looked at.
 *
 * `sinceId` is exclusive, which is what makes the loop safe to run on a timer:
 * the same window is never read twice. `max_results` is capped low on purpose.
 * Every mention costs a market mint if it turns into one, and a viral thread
 * that mentions us two hundred times should drain over several polls rather
 * than spending two hundred rent deposits inside one.
 */
export async function mentions(sinceId: string | null, max = 20): Promise<{ items: Mention[]; newestId: string | null }> {
  const qs = new URLSearchParams({
    max_results: String(Math.max(5, Math.min(100, max))),
    "tweet.fields": "created_at,referenced_tweets,author_id",
    expansions: "author_id",
    "user.fields": "username",
  });
  if (sinceId) qs.set("since_id", sinceId);

  const body = await call<MentionsResponse>(`/users/${BOT_USER_ID}/mentions?${qs}`);
  const byId = new Map((body.includes?.users ?? []).map((u) => [u.id, u.username]));
  const items = (body.data ?? []).map((t) => ({
    id: t.id,
    text: t.text,
    authorId: t.author_id,
    authorHandle: byId.get(t.author_id) ?? null,
    repliedToId: t.referenced_tweets?.find((r) => r.type === "replied_to")?.id ?? null,
    createdAt: t.created_at ?? null,
  }));
  return { items, newestId: body.meta?.newest_id ?? null };
}

/* ---------------------------------------------------------------- posts ---- */

/**
 * Upload a PNG and return its media id.
 *
 * Simple upload, which is the whole API for anything under 5MB, and our cards
 * are ~60KB. The chunked flow exists for video and would be ceremony here.
 */
export async function uploadMedia(png: Buffer): Promise<string> {
  const token = await accessToken();
  const form = new FormData();
  form.append("media", new Blob([new Uint8Array(png)], { type: "image/png" }), "card.png");
  // Required on v2, and its absence is a 400 rather than a default.
  form.append("media_category", "tweet_image");
  const res = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const body = (await res.json().catch(() => ({}))) as {
    data?: { id?: string; media_key?: string };
    media_id_string?: string;
    errors?: unknown;
  };
  // `id` first: media_ids has always taken the numeric id, and v2 returns both.
  // The docs annotate media_key as the reference to use, and the forums say
  // either works, so the fallback is here rather than a coin flip in the code.
  const id = body.data?.id ?? body.data?.media_key ?? body.media_id_string;
  if (!res.ok || !id) {
    // A 403 here with an otherwise-working token means the OAuth grant is
    // missing media.write. It cannot be added to an existing refresh token;
    // the bot has to be re-authorised. See scripts/x-authorize.ts.
    throw new XError(res.status, `media upload -> ${res.status}`, body);
  }
  return id;
}

export interface PostedTweet { id: string; text: string }

export async function postReply(opts: {
  text: string;
  inReplyTo: string;
  mediaIds?: string[];
}): Promise<PostedTweet> {
  const payload: Record<string, unknown> = {
    text: opts.text,
    reply: { in_reply_to_tweet_id: opts.inReplyTo },
  };
  if (opts.mediaIds?.length) payload.media = { media_ids: opts.mediaIds };
  const body = await call<{ data: PostedTweet }>("/tweets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return body.data;
}

export async function postTweet(opts: { text: string; quoteTweetId?: string; mediaIds?: string[] }): Promise<PostedTweet> {
  const payload: Record<string, unknown> = { text: opts.text };
  if (opts.quoteTweetId) payload.quote_tweet_id = opts.quoteTweetId;
  if (opts.mediaIds?.length) payload.media = { media_ids: opts.mediaIds };
  const body = await call<{ data: PostedTweet }>("/tweets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return body.data;
}

/** One tweet by id, for reading the claim a mention was replying to.
 *  It also carries its OWN parent, so the loop can walk up a thread when two
 *  posts were not enough to name what the argument is about. Asking for
 *  referenced_tweets costs nothing extra: it is a field on a resource we are
 *  already being charged for. */
export async function tweet(id: string): Promise<{ id: string; text: string; authorHandle: string | null; repliedToId: string | null } | null> {
  try {
    const body = await call<{
      data?: { id: string; text: string; author_id: string;
               referenced_tweets?: Array<{ type: string; id: string }> };
      includes?: { users?: Array<{ id: string; username: string }> };
    }>(`/tweets/${id}?expansions=author_id&user.fields=username&tweet.fields=referenced_tweets`);
    if (!body.data) return null;
    const u = body.includes?.users?.find((x) => x.id === body.data!.author_id);
    const up = body.data.referenced_tweets?.find((r) => r.type === "replied_to")?.id ?? null;
    return { id: body.data.id, text: body.data.text, authorHandle: u?.username ?? null, repliedToId: up };
  } catch (e) {
    // A deleted or protected parent is a normal outcome, not an error worth
    // aborting a poll over. The caller decides whether it can proceed without.
    if (e instanceof XError && (e.status === 403 || e.status === 404)) return null;
    throw e;
  }
}
