// A call in every connected stream (src/live/autoCall.ts): which call fits
// what is on, when Lev's account says it and when it stays quiet, and that his
// line goes out on his own token and comes back as his, never as oddie's.
//
// Run with: npm run test-auto-call

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";
import { AUTO_CALL_AFTER_MS, AUTO_CALL_OPENED_SLACK_MS, autoCaller, chooseCall, type AutoCallDeps } from "../src/live/autoCall.js";
import { _resetLive, type Platform } from "../src/live/calls.js";
import { deathWindowOf } from "../src/games/screen.js";
import { parsePriceCall } from "../src/live/priceCall.js";
import { parseViewerCall } from "../src/live/viewerCall.js";
import { chatFromTwitch } from "../src/twitch/client.js";
import { chatFromKick } from "../src/kick/client.js";
import { kickSayAsOperator, type KickChat } from "../src/kick/routes.js";
import { twitchRouter, twitchSayAsOperator, _resetTwitchVoice } from "../src/twitch/routes.js";
import { saveChannel, _resetLiveStore } from "../src/store/live.js";
import { _setPace } from "../src/live/pace.js";

_setPace({ gapMs: 0, retryMs: [0, 0] });

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};
const at = (iso: string) => Date.parse(iso);
const q = (line: string | null) => (line ?? "").replace(/^!call /, "");

console.log("which call fits what is on");
{
  const gta = chooseCall({ name: "IsaacBeast", game: "Grand Theft Auto VI", viewers: 30, matchCalls: true, now: at("2026-11-27T00:10:00Z") });
  check("GTA: the timed death call about the streamer, by name", gta === "!call will IsaacBeast die in the next 15 minutes?", String(gta));
  check("...which the screen reads as fifteen minutes about him", deathWindowOf(q(gta), "IsaacBeast") === 15);
  check("...and GTA V too", chooseCall({ name: "IsaacBeast", game: "Grand Theft Auto V", viewers: 30, matchCalls: true, now: 0 }) === gta);
  const unread = chooseCall({ name: "IsaacBeast", game: "Grand Theft Auto VI", viewers: 30, matchCalls: false, now: 0 });
  check("...but where the screen is not read, the viewer call instead", unread === "!call will we hit 39 viewers in the next 30 minutes?", String(unread));
  const longName = chooseCall({ name: "Big Bad Wolf", game: "GTA RP", viewers: 10, matchCalls: true, now: 0 });
  check("...and a name the grammar cannot take falls through to it too", longName === "!call will we hit 13 viewers in the next 30 minutes?", String(longName));

  const early = chooseCall({ name: "Bee_Empire", game: "Crypto", viewers: 24, matchCalls: true, now: at("2026-11-26T11:33:00Z") });
  check("crypto with 27 minutes left in the hour: this hour's candle", early === "!call will BTC close the hour green?", String(early));
  check("...a price call the engine settles itself", parsePriceCall(q(early)) !== null);
  const late = chooseCall({ name: "Bee_Empire", game: "Crypto & Trading", viewers: 24, matchCalls: true, now: at("2026-11-26T11:45:00Z") });
  check("...with 15 left: the next hour's", late === "!call will BTC close the next hour green?", String(late));
  check("...also a price call", parsePriceCall(q(late)) !== null);

  const chat = chooseCall({ name: "Someone", game: "Just Chatting", viewers: 24, matchCalls: true, now: 0 });
  check("anything else: the viewer call, three tenths above the count now", chat === "!call will we hit 32 viewers in the next 30 minutes?", String(chat));
  check("...which the engine reads as a viewer call", parseViewerCall(q(chat)) !== null);
  check("...at least two above a small one", chooseCall({ name: "a", game: "Just Chatting", viewers: 3, matchCalls: true, now: 0 }) === "!call will we hit 5 viewers in the next 30 minutes?");
  check("a casino stream gets one too (Lev, 26 Nov: we are a prediction market)",
    chooseCall({ name: "a", game: "Slots & Casino", viewers: 100, matchCalls: true, now: 0 }) === "!call will we hit 130 viewers in the next 30 minutes?");
  check("no category and no count: nothing",
    chooseCall({ name: "a", game: null, viewers: null, matchCalls: true, now: 0 }) === null
    && chooseCall({ name: "a", game: "Just Chatting", viewers: 0, matchCalls: true, now: 0 }) === null);
}

console.log("\nthe engine reads Lev's line as his");
{
  const kick = chatFromKick({ message_id: "k1", content: "!call will IsaacBeast die in the next 15 minutes?",
    broadcaster: { user_id: 72486, username: "IsaacBeast", channel_slug: "isaacbeast" }, sender: { user_id: 132108626, username: "levvercetti", identity: { badges: [] } } });
  check("on Kick, from his account it runs the call", kick?.canRun === true && kick.text === "!call will IsaacBeast die in the next 15 minutes?", JSON.stringify(kick));
  const tw = chatFromTwitch({ broadcaster_user_id: "1372956063", broadcaster_user_login: "bee_empire", chatter_user_id: "1553273942", chatter_user_login: "levvercetti",
    message_id: "t1", message: { text: "!call will BTC close the hour green?" }, badges: [] });
  check("...and on Twitch", tw?.canRun === true);
}

console.log("\nwhen Lev's account says it");
{
  let now = at("2026-11-27T00:00:00Z");
  const said: Array<{ p: Platform; c: string; text: string }> = [];
  const logs: string[] = [];
  const alerts: Array<{ title: string; text: string; link?: [string, string] }> = [];
  const since: number[] = [];
  const channels = new Map<string, { slug: string; name: string | null; matchCalls?: boolean }>([
    ["kick:72486", { slug: "isaacbeast", name: "IsaacBeast", matchCalls: true }],
    ["twitch:1372956063", { slug: "bee_empire", name: "Bee_Empire" }],
    ["kick:132108626", { slug: "levvercetti", name: "levvercetti" }],
    ["kick:500", { slug: "off", name: "Off" }],
    ["kick:501", { slug: "busy", name: "Busy" }],
    ["kick:502", { slug: "hadone", name: "HadOne" }],
    ["kick:503", { slug: "refuses", name: "Refuses" }],
    ["x:9", { slug: "onx", name: "OnX" }],
    ["youtube:9", { slug: "onyt", name: "OnYT" }],
  ]);
  const streams = new Map<string, { live: boolean; game: string | null; viewers?: number | null }>([
    ["kick:72486", { live: true, game: "Grand Theft Auto VI", viewers: 30 }],
    ["twitch:1372956063", { live: true, game: "Crypto", viewers: 24 }],
    ["kick:132108626", { live: true, game: "Just Chatting", viewers: 2 }],
    ["kick:500", { live: false, game: null, viewers: null }],
    ["kick:501", { live: true, game: "Just Chatting", viewers: 50 }],
    ["kick:502", { live: true, game: "Just Chatting", viewers: 50 }],
    ["kick:503", { live: true, game: "Just Chatting", viewers: 50 }],
    // A call would fit both: only the platform keeps them out.
    ["x:9", { live: true, game: "Just Chatting", viewers: 40 }],
    ["youtube:9", { live: true, game: "Just Chatting", viewers: 40 }],
  ]);
  let refuse = true;
  const deps: AutoCallDeps = {
    channel: async (p, c) => { if (c === "boom") throw new Error("store down"); return channels.get(`${p}:${c}`) ?? null; },
    stream: async (p, c) => streams.get(`${p}:${c}`) ?? null,
    unsettled: async (p, c) => (c === "501" ? [{ id: "open" }] : []),
    openedSince: async (_p, c, s) => { since.push(s); return c === "502" ? 1 : 0; },
    say: async (p, c, text) => { if (c === "503" && refuse) { const e = new Error("403 Forbidden: follow first") as Error & { status?: number }; e.status = 403; throw e; } said.push({ p, c, text }); },
    from: "levvercetti",
    now: () => now,
    log: (l) => logs.push(l),
    alert: (a) => alerts.push(a),
  };
  const auto = autoCaller(deps);
  const t0 = now;
  auto.wentLive({ platform: "kick", channelId: "72486" });
  auto.wentLive({ platform: "twitch", channelId: "1372956063" });
  now = t0 + AUTO_CALL_AFTER_MS - 1;
  check("nothing before ten minutes are up", (await auto.tick()) === 0 && said.length === 0);
  now = t0 + AUTO_CALL_AFTER_MS;
  const n = await auto.tick();
  check("then each stream gets the call that fits it", n === 2
    && said.some((s) => s.p === "kick" && s.c === "72486" && s.text === "!call will IsaacBeast die in the next 15 minutes?")
    && said.some((s) => s.p === "twitch" && s.c === "1372956063" && /^!call will BTC close the (next )?hour green\?$/.test(s.text)), JSON.stringify(said));
  check("...asking for calls opened since a little before the stream was seen live", since.every((s) => s === t0 - AUTO_CALL_OPENED_SLACK_MS), JSON.stringify(since));
  check("...and the log says what was said", logs.filter((l) => l === "auto call said").length === 2);
  now += 60_000;
  check("once per stream: the next pass says nothing", (await auto.tick()) === 0 && said.length === 2);

  said.length = 0; logs.length = 0;
  const t1 = now;
  for (const c of ["132108626", "500", "501", "502"]) auto.wentLive({ platform: "kick", channelId: c });
  auto.wentLive({ platform: "x", channelId: "9" });
  auto.wentLive({ platform: "youtube", channelId: "9" });
  now = t1 + AUTO_CALL_AFTER_MS;
  check("never in Lev's own stream, nor one that ended, nor one with a call open, nor one that had a call, nor on X or YouTube",
    (await auto.tick()) === 0 && said.length === 0, JSON.stringify(said));
  check("...and the log says why", logs.includes("auto call skipped: the stream is not on") && logs.includes("auto call skipped: a call is open")
    && logs.includes("auto call skipped: this stream had a call"), JSON.stringify(logs));

  logs.length = 0;
  const t2 = now;
  auto.wentLive({ platform: "kick", channelId: "503" });
  auto.wentLive({ platform: "kick", channelId: "boom" });
  now = t2 + AUTO_CALL_AFTER_MS;
  await auto.tick();
  check("a chat that refuses his line: logged, and Lev hears what fixes it", logs.includes("auto call refused") && alerts.length === 1
    && alerts[0].title === "levvercetti can't open a call in Refuses's Kick chat" && /follow the channel and accept its chat rules/.test(alerts[0].text)
    && alerts[0].link?.[1] === "https://kick.com/refuses", JSON.stringify(alerts));
  check("...and a store that fails is logged, never thrown", logs.includes("auto call failed"));
  auto.wentLive({ platform: "kick", channelId: "503" });
  now += AUTO_CALL_AFTER_MS;
  await auto.tick();
  check("...the same chat again within six hours: no second mail", alerts.length === 1);
  now += 6 * 60 * 60_000;
  auto.wentLive({ platform: "kick", channelId: "503" });
  now += AUTO_CALL_AFTER_MS;
  await auto.tick();
  check("...after them, one more", alerts.length === 2);
  refuse = false;
  auto.wentLive({ platform: "kick", channelId: "503" });
  now += AUTO_CALL_AFTER_MS;
  check("...and once it takes his line, the call goes", (await auto.tick()) === 1 && said.at(-1)?.text === "!call will we hit 65 viewers in the next 30 minutes?");
}

console.log("\nhis line goes out on his own token");
{
  _resetLiveStore(); _resetLive();
  await saveChannel({ platform: "kick", channelId: "132108626", slug: "levvercetti", name: "levvercetti", avatar: null,
    accessToken: "lev-kick", refreshToken: null, tokenExpiresAt: null, active: true });
  const kickSent: Array<{ token: string; channel: string; text: string }> = [];
  let kick401 = 1;
  const kickChat: KickChat = {
    bot: async () => { throw new Error("never the bot"); },
    user: async (token, channel, text) => {
      if (kick401-- > 0) { const e = new Error("401") as Error & { status?: number }; e.status = 401; throw e; }
      kickSent.push({ token, channel, text });
    },
  };
  await kickSayAsOperator("levvercetti", "72486", "!call will IsaacBeast die in the next 15 minutes?", kickChat);
  check("Kick: as his account, into that chat, once more after a 401",
    kickSent.length === 1 && kickSent[0].token === "lev-kick" && kickSent[0].channel === "72486", JSON.stringify(kickSent));
  let threw = "";
  try { await kickSayAsOperator("nobody", "72486", "!call x", kickChat); } catch (e) { threw = (e as Error).message; }
  check("...an account that is not connected throws, so the caller hears it", threw === "nobody is not connected on Kick", threw);
}

console.log("\non Twitch it comes back through the feed as his, and opens the call");
{
  _resetLiveStore(); _resetLive(); _resetTwitchVoice();
  const SECRET = "test-secret-0123456789";
  const sign = (id: string, ts: string, body: string) => "sha256=" + createHmac("sha256", SECRET).update(id + ts + body).digest("hex");
  for (const [id, slug, tok] of [["1001", "streamer", "tok"], ["9009", "oddiefun", "v-tok"], ["1553273942", "levvercetti", "lev-tok"]]) {
    await saveChannel({ platform: "twitch", channelId: id, slug, name: slug === "streamer" ? "Streamer" : slug, avatar: null,
      accessToken: tok, refreshToken: null, tokenExpiresAt: null, active: true });
  }
  const levSent: Array<{ token: string; broadcaster: string; sender: string; text: string }> = [];
  await twitchSayAsOperator("levvercetti", "1001", "!call will I win?", {
    send: async (token, broadcaster, sender, text) => { levSent.push({ token, broadcaster, sender, text }); return "lev-line-1"; },
  });
  check("as his account, on his own token, into that chat", levSent.length === 1 && levSent[0].token === "lev-tok"
    && levSent[0].broadcaster === "1001" && levSent[0].sender === "1553273942", JSON.stringify(levSent));
  const did: unknown[] = [];
  const voiceSaid: string[] = [];
  const app = express();
  app.use(twitchRouter({
    appBaseUrl: "https://app.oddie.fun", pageHtml: () => "<p>page</p>", pageOpen: () => true, pageClosed: (res) => { res.status(404).end(); },
    log: (l, extra) => { if (l === "twitch chat command") did.push(extra?.action); },
    secret: () => SECRET, chat: { send: async (_t, _b, _s, text) => { voiceSaid.push(text); return null; } }, voice: "oddiefun",
  }));
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const b = JSON.stringify({ subscription: { type: "channel.chat.message" }, event: {
    broadcaster_user_id: "1001", broadcaster_user_login: "streamer", chatter_user_id: "1553273942", chatter_user_login: "levvercetti",
    message_id: "lev-line-1", message: { text: "!call will I win?" }, badges: [] } });
  const ts = new Date().toISOString();
  await fetch(`http://127.0.0.1:${port}/live/twitch/webhook`, { method: "POST", body: b, headers: { "content-type": "application/json",
    "Twitch-Eventsub-Message-Id": "e-1", "Twitch-Eventsub-Message-Timestamp": ts, "Twitch-Eventsub-Message-Signature": sign("e-1", ts, b), "Twitch-Eventsub-Message-Type": "notification" } });
  await new Promise((r) => setTimeout(r, 120));
  server.close();
  check("...his line is read as his, not oddie's: the call opens and oddie says so", did[0] === "opened" && voiceSaid.some((t) => /will I win\?/.test(t)),
    JSON.stringify({ did, voiceSaid }));
}

console.log("\nwired at boot");
{
  const server = readFileSync("src/server.ts", "utf8");
  check("the server says the line as levvercetti unless AUTO_CALL_FROM says otherwise, and AUTO_CALLS=off stops it",
    /process\.env\.AUTO_CALL_FROM \?\? "levvercetti"/.test(server) && /process\.env\.AUTO_CALLS \?\? "on"\)\.trim\(\)\.toLowerCase\(\) !== "off"/.test(server));
  check("...on Kick and Twitch through his own account",
    /p === "kick" \? kickSayAsOperator\(autoCallFrom, c, text\)/.test(server) && /p === "twitch" \? twitchSayAsOperator\(autoCallFrom, c, text\)/.test(server));
  check("...the went-live pass starts its clock, and a pass every half minute says what is due",
    /report: \(c\) => \{ if \(OPS_MAIL_ON\) reportLive\(c\); autoCalls\?\.wentLive\(c\); \}/.test(server)
    && /autoCalls\.tick\(\)[\s\S]{0,200}\}, 30_000\)/.test(server));
}

if (failures) { console.error(`\n${failures} auto call check(s) failed`); process.exit(1); }
console.log("\nall auto call checks passed.");
