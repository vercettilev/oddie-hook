/**
 * GAME STATE INTEGRATION: the game itself tells oddie what is happening.
 *
 * WHY. FACEIT wanted a Steam account with Prime and an identity check before
 * it would hand out a data key (11 Oct); Overwatch wanted fifty matches first.
 * Valve's own games need none of that: Counter-Strike 2 and Dota 2 both ship
 * Game State Integration, the mechanism every stream overlay uses. The
 * streamer drops one small config file in the game's cfg folder and the game
 * POSTs its state to the URL in that file, on every change, from the
 * streamer's own machine. Any mode, any matchmaking, no third party.
 *
 * WHAT THIS FILE DOES. One function, readSnapshot: a POST body from either
 * game becomes the same small picture: which game, which match, which map,
 * whether the match is warming up, live or over, the streamer's side, the
 * score from their side, and who won. The engine (src/live/gsiCalls.ts) acts
 * on transitions; this file never remembers anything.
 *
 * CS2 names sides CT and T and swaps them at the half, so the streamer's side
 * is read off every snapshot and the winner is decided at "gameover" from the
 * final scores against the side they ended on. Dota names sides radiant and
 * dire for the whole game and says the winner outright. CS2 carries no match
 * id, so the engine makes one from the first live snapshot; Dota carries one.
 */
import { mapName } from "./faceit.js";

export type GsiGame = "cs2" | "dota2";
export type GsiPhase = "warmup" | "live" | "over" | "other";

export interface GsiSnapshot {
  game: GsiGame;
  /** The game's own match id, when it has one (Dota). */
  matchId: string | null;
  steamId: string | null;
  map: string | null;
  phase: GsiPhase;
  /** The round the map is on (CS2), or null. */
  round: number | null;
  /** "CT" | "T" (CS2), "radiant" | "dire" (Dota), as the game names them. */
  side: string | null;
  /** From the streamer's side: mine first. Null until both scores are known. */
  score: { mine: number; theirs: number } | null;
  /** At "over": whether the streamer's side won. Null for a draw or an unreadable end. */
  won: boolean | null;
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" ? v as Raw : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The auth token the game put in the body, or null. */
export function bodyToken(body: unknown): string | null {
  return str(obj(obj(body).auth).token);
}

function readCs2(r: Raw): GsiSnapshot {
  const map = obj(r.map), player = obj(r.player), provider = obj(r.provider);
  const ph = str(map.phase);
  const phase: GsiPhase = ph === "live" || ph === "intermission" ? "live" : ph === "warmup" ? "warmup" : ph === "gameover" ? "over" : "other";
  const side = str(player.team);
  const ct = num(obj(map.team_ct).score), t = num(obj(map.team_t).score);
  const mine = side === "CT" ? ct : side === "T" ? t : null;
  const theirs = side === "CT" ? t : side === "T" ? ct : null;
  const score = mine !== null && theirs !== null ? { mine, theirs } : null;
  const won = phase === "over" && score ? (score.mine === score.theirs ? null : score.mine > score.theirs) : null;
  return {
    game: "cs2", matchId: null, steamId: str(provider.steamid), map: mapName(map.name),
    phase, round: num(map.round), side, score, won,
  };
}

function readDota(r: Raw): GsiSnapshot {
  const map = obj(r.map), player = obj(r.player), provider = obj(r.provider);
  const st = String(map.game_state ?? "");
  const phase: GsiPhase = st === "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS" ? "live"
    : st === "DOTA_GAMERULES_STATE_POST_GAME" ? "over"
    : /HERO_SELECTION|STRATEGY_TIME|TEAM_SHOWCASE|WAIT_FOR_MAP_TO_LOAD|PRE_GAME/.test(st) ? "warmup" : "other";
  const side = str(player.team_name);
  const radiant = num(map.radiant_score), dire = num(map.dire_score);
  const mine = side === "radiant" ? radiant : side === "dire" ? dire : null;
  const theirs = side === "radiant" ? dire : side === "dire" ? radiant : null;
  const winTeam = str(map.win_team);
  const won = phase === "over" && side && winTeam && winTeam !== "none" ? winTeam === side : null;
  const id = map.matchid;
  return {
    game: "dota2", matchId: typeof id === "string" || typeof id === "number" ? String(id) : null, steamId: str(provider.steamid), map: null,
    phase, round: null, side, score: mine !== null && theirs !== null ? { mine, theirs } : null, won,
  };
}

/** A POST body from the game, read; null when it is not one. */
export function readSnapshot(body: unknown): GsiSnapshot | null {
  const r = obj(body);
  const appid = obj(r.provider).appid;
  if (appid === 730) return readCs2(r);
  if (appid === 570) return readDota(r);
  // The appid is the one field both games always send; without it this is not a game.
  return null;
}

/** The config file the streamer drops into the game. One file serves both
 *  games: each ignores the data keys it does not know. The token rides in the
 *  URL and in the body, and the server checks both. */
export function gsiConfig(uri: string, token: string): string {
  return [
    `"oddie"`,
    `{`,
    `  "uri" "${uri}"`,
    `  "timeout" "5.0"`,
    `  "buffer" "0.5"`,
    `  "throttle" "1.0"`,
    `  "heartbeat" "30.0"`,
    `  "auth"`,
    `  {`,
    `    "token" "${token}"`,
    `  }`,
    `  "data"`,
    `  {`,
    `    "provider" "1"`,
    `    "map" "1"`,
    `    "round" "1"`,
    `    "player_id" "1"`,
    `    "player_state" "1"`,
    `    "player_match_stats" "1"`,
    `    "player" "1"`,
    `    "hero" "1"`,
    `  }`,
    `}`,
    ``,
  ].join("\n");
}
