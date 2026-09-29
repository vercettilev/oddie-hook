// Live calls in a stream's chat: the commands, who may do what, one call and
// one answer at a time, the clock, the points, and Kick's side of it (the
// payload, the signature, the sealed tokens, a signed webhook end to end).
if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database: unset DATABASE_URL");
  process.exit(1);
}
process.env.LIVE_TOKEN_KEY = "test-key-for-sealing";
import { createSign, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";
import {
  parseCommand, handleChat, lockDue, pointsFor, LIVE_COPY, SPLIT_GAP_MS, _resetLive, type ChatMessage, type LiveDeps,
} from "../src/live/calls.js";
import { liveStore, saveChannel, channelStandings, recentCalls, sealToken, openToken, _resetLiveStore } from "../src/store/live.js";
import { chatFromKick, verifyKickSignature } from "../src/kick/client.js";
import { kickRouter, kickEngineDeps, type KickChat } from "../src/kick/routes.js";
import { openFromChat, MARKET_COPY, type ChatMarketDeps } from "../src/live/claims.js";
import { kickChatSource, sourceUrlKind, sourcePostKey, isWebSourceUrl, claimMention, settleMention, _memMentionOutcome } from "../src/store/markets.js";
import type { Extraction } from "../src/matching/extractClaim.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

console.log("what a chat line asks for");
{
  check("!yes and !no are answers", parseCommand("!yes")?.kind === "pick" && (parseCommand("!NO lol") as { side: string }).side === "no");
  check("...and so are !evet and !hayır", (parseCommand("!evet") as { side: string }).side === "yes" && (parseCommand("!hayır") as { side: string }).side === "no");
  check("a command must start the line", parseCommand("i'd say !yes") === null && parseCommand("!yesss") === null);
  const o = parseCommand("!call will I win this game?");
  check("!call opens a call, three minutes by default", o?.kind === "open" && (o as { minutes: number }).minutes === 3
    && (o as { question: string }).question === "will I win this game?");
  const f = parseCommand("!call 5m will I win?");
  check("...a length at the start sets the minutes", f?.kind === "open" && (f as { minutes: number }).minutes === 5 && (f as { question: string }).question === "will I win?");
  const q = parseCommand("!call will he hit 5m followers");
  check("...but a number inside the question stays in it", q?.kind === "open" && (q as { minutes: number }).minutes === 3 && /5m followers/.test((q as { question: string }).question));
  check("...never longer than thirty", (parseCommand("!call 90m ok?") as { minutes: number }).minutes === 30);
  check("!call yes and !call no settle", (parseCommand("!call yes") as { outcome: string }).outcome === "yes" && (parseCommand("!call hayir") as { outcome: string }).outcome === "no");
  check("!call cancel cancels", parseCommand("!call iptal")?.kind === "cancel");
  check("!call alone asks for help", parseCommand("!call")?.kind === "help");
  const mk = parseCommand("!oddie BTC above 120k by Friday?");
  check("!oddie is the market door, whatever follows is the claim", mk?.kind === "market" && (mk as { claim: string }).claim === "BTC above 120k by Friday?");
  check("...and bare !oddie is the door with no claim yet", parseCommand("!oddie")?.kind === "market" && (parseCommand("!oddie") as { claim: string }).claim === "");
  check("ordinary chat is ordinary chat", parseCommand("gg ez") === null && parseCommand("!callx hi") === null && parseCommand("!oddiex hi") === null);
}

console.log("\nthe points");
{
  check("right with 20% agreeing is worth 80", pointsFor({ yes: 2, no: 8 }, "yes") === 80);
  check("right with everybody is 1, never 0", pointsFor({ yes: 5, no: 0 }, "yes") === 1);
  check("no answers, no points", pointsFor({ yes: 0, no: 0 }, "no") === 0);
}

// A room: a streamer, a mod, viewers, and a clock we move.
function room() {
  _resetLiveStore(); _resetLive();
  let clock = 1_800_000_000_000;
  const said: Array<{ text: string; replyTo?: string }> = [];
  const deps: LiveDeps = {
    store: liveStore,
    now: () => clock,
    say: async (_p, _c, text, replyTo) => { said.push({ text, replyTo }); },
    standingsUrl: async () => "https://app.oddie.fun/live/kick/streamer",
    log: () => {},
  };
  let n = 0;
  const line = (who: string, text: string, canRun = false): ChatMessage => ({
    platform: "kick", channelId: "100", messageId: `m${++n}`, senderId: who, senderName: who, canRun, text,
  });
  return { deps, said, line, tick: (ms: number) => { clock += ms; } };
}

console.log("\na call, start to finish");
{
  const r = room();
  check("a viewer cannot open a call, and hears nothing about it",
    (await handleChat(r.line("v1", "!call will he win?"), r.deps)) === "not-allowed" && r.said.length === 0);
  check("the streamer or a mod can", (await handleChat(r.line("mod", "!call will he win this game?", true), r.deps)) === "opened");
  check("...and the room hears how to answer and where the standings are",
    r.said[0]?.text === LIVE_COPY.opened("will he win this game?", 3, "https://app.oddie.fun/live/kick/streamer"));
  check("one call at a time", (await handleChat(r.line("mod2", "!call another?", true), r.deps)) === "busy"
    && r.said[1]?.text === LIVE_COPY.busy("will he win this game?") && r.said[1]?.replyTo === "m3");
  for (const [who, side] of [["a", "!yes"], ["b", "!no"], ["c", "!no"], ["d", "!no"], ["e", "!no"]] as const) await handleChat(r.line(who, side), r.deps);
  check("one answer per person, and it is final", (await handleChat(r.line("a", "!no"), r.deps)) === "already-picked");
  check("the split is not repeated on every answer", r.said.length === 2);
  r.tick(SPLIT_GAP_MS);
  await handleChat(r.line("f", "!yes"), r.deps);
  check("...but the room hears it every so often", /33% YES from 6 calls/.test(r.said[2]?.text ?? ""), r.said[2]?.text);
  r.tick(3 * 60_000);
  check("after the time is up an answer is late", (await handleChat(r.line("g", "!yes"), r.deps)) === "late");
  check("...and the call locks, said once", r.said.filter((s) => s.text.startsWith("Calls are locked")).length === 1);
  await lockDue(r.deps);
  check("the clock does not lock it twice", r.said.filter((s) => s.text.startsWith("Calls are locked")).length === 1);
  check("a viewer cannot settle", (await handleChat(r.line("a", "!call yes"), r.deps)) === "not-allowed");
  check("the mod settles", (await handleChat(r.line("mod", "!call yes", true), r.deps)) === "settled");
  check("...and the room hears who was right and what it was worth",
    r.said[r.said.length - 1]?.text === "It's YES. 2 of 6 called it right, +67 each. Standings: https://app.oddie.fun/live/kick/streamer",
    r.said[r.said.length - 1]?.text);
  const st = await channelStandings("kick", "100");
  check("the standings count only the right answers", st.length === 6 && st[0].points === 67 && st.filter((s) => s.points > 0).length === 2);
  check("a settled call is not settled again", (await handleChat(r.line("mod", "!call no", true), r.deps)) === "no-call");
  check("the next call can open", (await handleChat(r.line("mod", "!call 1m next round?", true), r.deps)) === "opened");
  check("...a mod can cancel it", (await handleChat(r.line("mod", "!call cancel", true), r.deps)) === "canceled");
  const rec = await recentCalls("kick", "100");
  check("a canceled call leaves no trace in the results", rec.length === 1 && rec[0].outcome === "yes");
}
{
  const r = room();
  await handleChat(r.line("owner", "!call 2m clutch this round?", true), r.deps);
  r.tick(2 * 60_000 + 1);
  check("the clock locks a call whose time is up", (await lockDue(r.deps)) === 1 && /Calls are locked for this one/.test(r.said[1]?.text ?? ""));
  check("a new call waits for the old one to be settled",
    (await handleChat(r.line("owner", "!call again?", true), r.deps)) === "busy" && r.said[2]?.text === LIVE_COPY.settleFirst("clutch this round?"));
  await handleChat(r.line("owner", "!call no", true), r.deps);
  check("settling a call nobody answered says what is next", /It's NO\. The next one opens with !call/.test(r.said[3]?.text ?? ""));
}
{
  const r = room();
  await handleChat(r.line("mod", "!call will he win?", true), r.deps);
  await handleChat(r.line("a", "!yes"), r.deps);
  const out = await handleChat(r.line("mod", "!call no", true), r.deps);
  check("settling an open call locks it first", out === "settled" && /The whole room went the other way/.test(r.said[1]?.text ?? ""));
  check("the copy never says nobody", Object.values(LIVE_COPY).every((v) => typeof v !== "string" || !/nobody/i.test(v)));
}

console.log("\nKick's side");
{
  const payload = {
    message_id: "unique_message_id_123",
    broadcaster: { is_anonymous: false, user_id: 123456789, username: "broadcaster_name", channel_slug: "broadcaster_channel", identity: null },
    sender: { is_anonymous: false, user_id: 987654321, username: "sender_name",
      identity: { username_color: "#FF5733", badges: [{ text: "Moderator", type: "moderator" }, { text: "Subscriber", type: "subscriber", count: 3 }] } },
    content: "!oddie will I win? [emote:37226:KEKW]",
    created_at: "2025-01-14T16:08:06Z",
  };
  const m = chatFromKick(payload);
  check("Kick's documented chat payload becomes a chat line", m?.channelId === "123456789" && m?.senderId === "987654321" && m?.senderName === "sender_name");
  check("...a moderator may run calls", m?.canRun === true);
  check("...emotes are not part of the words", m?.text === "!oddie will I win?");
  const viewer = chatFromKick({ ...payload, sender: { ...payload.sender, identity: { badges: [{ type: "subscriber" }] } } });
  check("...a subscriber may only answer", viewer?.canRun === false);
  const owner = chatFromKick({ ...payload, sender: { ...payload.sender, user_id: 123456789, identity: null } });
  check("...the channel's owner may run calls", owner?.canRun === true);
  check("...and anything else is ignored", chatFromKick({ hello: 1 }) === null);

  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const sign = (id: string, ts: string, body: string) => createSign("RSA-SHA256").update(`${id}.${ts}.${body}`).sign(privateKey, "base64");
  const body = JSON.stringify(payload);
  const sig = sign("01J", "2026-09-29T10:00:00Z", body);
  check("a signature Kick made verifies", verifyKickSignature(pem, "01J", "2026-09-29T10:00:00Z", body, sig));
  check("...and not over a changed body", !verifyKickSignature(pem, "01J", "2026-09-29T10:00:00Z", body.replace("will I", "wont I"), sig));
  check("...nor with another message id", !verifyKickSignature(pem, "01K", "2026-09-29T10:00:00Z", body, sig));

  const sealed = sealToken("kick", "secret-access-token");
  check("a streamer's token is sealed before it is stored", !sealed.includes("secret-access-token") && openToken("kick", sealed) === "secret-access-token");
  const [iv, tag, cipher] = sealed.split(".");
  const tampered = [iv, tag, (cipher[0] === "A" ? "B" : "A") + cipher.slice(1)].join(".");
  check("...and a tampered seal opens to nothing", openToken("kick", tampered) === null);

  // A signed webhook, end to end, through the real router.
  _resetLiveStore(); _resetLive();
  await saveChannel({ platform: "kick", channelId: "123456789", slug: "broadcaster_channel", name: "Streamer", avatar: null,
    accessToken: "t", refreshToken: null, tokenExpiresAt: null, active: true });
  const said: string[] = [];
  const app = express();
  const jsonBody = express.json();
  app.use((req, res, next) => (req.path === "/live/kick/webhook" ? next() : jsonBody(req, res, next)));
  app.use(kickRouter({
    appBaseUrl: "https://app.oddie.fun", pageHtml: () => "<p>page</p>", pageOpen: () => true, pageClosed: (res) => { res.status(404).end(); },
    log: () => {}, publicKey: async () => pem,
    engine: { store: liveStore, now: () => Date.now(), say: async (_p, _c, t) => { said.push(t); },
      standingsUrl: async () => "https://app.oddie.fun/live/kick/broadcaster_channel", log: () => {} },
  }));
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const post = async (b: string, over: Record<string, string> = {}) => {
    const ts = new Date().toISOString();
    const id = `01H${Math.random().toString(36).slice(2, 10)}`;
    return fetch(`http://127.0.0.1:${port}/live/kick/webhook`, {
      method: "POST", body: b,
      headers: { "content-type": "application/json", "Kick-Event-Message-Id": id, "Kick-Event-Message-Timestamp": ts,
        "Kick-Event-Signature": sign(id, ts, b), "Kick-Event-Type": "chat.message.sent", "Kick-Event-Version": "1", ...over },
    });
  };
  // A quick vote through the real route; !oddie is the market door now.
  const ok = await post(JSON.stringify({ ...payload, content: "!call will I win? [emote:37226:KEKW]" }));
  await new Promise((res) => setTimeout(res, 50));
  check("a signed chat line opens a call through the real route", ok.status === 200 && (await liveStore.current("kick", "123456789"))?.question === "will I win?"
    && said[0]?.startsWith('oddie call: "will I win?"'), `${ok.status} ${said[0]}`);
  const forged = await post(JSON.stringify({ ...payload, message_id: "x2", content: "!call cancel" }), { "Kick-Event-Signature": sig });
  check("a forged one is refused", forged.status === 401 && (await liveStore.current("kick", "123456789")) !== null);
  const api = await fetch(`http://127.0.0.1:${port}/api/live/kick/broadcaster_channel`).then((x) => x.json()) as { current?: { question: string } };
  check("the page reads the running call", api.current?.question === "will I win?");
  server.close();
}

console.log("\nthe market door: !oddie <claim>, like a tag on X or Telegram");
{
  const good = (q: string): Extraction => ({ question: q, resolution_criteria: "CoinGecko daily close.", price_claim: null,
    close_time: "2026-10-03T23:59:00Z", close_time_inferred: false, category: "Crypto", resolvability: "clean",
    appropriate: true, reason: "clean", hook: "BTC to 120k by Friday?" } as Extraction);
  const world = (over: Partial<ChatMarketDeps> = {}) => {
    const said: string[] = []; const opened: Array<{ openerId: string; sourceUrl: string }> = [];
    let opens = 0;
    const deps: ChatMarketDeps = {
      extract: async () => good("Will BTC close above $120k on Friday, October 3, 2026?"),
      existingMarket: async () => null,
      openMarket: async (i) => { opened.push({ openerId: i.openerId, sourceUrl: i.sourceUrl }); return { ok: true, slug: `m${++opens}` } as never; },
      claim: (k, a) => claimMention(k, a),
      settle: (k, o, x) => settleMention(k, o, x),
      openedToday: async () => 0,
      dailyCap: 5,
      sourceFor: (m) => kickChatSource(m.channelSlug ?? m.channelId, m.messageId),
      say: async (_m, t) => { said.push(t); },
      baseUrl: "https://app.oddie.fun",
      log: () => {},
      ...over,
    };
    return { deps, said, opened };
  };
  const viewer = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    platform: "kick", channelId: "131980691", channelSlug: "oddiefun", messageId: id, senderId: "viewer1", senderName: "viewer1",
    canRun: false, text, ...extra,
  });
  const w = world();
  const out = await openFromChat(viewer("0f1e2d3c-aaaa-bbbb-cccc-000000000001", "!oddie BTC above 120k by Friday?"), "BTC above 120k by Friday?", w.deps);
  check("anybody in chat opens a real market", out === "market-opened" && w.opened.length === 1);
  check("...opened by the channel, so the channel's 2%", w.opened[0]?.openerId === "kick:131980691");
  check("...with the chat message as its source, never a link", sourceUrlKind(w.opened[0]?.sourceUrl) === "kick"
    && !isWebSourceUrl(w.opened[0]?.sourceUrl) && /^kick-chat:oddiefun\//.test(w.opened[0]?.sourceUrl ?? ""));
  check("...and the chat hears the link and who earns from it",
    w.said[0] === MARKET_COPY.opened("BTC to 120k by Friday?", "https://app.oddie.fun/m/m1", "oddiefun") && /earns 2% of the pool/.test(w.said[0] ?? ""));
  check("...recorded once", _memMentionOutcome("kick:131980691:0f1e2d3c-aaaa-bbbb-cccc-000000000001") === "replied");
  check("the same message is never handled twice",
    (await openFromChat(viewer("0f1e2d3c-aaaa-bbbb-cccc-000000000001", "x"), "BTC above 120k by Friday?", w.deps)) === "already-handled" && w.opened.length === 1);

  const capped = world({ openedToday: async () => 5 });
  check("a viewer gets a few a day", (await openFromChat(viewer("id-2", "x"), "claim", capped.deps)) === "cap" && capped.said[0] === MARKET_COPY.cap(5));
  const mod = world({ openedToday: async () => 50 });
  check("...the channel's owner and mods as many as they like", (await openFromChat(viewer("id-3", "x", { canRun: true }), "claim", mod.deps)) === "market-opened");
  const vibes = world({ extract: async () => ({ ...good(""), question: "", resolvability: "unresolvable" } as Extraction) });
  check("a claim with no yes, no or date is explained, not opened",
    (await openFromChat(viewer("id-4", "x"), "vibes are good", vibes.deps)) === "unmarketable" && vibes.said[0] === MARKET_COPY.unmarketable && vibes.opened.length === 0);
  const down = world({ extract: async () => { throw new Error("extract 529 overloaded"); } });
  check("a model outage asks for another go", (await openFromChat(viewer("id-5", "x"), "claim", down.deps)) === "later" && down.said[0] === MARKET_COPY.later);
  const known = world({ existingMarket: async () => ({ slug: "known", question: "Will BTC close above $120k?" }) });
  check("a claim that already has a market points at it", (await openFromChat(viewer("id-6", "x"), "claim", known.deps)) === "existing"
    && /app\.oddie\.fun\/m\/known/.test(known.said[0] ?? "") && known.opened.length === 0);

  // Through the engine: under a message, a bare !oddie means that message.
  const r = room();
  let asked = "";
  r.deps.market = async (_m, claim) => { asked = claim; return "market-opened"; };
  const replied = await handleChat({ ...r.line("v9", "!oddie"), replyText: "ETH flips BTC this year" }, r.deps);
  check("a bare !oddie under a message opens a market on that message", replied === "market-opened" && asked === "ETH flips BTC this year");
  delete r.deps.market;
  check("...and a bare !oddie on its own says how", (await handleChat(r.line("v9", "!oddie"), r.deps)) === "market-help"
    && r.said[r.said.length - 1]?.text === LIVE_COPY.marketHelp);

  check("a Kick message id in another shape is hashed, never refused", /^kick-chat:oddiefun\/[0-9a-f]{32}$/.test(kickChatSource("OddieFun", "unique_message_id_123")));
  check("...and one message is one source", sourcePostKey(kickChatSource("oddiefun", "0F1E2D3C-AAAA-BBBB-CCCC-000000000001"))
    === sourcePostKey(kickChatSource("ODDIEFUN", "0f1e2d3c-aaaa-bbbb-cccc-000000000001")));
}

console.log("\nwhen Kick will not take a bot line");
{
  _resetLiveStore();
  for (const id of ["555", "777"]) {
    await saveChannel({ platform: "kick", channelId: id, slug: `c${id}`, name: "C", avatar: null,
      accessToken: "tok", refreshToken: null, tokenExpiresAt: null, active: true });
  }
  const sent: string[] = [];
  const fail = (status: number) => { const e = new Error(`kick POST /chat ${status}`) as Error & { status?: number }; e.status = status; return e; };
  const chat: KickChat = {
    bot: async (_t, text) => { sent.push(`bot:${text}`); throw fail(404); },
    user: async (_t, ch, text) => { sent.push(`user:${ch}:${text}`); },
  };
  const deps = kickEngineDeps({ appBaseUrl: "https://app.oddie.fun", log: () => {} }, chat);
  await deps.say("kick", "555", "hello");
  await deps.say("kick", "555", "again");
  check("a line Kick refuses from the bot goes out as the channel's own account",
    sent.join("|") === "bot:hello|user:555:hello|user:555:again", sent.join("|"));
  check("...and once refused there, the bot is not asked again in that channel", sent.filter((x) => x.startsWith("bot:")).length === 1);
  const other = kickEngineDeps({ appBaseUrl: "https://app.oddie.fun", log: () => {} }, {
    bot: async () => { throw fail(500); }, user: async () => { sent.push("user:777"); },
  });
  let threw = false;
  try { await other.say("kick", "777", "x"); } catch { threw = true; }
  check("...but an outage is an outage, not a reason to speak as the streamer", threw && !sent.includes("user:777"));
}

console.log("\nthe lines no memory test reaches");
{
  const server = readFileSync("src/server.ts", "utf8");
  check("the JSON parser leaves the webhook's bytes alone", /req\.path === "\/live\/kick\/webhook" \? next\(\) : jsonBody\(req, res, next\)/.test(server)
    && !/^app\.use\(express\.json\(\)\);$/m.test(server));
  check("the live pages are app pages", /\(m\|market\|w\|u\|live\)/.test(server) && /\|following\|live\)/.test(server));
  check("the Kick router is mounted, and the clock runs only where Kick is set up",
    /app\.use\(kickRouter\(\{/.test(server) && /if \(kickConfigured\(\)\) startLiveClock\(/.test(server));
  const store = readFileSync("src/store/live.ts", "utf8");
  check("one live call per channel is the database's rule",
    /CREATE UNIQUE INDEX IF NOT EXISTS live_call_one_open ON live_call \(platform, channel_id\)\s+WHERE settled_at IS NULL AND canceled_at IS NULL/.test(store));
  check("one answer per person is the primary key", /PRIMARY KEY \(call_id, platform, user_id\)/.test(store));
  check("no column is called `right`: RIGHT is reserved, and ORDER BY right is a syntax error Postgres found live",
    !/\bAS right\b/.test(store) && !/ORDER BY[^`]*\bright\b/.test(store));
  check("an answer lands only in a call that is still open", /WHERE EXISTS \(SELECT 1 FROM live_call WHERE id = \$1 AND locked_at IS NULL/.test(store));
  const routes = readFileSync("src/kick/routes.ts", "utf8");
  check("the market door is the same machinery as X and Telegram, the channel is the opener, a viewer's day is capped",
    /extract: \(text: string\) => runExtract\(text\)/.test(server) && /payee: input\.openerId/.test(server)
    && /dailyCap: KICK_MARKETS_PER_DAY/.test(server) && /markets: kickMarkets,/.test(server));
  check("a market opened on Kick names its channel on its page", /platform: "kick", handle: m\[1\], url: `https:\/\/kick\.com\/\$\{m\[1\]\}`/.test(server));
  check("...and its result goes back to that chat", /kickThreadsForSlug\(slug\)/.test(server) && /Winners collect at/.test(server));
  const page = readFileSync("public/app/market.html", "utf8");
  check("the market page says 18+ next to the buttons on a Kick market", /m\.origin === "kick"\) html \+= '<p class="adult">18\+ only/.test(page)
    && /function kickChip\(handle\)/.test(page));
  check("a webhook older than ten minutes is refused, and each message is handled once",
    /age <= WEBHOOK_MAX_AGE_MS/.test(routes) && /if \(seen\.has\(id\)\) return;/.test(routes));
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall live checks passed.\n");
process.exit(failures ? 1 : 0);
