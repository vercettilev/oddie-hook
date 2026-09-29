/**
 * oddie on Kick: the door a streamer walks through once, the webhook their
 * chat arrives on, the page their standings live on, and the clock that
 * locks a call when its time is up. The rules are in src/live/calls.ts; this
 * file only connects them to Kick.
 */
import express, { type Request, type Response, type Router } from "express";
import { randomBytes } from "node:crypto";
import {
  authorizeUrl, chatFromKick, exchangeCode, kickConfigured, kickPublicKey, me, myChannel, pkcePair,
  refreshTokens, sendChat, sendChatAsUser, subscribeToChannel, verifyKickSignature, WEBHOOK_MAX_AGE_MS,
} from "./client.js";
import { handleChat, LIVE_COPY, lockDue, yesPct, type LiveDeps, type Platform } from "../live/calls.js";
import {
  channelById, channelBySlug, channelStandings, liveStore, recentCalls, saveChannel, type LiveChannel,
} from "../store/live.js";

export interface KickRouteDeps {
  /** Where the app lives: the standings links and the OAuth redirect. */
  appBaseUrl: string;
  /** The page, already stamped for this deploy. */
  pageHtml(): string;
  /** The app's own gate, for the page. */
  pageOpen(req: Request): boolean;
  pageClosed(res: Response): void;
  log(line: string, extra?: Record<string, unknown>): void;
  /** Test seams: Kick's key, and the engine's hands. */
  publicKey?(): Promise<string>;
  engine?: LiveDeps;
}

const pending = new Map<string, { verifier: string; at: number }>();
const seen = new Map<string, number>();
const SEEN_MAX = 5_000;

/** A token that works: refreshed a minute before it would not, or on demand. */
async function tokenFor(ch: LiveChannel, force = false): Promise<string> {
  if (!ch.accessToken) throw new Error("channel not connected");
  const stale = ch.tokenExpiresAt !== null && ch.tokenExpiresAt - Date.now() < 60_000;
  if ((force || stale) && ch.refreshToken) {
    const t = await refreshTokens(ch.refreshToken);
    await saveChannel({ ...ch, accessToken: t.accessToken, refreshToken: t.refreshToken ?? ch.refreshToken, tokenExpiresAt: t.expiresAt });
    return t.accessToken;
  }
  return ch.accessToken;
}

/** How a line reaches a Kick chat. A seam for the tests. */
export interface KickChat {
  bot(token: string, text: string, replyTo?: string): Promise<void>;
  user(token: string, channelId: string, text: string, replyTo?: string): Promise<void>;
}
const kickChat: KickChat = { bot: sendChat, user: sendChatAsUser };

/**
 * A NEW APP'S BOT CANNOT POST YET. Found on the first live test (29 Sep):
 * every bot line from the freshly made oddie app came back 404 "Not found",
 * and other developers report the same for new apps with no answer from
 * Kick. So a line goes out as the bot first and, on 404 or 400, as the
 * account that authorized us, which is what the chat:write scope grants.
 * A channel where the bot has failed once skips straight to that.
 */
const botCannotPost = new Set<string>();

export function kickEngineDeps(d: Pick<KickRouteDeps, "appBaseUrl" | "log">, chat: KickChat = kickChat): LiveDeps {
  const base = d.appBaseUrl.replace(/\/+$/, "");
  const deliver = async (token: string, channelId: string, text: string, replyTo?: string) => {
    if (!botCannotPost.has(channelId)) {
      try { await chat.bot(token, text, replyTo); return; }
      catch (e) {
        const st = (e as { status?: number }).status;
        if (st !== 404 && st !== 400) throw e;
        botCannotPost.add(channelId);
        d.log("kick bot cannot post here, sending as the channel's account", { channel: channelId, status: st });
      }
    }
    await chat.user(token, channelId, text, replyTo);
  };
  return {
    store: liveStore,
    now: () => Date.now(),
    say: async (_p: Platform, channelId, text, replyTo) => {
      const ch = await channelById("kick", channelId);
      if (!ch?.active) return;
      try { await deliver(await tokenFor(ch), channelId, text, replyTo); }
      catch (e) {
        // An expired token says 401: refresh once and say it again.
        if ((e as { status?: number }).status !== 401) throw e;
        await deliver(await tokenFor(ch, true), channelId, text, replyTo);
      }
    },
    standingsUrl: async (_p, channelId) => {
      const ch = await channelById("kick", channelId).catch(() => null);
      return `${base}/live/kick/${encodeURIComponent(ch?.slug ?? channelId)}`;
    },
    log: d.log,
  };
}

export function kickRouter(d: KickRouteDeps): Router {
  const r = express.Router();
  const base = d.appBaseUrl.replace(/\/+$/, "");
  const redirectUri = `${base}/live/kick/callback`;
  const engine = d.engine ?? kickEngineDeps(d);
  const publicKey = d.publicKey ?? kickPublicKey;

  /** A streamer adds oddie to their channel. */
  r.get("/live/kick/connect", (_req, res) => {
    if (!kickConfigured()) return res.status(503).type("text").send("oddie for Kick is almost here.");
    for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60_000) pending.delete(k);
    const state = randomBytes(16).toString("hex");
    const { verifier, challenge } = pkcePair();
    pending.set(state, { verifier, at: Date.now() });
    res.redirect(authorizeUrl({ state, challenge, redirectUri }));
  });

  r.get("/live/kick/callback", async (req, res) => {
    const state = String(req.query.state ?? "");
    const code = String(req.query.code ?? "");
    const p = pending.get(state);
    pending.delete(state);
    if (!p || !code || Date.now() - p.at > 10 * 60_000) return res.redirect(`${base}/live?kick=expired`);
    try {
      const t = await exchangeCode(code, p.verifier, redirectUri);
      const [who, chan] = await Promise.all([me(t.accessToken), myChannel(t.accessToken)]);
      const ch: LiveChannel = {
        platform: "kick", channelId: who.userId, slug: chan.slug, name: who.name, avatar: who.avatar,
        accessToken: t.accessToken, refreshToken: t.refreshToken, tokenExpiresAt: t.expiresAt, active: true,
      };
      await saveChannel(ch);
      await subscribeToChannel(t.accessToken).catch((e) => d.log("kick subscribe failed", { channel: ch.slug, err: (e as Error).message }));
      await engine.say("kick", ch.channelId, LIVE_COPY.hello)
        .catch((e) => d.log("kick hello not delivered", { channel: ch.slug, err: (e as Error).message }));
      d.log("kick channel connected", { channel: ch.slug });
      res.redirect(`${base}/live/kick/${encodeURIComponent(ch.slug)}?connected=1`);
    } catch (e) {
      d.log("kick connect failed", { err: (e as Error).message });
      res.redirect(`${base}/live?kick=failed`);
    }
  });

  /**
   * THE WEBHOOK. Raw body, because the signature is over the exact bytes.
   * Answered at once: Kick drops a subscription whose webhook keeps failing,
   * and the work that follows must never be the reason it does.
   */
  r.post("/live/kick/webhook", express.raw({ type: "*/*", limit: "256kb" }), async (req, res) => {
    const id = String(req.header("Kick-Event-Message-Id") ?? "");
    const ts = String(req.header("Kick-Event-Message-Timestamp") ?? "");
    const sig = String(req.header("Kick-Event-Signature") ?? "");
    const type = String(req.header("Kick-Event-Type") ?? "");
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const age = Date.now() - Date.parse(ts);
    const key = await publicKey().catch(() => null);
    if (!id || !sig || !key || !(age >= -60_000 && age <= WEBHOOK_MAX_AGE_MS) || !verifyKickSignature(key, id, ts, raw, sig)) {
      return res.status(401).end();
    }
    res.status(200).end();
    // Kick may deliver twice; a message is handled once.
    if (seen.has(id)) return;
    seen.set(id, Date.now());
    if (seen.size > SEEN_MAX) for (const k of [...seen.keys()].slice(0, SEEN_MAX / 2)) seen.delete(k);
    if (type !== "chat.message.sent") return;
    let body: unknown = null;
    try { body = JSON.parse(raw.toString("utf8")); } catch { return; }
    const msg = chatFromKick(body);
    if (!msg) return;
    const action = await handleChat(msg, engine).catch((e) => { d.log("kick chat failed", { err: (e as Error).message }); return "error"; });
    // What a command did, never what anybody wrote: ordinary chat is not logged.
    if (action !== "chat") d.log("kick chat command", { channel: msg.channelId, action, runner: msg.canRun });
  });

  /** A channel's page on oddie, and what it reads. */
  r.get("/live/kick/:slug", (req, res) => {
    if (!d.pageOpen(req)) return d.pageClosed(res);
    res.set("Cache-Control", "no-cache").type("html").send(d.pageHtml());
  });

  r.get("/api/live/kick/:slug", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const ch = await channelBySlug("kick", req.params.slug).catch(() => null);
    if (!ch) return res.status(404).json({ error: "unknown" });
    const [current, recent, standings] = await Promise.all([
      liveStore.current("kick", ch.channelId).catch(() => null),
      recentCalls("kick", ch.channelId, 10).catch(() => []),
      channelStandings("kick", ch.channelId, 20).catch(() => []),
    ]);
    const tally = current ? await liveStore.tally(current.id).catch(() => ({ yes: 0, no: 0 })) : null;
    res.json({
      platform: "kick", slug: ch.slug, name: ch.name, avatar: ch.avatar, url: `https://kick.com/${ch.slug}`,
      current: current && tally ? {
        question: current.question, closesAt: new Date(current.closesAt).toISOString(),
        locked: current.lockedAt !== null || Date.now() >= current.closesAt, yes: tally.yes, no: tally.no, yesPct: yesPct(tally),
      } : null,
      recent: recent.filter((c) => c.settledAt !== null).map((c) => ({
        question: c.question, outcome: c.outcome, yes: c.yes, no: c.no, points: c.points,
        settledAt: c.settledAt ? new Date(c.settledAt).toISOString() : null,
      })),
      standings: standings.map((s, i) => ({ rank: i + 1, username: s.username, points: s.points, right: s.right, calls: s.calls })),
    });
  });

  return r;
}

/** The clock: every few seconds, calls whose time is up are locked and said. */
export function startLiveClock(d: Pick<KickRouteDeps, "appBaseUrl" | "log">, everyMs = 5_000): NodeJS.Timeout {
  const engine = kickEngineDeps(d);
  return setInterval(() => { void lockDue(engine).catch((e) => d.log("live clock failed", { err: (e as Error).message })); }, everyMs);
}
