// The operator's mail (src/live/openedMail.ts): a call or a market a person
// opens in a stream's chat sends one; oddie's own match calls and a repeat's
// later rounds do not; a connected channel going live sends one, once; a
// person's call getting its result sends one, with who called it and the
// picture the screen settled it on; each kind has its own cap a day; and
// nothing about a mail can stop a chat line.
if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database: unset DATABASE_URL");
  process.exit(1);
}
import { readFileSync } from "node:fs";
import { handleChat, settleOnScreen, _resetLive, type ChatMessage, type LiveDeps } from "../src/live/calls.js";
import { liveStore, _resetLiveStore } from "../src/store/live.js";
import { openFromChat, type ChatMarketDeps } from "../src/live/claims.js";
import { openMatchCall } from "../src/live/matchCalls.js";
import { claimMention, settleMention, kickChatSource } from "../src/store/markets.js";
import {
  alertMail, liveMail, openedMail, opsMail, opsMailer, settledMail, setOpsSink, watchUrl, wentLiveWatcher,
  type OpsEvent, type Opened, type Settled,
} from "../src/live/openedMail.js";
import type { Extraction } from "../src/matching/extractClaim.js";
import { _setPace } from "../src/live/pace.js";

_setPace({ gapMs: 0, retryMs: [0, 0] });

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

const seen: OpsEvent[] = [];
const opened = () => seen.filter((e): e is Opened => e.kind === "call" || e.kind === "market");
const settled = () => seen.filter((e): e is Settled => e.kind === "settled");
const sink = (e: OpsEvent) => { seen.push(e); };
setOpsSink(sink);

function room(channelId = "100") {
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
  const line = (who: string, text: string, canRun = false, channel = channelId): ChatMessage => ({
    platform: "kick", channelId: channel, messageId: `m${++n}`, senderId: who, senderName: who, canRun, text,
  });
  return { deps, said, line, tick: (ms: number) => { clock += ms; } };
}

console.log("what mails: a call a person opened");
{
  const r = room();
  await handleChat(r.line("v1", "!call will he win?"), r.deps);
  check("a viewer's refused !call mails nothing", seen.length === 0);
  check("the streamer's or a mod's !call mails once",
    (await handleChat(r.line("mod", "!call will he clutch this?", true), r.deps)) === "opened" && opened().length === 1);
  check("...saying the call, where and who opened it",
    opened()[0]?.kind === "call" && opened()[0]?.platform === "kick" && opened()[0]?.channelId === "100"
    && opened()[0]?.question === "will he clutch this?" && opened()[0]?.by === "mod", JSON.stringify(opened()[0]));
  await handleChat(r.line("mod", "!call will he clutch this?", true), r.deps);
  check("the same question brought back up mails nothing more", opened().length === 1);
  await handleChat(r.line("a", "!yes"), r.deps);
  check("an answer mails nothing", seen.length === 1);
}
{
  const r = room();
  await handleChat(r.line("owner", "!call repeat will I win this round?", true), r.deps);
  check("a !call repeat mails at its first round", opened().length === 1 && opened()[0]?.question === "will I win this round?");
  await handleChat(r.line("owner", "!call yes", true), r.deps);
  const open = await liveStore.unsettled("kick", "100");
  check("...its next round opens and mails no opening", open.length === 1 && open[0]?.question === "will I win this round?" && opened().length === 1,
    `${open.length} open, ${opened().length} opened mails`);
}
{
  const r = room();
  const out = await openMatchCall(r.deps, { platform: "kick", channelId: "200", slug: "cs", name: "CS" }, "match-1", "Mirage", 1_800_000_000_000);
  check("oddie's own match call mails nothing", typeof out === "object" && seen.length === 0);
  await handleChat(r.line("mod", "!call yes", true, "200"), r.deps);
  check("...and a mod settling it mails nothing either", seen.length === 0, JSON.stringify(seen));
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
  check("a market opened from chat mails once", (await openFromChat(viewer("mail-1"), "BTC above 120k by Friday?", world())) === "market-opened" && opened().length === 1);
  check("...with the market's question, its page and who typed it",
    opened()[0]?.kind === "market" && opened()[0]?.platform === "twitch" && opened()[0]?.slug === "m1" && opened()[0]?.by === "viewer1"
    && opened()[0]?.question === good.question, JSON.stringify(opened()[0]));
  await openFromChat(viewer("mail-2"), "claim", world({ existingMarket: async () => ({ slug: "old", question: "old one" }) }));
  await openFromChat(viewer("mail-3"), "claim", world({ openedToday: async () => 5 }));
  await openFromChat(viewer("mail-4"), "vibes", world({ extract: async () => ({ ...good, question: "", resolvability: "unresolvable" } as Extraction) }));
  await openFromChat(viewer("mail-5"), "claim", world({ openMarket: async () => ({ ok: true, slug: "elsewhere", existed: true }) as never }));
  check("a claim that already had a market, a capped viewer and a refused claim mail nothing", opened().length === 1, `${opened().length} mails`);
}

console.log("\nwhat mails: a person's call has its result");
{
  const r = room();
  await handleChat(r.line("mod", "!call will he clutch this?", true), r.deps);
  await handleChat(r.line("a", "!yes"), r.deps);
  await handleChat(r.line("b", "!no"), r.deps);
  await handleChat(r.line("c", "!yes"), r.deps);
  await handleChat(r.line("mod", "!call yes", true), r.deps);
  const s = settled()[0];
  check("the streamer's or a mod's result mails once", settled().length === 1, JSON.stringify(settled()));
  check("...saying the result, who gave it and who called it",
    s?.source === "streamer" && s?.by === "mod" && s?.outcome === "yes" && s?.right === 2 && s?.total === 3
    && s?.winners.join(",") === "a,c" && s?.frame === false && s?.question === "will he clutch this?" && typeof s?.callId === "string",
    JSON.stringify(s));
}
{
  const r = room();
  await handleChat(r.line("mod", "!call will he win this game?", true), r.deps);
  await handleChat(r.line("a", "!no"), r.deps);
  const call = (await liveStore.unsettled("kick", "100"))[0]!;
  check("the screen's result mails once, with its picture",
    (await settleOnScreen(call, "no", "DEFEAT", r.deps, Buffer.from("jpeg"))) && settled().length === 1
    && settled()[0]?.source === "screen" && settled()[0]?.frame === true && settled()[0]?.outcome === "no" && settled()[0]?.winners.join(",") === "a",
    JSON.stringify(settled()));
  check("...and settling what is already settled mails nothing more", !(await settleOnScreen(call, "yes", "VICTORY", r.deps)) && settled().length === 1);
}
{
  const r = room();
  await handleChat(r.line("mod", "!call clutch?", true), r.deps);
  await handleChat(r.line("mod", "!call cancel", true), r.deps);
  check("a canceled call mails no result", settled().length === 0 && opened().length === 1);
}
{
  const calls = readFileSync("src/live/calls.ts", "utf8");
  const price = calls.slice(calls.indexOf("async function settlePrice"), calls.indexOf("async function settlePrices"));
  check("the price's result mails too, for a person's call only",
    /reportSettled\(\{[^}]*source: "price"/.test(price) && /if \(w\.call\.matchId === null\)/.test(price));
}

console.log("\nnothing about a mail stops a chat line");
{
  const r = room();
  setOpsSink(() => { throw new Error("mailer exploded"); });
  check("a sink that throws still opens the call and says it",
    (await handleChat(r.line("mod", "!call clutch?", true), r.deps)) === "opened" && r.said.length >= 1);
  const before = r.said.length;
  check("...and still settles it and says so",
    (await handleChat(r.line("mod", "!call yes", true), r.deps)) === "settled" && r.said.length > before);
  setOpsSink(sink);
}

console.log("\nwhat mails: a channel going live");
{
  const states = new Map<string, boolean | null | "throw">();
  const chans: Array<{ platform: "kick" | "twitch" | "x"; channelId: string }> = [
    { platform: "kick", channelId: "1" }, { platform: "twitch", channelId: "2" }, { platform: "x", channelId: "3" },
  ];
  const reported: string[] = [];
  let now = Date.UTC(2026, 10, 24, 12, 0);
  const pass = wentLiveWatcher({
    channels: async () => chans,
    streamLive: async (p, c) => {
      const s = states.get(`${p}:${c}`);
      if (s === "throw") throw new Error("api down");
      return s ?? null;
    },
    now: () => now,
    report: (c) => { reported.push(`${c.platform}:${c.channelId}`); },
  });
  const count = (k: string) => reported.filter((x) => x === k).length;
  states.set("kick:1", true); states.set("twitch:2", false); states.set("x:3", null);
  await pass();
  check("the first pass only learns who is on", reported.length === 0);
  await pass();
  check("a stream already on at boot never mails", reported.length === 0);
  states.set("twitch:2", true);
  check("off to on mails once", (await pass()) === 1 && count("twitch:2") === 1);
  await pass();
  check("...and while it stays on, nothing more", count("twitch:2") === 1);
  states.set("twitch:2", "throw"); await pass();
  states.set("twitch:2", null); await pass();
  states.set("twitch:2", true); await pass();
  check("a read that failed in between is not a new stream", count("twitch:2") === 1, reported.join(" "));
  states.set("x:3", true); await pass();
  check("X, unknown until a broadcast starts, mails when one does", count("x:3") === 1);
  states.set("twitch:2", false); now += 10 * 60_000; await pass();
  states.set("twitch:2", true); now += 60_000; await pass();
  check("a stream that drops and comes back inside two hours is not a new one", count("twitch:2") === 1);
  states.set("twitch:2", false); now += 3 * 60 * 60_000; await pass();
  states.set("twitch:2", true); await pass();
  check("the next stream, hours later, mails again", count("twitch:2") === 2);
  chans.push({ platform: "kick", channelId: "9" }); states.set("kick:9", true); await pass();
  check("a channel connected later that is live mails", count("kick:9") === 1);
  check("the one on since boot never did", count("kick:1") === 0);
}
{
  let calls = 0;
  const pass = wentLiveWatcher({
    channels: async () => { if (++calls === 1) throw new Error("db down"); return [{ platform: "kick", channelId: "5" }]; },
    streamLive: async () => true, now: () => 0, report: () => { throw new Error("should not mail"); },
  });
  let threw = false;
  try { await pass(); } catch { threw = true; }
  let mailed = true;
  try { await pass(); mailed = false; } catch { mailed = true; }
  check("a first pass that could not list the channels is still only learning", threw && !mailed);
}

console.log("\nthe mails themselves");
{
  const base = "https://app.oddie.fun/";
  const call = openedMail({ kind: "call", platform: "x", channelId: "1600", question: "will I win this game?", by: "Showdown" },
    { slug: "ShowdownTV", name: "Showdown" }, base);
  check("opened: the subject says what, where and the question", call.subject === 'Call opened on Showdown (X): "will I win this game?"', call.subject);
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

  const xLive = liveMail({ kind: "live", platform: "x", channelId: "1600" }, { slug: "ShowdownTV", name: "Showdown" }, base);
  check("live: the subject says who and where", xLive.subject === "Showdown is live on X", xLive.subject);
  check("...on X, that Lev can open the calls himself",
    xLive.html.includes("<b>Showdown</b> just went live on X.") && xLive.html.includes("You can open calls in this chat yourself")
    && xLive.html.includes('href="https://x.com/ShowdownTV"') && xLive.html.includes('href="https://app.oddie.fun/live/x/ShowdownTV"'));
  const kickLive = liveMail({ kind: "live", platform: "kick", channelId: "72486" }, { slug: "isaacbeast", name: "IsaacBeast" }, base);
  check("...elsewhere, that the streamer or a mod opens them",
    kickLive.subject === "IsaacBeast is live on Kick" && kickLive.html.includes("A call opens when they or a mod type !call")
    && kickLive.html.includes('href="https://kick.com/isaacbeast"'));

  const screen = settledMail({ kind: "settled", platform: "twitch", channelId: "7", callId: "42", question: "will he clutch?", outcome: "yes",
    source: "screen", right: 2, total: 3, winners: ["ana", "bo"], frame: true }, { slug: "bee_empire", name: "Bee" }, base);
  check("settled: the subject says where, the result and the question", screen.subject === 'Call settled on Bee (Twitch): YES, "will he clutch?"', screen.subject);
  check("...the body what settled it, who called it, and the picture it was settled on",
    screen.html.includes("The screen settled it <b>YES</b> on Bee's Twitch stream:") && screen.html.includes("2 of 3 called it: @ana @bo")
    && screen.html.includes('href="https://app.oddie.fun/api/live/twitch/bee_empire/frame/42"') && screen.html.includes(">What Oddie saw<"));
  check("...and first of its links, the call's card, one tap from a post",
    screen.html.includes('<a href="https://app.oddie.fun/live/twitch/bee_empire/call/42">The card</a> · <a href="https://app.oddie.fun/api/live/twitch/bee_empire/frame/42">What Oddie saw</a>')
    && !screen.html.includes("Chat voted"), screen.html);
  const against = settledMail({ kind: "settled", platform: "twitch", channelId: "7", callId: "43", question: "will I win this game?", outcome: "yes",
    source: "screen", right: 1, total: 4, winners: ["ana"], frame: true }, { slug: "bee_empire", name: "Bee" }, base);
  check("a result the room voted against says so, before who called it", against.html.includes("<b>Chat voted no.</b> 1 of 4 called it: @ana"), against.html);
  check("...also when nobody called it, and never from two answers",
    settledMail({ kind: "settled", platform: "kick", channelId: "9", callId: "7", question: "q?", outcome: "no", source: "streamer", by: "mod", right: 0, total: 3, winners: [], frame: false }, null, base)
      .html.includes("<b>Chat voted yes.</b> Nobody called it. 3 answered."));
  const byMod = settledMail({ kind: "settled", platform: "kick", channelId: "9", callId: "7", question: "q?", outcome: "no",
    source: "streamer", by: "<b>mod</b>", right: 0, total: 2, winners: [], frame: false }, null, base);
  check("a mod's result names the mod, escaped, and has no picture",
    byMod.html.includes("<b>&lt;b&gt;mod&lt;/b&gt;</b> settled it <b>NO</b>") && !byMod.html.includes("What Oddie saw")
    && byMod.html.includes("Nobody called it. 2 answered."));
  const empty = settledMail({ kind: "settled", platform: "kick", channelId: "9", callId: "8", question: "q?", outcome: "yes",
    source: "price", right: 0, total: 0, winners: [], frame: false }, null, base);
  check("the price's result, and a call nobody answered", empty.html.includes("The price settled it <b>YES</b>") && empty.html.includes("Nobody answered."));
  const crowd = settledMail({ kind: "settled", platform: "kick", channelId: "9", callId: "9", question: "q?", outcome: "yes",
    source: "screen", right: 11, total: 12, winners: Array.from({ length: 11 }, (_, i) => `p${i}`), frame: false }, null, base);
  check("a long list of callers names eight and counts the rest", crowd.html.includes("@p7 and 3 more") && !crowd.html.includes("@p8"));
  check("any event's mail is its kind's", opsMail({ kind: "live", platform: "kick", channelId: "72486" }, null, base).subject === "72486 is live on Kick"
    && opsMail({ kind: "call", platform: "kick", channelId: "9", question: "q?", by: "m" }, null, base).subject.startsWith("Call opened on 9"));
  const alert = alertMail({ kind: "alert", title: "Oddie's Kick voice (oddiefun) is signed out", text: "oddiefun can no longer post <here>.", link: ["Sign it in again", "https://app.oddie.fun/live/kick/connect"] });
  check("alert: the subject is the trouble, the body says it escaped, with the link that fixes it",
    alert.subject === "Oddie's Kick voice (oddiefun) is signed out" && alert.html.includes("can no longer post &lt;here&gt;.")
    && alert.html.includes('href="https://app.oddie.fun/live/kick/connect"'));
  check("no em dash anywhere", !/—/.test([call, market, xLive, kickLive, screen, byMod, empty, crowd, alert].map((m) => m.subject + m.html).join("")));
}

console.log("\nthe mailer: one mail each, each kind its own cap a day");
{
  let now = Date.UTC(2026, 10, 23, 10, 0);
  const sent: Array<{ to: string; subject: string; html: string }> = [];
  const logs: string[] = [];
  const mail = opsMailer({
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
  mail({ kind: "live", platform: "twitch", channelId: "7" });
  mail({ kind: "settled", platform: "twitch", channelId: "7", callId: "1", question: "clutch?", outcome: "yes", source: "screen", right: 1, total: 1, winners: ["a"], frame: true });
  await flush();
  check("a day of openings never silences the live and settled mails", sent.length === 4
    && sent[2]!.subject === "Bee is live on Twitch" && sent[3]!.subject.startsWith("Call settled on Bee (Twitch): YES"), sent.map((m) => m.subject).join(" | "));
  check("...each logged as its kind", logs.includes("live mail") && logs.includes("settled mail"));
  let looked = 0;
  const alertSent: Array<{ to: string; subject: string; html: string }> = [];
  const alertsOnly = opsMailer({
    to: "lev@oddie.fun", send: async (m) => { alertSent.push(m); return "dry-run"; },
    channel: async () => { looked++; return null; }, appBase: "https://app.oddie.fun", dailyMax: 2, now: () => now, log: (l) => { logs.push(l); },
  });
  alertsOnly({ kind: "alert", title: "Oddie's Kick voice (oddiefun) is signed out", text: "x" });
  await flush();
  check("an alert mails with no channel to look up", alertSent.length === 1 && looked === 0 && alertSent[0]!.subject.startsWith("Oddie's Kick voice") && logs.includes("alert mail"));
  now += 24 * 60 * 60_000;
  mail(o);
  await flush();
  check("a new UTC day mails again", sent.length === 5);

  const failing = opsMailer({
    to: "lev@oddie.fun",
    send: async () => { throw new Error("resend 500"); },
    channel: async () => { throw new Error("db down"); },
    appBase: "https://app.oddie.fun", dailyMax: 5, now: () => now, log: (l) => { logs.push(l); },
  });
  let threw = false;
  try { failing(o); failing({ kind: "live", platform: "kick", channelId: "1" }); } catch { threw = true; }
  await flush();
  check("a mailer that fails is a log line, never a throw", !threw && logs.includes("opened mail failed") && logs.includes("live mail failed"));
}

console.log("\nwired at boot");
{
  const server = readFileSync("src/server.ts", "utf8");
  check("the server sets the sink with the mailer, lev@oddie.fun unless OPS_MAIL_TO says otherwise",
    /setOpsSink\(opsMailer\(/.test(server) && /process\.env\.OPS_MAIL_TO \?\? "lev@oddie\.fun"/.test(server));
  check("...and runs the went-live watcher every two minutes over every active channel",
    /wentLiveWatcher\(\{[\s\S]{0,200}channels: \(\) => liveStore\.channels\(\)[\s\S]{0,300}report: \(c\) => reportLive\(c\)/.test(server)
    && /setInterval\(look, 120_000\)/.test(server) && /if \(OPS_MAIL_ON\) \{\s*const pass = wentLiveWatcher/.test(server));
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall operator-mail checks passed.\n");
process.exit(failures ? 1 : 0);
