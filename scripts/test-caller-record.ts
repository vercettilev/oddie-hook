// What a caller sees of themselves (Lev, 16 Oct): a run of right calls next to
// the name in the result line, !me in any chat, this week's boards (they turn
// over Monday 00:00 UTC), and the week's first call naming last week's best.
//
// Run with: npm run test-caller-record

import {
  parseCommand, handleChat, weekStart, LIVE_COPY, ME_GAP_MS, WEEK_MS, _resetLive, type ChatMessage, type LiveDeps,
} from "../src/live/calls.js";
import { liveStore, channelStandings, allStandings, callerRecord, streaksFor, _resetLiveStore } from "../src/store/live.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

// Thursday 15 Oct 2026, noon UTC: the week began Monday 12 Oct.
const THU = Date.UTC(2026, 9, 15, 12, 0, 0);
const MON = Date.UTC(2026, 9, 12);

console.log("the week");
{
  check("a Thursday's week began on its Monday, 00:00 UTC", weekStart(THU) === MON);
  check("Monday 00:00 is the week's own first moment", weekStart(MON) === MON);
  check("Sunday 23:59 still belongs to the week before", weekStart(MON - 60_000) === MON - WEEK_MS);
  check("!me is a command, anywhere in the case", parseCommand("!me")?.kind === "me" && parseCommand("!ME please")?.kind === "me"
    && parseCommand("!meme") === null && parseCommand("me!") === null);
}

function room(platform: "kick" | "x" = "kick", channelId = "100") {
  let clock = THU;
  const said: Array<{ text: string; replyTo?: string }> = [];
  const deps: LiveDeps = {
    store: liveStore,
    now: () => clock,
    say: async (_p, _c, text, replyTo) => { said.push({ text, replyTo }); return `s${said.length}`; },
    standingsUrl: async () => "",
    log: () => {},
  };
  let n = 0;
  const line = (who: string, text: string, canRun = false): ChatMessage => ({
    platform, channelId, messageId: `${channelId}-m${++n}`, senderId: who, senderName: who, canRun, text,
  });
  /** A call opened by the owner, answered as given, settled. */
  const round = async (q: string, answers: Array<[string, "!yes" | "!no"]>, outcome: "yes" | "no") => {
    await handleChat(line("owner", `!call ${q}`, true), deps);
    for (const [who, side] of answers) await handleChat(line(who, side), deps);
    clock += 60_000;
    await handleChat(line("owner", `!call ${outcome}`, true), deps);
    clock += 60_000;
  };
  return {
    deps, said, line, round, tick: (ms: number) => { clock += ms; }, now: () => clock,
    // The last line that is not the stream's best callers, which follow a
    // result from the stream's second on (src/live/calls.ts sayStreamTop).
    last: () => said.filter((x) => !x.text.startsWith("top callers this stream")).at(-1)?.text ?? "",
  };
}

console.log("\na run of right calls");
{
  _resetLiveStore(); _resetLive();
  const r = room();
  await r.round("one?", [["ana", "!yes"], ["bo", "!no"]], "yes");
  await r.round("two?", [["ana", "!yes"], ["bo", "!yes"]], "yes");
  check("two in a row is not a streak yet", r.last() === 'Result: YES on "two?" Called it: @ana @bo.', r.last());
  await r.round("three?", [["bo", "!yes"], ["ana", "!yes"]], "yes");
  check("the third right call in a row lights it, and the streak is named first",
    r.last() === 'Result: YES on "three?" Called it: @ana 🔥3 @bo.', r.last());
  await r.round("four?", [["cy", "!no"], ["dee", "!no"], ["eli", "!no"], ["ana", "!no"]], "no");
  check("past three names, the streak still makes the line and the rest are counted",
    r.last() === 'Result: NO on "four?" Called it: @ana 🔥4 @cy @dee +1.', r.last());
  await r.round("five?", [["ana", "!yes"], ["bo", "!no"]], "no");
  const runs = await streaksFor([{ platform: "kick", userId: "ana" }, { platform: "kick", userId: "bo" }, { platform: "kick", userId: "nobody" }]);
  // bo: wrong, right, right, (no answer), right. A call somebody skipped is not part of their run.
  check("a wrong call ends the run; a call skipped does not", runs.get("kick:ana") === 0 && runs.get("kick:bo") === 3, JSON.stringify([...runs]));
  check("somebody who never answered has no run", (runs.get("kick:nobody") ?? 0) === 0);
  const other = room("kick", "200");
  await other.round("elsewhere?", [["bo", "!yes"]], "yes");
  check("a run follows the person from channel to channel", (await streaksFor([{ platform: "kick", userId: "bo" }])).get("kick:bo") === 4);
  const cancel = room();
  await handleChat(cancel.line("owner", "!call never mind?", true), cancel.deps);
  await handleChat(cancel.line("bo", "!no"), cancel.deps);
  await handleChat(cancel.line("owner", "!call cancel", true), cancel.deps);
  check("a canceled call neither adds to a run nor ends it", (await streaksFor([{ platform: "kick", userId: "bo" }])).get("kick:bo") === 4);
}

console.log("\n!me");
{
  _resetLiveStore(); _resetLive();
  const r = room();
  await r.round("one?", [["ana", "!yes"], ["bo", "!no"]], "yes");
  await r.round("two?", [["ana", "!yes"], ["bo", "!yes"]], "yes");
  await r.round("three?", [["ana", "!yes"], ["bo", "!no"]], "yes");
  const ask = r.line("ana", "!me");
  check("anybody asks, not only the streamer or a mod", (await handleChat(ask, r.deps)) === "me");
  check("...and hears their record, run and place this week, as a reply",
    r.last() === "@ana: 3/3 right · 🔥3 · #1 here this week" && r.said[r.said.length - 1]?.replyTo === ask.messageId, r.last());
  await handleChat(r.line("bo", "!me"), r.deps);
  check("a run under three is left out", r.last() === "@bo: 1/3 right · #2 here this week", r.last());
  const before = r.said.length;
  check("asking again within ten minutes is quiet", (await handleChat(r.line("ana", "!me"), r.deps)) === "me-quiet" && r.said.length === before);
  r.tick(ME_GAP_MS);
  check("...after ten minutes it answers again", (await handleChat(r.line("ana", "!me"), r.deps)) === "me");
  await handleChat(r.line("newcomer", "!me"), r.deps);
  check("somebody with no result yet hears where it starts", r.last() === "@newcomer: your record starts with the next result. !yes or !no on the next call", r.last());
  check("no line of !me reads as a command", parseCommand(LIVE_COPY.me("a", { right: 1, calls: 2, streak: 3, weekRank: 1 })) === null
    && parseCommand(LIVE_COPY.me("a", { right: 0, calls: 0, streak: 0, weekRank: null })) === null
    && parseCommand(LIVE_COPY.lastWeekTop("a", 3, 4)) === null);
  await handleChat(r.line("levvercetti", "!yes"), r.deps);
  const house = await callerRecord("kick", "levvercetti", "100", r.now());
  check("the house's own record has no place on the board", house.weekRank === null);
  const noStore = { ...r.deps, store: { ...liveStore, record: undefined } } as LiveDeps;
  check("a store without records leaves !me as chat", (await handleChat(r.line("cy", "!me"), noStore)) === "chat");
}

console.log("\nthis week's boards");
{
  _resetLiveStore(); _resetLive();
  const r = room();
  await r.round("old one?", [["old", "!yes"], ["ana", "!no"]], "yes");
  r.tick(WEEK_MS);   // into next week
  await r.round("new one?", [["ana", "!yes"], ["levvercetti", "!yes"]], "yes");
  const now = r.now();
  const week = await channelStandings("kick", "100", 20, { since: weekStart(now) });
  const all = await channelStandings("kick", "100", 20);
  check("this week counts only what settled since Monday", week.length === 1 && week[0].userId === "ana" && week[0].right === 1, JSON.stringify(week));
  check("all time counts everything", all.length === 2 && all.some((x) => x.userId === "old"), JSON.stringify(all));
  check("the house never ranks, here or on the big board",
    all.every((x) => x.userId !== "levvercetti") && (await allStandings(50)).every((x) => x.username !== "levvercetti"));
  const big = await allStandings(50, { since: weekStart(now) });
  check("the big board has its week too", big.length === 1 && big[0].username === "ana", JSON.stringify(big));
  const last = await allStandings(50, { since: weekStart(now) - WEEK_MS, until: weekStart(now) });
  check("...and a closed window is last week's", last.length === 2 && last[0].username === "old", JSON.stringify(last));
}

console.log("\nthe week's first call names last week's best");
{
  _resetLiveStore(); _resetLive();
  const r = room();
  await r.round("last week a?", [["ana", "!yes"], ["bo", "!no"]], "yes");
  await r.round("last week b?", [["ana", "!yes"], ["bo", "!yes"]], "yes");
  r.tick(WEEK_MS);
  const before = r.said.length;
  await handleChat(r.line("owner", "!call first of the week?", true), r.deps);
  const lines = r.said.slice(before).map((x) => x.text);
  check("the call's own line first, then last week's best", lines.length === 2 && lines[0].startsWith('call: "first of the week?"')
    && lines[1] === "last week's top caller here: @ana, 2/2 right", JSON.stringify(lines));
  await handleChat(r.line("owner", "!call cancel", true), r.deps);
  const again = r.said.length;
  await handleChat(r.line("owner", "!call second of the week?", true), r.deps);
  check("only the week's first call says it", r.said.length === again + 1, JSON.stringify(r.said.slice(again)));
  _resetLiveStore(); _resetLive();
  const quiet = room();
  quiet.tick(WEEK_MS);
  await handleChat(quiet.line("owner", "!call nobody last week?", true), quiet.deps);
  check("a channel with no right call last week hears only its call", quiet.said.length === 1, JSON.stringify(quiet.said));
}

console.log("\nX live chat: the same record");
{
  _resetLiveStore(); _resetLive();
  const r = room("x", "2000000000000000002");
  await r.round("x one?", [["1111", "!yes"]], "yes");
  const rec = await callerRecord("x", "1111", null, r.now());
  check("an X account's votes are its record, with no channel asked", rec.right === 1 && rec.calls === 1 && rec.weekRank === null, JSON.stringify(rec));
}

console.log(failures ? `\n${failures} FAILED` : "\nall caller record checks passed.");
process.exit(failures ? 1 : 0);
