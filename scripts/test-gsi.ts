/**
 * Game State Integration: a CS2 or Dota 2 POST becomes a snapshot, a live
 * match opens the channel's call, "over" settles it from the score, and the
 * FACEIT pass steps aside while the game is talking. In memory, no network.
 */
if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database: unset DATABASE_URL");
  process.exit(1);
}
process.env.LIVE_TOKEN_KEY = "test-key-for-sealing";
import assert from "node:assert/strict";
import { bodyToken, gsiConfig, readSnapshot } from "../src/games/gsi.js";
import { handleGsi, _resetGsi } from "../src/live/gsiCalls.js";
import { GAME_COPY, GAME_POLL_MS, GSI_STALE_MS, matchQuestion, watchGames, _resetGames } from "../src/live/gameCalls.js";
import { handleChat, _resetLive, _forgetWaits, type ChatMessage, type LiveDeps } from "../src/live/calls.js";
import { parseMatch, type GameSource } from "../src/games/faceit.js";
import { liveStore, saveChannel, channelStandings, _resetLiveStore } from "../src/store/live.js";
import { _setPace } from "../src/live/pace.js";

_setPace({ gapMs: 0, retryMs: [0, 0] });
let checks = 0;
const ok = (cond: unknown, what: string) => { assert.ok(cond, what); checks++; };
const eq = <T>(a: T, b: T, what: string) => { assert.deepEqual(a, b, what); checks++; };

/* ------------------------------------------------------------ snapshots -- */
const cs2 = (over: Record<string, unknown> = {}, player: Record<string, unknown> = {}) => ({
  provider: { name: "Counter-Strike: Global Offensive", appid: 730, steamid: "7656119", timestamp: 1_700_000_000 },
  map: { mode: "competitive", name: "de_mirage", phase: "live", round: 3, team_ct: { score: 2 }, team_t: { score: 1 }, ...over },
  player: { steamid: "7656119", name: "s1mple", team: "CT", activity: "playing", ...player },
  auth: { token: "tok" },
});
const dota = (over: Record<string, unknown> = {}, player: Record<string, unknown> = {}) => ({
  provider: { name: "Dota 2", appid: 570, steamid: "7656119", timestamp: 1_700_000_000 },
  map: { name: "start", matchid: "7001", game_state: "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", radiant_score: 10, dire_score: 4, win_team: "none", ...over },
  player: { steamid: "7656119", name: "dendi", team_name: "radiant", ...player },
  auth: { token: "tok" },
});
{
  const s = readSnapshot(cs2())!;
  eq([s.game, s.map, s.phase, s.round, s.side], ["cs2", "Mirage", "live", 3, "CT"], "a CS2 snapshot is read");
  eq(s.score, { mine: 2, theirs: 1 }, "the score is from the streamer's side");
  eq(s.won, null, "no winner while live");
  const t = readSnapshot(cs2({}, { team: "T" }))!;
  eq(t.score, { mine: 1, theirs: 2 }, "...and flips with the side");
  const w = readSnapshot(cs2({ phase: "gameover", team_ct: { score: 13 }, team_t: { score: 9 } }))!;
  eq([w.phase, w.won], ["over", true], "gameover with the better score is a win");
  const l = readSnapshot(cs2({ phase: "gameover", team_ct: { score: 9 }, team_t: { score: 13 } }))!;
  eq(l.won, false, "...the worse score a loss");
  const d = readSnapshot(cs2({ phase: "gameover", team_ct: { score: 12 }, team_t: { score: 12 } }))!;
  eq(d.won, null, "...and a draw is nobody's");
  eq(readSnapshot(cs2({ phase: "warmup" }))!.phase, "warmup", "warmup is warmup");
  eq(readSnapshot(cs2({ phase: "intermission" }))!.phase, "live", "the half-time break is still the match");
  eq(readSnapshot(cs2({ phase: "gameover" }, { team: undefined }))!.won, null, "no side known, no winner");
  const o = readSnapshot(dota())!;
  eq([o.game, o.matchId, o.phase, o.side], ["dota2", "7001", "live", "radiant"], "a Dota snapshot is read, with the game's match id");
  eq(o.score, { mine: 10, theirs: 4 }, "radiant first for a radiant player");
  const ow = readSnapshot(dota({ game_state: "DOTA_GAMERULES_STATE_POST_GAME", win_team: "radiant" }))!;
  eq([ow.phase, ow.won], ["over", true], "post game names the winner");
  eq(readSnapshot(dota({ game_state: "DOTA_GAMERULES_STATE_POST_GAME", win_team: "dire" }))!.won, false, "...or the loser");
  eq(readSnapshot(dota({ game_state: "DOTA_GAMERULES_STATE_HERO_SELECTION" }))!.phase, "warmup", "hero selection is warmup");
  eq(readSnapshot({ hello: 1 }), null, "not a game");
  eq(bodyToken(cs2()), "tok", "the body carries the token");
  const cfg = gsiConfig("https://app.oddie.fun/api/gsi/abc", "abc");
  ok(/"uri" "https:\/\/app\.oddie\.fun\/api\/gsi\/abc"/.test(cfg) && /"token" "abc"/.test(cfg) && /"map" "1"/.test(cfg), "the config carries the url, the token and the data keys");
}

/* --------------------------------------------------------------- engine -- */
const said: string[] = [];
const logs: string[] = [];
let now = 1_800_000_000_000;
let live: boolean | null = true;
const deps: LiveDeps = {
  store: liveStore,
  now: () => now,
  say: async (_p, _c, t) => { said.push(t); return `m${said.length}`; },
  standingsUrl: async () => "https://app.oddie.fun/live/twitch/chan",
  log: (line) => { logs.push(line); },
  streamLive: async () => live,
};
const msg = (text: string, over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ platform: "twitch", channelId: "c1", messageId: "x", senderId: "mod1", senderName: "mod", canRun: true, text, ...over });
const last = () => said[said.length - 1] ?? "";
const reset = async () => {
  _resetLive(); _forgetWaits(); _resetGames(); _resetGsi(); _resetLiveStore(); said.length = 0; logs.length = 0; live = true;
  await saveChannel({ platform: "twitch", channelId: "c1", slug: "s1mple", name: "S1mple", avatar: null, accessToken: null, refreshToken: null, tokenExpiresAt: null, active: true });
};
const withTok = (b: Record<string, unknown>, token: string) => ({ ...b, auth: { token } });

/* tokens */
let TOK = "";
{
  await reset();
  eq(await liveStore.gsiToken("twitch", "c1", false), null, "no token until asked for");
  TOK = (await liveStore.gsiToken("twitch", "c1", true))!;
  ok(/^[A-Za-z0-9_-]{20,}$/.test(TOK), "a token is made on the first ask");
  eq(await liveStore.gsiToken("twitch", "c1", true), TOK, "...and kept");
  eq((await liveStore.channelByGsiToken(TOK))?.channelId, "c1", "the token names the channel");
  eq(await liveStore.channelByGsiToken("nope"), null, "a stranger's token names nobody");
  eq(await handleGsi("nope", withTok(cs2(), "nope"), deps), "unknown-token", "an unknown token is ignored");
  eq(await handleGsi(TOK, withTok(cs2(), "other"), deps), "bad-token", "a body whose token differs is ignored");
  eq(await handleGsi(TOK, withTok({ hello: 1 }, TOK), deps), "not-a-game", "a body that is not a game is ignored");
}

/* a live match opens a call, once; gameover settles it */
{
  eq(await handleGsi(TOK, withTok(cs2({ phase: "warmup", round: 0 }), TOK), deps), "nothing", "warmup opens nothing");
  eq(await handleGsi(TOK, withTok(cs2({ round: 1 }), TOK), deps), "opened", "the first live snapshot opens the call");
  const open = await liveStore.current("twitch", "c1");
  ok(open && open.matchId?.startsWith("gsi:cs2:") && open.question === matchQuestion("S1mple", "Mirage"), "the call is about this match, under the stream name");
  eq(last(), GAME_COPY.opened("S1mple", "Mirage", "https://app.oddie.fun/live/twitch/chan"), "chat hears the match line");
  eq(await handleGsi(TOK, withTok(cs2({ round: 2 }), TOK), deps), "nothing", "the next round is the same match");
  eq(await handleGsi(TOK, withTok(cs2({ round: 12, phase: "intermission" }), TOK), deps), "nothing", "...and so is the half");
  eq((await liveStore.unsettled("twitch", "c1")).length, 1, "one call");
  ok((await liveStore.markGsiSeen("twitch", "c1", now), (await liveStore.withFaceit()).length === 0), "nothing to walk yet");
  eq(await handleChat(msg("!yes", { senderId: "u1", senderName: "alice", canRun: false }), deps), "picked", "a viewer answers");
  eq(await handleChat(msg("!no", { senderId: "u2", senderName: "bob", canRun: false }), deps), "picked", "another answers the other way");
  said.length = 0;
  eq(await handleGsi(TOK, withTok(cs2({ phase: "gameover", round: 22, team_ct: { score: 13 }, team_t: { score: 9 } }), TOK), deps), "settled", "gameover settles from the score");
  ok(last().startsWith(GAME_COPY.result("S1mple", true, "13-9", "Mirage")) && /It's YES/.test(last()), "chat hears the score and the outcome: " + last());
  eq(await handleGsi(TOK, withTok(cs2({ phase: "gameover", team_ct: { score: 13 }, team_t: { score: 9 } }), TOK), deps), "nothing", "gameover said again does nothing");
  const rows = await channelStandings("twitch", "c1");
  ok(rows.some((r) => r.username === "alice" && r.points > 0) && !rows.some((r) => r.username === "bob" && r.points > 0), "alice scored, bob did not");
}

/* the side swaps at the half: the end decides */
{
  eq(await handleGsi(TOK, withTok(cs2({ name: "de_ancient", round: 1, team_ct: { score: 0 }, team_t: { score: 0 } }, { team: "T" }), TOK), deps), "opened", "a new map is a new match");
  eq((await liveStore.current("twitch", "c1"))?.question, matchQuestion("S1mple", "Ancient"), "...named after its map");
  said.length = 0;
  eq(await handleGsi(TOK, withTok(cs2({ name: "de_ancient", phase: "gameover", round: 24, team_ct: { score: 11 }, team_t: { score: 13 } }, { team: "CT" }), TOK), deps), "settled", "settled from the side they ended on");
  ok(last().startsWith(GAME_COPY.result("S1mple", false, "11-13", "Ancient")) && /It's NO/.test(last()), "a loss is said as a loss: " + last());
}

/* a draw goes to the mods, once */
{
  eq(await handleGsi(TOK, withTok(cs2({ name: "de_inferno", round: 1, team_ct: { score: 0 }, team_t: { score: 0 } }), TOK), deps), "opened", "inferno opens");
  said.length = 0;
  eq(await handleGsi(TOK, withTok(cs2({ name: "de_inferno", phase: "gameover", round: 24, team_ct: { score: 12 }, team_t: { score: 12 } }), TOK), deps), "to-mods", "a draw is the mods'");
  eq(last(), GAME_COPY.unreadable(matchQuestion("S1mple", "Inferno")), "...said once");
  eq(await handleChat(msg("!call no"), deps), "settled", "a mod settles it by hand");
}

/* abandoned: a new match starts while the last one never ended */
{
  eq(await handleGsi(TOK, withTok(cs2({ name: "de_nuke", round: 1, team_ct: { score: 0 }, team_t: { score: 0 } }), TOK), deps), "opened", "nuke opens");
  said.length = 0;
  eq(await handleGsi(TOK, withTok(cs2({ name: "de_dust2", round: 1, team_ct: { score: 0 }, team_t: { score: 0 } }), TOK), deps), "opened", "dust2 opens next");
  ok(said.some((s) => s === GAME_COPY.abandoned(matchQuestion("S1mple", "Nuke"))), "...and the nuke call is canceled, said");
  eq((await liveStore.unsettled("twitch", "c1")).map((c) => c.question), [matchQuestion("S1mple", "Dust2")], "only the new one waits");
  eq(await handleGsi(TOK, withTok(cs2({ name: "de_dust2", phase: "gameover", round: 20, team_ct: { score: 13 }, team_t: { score: 7 } }), TOK), deps), "settled", "and it settles");
}

/* no stream, no call; a room call open, no call */
{
  live = false;
  eq(await handleGsi(TOK, withTok(cs2({ name: "de_mirage", round: 1, team_ct: { score: 0 }, team_t: { score: 0 } }), TOK), deps), "nothing", "a match off stream opens nothing");
  eq(await handleGsi(TOK, withTok(cs2({ name: "de_mirage", phase: "gameover", team_ct: { score: 13 }, team_t: { score: 2 } }), TOK), deps), "nothing", "...and its end settles nothing");
  live = true;
  eq(await handleChat(msg("!call will I clutch this?"), deps), "opened", "a mod opens a room call");
  eq(await handleGsi(TOK, withTok(cs2({ name: "de_vertigo", round: 1, team_ct: { score: 0 }, team_t: { score: 0 } }), TOK), deps), "nothing", "the match waits while the room's call takes answers");
  eq(await handleChat(msg("!call yes"), deps), "settled", "the mod settles it");
}

/* Dota: the game names the match */
{
  await reset();
  TOK = (await liveStore.gsiToken("twitch", "c1", true))!;
  eq(await handleGsi(TOK, withTok(dota({ game_state: "DOTA_GAMERULES_STATE_HERO_SELECTION" }), TOK), deps), "nothing", "hero selection opens nothing");
  eq(await handleGsi(TOK, withTok(dota(), TOK), deps), "opened", "the game going live opens the call");
  eq((await liveStore.current("twitch", "c1"))?.matchId, "gsi:dota2:7001", "...keyed by the game's match id");
  eq(await handleGsi(TOK, withTok(dota({ radiant_score: 20 }), TOK), deps), "nothing", "the same match again is nothing");
  said.length = 0;
  eq(await handleGsi(TOK, withTok(dota({ game_state: "DOTA_GAMERULES_STATE_POST_GAME", win_team: "dire", radiant_score: 20, dire_score: 41 }), TOK), deps), "settled", "post game settles");
  ok(last().startsWith(GAME_COPY.result("S1mple", false, "20-41", null)) && /It's NO/.test(last()), "a Dota loss, scores from the streamer's side: " + last());
  eq(await handleGsi(TOK, withTok(dota({ matchid: "7002" }), TOK), deps), "opened", "a new match id is a new match");
}

/* while the game talks, the FACEIT pass steps aside */
{
  await reset();
  TOK = (await liveStore.gsiToken("twitch", "c1", true))!;
  await liveStore.setFaceit("twitch", "c1", { id: "p-s1", nick: "s1mple" });
  let ongoing = parseMatch({ match_id: "f1", status: "ONGOING", teams: { faction1: { roster: [{ player_id: "p-s1" }] }, faction2: { roster: [{ player_id: "p-2" }] } }, voting: { map: { pick: ["de_mirage"] } } });
  const games: GameSource = { player: async () => null, ongoing: async () => ongoing, match: async () => null };
  const d2: LiveDeps = { ...deps, games };
  eq(await handleGsi(TOK, withTok(cs2({ phase: "warmup" }), TOK), deps), "nothing", "the game is talking");
  now += GAME_POLL_MS;
  eq(await watchGames(d2), 0, "the FACEIT pass leaves a talking channel alone");
  now += GSI_STALE_MS + GAME_POLL_MS;
  eq(await watchGames(d2), 1, "...and takes over once the game has gone quiet");
  void ongoing;
}

console.log(`test-gsi: ${checks} checks passed`);
