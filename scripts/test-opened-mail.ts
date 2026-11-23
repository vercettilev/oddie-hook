// The operator's mail (src/live/openedMail.ts): a call or a market a person
// opens in a stream's chat sends one; oddie's own match calls and a repeat's
// later rounds do not; the mail says what, who and where; a busy day stops at
// its cap; and nothing about a mail can stop a chat line.
if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database: unset DATABASE_URL");
  process.exit(1);
}
import { readFileSync } from "node:fs";
import { handleChat, _resetLive, type ChatMessage, type LiveDeps } from "../src/live/calls.js";
import { liveStore, _resetLiveStore } from "../src/store/live.js";
import { openFromChat, type ChatMarketDeps } from "../src/live/claims.js";
import { openMatchCall } from "../src/live/matchCalls.js";
import { claimMention, settleMention, kickChatSource } from "../src/store/markets.js";
import { openedMail, openedMailer, setOpenedSink, watchUrl, type Opened } from "../src/live/openedMail.js";
import type { Extraction } from "../src/matching/extractClaim.js";
import { _setPace } from "../src/live/pace.js";

_setPace({ gapMs: 0, retryMs: [0, 0] });

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

const seen: Opened[] = [];
setOpenedSink((o) => { seen.push(o); });

function room() {
  _resetLiveStore(); _resetLive(); seen.length = 0;
  let clock = 1_800_000_000_000;
  const said: string[] = [];
  const deps: LiveDeps = {
    store: liveStore,
    now: () => clock,
    say: async (_p, _c, text) => { said.push(text); return `said-${said.length}`; },
    standingsUrl: async () => "https://app.oddie.fun/live/kick/streamer",
    log: () => {},
  };
  let n = 0;
  const line = (who: string, text: string, canRun = false): ChatMessage => ({
    platform: "kick", channelId: "100", messageId: `m${++n}`, senderId: who, senderName: who, canRun, text,
  });
  return { deps, said, line, tick: (ms: number) => { clock += ms; } };
}

console.log("what mails: a call a person opened");
{
  const r = room();
  await handleChat(r.line("v1", "!call will he win?"), r.deps);
  check("a viewer's refused !call mails nothing", seen.length === 0);
  check("the streamer's or a mod's !call mails once",
    (await handleChat(r.line("mod", "!call will he clutch this?", true), r.deps)) === "opened" && seen.length === 1);
  check("...saying the call, where and who opened it",
    seen[0]?.kind === "call" && seen[0]?.platform === "kick" && seen[0]?.channelId === "100"
    && seen[0]?.question === "will he clutch this?" && seen[0]?.by === "mod", JSON.stringify(seen[0]));
  await handleChat(r.line("mod", "!call will he clutch this?", true), r.deps);
  check("the same question brought back up mails nothing more", seen.length === 1);
  await handleChat(r.line("a", "!yes"), r.deps);
  await handleChat(r.line("mod", "!call yes", true), r.deps);
  check("answers and results mail nothing", seen.length === 1);
}
{
  const r = room();
  await handleChat(r.line("owner", "!call repeat will I win this round?", true), r.deps);
  check("a !call repeat mails at its first round", seen.length === 1 && seen[0]?.question === "will I win this round?");
  await handleChat(r.line("owner", "!call yes", true), r.deps);
  const open = await liveStore.unsettled("kick", "100");
  check("...its next round opens and mails nothing", open.length === 1 && open[0]?.question === "will I win this round?" && seen.length === 1,
    `${open.length} open, ${seen.length} mails`);
}
{
  const r = room();
  const out = await openMatchCall(r.deps, { platform: "kick", channelId: "200", slug: "cs", name: "CS" }, "match-1", "Mirage", 1_800_000_000_000);
  check("oddie's own match call mails nothing", typeof out === "object" && seen.length === 0);
}

console.log("\nwhat mails: a market !oddie opened");
{
  const good: Extraction = { question: "Will BTC close above $120k on Friday, October 3, 2026?", resolution_criteria: "CoinGecko daily close.",
    price_claim: null, close_time: "2026-10-03T23:59:00Z", close_time_inferred: false, category: "Crypto", resolvability: "clean",
    appropriate: true, reason: "clean", hook: "BTC to 120k by Friday?" } as Extraction;
  const world = (over: Partial<ChatMarketDeps> = {}): ChatMarketDeps => ({
    extract: async () => good,
    existingMarket: async () => null,
    openMarket: async () => ({ ok: true, slug: "m1" }) as never,
    claim: (k, a) => claimMention(k, a),
    settle: (k, o, x) => settleMention(k, o, x),
    openedToday: async () => 0,
    dailyCap: 5,
    sourceFor: (m) => kickChatSource(m.channelSlug ?? m.channelId, m.messageId),
    say: async () => {},
    baseUrl: "https://app.oddie.fun",
    log: () => {},
    ...over,
  });
  const viewer = (id: string): ChatMessage => ({
    platform: "twitch", channelId: "7", channelSlug: "bee_empire", messageId: id, senderId: "u1", senderName: "viewer1", canRun: false, text: "!oddie x",
  });
  seen.length = 0;
  check("a market opened from chat mails once", (await openFromChat(viewer("mail-1"), "BTC above 120k by Friday?", world())) === "market-opened" && seen.length === 1);
  check("...with the market's question, its page and who typed it",
    seen[0]?.kind === "market" && seen[0]?.platform === "twitch" && seen[0]?.slug === "m1" && seen[0]?.by === "viewer1"
    && seen[0]?.question === good.question, JSON.stringify(seen[0]));
  await openFromChat(viewer("mail-2"), "claim", world({ existingMarket: async () => ({ slug: "old", question: "old one" }) }));
  await openFromChat(viewer("mail-3"), "claim", world({ openedToday: async () => 5 }));
  await openFromChat(viewer("mail-4"), "vibes", world({ extract: async () => ({ ...good, question: "", resolvability: "unresolvable" } as Extraction) }));
  await openFromChat(viewer("mail-5"), "claim", world({ openMarket: async () => ({ ok: true, slug: "elsewhere", existed: true }) as never }));
  check("a claim that already had a market, a capped viewer and a refused claim mail nothing", seen.length === 1, `${seen.length} mails`);
}

console.log("\nnothing about a mail stops a chat line");
{
  const r = room();
  setOpenedSink(() => { throw new Error("mailer exploded"); });
  check("a sink that throws still opens the call and says it",
    (await handleChat(r.line("mod", "!call clutch?", true), r.deps)) === "opened" && r.said.length >= 1);
  setOpenedSink((o) => { seen.push(o); });
}

console.log("\nthe mail itself");
{
  const base = "https://app.oddie.fun/";
  const call = openedMail({ kind: "call", platform: "x", channelId: "1600", question: "will I win this game?", by: "Showdown" },
    { slug: "ShowdownTV", name: "Showdown" }, base);
  check("the subject says what, where and the question", call.subject === 'Call opened on Showdown (X): "will I win this game?"', call.subject);
  check("...the body who opened it, and links to the stream and its channel page",
    call.html.includes("<b>Showdown</b> opened a call on Showdown's X stream:")
    && call.html.includes('href="https://x.com/ShowdownTV"') && call.html.includes('href="https://app.oddie.fun/live/x/ShowdownTV"'));
  const market = openedMail({ kind: "market", platform: "twitch", channelId: "7", question: "Will BTC close above $120k?", by: "viewer1", slug: "btc-120k" },
    { slug: "bee_empire", name: "Bee" }, base);
  check("a market's mail links the market",
    market.subject.startsWith("Market opened on Bee (Twitch): ") && market.html.includes('href="https://app.oddie.fun/m/btc-120k"')
    && market.html.includes("opened a market in Bee's Twitch chat"));
  check("every platform's stream link", watchUrl("twitch", "bee_empire", "7") === "https://www.twitch.tv/bee_empire"
    && watchUrl("kick", "oddiefun", "131980691") === "https://kick.com/oddiefun" && watchUrl("x", "levvercetti", "1") === "https://x.com/levvercetti"
    && watchUrl("youtube", "somehandle", "UCabc") === "https://www.youtube.com/channel/UCabc/live");
  const nasty = openedMail({ kind: "call", platform: "kick", channelId: "9", question: '<script>alert(1)</script> & "x"\nsecond line', by: "<img src=x>" }, null, base);
  check("chat text is escaped, never markup", !nasty.html.includes("<script>") && !nasty.html.includes("<img")
    && nasty.html.includes("&lt;script&gt;") && nasty.html.includes("&quot;x&quot;"));
  check("...and the subject is one line", !/[\r\n]/.test(nasty.subject));
  check("no channel known: its id stands in", nasty.subject.startsWith("Call opened on 9 (Kick): ") && nasty.html.includes("https://kick.com/9"));
  const long = openedMail({ kind: "call", platform: "kick", channelId: "9", question: "a".repeat(300), by: "m" }, null, base);
  check("a long question is clipped in the subject", long.subject.length < 150 && long.subject.endsWith('…"'), String(long.subject.length));
  check("no em dash anywhere", !/—/.test(call.subject + call.html + market.subject + market.html));
}

console.log("\nthe mailer: one mail each, a cap a day");
{
  let now = Date.UTC(2026, 10, 23, 10, 0);
  const sent: Array<{ to: string; subject: string; html: string }> = [];
  const logs: string[] = [];
  const mail = openedMailer({
    to: "lev@oddie.fun",
    send: async (m) => { sent.push(m); return "dry-run"; },
    channel: async () => ({ slug: "bee_empire", name: "Bee" }),
    appBase: "https://app.oddie.fun",
    dailyMax: 2,
    now: () => now,
    log: (l) => { logs.push(l); },
  });
  const o: Opened = { kind: "call", platform: "twitch", channelId: "7", question: "clutch?", by: "mod" };
  mail(o); mail(o); mail(o);
  await flush();
  check("to the operator's address, up to the day's cap", sent.length === 2 && sent.every((m) => m.to === "lev@oddie.fun"), String(sent.length));
  check("...the last one says it is the last", !sent[0]!.html.includes("last mail") && sent[1]!.html.includes("today's last mail"));
  check("...and the one after is a log line", logs.includes("opened mail skipped: the day's mails are used"));
  now += 24 * 60 * 60_000;
  mail(o);
  await flush();
  check("a new UTC day mails again", sent.length === 3);

  const failing = openedMailer({
    to: "lev@oddie.fun",
    send: async () => { throw new Error("resend 500"); },
    channel: async () => { throw new Error("db down"); },
    appBase: "https://app.oddie.fun", dailyMax: 5, now: () => now, log: (l) => { logs.push(l); },
  });
  let threw = false;
  try { failing(o); } catch { threw = true; }
  await flush();
  check("a mailer that fails is a log line, never a throw", !threw && logs.includes("opened mail failed"));
}

console.log("\nwired at boot");
{
  const server = readFileSync("src/server.ts", "utf8");
  check("the server sets the sink with the mailer, lev@oddie.fun unless OPS_MAIL_TO says otherwise",
    /setOpenedSink\(openedMailer\(/.test(server) && /process\.env\.OPS_MAIL_TO \?\? "lev@oddie\.fun"/.test(server));
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall opened-mail checks passed.\n");
process.exit(failures ? 1 : 0);
