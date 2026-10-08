// oddie on Twitch: the signature, the challenge, what a chat line becomes,
// the sign-in, and the door into a market, all through the real router with
// Twitch faked at its edges.
//
// Run with: npm run test-twitch

import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { _resetLive, LIVE_COPY } from "../src/live/calls.js";
import { liveStore, saveChannel, channelById, _resetLiveStore } from "../src/store/live.js";
import { chatFromTwitch, verifyTwitchSignature } from "../src/twitch/client.js";
import { twitchRouter, twitchEngineDeps, type TwitchChat, type TwitchSignIn } from "../src/twitch/routes.js";
import { ownerCookieName } from "../src/live/owner.js";
import { MARKET_COPY, type ChatMarketDeps } from "../src/live/claims.js";
import {
  twitchChatSource, sourceUrlKind, sourcePostKey, isWebSourceUrl, claimMention, settleMention,
  streamOpenedSlugs, streamOpenerOf, streamThreadsForSlug, kickChatSource,
} from "../src/store/markets.js";
import type { Extraction } from "../src/matching/extractClaim.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

const SECRET = "test-secret-0123456789";
const sign = (id: string, ts: string, body: string) => "sha256=" + createHmac("sha256", SECRET).update(id + ts + body).digest("hex");

console.log("the signature");
{
  const ts = new Date().toISOString();
  const good = sign("m1", ts, '{"a":1}');
  check("a line Twitch signed verifies", verifyTwitchSignature(SECRET, "m1", ts, '{"a":1}', good));
  check("...a changed byte does not", !verifyTwitchSignature(SECRET, "m1", ts, '{"a":2}', good));
  check("...nor another message id, nor another secret",
    !verifyTwitchSignature(SECRET, "m2", ts, '{"a":1}', good) && !verifyTwitchSignature("another-secret-xx", "m1", ts, '{"a":1}', good));
  check("...nor a header of the wrong length", !verifyTwitchSignature(SECRET, "m1", ts, '{"a":1}', "sha256=abc"));
}

console.log("\nwhat a chat line becomes");
const ev = (over: Record<string, unknown> = {}) => ({
  broadcaster_user_id: "1001", broadcaster_user_login: "streamer", chatter_user_id: "2002", chatter_user_login: "viewer",
  message_id: "8f3c2c4e-1b2a-4d6e-9a1b-2c3d4e5f6a7b", message: { text: "!call will I win?" }, badges: [], ...over,
});
{
  const m = chatFromTwitch(ev());
  check("a viewer's line is read as the engine reads Kick's", m?.platform === "twitch" && m.channelId === "1001" && m.senderId === "2002"
    && m.text === "!call will I win?" && m.canRun === false && m.channelSlug === "streamer");
  check("the broadcaster can run calls", chatFromTwitch(ev({ chatter_user_id: "1001" }))?.canRun === true);
  check("...and so can a moderator", chatFromTwitch(ev({ badges: [{ set_id: "moderator" }] }))?.canRun === true);
  check("shared chat: a line from another channel is not answered here",
    chatFromTwitch(ev({ source_broadcaster_user_id: "3003" })) === null && chatFromTwitch(ev({ source_broadcaster_user_id: "1001" })) !== null);
  const r = chatFromTwitch(ev({ message: { text: "@bob !oddie" }, reply: { parent_message_body: "BTC hits 150k this year" } }));
  check("a reply's leading @mention is dropped, and the parent is the claim", r?.text === "!oddie" && r.replyText === "BTC hits 150k this year");
  check("nothing that is not a chat event becomes a line", chatFromTwitch(null) === null && chatFromTwitch({ message: {} }) === null);
}

console.log("\nwhere a market from Twitch says it came from");
{
  const src = twitchChatSource("Streamer", "8F3C2C4E-1B2A-4D6E-9A1B-2C3D4E5F6A7B");
  check("twitch-chat:<login>/<message id>, lowercased", src === "twitch-chat:streamer/8f3c2c4e-1b2a-4d6e-9a1b-2c3d4e5f6a7b", src);
  check("it is a Twitch source, never printed as a link", sourceUrlKind(src) === "twitch" && !isWebSourceUrl(src));
  check("one message, one market: the key is the message", sourcePostKey(src) === "twitch:8f3c2c4e-1b2a-4d6e-9a1b-2c3d4e5f6a7b");
  check("...and Kick's sources are unchanged", sourceUrlKind(kickChatSource("oddiefun", "abcdef12-0000")) === "kick");
}

console.log("\nthe webhook, through the real router");
{
  _resetLiveStore(); _resetLive();
  await saveChannel({ platform: "twitch", channelId: "1001", slug: "streamer", name: "Streamer", avatar: null,
    accessToken: "t", refreshToken: null, tokenExpiresAt: null, active: true });
  const said: string[] = [];
  const app = express();
  const jsonBody = express.json();
  app.use((req, res, next) => (req.path === "/live/twitch/webhook" ? next() : jsonBody(req, res, next)));
  app.use(twitchRouter({
    appBaseUrl: "https://app.oddie.fun", pageHtml: () => "<p>page</p>", pageOpen: () => true, pageClosed: (res) => { res.status(404).end(); },
    log: () => {}, secret: () => SECRET,
    engine: { store: liveStore, now: () => Date.now(), say: async (_p, _c, t) => { said.push(t); },
      standingsUrl: async () => "https://app.oddie.fun/live/twitch/streamer", log: () => {} },
  }));
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const post = async (type: string, b: string, over: Record<string, string> = {}) => {
    const ts = new Date().toISOString();
    const id = `msg-${Math.random().toString(36).slice(2, 10)}`;
    return fetch(`http://127.0.0.1:${port}/live/twitch/webhook`, {
      method: "POST", body: b,
      headers: { "content-type": "application/json", "Twitch-Eventsub-Message-Id": id, "Twitch-Eventsub-Message-Timestamp": ts,
        "Twitch-Eventsub-Message-Signature": sign(id, ts, b), "Twitch-Eventsub-Message-Type": type,
        "Twitch-Eventsub-Subscription-Type": "channel.chat.message", ...over },
    });
  };
  const ch = await post("webhook_callback_verification", JSON.stringify({ challenge: "pogchamp-kappa-360noscope", subscription: {} }));
  check("Twitch's challenge is answered with the challenge, as plain text",
    ch.status === 200 && (await ch.text()) === "pogchamp-kappa-360noscope" && /text\/plain/.test(ch.headers.get("content-type") ?? ""));
  const ok = await post("notification", JSON.stringify({ subscription: { type: "channel.chat.message" }, event: ev({ chatter_user_id: "1001" }) }));
  await new Promise((r) => setTimeout(r, 50));
  check("a signed chat line opens a call", ok.status === 204 && (await liveStore.current("twitch", "1001"))?.question === "will I win?"
    && said[0]?.startsWith('oddie call: "will I win?"'), `${ok.status} ${said[0]}`);
  const forged = await post("notification", JSON.stringify({ event: ev({ message: { text: "!call cancel" }, chatter_user_id: "1001" }) }),
    { "Twitch-Eventsub-Message-Signature": "sha256=" + "0".repeat(64) });
  check("a forged one is refused", forged.status === 403 && (await liveStore.current("twitch", "1001")) !== null);
  const old = new Date(Date.now() - 20 * 60_000).toISOString();
  const b = JSON.stringify({ event: ev() });
  const stale = await fetch(`http://127.0.0.1:${port}/live/twitch/webhook`, {
    method: "POST", body: b, headers: { "Twitch-Eventsub-Message-Id": "old1", "Twitch-Eventsub-Message-Timestamp": old,
      "Twitch-Eventsub-Message-Signature": sign("old1", old, b), "Twitch-Eventsub-Message-Type": "notification" },
  });
  check("...and so is a replayed one", stale.status === 403);
  const rev = await post("revocation", JSON.stringify({ subscription: { status: "authorization_revoked", condition: { broadcaster_user_id: "1001" } } }));
  await new Promise((r) => setTimeout(r, 30));
  check("a revocation switches the channel off", rev.status === 204 && (await channelById("twitch", "1001"))?.active === false);
  const api = await fetch(`http://127.0.0.1:${port}/api/live/twitch/streamer`).then((x) => x.json()) as { platform?: string; url?: string; current?: { question: string } };
  check("the page reads the running call, with the Twitch link", api.platform === "twitch" && api.url === "https://www.twitch.tv/streamer"
    && api.current?.question === "will I win?");
  server.close();
}

console.log("\n!yes or !no with nothing open, through the real router and Twitch's own reply");
{
  // Live on 8 Oct: the first Twitch pilot's !yes or !no came in with no call
  // open, and the log said only action="no-open-call" runner=true.
  _resetLiveStore(); _resetLive();
  await saveChannel({ platform: "twitch", channelId: "1001", slug: "streamer", name: "Streamer", avatar: null,
    accessToken: "tok", refreshToken: null, tokenExpiresAt: null, active: true });
  const sent: Array<{ broadcaster: string; sender: string; text: string; replyTo?: string }> = [];
  const chat: TwitchChat = { send: async (_t, b, s, text, replyTo) => { sent.push({ broadcaster: b, sender: s, text, replyTo }); } };
  const did: Array<{ action: unknown; runner: unknown }> = [];
  const app = express();
  app.use(twitchRouter({
    appBaseUrl: "https://app.oddie.fun", pageHtml: () => "<p>page</p>", pageOpen: () => true, pageClosed: (res) => { res.status(404).end(); },
    log: (line, extra) => { if (line === "twitch chat command") did.push({ action: extra?.action, runner: extra?.runner }); },
    secret: () => SECRET, chat, voice: "",
  }));
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  /** One signed chat line, back once the router has logged what it did. */
  const line = async (text: string, over: Record<string, unknown>) => {
    const b = JSON.stringify({ subscription: { type: "channel.chat.message" }, event: ev({ message: { text }, ...over }) });
    const ts = new Date().toISOString();
    const id = `msg-${Math.random().toString(36).slice(2, 10)}`;
    const before = did.length;
    await fetch(`http://127.0.0.1:${port}/live/twitch/webhook`, {
      method: "POST", body: b,
      headers: { "content-type": "application/json", "Twitch-Eventsub-Message-Id": id, "Twitch-Eventsub-Message-Timestamp": ts,
        "Twitch-Eventsub-Message-Signature": sign(id, ts, b), "Twitch-Eventsub-Message-Type": "notification" },
    });
    for (let i = 0; i < 100 && did.length === before; i++) await new Promise((r) => setTimeout(r, 10));
    return did[did.length - 1];
  };
  const viewer = await line("!no", { message_id: "b0b0b0b0-0000-4000-8000-000000000001" });
  check("a viewer's !no is chat: nothing is said", viewer?.action === "no-open-call" && viewer.runner === false && sent.length === 0,
    JSON.stringify({ viewer, sent }));
  const first = await line("!no", { chatter_user_id: "1001", message_id: "b0b0b0b0-0000-4000-8000-000000000002" });
  check("the streamer's !no hears how !yes and !no work, as a Twitch reply to it",
    first?.action === "pick-help" && first.runner === true && sent.length === 1 && sent[0].broadcaster === "1001"
    && sent[0].text === LIVE_COPY.pickHelp && sent[0].replyTo === "b0b0b0b0-0000-4000-8000-000000000002", JSON.stringify({ first, sent }));
  const again = await line("!yes", { chatter_user_id: "3003", badges: [{ set_id: "moderator" }], message_id: "b0b0b0b0-0000-4000-8000-000000000003" });
  check("...and a mod's !yes right after is not answered twice", again?.action === "no-open-call" && again.runner === true && sent.length === 1,
    JSON.stringify({ again, sent }));
  server.close();
}

console.log("\nthe sign-in");
{
  _resetLiveStore(); _resetLive();
  process.env.LIVE_TOKEN_KEY = "live-token-key-for-tests";
  const said: string[] = [];
  let subscribed = 0;
  const signIn: TwitchSignIn = {
    exchangeCode: async () => ({ accessToken: "acc", refreshToken: "ref", expiresAt: Date.now() + 3_600_000 }),
    me: async () => ({ userId: "5005", login: "newstreamer", name: "NewStreamer", avatar: null }),
    subscribe: async (id, cb, secret) => { if (id === "5005" && cb.endsWith("/live/twitch/webhook") && secret === SECRET) subscribed++; return { added: true }; },
  };
  const app = express();
  app.use(express.json());
  app.use(twitchRouter({
    appBaseUrl: "https://app.oddie.fun", pageHtml: () => "<p>page</p>", pageOpen: () => true, pageClosed: (res) => { res.status(404).end(); },
    log: () => {}, signIn, secret: () => SECRET,
    engine: { store: liveStore, now: () => Date.now(), say: async (_p, _c, t) => { said.push(t); }, standingsUrl: async () => "", log: () => {} },
  }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const signInOnce = async () => {
    const go = await fetch(`${base}/live/twitch/connect`, { redirect: "manual" });
    const loc = new URL(go.headers.get("location") ?? "http://x");
    const state = loc.searchParams.get("state") ?? "";
    return { loc, res: await fetch(`${base}/live/twitch/callback?state=${state}&code=abc`, { redirect: "manual" }) };
  };
  const first = await signInOnce();
  check("the door goes to Twitch with the four chat scopes", first.loc.host === "id.twitch.tv"
    && first.loc.searchParams.get("scope") === "user:read:chat user:write:chat user:bot channel:bot");
  const setCookie = first.res.headers.get("set-cookie") ?? "";
  check("Twitch's sign-in ends with Twitch's own owner cookie, on its own path", setCookie.startsWith(`${ownerCookieName("twitch")}=`)
    && /Path=\/api\/live\/twitch/.test(setCookie) && /HttpOnly/.test(setCookie)
    && first.res.headers.get("location") === "https://app.oddie.fun/live/twitch/newstreamer?connected=1", setCookie);
  check("...the chat is subscribed, and oddie says hello once", subscribed === 1 && said.filter((t) => t === LIVE_COPY.hello).length === 1);
  const again = await signInOnce();
  check("signing in again is not a second hello", said.filter((t) => t === LIVE_COPY.hello).length === 1
    && again.res.headers.get("location") === "https://app.oddie.fun/live/twitch/newstreamer");
  const declined = await fetch(`${base}/live/twitch/callback?state=nope&error=access_denied`, { redirect: "manual" });
  check("declining on Twitch's screen comes back politely", declined.headers.get("location") === "https://app.oddie.fun/live?twitch=declined");
  server.close();
}

console.log("\nthe market door: !oddie in a Twitch chat");
{
  _resetLiveStore(); _resetLive();
  await saveChannel({ platform: "twitch", channelId: "1001", slug: "streamer", name: "Streamer", avatar: null,
    accessToken: "tok", refreshToken: null, tokenExpiresAt: null, active: true });
  const sent: Array<{ broadcaster: string; sender: string; text: string; replyTo?: string }> = [];
  const chat: TwitchChat = { send: async (_t, b, s, text, replyTo) => { sent.push({ broadcaster: b, sender: s, text, replyTo }); } };
  const opened: Array<{ openerId: string; sourceUrl: string }> = [];
  const good: Extraction = { question: "Will BTC close above $120k on Friday?", resolution_criteria: "CoinGecko daily close.", price_claim: null,
    close_time: "2026-10-10T23:59:00Z", close_time_inferred: false, category: "Crypto", resolvability: "clean",
    appropriate: true, reason: "clean", hook: "BTC to 120k by Friday?" } as Extraction;
  const markets: Omit<ChatMarketDeps, "say" | "sourceFor"> = {
    extract: async () => good,
    existingMarket: async () => null,
    openMarket: async (i) => { opened.push({ openerId: i.openerId, sourceUrl: i.sourceUrl }); return { ok: true, slug: "tw-btc" } as never; },
    claim: (k, a) => claimMention(k, a),
    settle: (k, o, x) => settleMention(k, o, x),
    openedToday: async () => 0,
    dailyCap: 5,
    baseUrl: "https://app.oddie.fun",
    log: () => {},
  };
  const eng = twitchEngineDeps({ appBaseUrl: "https://app.oddie.fun", log: () => {}, markets, voice: "" }, chat);
  const msg = chatFromTwitch(ev({ message: { text: "!oddie BTC closes above 120k on Friday" } }))!;
  const out = await eng.market!(msg, "BTC closes above 120k on Friday");
  check("a viewer's !oddie opens a market the CHANNEL opened", out === "market-opened" && opened[0]?.openerId === "twitch:1001"
    && opened[0]?.sourceUrl === "twitch-chat:streamer/8f3c2c4e-1b2a-4d6e-9a1b-2c3d4e5f6a7b", JSON.stringify(opened));
  check("...and says so in that chat, as a reply, naming who earns 2%",
    sent[0]?.broadcaster === "1001" && sent[0]?.replyTo === msg.messageId && sent[0]?.text === MARKET_COPY.opened("BTC to 120k by Friday?", "https://app.oddie.fun/m/tw-btc", "streamer"),
    JSON.stringify(sent[0]));
  check("the channel's markets, opener and result thread are read off the ledger",
    (await streamOpenedSlugs("twitch", "1001")).includes("tw-btc") && (await streamOpenerOf("tw-btc")) === "twitch:1001"
    && (await streamThreadsForSlug("twitch", "tw-btc"))[0]?.channelId === "1001" && (await streamOpenedSlugs("kick", "1001")).length === 0);
  const twice = await eng.market!(msg, "BTC closes above 120k on Friday");
  check("the same line twice is one market", twice === "already-handled" && opened.length === 1);
}

if (failures) { console.error(`\n${failures} twitch check(s) failed`); process.exit(1); }
console.log("\nall twitch checks passed.");
