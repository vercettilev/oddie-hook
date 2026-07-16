// The lightest sane OAuth 2.0: authorization code + PKCE, two providers, no
// library, no session store, no refresh tokens.
//
// We ask for the smallest scope that yields a stable id and a public name, use
// the access token exactly once to read that name, and throw it away. Nothing
// is stored that could post as the user — the Week-6 bot will ask for its own
// permission, in its own consent screen.
//
// Secrets live only in the environment. Client ids are public by design and are
// checked in, because a client id in a repo is a URL, not a credential.

import { createHash, randomBytes } from "node:crypto";

export type Provider = "google" | "twitter";
export const PROVIDERS: Provider[] = ["twitter", "google"]; // X first: it is the identity, not the backup

export interface Identity {
  provider: Provider;
  uid: string;
  handle?: string | null;
  name?: string | null;
  /** Google only, and only when verified. Used for settlement emails, nothing else. */
  email?: string | null;
}

interface Config {
  clientId: string;
  clientSecret: string | undefined;
  secretEnv: string;
  authUrl: string;
  tokenUrl: string;
  scope: string;
  /** X requires HTTP Basic for confidential clients; Google takes the secret in the body. */
  basicAuth: boolean;
  label: string;
}

const CONFIG: Record<Provider, Config> = {
  twitter: {
    clientId: process.env.TWITTER_CLIENT_ID ?? "d2hjd0hjbkNBR05JQUJJdEZLNWI6MTpjaQ",
    clientSecret: process.env.TWITTER_CLIENT_SECRET,
    secretEnv: "TWITTER_CLIENT_SECRET",
    authUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    // users.read cannot be requested without tweet.read; X rejects the pair split.
    // We never call a tweet endpoint. `offline.access` is deliberately absent:
    // a refresh token is a standing permission we have no use for.
    scope: "users.read tweet.read",
    basicAuth: true,
    label: "X",
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "1033860344624-h2k97k5r4b7v4285ijnes52lijsoimj8.apps.googleusercontent.com",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    secretEnv: "GOOGLE_CLIENT_SECRET",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    // `openid` for the stable `sub`, `profile` for a display name, and `email`
    // because settlement notifications finally gave us a reason to hold one.
    scope: "openid email profile",
    basicAuth: false,
    label: "Google",
  },
};

export const isProvider = (s: string): s is Provider => s === "google" || s === "twitter";
export const isConfigured = (p: Provider): boolean => Boolean(CONFIG[p].clientSecret);
export const providerLabel = (p: Provider): string => CONFIG[p].label;
export const missingSecretEnv = (p: Provider): string => CONFIG[p].secretEnv;

/**
 * The redirect URI, derived from PUBLIC_BASE_URL and nothing else.
 *
 * It must match the console registration byte for byte or the provider answers
 * `redirect_uri_mismatch` and there is no login. Deriving it here — rather than
 * letting each call site build one — means the authorize request and the token
 * exchange cannot disagree, which is the other way this breaks.
 */
export function redirectUri(base: string, p: Provider): string {
  return `${base.replace(/\/+$/, "")}/api/auth/${p}/callback`;
}

// --- PKCE --------------------------------------------------------------------

const b64url = (b: Buffer) => b.toString("base64url");

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function pkce(): Pkce {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

/**
 * Pending authorisations, keyed by the `state` we hand the provider.
 *
 * In memory on purpose. A login is a ten-second round trip; a redeploy in that
 * window costs one retry and nothing else. A table would need cleaning, and a
 * cookie would need a signing secret we do not otherwise have.
 */
interface Pending { provider: Provider; verifier: string; deviceId: string; at: number; returnTo: string | null }
const pending = new Map<string, Pending>();
const PENDING_TTL_MS = 10 * 60_000;

/** `returnTo` rides the state: a sign-in that started on a market permalink
 *  lands back ON that market, not on the generic feed. Local paths only —
 *  the caller validates before passing it in. */
export function remember(provider: Provider, verifier: string, deviceId: string, returnTo: string | null = null): string {
  const state = b64url(randomBytes(24));
  // Opportunistic sweep: a login that never came back is not worth a timer.
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [k, v] of pending) if (v.at < cutoff) pending.delete(k);
  pending.set(state, { provider, verifier, deviceId, at: Date.now(), returnTo });
  return state;
}

/** One-shot. A replayed `state` is an attacker or a double-tapped back button. */
export function consume(state: string): Pending | null {
  const p = pending.get(state);
  if (!p) return null;
  pending.delete(state);
  if (Date.now() - p.at > PENDING_TTL_MS) return null;
  return p;
}

// --- the two round trips -----------------------------------------------------

export function authorizeUrl(p: Provider, state: string, challenge: string, base: string): string {
  const c = CONFIG[p];
  const q = new URLSearchParams({
    response_type: "code",
    client_id: c.clientId,
    redirect_uri: redirectUri(base, p),
    scope: c.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${c.authUrl}?${q}`;
}

async function exchangeCode(p: Provider, code: string, verifier: string, base: string): Promise<string> {
  const c = CONFIG[p];
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(base, p),
    code_verifier: verifier,
    client_id: c.clientId,
  });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (c.basicAuth) headers.authorization = `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`;
  else body.set("client_secret", c.clientSecret!);

  const res = await fetch(c.tokenUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; id_token?: string; error?: string; error_description?: string };
  if (!res.ok) throw new Error(`${p} token ${res.status}: ${json.error_description ?? json.error ?? "unknown"}`);

  // Google hands back an id_token; X does not. Return whichever proves identity.
  if (p === "google") {
    if (!json.id_token) throw new Error("google returned no id_token");
    return json.id_token;
  }
  if (!json.access_token) throw new Error("x returned no access_token");
  return json.access_token;
}

/**
 * Google's `id_token` payload, unverified — and that is correct here.
 *
 * Signature verification exists to protect a token that travelled through the
 * browser. This one came straight back from `oauth2.googleapis.com` over TLS on
 * a connection we opened, in response to a code only we hold, so there is no
 * third party to have forged it. Google documents exactly this exception. We
 * read two fields and never store the token.
 */
function readIdToken(idToken: string): { sub: string; name?: string; email?: string } {
  const [, payload] = idToken.split(".");
  if (!payload) throw new Error("malformed id_token");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    sub?: string; name?: string; email?: string; email_verified?: boolean;
  };
  if (!claims.sub) throw new Error("id_token carries no sub");
  // An unverified address is a string someone typed, not a mailbox they own.
  return { sub: claims.sub, name: claims.name, email: claims.email_verified ? claims.email : undefined };
}

async function xUser(accessToken: string): Promise<{ id: string; username?: string; name?: string }> {
  const res = await fetch("https://api.x.com/2/users/me", {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: { id: string; username?: string; name?: string }; title?: string; detail?: string };
  if (!res.ok || !json.data?.id) throw new Error(`x users/me ${res.status}: ${json.detail ?? json.title ?? "unknown"}`);
  return json.data;
}

/** Code in, identity out. The access token does not survive this function. */
export async function identify(p: Provider, code: string, verifier: string, base: string): Promise<Identity> {
  const token = await exchangeCode(p, code, verifier, base);
  if (p === "google") {
    const { sub, name, email } = readIdToken(token);
    return { provider: "google", uid: sub, handle: null, name: name ?? null, email: email ?? null };
  }
  const u = await xUser(token);
  return { provider: "twitter", uid: u.id, handle: u.username ? `@${u.username}` : null, name: u.name ?? null };
}
