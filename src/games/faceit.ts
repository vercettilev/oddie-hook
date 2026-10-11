/**
 * CS2 on FACEIT: the first game whose matches oddie calls and settles by itself.
 *
 * WHY A GAME API. On a gaming stream the viewer watches the game, not the chat,
 * and the streamer does not remember to type !call between rounds. A call that
 * opens itself when the match starts and settles itself when it ends is the
 * difference between a bot in the chat and a thing the room plays. Twitch's own
 * Predictions cannot do either: the streamer opens them and closes them by hand.
 *
 * ONE SOURCE, THE OFFICIAL ONE. FACEIT's Data API (open.faceit.com/data/v4,
 * server-side key) answers three questions: who is this nickname, which match
 * is this player in right now (players/{id}/matches?type=ongoing), and how did
 * a match end (matches/{id}: status, factions, results.winner, score, map).
 * Nothing here scrapes faceit.com.
 *
 * NARROW ON PURPOSE. The only call this opens is "does the streamer's team win
 * this match". Rounds and clutches stay the room's (!call, !result): FACEIT
 * publishes round data only after the match, and a wrong result in a live chat
 * costs more than a mod typing !call yes.
 */
import type { Side } from "../live/calls.js";

export interface GamePlayer { id: string; nick: string; /** FACEIT lists CS2 under their games. */ playsCs2: boolean }
export type Faction = "faction1" | "faction2";
export interface GameMatch {
  id: string;
  /** "live" is anything FACEIT has not finished or cancelled: voting, ready, ongoing. */
  status: "live" | "finished" | "cancelled";
  map: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** Player ids on each side. */
  factions: Record<Faction, string[]>;
  winner: Faction | null;
  score: Record<Faction, number> | null;
}
export interface GameSource {
  /** A FACEIT player by nickname, or null when there is none. */
  player(nick: string): Promise<GamePlayer | null>;
  /** The player's match in progress, or null. */
  ongoing(playerId: string): Promise<GameMatch | null>;
  /** A match by id, or null when FACEIT does not know it. */
  match(matchId: string): Promise<GameMatch | null>;
}

const API = "https://open.faceit.com/data/v4";

/** "de_mirage" -> "Mirage"; anything unrecognisable passes through capitalised. */
export function mapName(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim().replace(/^de_/i, "").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" ? v as Raw : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const secs = (v: unknown): number | null => (typeof v === "number" && v > 0 ? v * 1000 : null);

/** Player ids of a faction, from a match (roster) or a history item (players). */
function ids(team: unknown): string[] {
  const t = obj(team);
  const list = Array.isArray(t.roster) ? t.roster : Array.isArray(t.players) ? t.players : [];
  return list.map((p) => str(obj(p).player_id)).filter((x): x is string => !!x);
}

/** FACEIT's match object (or a history item) in oddie's terms; null without an id. */
export function parseMatch(raw: unknown): GameMatch | null {
  const r = obj(raw);
  const id = str(r.match_id);
  if (!id) return null;
  const st = String(r.status ?? "").toUpperCase();
  const status: GameMatch["status"] = st === "FINISHED" ? "finished"
    : /^(CANCEL+ED|ABORTED)$/.test(st) ? "cancelled" : "live";
  const teams = obj(r.teams);
  const results = obj(r.results);
  const w = str(results.winner);
  const sc = obj(results.score);
  const score = typeof sc.faction1 === "number" && typeof sc.faction2 === "number" ? { faction1: sc.faction1, faction2: sc.faction2 } : null;
  const pick = obj(obj(obj(r.voting).map)).pick;
  const map = mapName(Array.isArray(pick) ? pick[0] : pick);
  return {
    id, status, map,
    startedAt: secs(r.started_at), finishedAt: secs(r.finished_at),
    factions: { faction1: ids(teams.faction1), faction2: ids(teams.faction2) },
    winner: w === "faction1" || w === "faction2" ? w : null,
    score,
  };
}

/** The streamer's side of a finished match: YES when their faction won. Null
 *  when the player is on neither roster or no winner is recorded. */
export function sideFor(m: GameMatch, playerId: string): { side: Side; mine: Faction } | null {
  const mine: Faction | null = m.factions.faction1.includes(playerId) ? "faction1" : m.factions.faction2.includes(playerId) ? "faction2" : null;
  if (!mine || !m.winner) return null;
  return { side: m.winner === mine ? "yes" : "no", mine };
}

/** "13-9", the streamer's score first. */
export function scoreText(m: GameMatch, mine: Faction): string | null {
  if (!m.score) return null;
  const theirs: Faction = mine === "faction1" ? "faction2" : "faction1";
  return `${m.score[mine]}-${m.score[theirs]}`;
}
/** The same, from a score already read from the streamer's side. */
export function scoreTextFrom(score: { mine: number; theirs: number } | null): string | null {
  return score ? `${score.mine}-${score.theirs}` : null;
}

/** The live client. `fetchImpl` is the test seam. */
export function faceitSource(key: string, fetchImpl: typeof fetch = fetch): GameSource {
  const get = async (path: string): Promise<unknown | null> => {
    const r = await fetchImpl(`${API}${path}`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`faceit ${r.status}`);
    return r.json();
  };
  return {
    async player(nick) {
      const p = obj(await get(`/players?nickname=${encodeURIComponent(nick.trim())}`));
      const id = str(p.player_id), name = str(p.nickname);
      return id && name ? { id, nick: name, playsCs2: "cs2" in obj(p.games) } : null;
    },
    async ongoing(playerId) {
      const r = obj(await get(`/players/${encodeURIComponent(playerId)}/matches?type=ongoing&offset=0&limit=5`));
      const items = Array.isArray(r.items) ? r.items : [];
      for (const it of items) {
        const game = str(obj(it).game) ?? str(obj(it).game_id);
        if (game && game !== "cs2") continue;
        const m = parseMatch(it);
        if (m && m.status === "live") return m;
      }
      return null;
    },
    async match(matchId) {
      const raw = await get(`/matches/${encodeURIComponent(matchId)}`);
      return raw ? parseMatch(raw) : null;
    },
  };
}

let configured: GameSource | null = null;
/** Set once at boot from FACEIT_API_KEY; the engine reads it when its deps carry no source. */
export function configureFaceit(key: string | undefined): GameSource | null {
  configured = key && key.trim() ? faceitSource(key.trim()) : null;
  return configured;
}
export function faceitConfigured(): GameSource | null { return configured; }
