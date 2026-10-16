/**
 * Match calls on FACEIT: !faceit links a channel, the clock opens a call when
 * the streamer's match starts, settles it from the result, and nothing of it
 * reaches a channel that is not streaming. In memory, no network.
 */
if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database: unset DATABASE_URL");
  process.exit(1);
}
process.env.LIVE_TOKEN_KEY = "test-key-for-sealing";
import assert from "node:assert/strict";
import { handleChat, lockDue, parseCommand, LIVE_COPY, STREAM_POLL_MS, _resetLive, _forgetWaits, type ChatMessage, type LiveDeps } from "../src/live/calls.js";
import { GAME_COPY, GAME_POLL_MS, matchQuestion, watchGames, _resetGames } from "../src/live/gameCalls.js";
import { faceitSource, mapName, parseMatch, scoreText, sideFor, type GameMatch, type GameSource } from "../src/games/faceit.js";
import { liveStore, saveChannel, channelStandings, _resetLiveStore } from "../src/store/live.js";
import { _setPace } from "../src/live/pace.js";

_setPace({ gapMs: 0, retryMs: [0, 0] });
let checks = 0;
const ok = (cond: unknown, what: string) => { assert.ok(cond, what); checks++; };
const eq = <T>(a: T, b: T, what: string) => { assert.deepEqual(a, b, what); checks++; };

/* ------------------------------------------------------------ parsing -- */
{
  eq(parseCommand("!faceit s1mple"), { kind: "faceit", arg: "s1mple" }, "!faceit <nick> links");
  eq(parseCommand("!faceit @s1mple "), { kind: "faceit", arg: "s1mple" }, "a leading @ is dropped");
  eq(parseCommand("!faceit"), { kind: "faceit", arg: "" }, "bare !faceit asks how");
  eq(parseCommand("!faceit off"), { kind: "faceit", arg: "off" }, "!faceit off unlinks");
  eq(parseCommand("!faceitx"), null, "a longer word is not the command");
  eq(mapName("de_mirage"), "Mirage", "map names lose their prefix");
  eq(mapName("de_ancient"), "Ancient", "and are capitalised");
  eq(mapName(null), null, "no map, no name");
}

const rawMatch = (over: Record<string, unknown> = {}) => ({
  match_id: "m1", status: "ONGOING", started_at: 1_700_000_000,
  teams: { faction1: { name: "Team A", roster: [{ player_id: "p-s1", nickname: "s1mple" }, { player_id: "p-2" }] }, faction2: { name: "Team B", roster: [{ player_id: "p-3" }] } },
  voting: { map: { pick: ["de_mirage"] } },
  ...over,
});
{
  const m = parseMatch(rawMatch())!;
  eq(m.status, "live", "ONGOING is live");
  eq(m.map, "Mirage", "the picked map is read");
  eq(m.factions, { faction1: ["p-s1", "p-2"], faction2: ["p-3"] }, "rosters become player ids");
  eq(m.startedAt, 1_700_000_000_000, "FACEIT seconds become milliseconds");
  const h = parseMatch({ match_id: "h1", status: "finished", teams: { faction1: { players: [{ player_id: "a" }] }, faction2: { players: [{ player_id: "b" }] } },
    results: { winner: "faction2", score: { faction1: 9, faction2: 13 } } })!;
  eq(h.status, "finished", "finished, whatever the case");
  eq(h.factions, { faction1: ["a"], faction2: ["b"] }, "history items list players, not rosters");
  eq(sideFor(h, "a"), { side: "no", mine: "faction1" }, "the loser's side is NO");
  eq(sideFor(h, "b"), { side: "yes", mine: "faction2" }, "the winner's side is YES");
  eq(sideFor(h, "nobody"), null, "a player on neither roster has no side");
  eq(scoreText(h, "faction1"), "9-13", "the score is said from the streamer's side");
  eq(parseMatch(rawMatch({ status: "CANCELLED" }))!.status, "cancelled", "CANCELLED is cancelled");
  eq(parseMatch(rawMatch({ status: "ABORTED" }))!.status, "cancelled", "ABORTED too");
  eq(parseMatch(rawMatch({ status: "READY" }))!.status, "live", "READY is a match about to start");
  eq(parseMatch({}), null, "no id, no match");
}

/* ------------------------------------------------------ the live client -- */
{
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url); calls.push(u);
    ok(/Bearer test-key/.test(String((init?.headers as Record<string, string>)?.Authorization)), "the key goes as a bearer");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (/\/players\?nickname=s1mple$/.test(u)) return json({ player_id: "p-s1", nickname: "s1mple" });
    if (/\/players\?nickname=rain$/.test(u)) return json({ player_id: "p-rain", nickname: "rain", games: { cs2: { game_player_id: "7656" } } });
    if (/\/players\?nickname=/.test(u)) return json({ errors: [{ message: "not found" }] }, 404);
    if (/\/players\/p-s1\/matches\?type=ongoing/.test(u)) return json({ items: [{ ...rawMatch(), game: "cs2" }, { ...rawMatch({ match_id: "other", status: "FINISHED" }) }] });
    if (/\/matches\/m1$/.test(u)) return json(rawMatch({ status: "FINISHED", results: { winner: "faction1", score: { faction1: 13, faction2: 9 } } }));
    return json({}, 500);
  }) as typeof fetch;
  const src = faceitSource("test-key", fetchImpl);
  eq(await src.player("s1mple"), { id: "p-s1", nick: "s1mple", playsCs2: false }, "a nickname resolves to a player (no games listed: no CS2)");
  eq(await src.player("nobody"), null, "404 is nobody");
  eq((await src.player("rain"))?.playsCs2, true, "CS2 under their games means they play it");
  eq((await src.ongoing("p-s1"))?.id, "m1", "the ongoing match is the live one");
  const m = (await src.match("m1"))!;
  eq([m.status, m.winner, scoreText(m, "faction1")], ["finished", "faction1", "13-9"], "a match is read with its result");
  await assert.rejects(src.match("boom"), /faceit 500/, "any other failure is an error, never a result");
  ok(calls.some((c) => c.includes("/players/p-s1/matches?type=ongoing")), "ongoing comes from the official matches filter");
}

/* ------------------------------------------------------------- engine -- */
const said: string[] = [];
const logs: string[] = [];
let now = 1_800_000_000_000;
let live: boolean | null = true;
let ongoing: GameMatch | null = null;
const matches = new Map<string, GameMatch>();
let playerCalls = 0;
const games: GameSource = {
  player: async (nick) => { playerCalls++; return nick.toLowerCase() === "s1mple" ? { id: "p-s1", nick: "s1mple", playsCs2: true }
    : nick.toLowerCase() === "chessguy" ? { id: "p-chess", nick: "chessguy", playsCs2: false } : null; },
  ongoing: async () => ongoing,
  match: async (id) => matches.get(id) ?? null,
};
const deps: LiveDeps = {
  store: liveStore,
  now: () => now,
  say: async (_p, _c, t) => { said.push(t); return `m${said.length}`; },
  standingsUrl: async () => "https://app.oddie.fun/live/twitch/chan",
  log: (line) => { logs.push(line); },
  streamLive: async () => live,
  games,
};
const msg = (text: string, over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ platform: "twitch", channelId: "c1", messageId: "x", senderId: "mod1", senderName: "mod", canRun: true, text, ...over });
const last = () => said[said.length - 1] ?? "";
const tick = async () => { now += GAME_POLL_MS; return watchGames(deps); };
const reset = () => { _resetLive(); _forgetWaits(); _resetGames(); _resetLiveStore(); said.length = 0; logs.length = 0; ongoing = null; matches.clear(); live = true; };

/* found by name, not typed */
{
  reset();
  await saveChannel({ platform: "twitch", channelId: "c1", slug: "s1mple", name: "S1mple", avatar: null, accessToken: null, refreshToken: null, tokenExpiresAt: null, active: true });
  await saveChannel({ platform: "twitch", channelId: "c2", slug: "chessguy", name: "Chess Guy", avatar: null, accessToken: null, refreshToken: null, tokenExpiresAt: null, active: true });
  await saveChannel({ platform: "twitch", channelId: "c3", slug: "nobody", name: null, avatar: null, accessToken: null, refreshToken: null, tokenExpiresAt: null, active: true });
  await saveChannel({ platform: "twitch", channelId: "c4", slug: "s1mple2", name: null, avatar: null, accessToken: null, refreshToken: null, tokenExpiresAt: null, active: false });
  eq((await liveStore.withoutFaceit(now)).map((c) => c.slug).sort(), ["chessguy", "nobody", "s1mple"], "every active channel with no account is looked up");
  playerCalls = 0;
  eq(await tick(), 0, "the first pass links and opens nothing yet");
  eq(playerCalls, 3, "...one lookup per channel");
  eq(await liveStore.faceit("twitch", "c1"), { id: "p-s1", nick: "s1mple" }, "the streamer with the same name on FACEIT and CS2 there is linked");
  eq(await liveStore.faceit("twitch", "c2"), null, "a FACEIT account without CS2 is not");
  eq(await liveStore.faceit("twitch", "c3"), null, "a name FACEIT does not know is not");
  eq(said.length, 0, "...and nobody in chat heard a thing");
  eq(await tick(), 0, "the next pass");
  eq(playerCalls, 3, "...does not look the same names up again today");
  eq(await handleChat(msg("!faceit off"), deps), "faceit-unlinked", "!faceit off unlinks");
  eq((await liveStore.withoutFaceit(now + 48 * 3_600_000)).map((c) => c.slug).sort(), ["chessguy", "nobody"], "...and stops oddie looking for that channel, even days later");
  eq(await handleChat(msg("!faceit s1mple"), deps), "faceit-linked", "a typed name links again");
  ongoing = parseMatch(rawMatch());
  eq(await tick(), 1, "the match opens a call");
  ok(/^S1mple is in a match on Mirage\. Does S1mple win it\?/.test(last()), "the room hears the streamer's own name, never FACEIT: " + last());
  ok(!/faceit/i.test(last()), "...not the source");
  eq((await liveStore.current("twitch", "c1"))?.question, "S1mple wins this match on Mirage?", "the question carries the stream name too");
}

/* linking */
{
  reset();
  eq(await handleChat(msg("!faceit s1mple", { canRun: false, senderId: "v1" }), deps), "not-allowed", "a viewer cannot link");
  eq(await handleChat(msg("!faceit"), deps), "faceit-how", "bare !faceit says how");
  eq(last(), LIVE_COPY.faceitHow, "...in one line");
  eq(await handleChat(msg("!faceit nobody"), deps), "faceit-not-found", "an unknown nickname is said back");
  eq(await handleChat(msg("!faceit s1mple"), deps), "faceit-linked", "a mod links the channel");
  eq(await liveStore.faceit("twitch", "c1"), { id: "p-s1", nick: "s1mple" }, "...and the store has it");
  eq(last(), LIVE_COPY.faceitLinked("s1mple"), "...and chat hears it");
  eq(await handleChat(msg("!faceit"), deps), "faceit-how", "bare !faceit then shows the link");
  eq(last(), LIVE_COPY.faceitStatus("s1mple"), "...with the nickname");
  eq((await liveStore.withFaceit()).map((c) => c.faceitNick), ["s1mple"], "the game pass sees the channel");
  eq(await handleChat(msg("!faceit off"), deps), "faceit-unlinked", "!faceit off unlinks");
  eq(await liveStore.faceit("twitch", "c1"), null, "...and the link is gone");
  eq(await handleChat(msg("!faceit s1mple"), deps), "faceit-linked", "linked again for the rest");
  const quiet: LiveDeps = { ...deps, games: undefined };
  eq(await handleChat(msg("!faceit s1mple"), quiet), "faceit-off", "without a source the command says FACEIT is not set up");
}

/* a match opens a call, once */
{
  said.length = 0;
  ongoing = parseMatch(rawMatch());
  eq(await tick(), 1, "a live match opens a call");
  const open = await liveStore.current("twitch", "c1");
  ok(open && open.matchId === "m1" && open.question === matchQuestion("s1mple", "Mirage") && !open.timed, "the call carries the match id and the map");
  eq(last(), GAME_COPY.opened("s1mple", "Mirage", "https://app.oddie.fun/live/twitch/chan"), "chat hears the match line");
  eq(await tick(), 0, "the same match does not open a second call");
  eq((await liveStore.unsettled("twitch", "c1")).length, 1, "...one call");
  eq(await watchGames(deps), 0, "and the pass does nothing between its minutes");
}

/* answers, then the result from FACEIT */
{
  eq(await handleChat(msg("!yes", { senderId: "u1", senderName: "alice", canRun: false }), deps), "picked", "a viewer answers");
  eq(await handleChat(msg("!no", { senderId: "u2", senderName: "bob", canRun: false }), deps), "picked", "another answers the other way");
  matches.set("m1", parseMatch(rawMatch({ status: "FINISHED", finished_at: 1_700_003_000, results: { winner: "faction1", score: { faction1: 13, faction2: 9 } } }))!);
  ongoing = null;
  said.length = 0;
  eq(await tick(), 1, "the finished match settles the call");
  ok(last().startsWith(GAME_COPY.result("s1mple", true, "13-9", "Mirage")), "chat hears the score first: " + last());
  ok(/YES: "/.test(last()), "...and the outcome");
  eq((await liveStore.unsettled("twitch", "c1")).length, 0, "nothing left waiting");
  const rows = await channelStandings("twitch", "c1");
  ok(rows.some((r) => r.username === "alice" && r.points > 0) && !rows.some((r) => r.username === "bob" && r.points > 0), "alice scored, bob did not");
  ongoing = parseMatch(rawMatch());
  eq(await tick(), 0, "FACEIT still listing the finished match as ongoing for a minute cannot reopen it");
}

/* no stream, no call; a running room call is not interrupted */
{
  ongoing = parseMatch(rawMatch({ match_id: "m2" }));
  live = false;
  eq(await tick(), 0, "an offline channel gets no match call");
  live = true;
  eq(await handleChat(msg("!call will I clutch this?"), deps), "opened", "a mod opens a room call");
  eq(await tick(), 0, "the match waits while the room's call takes answers");
  ok(logs.some((l) => /waits, the room has a call open/.test(l)), "...and the log says why");
  eq(await handleChat(msg("!call yes"), deps), "settled", "the mod settles it");
  eq(await tick(), 1, "then the match call opens");
  eq((await liveStore.current("twitch", "c1"))?.matchId, "m2", "...for the new match");
}

/* a cancelled match cancels its call */
{
  matches.set("m2", parseMatch(rawMatch({ match_id: "m2", status: "CANCELLED" }))!);
  ongoing = null;
  said.length = 0;
  eq(await tick(), 1, "a cancelled match is handled");
  eq(last(), GAME_COPY.cancelled(matchQuestion("s1mple", "Mirage")), "chat hears the cancel, no points");
  eq((await liveStore.unsettled("twitch", "c1")).length, 0, "the call is gone");
}

/* a result FACEIT cannot name goes to the mods */
{
  ongoing = parseMatch(rawMatch({ match_id: "m3" }));
  eq(await tick(), 1, "m3 opens");
  matches.set("m3", parseMatch(rawMatch({ match_id: "m3", status: "FINISHED" }))!); // no results block
  ongoing = null;
  said.length = 0;
  eq(await tick(), 0, "no winner named: nothing settles");
  eq(last(), GAME_COPY.unreadable(matchQuestion("s1mple", "Mirage")), "...the mods are asked, once");
  said.length = 0;
  eq(await tick(), 0, "the next minute does not ask again");
  eq(said.length, 0, "...silently");
  eq(await handleChat(msg("!call no"), deps), "settled", "a mod settles it by hand");
}

/* the stream ending does not cancel a match call: FACEIT settles it */
{
  ongoing = parseMatch(rawMatch({ match_id: "m4" }));
  eq(await tick(), 1, "m4 opens");
  live = true;
  now += STREAM_POLL_MS; await lockDue(deps); // seen live
  live = false;
  now += STREAM_POLL_MS; await lockDue(deps); // went dark
  eq((await liveStore.unsettled("twitch", "c1")).map((c) => c.matchId), ["m4"], "the match call survives the stream ending");
  matches.set("m4", parseMatch(rawMatch({ match_id: "m4", status: "FINISHED", results: { winner: "faction2", score: { faction1: 7, faction2: 13 } } }))!);
  ongoing = null;
  said.length = 0;
  live = true;
  eq(await tick(), 1, "and settles when FACEIT says so");
  ok(last().startsWith(GAME_COPY.result("s1mple", false, "7-13", "Mirage")), "a loss is said as a loss: " + last());
  ok(/NO: "/.test(last()), "...and NO");
}

/* no source configured: the pass is a no-op */
{
  const quiet: LiveDeps = { ...deps, games: undefined };
  _resetGames();
  ongoing = parseMatch(rawMatch({ match_id: "m5" }));
  eq(await watchGames(quiet), 0, "without a FACEIT source the pass does nothing");
}

console.log(`test-game-calls: ${checks} checks passed`);
