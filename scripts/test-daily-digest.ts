// The morning summary (src/live/dailyDigest.ts): what it keeps between mails,
// the day's calls out of the store, the mail itself, and once a day at 06:00 UTC.
//
// Run with: npm run test-daily-digest

import { readFileSync } from "node:fs";
import { digestEvents, digestMail, digestTimeFor, openerOf, sendDigestIfDue, type DigestEvent } from "../src/live/dailyDigest.js";
import { _resetLive } from "../src/live/calls.js";
import { callsBetween, liveStore, saveChannel, _resetLiveStore, type DigestCall } from "../src/store/live.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};
const HOUR = 60 * 60_000;
const T = Date.UTC(2026, 10, 26, 12, 0, 0); // 15:00 in Istanbul

console.log("what it keeps between mails");
{
  let row: string | null = null;
  let now = T;
  const ev = digestEvents({ get: async () => row, set: async (v) => { row = v; }, now: () => now });
  await ev.record({ kind: "live", platform: "kick", channelId: "100", at: T });
  await ev.record({ kind: "auto-said", platform: "kick", channelId: "100", at: T + 10 * 60_000, text: "!call will we hit 32 viewers in the next 30 minutes?" });
  const got = await ev.between(T, T + HOUR);
  check("each event is kept, and read back by its time", got.length === 2 && got[0].kind === "live" && got[1].kind === "auto-said");
  check("...outside the asked hours, none", (await ev.between(T + HOUR, T + 2 * HOUR)).length === 0);
  now = T + 49 * HOUR;
  await ev.record({ kind: "live", platform: "twitch", channelId: "7", at: now });
  const all = JSON.parse(row ?? "[]") as DigestEvent[];
  check("two days on, the old ones are dropped when the next is kept", all.length === 1 && all[0].platform === "twitch", JSON.stringify(all));
  row = "not json";
  check("a row that does not read is an empty one, never a throw", (await ev.between(0, Infinity)).length === 0);
}

console.log("\nthe day's calls out of the store");
{
  _resetLiveStore(); _resetLive();
  await saveChannel({ platform: "kick", channelId: "100", slug: "nova", name: "Nova", avatar: null, accessToken: null, refreshToken: null, tokenExpiresAt: null, active: true });
  // One call takes answers at a time: each is locked (or ended) before the next opens.
  const open = async (question: string, at: number, by: [string, string]) => {
    const c = await liveStore.open({ platform: "kick", channelId: "100", question,
      openedById: by[0], openedByName: by[1], openedAt: at, closesAt: at + 3 * 60_000, timed: true });
    if (!c) throw new Error(`did not open: ${question}`);
    return c;
  };
  const old = await open("from yesterday", T - 30 * HOUR, ["100", "nova"]);
  await liveStore.lock(old.id, T - 30 * HOUR + 3 * 60_000);
  const a = await open("will we hit 32 viewers in the next 30 minutes?", T + 10 * 60_000 + 20_000, ["132108626", "levvercetti"]);
  await liveStore.pick(a, "u1", "ana", "yes", T + 11 * 60_000);
  await liveStore.pick(a, "u2", "bo", "no", T + 11 * 60_000);
  await liveStore.lock(a.id, T + 13 * 60_000);
  const b = await open("will Nova die in the next 15 minutes?", T + 2 * HOUR, ["100", "nova"]);
  await liveStore.pick(b, "u1", "ana", "yes", T + 2 * HOUR + 60_000);
  await liveStore.lock(b.id, T + 2 * HOUR + 3 * 60_000);
  await liveStore.settle(b.id, "yes", 50, T + 2 * HOUR + 5 * 60_000);
  const c = await open("will BTC close the hour green?", T + 3 * HOUR, ["132108626", "levvercetti"]);
  await liveStore.lock(c.id, T + 3 * HOUR + 3 * 60_000);
  await liveStore.settle(c.id, "no", 1, T + 4 * HOUR);
  const d = await open("will Nova win this match?", T + 4 * HOUR, ["oddie", "oddie"]);
  await liveStore.cancel(d.id, T + 4 * HOUR + 60_000);
  const e = await open("will Nova <b>clutch</b>?", T + 5 * HOUR, ["555", "modguy"]);
  await liveStore.lock(e.id, T + 5 * HOUR + 3 * 60_000);
  const calls = [a, b, c, d, e];
  const got = await callsBetween(T, T + 24 * HOUR);
  check("every call opened in the hours, in order, none from before", got.length === 5 && got.map((x) => x.id).join() === calls.map((x) => x.id).join(),
    JSON.stringify(got.map((x) => x.question)));
  check("...each with its channel, opener, answers and end",
    got[0].slug === "nova" && got[0].name === "Nova" && got[0].openedByName === "levvercetti" && got[0].yes === 1 && got[0].no === 1 && got[0].outcome === null
    && got[1].outcome === "yes" && got[1].yes === 1 && got[2].outcome === "no" && got[3].canceledAt !== null, JSON.stringify(got[0]));

  console.log("\nthe mail");
  const events: DigestEvent[] = [
    { kind: "live", platform: "kick", channelId: "100", at: T },
    { kind: "auto-said", platform: "kick", channelId: "100", at: T + 10 * 60_000, text: "!call will we hit 32 viewers in the next 30 minutes?" },
    { kind: "auto-refused", platform: "twitch", channelId: "7", at: T + 6 * HOUR, text: "twitch chat dropped: followers_only_mode" },
  ];
  const m = await digestMail({ since: T - 3 * HOUR, until: T + 21 * HOUR, calls: got, events, from: "levvercetti",
    channel: async (p, id) => (p === "twitch" && id === "7" ? { slug: "bee_empire", name: "Bee" } : p === "kick" && id === "100" ? { slug: "nova", name: "Nova" } : null) });
  check("the subject adds it up", m.subject === "Oddie, the last 24 hours: 1 stream went live, 5 calls, 3 answers", m.subject);
  check("...the hours it covers, in Istanbul time", m.html.includes("26 Nov 12:00 to 27 Nov 12:00, Istanbul time"), m.html.slice(0, 300));
  check("who went live, when, where", m.html.includes("Went live") && m.html.includes("15:00 · <b>Nova</b> (Kick)"));
  check("each call: who opened it, its answers, how it ended",
    m.html.includes('"will we hit 32 viewers in the next 30 minutes?" · opened by your account, by itself · 1 yes, 1 no · <b>no result yet</b>')
    && m.html.includes('"will Nova die in the next 15 minutes?" · opened by the streamer · 1 yes, 0 no · <b>YES</b>')
    && m.html.includes('"will BTC close the hour green?" · opened by you · 0 yes, 0 no · <b>NO</b>')
    && m.html.includes('"will Nova win this match?" · opened by oddie (match) · 0 yes, 0 no · <b>cancelled</b>')
    && m.html.includes("opened by a mod (modguy)"), m.html);
  check("...a question is text, never markup", m.html.includes("will Nova &lt;b&gt;clutch&lt;/b&gt;?") && !m.html.includes("<b>clutch</b>"));
  check("the chats that refused Lev's line, with why", m.html.includes("Chats that refused your line")
    && m.html.includes("21:00 · <b>Bee</b> (Twitch): twitch chat dropped: followers_only_mode"));
  const quiet = await digestMail({ since: T, until: T + 24 * HOUR, calls: [], events: [], from: "levvercetti", channel: async () => null });
  check("a quiet day says so", quiet.subject === "Oddie, the last 24 hours: 0 streams went live, 0 calls, 0 answers"
    && quiet.html.includes("Quiet: no connected stream went live and no call was opened.") && !quiet.html.includes("Went live"));
  const c0 = got[0] as DigestCall;
  check("Lev's call far from any line of his own is his, not the account's by itself",
    openerOf({ ...c0, openedAt: T + 3 * HOUR }, events.filter((x) => x.kind === "auto-said"), "levvercetti") === "you");
}

console.log("\nonce a day, at 06:00 UTC");
{
  let now = Date.UTC(2026, 10, 27, 5, 59, 0);
  let day: string | null = "2026-11-26";
  const sent: Array<{ to: string; subject: string }> = [];
  const built: Array<[number, number]> = [];
  let failSend = false;
  const deps = {
    now: () => now,
    lastDay: async () => day,
    setLastDay: async (d: string) => { day = d; },
    build: async (since: number, until: number) => { built.push([since, until]); return { subject: "s", html: "h" }; },
    send: async (m: { to: string; subject: string; html: string }) => { if (failSend) throw new Error("mail down"); sent.push(m); return "sent" as const; },
    to: "ops@example.com",
    log: () => {},
  };
  check("06:00 UTC is 09:00 in Istanbul", digestTimeFor(now) === Date.UTC(2026, 10, 27, 6));
  check("before it, nothing", (await sendDigestIfDue(deps)) === false && sent.length === 0);
  now = Date.UTC(2026, 10, 27, 6, 0, 0);
  check("at it, the 24 hours before it, once", (await sendDigestIfDue(deps)) === true && sent.length === 1 && sent[0].to === "ops@example.com"
    && built[0][0] === Date.UTC(2026, 10, 26, 6) && built[0][1] === Date.UTC(2026, 10, 27, 6) && day === "2026-11-27");
  now += 30 * 60_000;
  check("...and not again that day", (await sendDigestIfDue(deps)) === false && sent.length === 1);
  now = Date.UTC(2026, 10, 28, 9, 30, 0);
  check("a server down at 06:00 sends it when it is back, the same hours", (await sendDigestIfDue(deps)) === true && sent.length === 2
    && built[1][0] === Date.UTC(2026, 10, 27, 6) && built[1][1] === Date.UTC(2026, 10, 28, 6));
  now = Date.UTC(2026, 10, 29, 6, 0, 0);
  failSend = true;
  let threw = false;
  try { await sendDigestIfDue(deps); } catch { threw = true; }
  failSend = false;
  check("the day is kept before the mail goes: a failed send is never sent twice", threw && day === "2026-11-29" && (await sendDigestIfDue(deps)) === false);
}

console.log("\nwired at boot");
{
  const server = readFileSync("src/server.ts", "utf8");
  check("what the store cannot say is kept in one bot_state row",
    /digestEvents\(\{\s*get: \(\) => botStateGet\("ops_digest_events"\),\s*set: \(v\) => botStateSet\("ops_digest_events", v\)/.test(server));
  check("...a stream going live, and Lev's line said or refused",
    /autoCalls\?\.wentLive\(c\);\s*void digest\.record\(\{ kind: "live"/.test(server)
    && /void digest\.record\(\{ kind: "auto-refused"/.test(server) && /void digest\.record\(\{ kind: "auto-said"/.test(server));
  check("the summary goes to the operator's address, looked for every minute, built from the store and those rows",
    /if \(OPS_MAIL_ON\) \{\s*let summing = false;[\s\S]{0,200}sendDigestIfDue\(\{[\s\S]{0,400}calls: await callsBetween\(since, until\), events: await digest\.between\(since, until\)[\s\S]{0,300}to: OPS_MAIL_TO,[\s\S]{0,200}\}, 60_000\);/.test(server));
}

if (failures) { console.error(`\n${failures} morning summary check(s) failed`); process.exit(1); }
console.log("\nall morning summary checks passed.");
