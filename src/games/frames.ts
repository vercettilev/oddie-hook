/**
 * FRAMES: oddie reads the stream itself.
 *
 * WHY. A match call needs to know when the streamer's match starts and how it
 * ends. The game can say so (src/games/gsi.ts) once the streamer drops a file
 * in its folder; FACEIT can say so with a key oddie does not have. The stream
 * says so to everyone, for free: the round score sits at the top of the
 * picture through every match, and the end screen names the winner. So this
 * file takes one picture of the live stream and asks a small model what it
 * shows. The streamer does nothing, the viewer does nothing (Lev, 12 Oct:
 * "hem yayıncı hem izleyici için ekstra iş olmadan").
 *
 * HOW. Twitch and Kick both play through HLS. A playlist for the stream (the
 * playback token Twitch's own player gets, the playback url Kick's channel
 * page gets), the last two-second segment of one variant, and ffmpeg decodes
 * one picture out of it, 640 wide. That picture goes to the fast model with a
 * strict JSON question. Two seconds and a few hundred tokens a frame,
 * measured on three live CS2 streams, 11 Oct.
 *
 * WHAT IT COSTS, since the question was asked (Lev, 12 Oct, "scale'de maliyetli
 * olmaz mı"): about 300 image tokens and the question a frame, a cent an hour
 * a channel while it idles, three to five cents a match. The picture is only
 * read while the channel is live in the game's category, and only as often
 * as the engine needs (src/live/frameCalls.ts); a channel whose game talks is
 * never read. A local digit reader for the score, with the model only on
 * transitions, is the next cut when the bill says so.
 *
 * This file never remembers anything and never decides anything: it fetches,
 * decodes and reads. The engine keeps the state.
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { authHeaders, inferenceEnabled, messagesUrl } from "../inference.js";
import type { Platform } from "../live/calls.js";

export type FrameView = "match" | "end" | "other";
export type FrameGame = "cs2" | "dota2";

/** What one picture of the stream shows, as the model read it. */
export interface FrameReading {
  view: FrameView;
  game: FrameGame | null;
  /** The two team scores at the top of the HUD, left and right as drawn. */
  score: { left: number; right: number } | null;
  /** The side of the HUD the streamer's own team is on, when the picture says. */
  side: "left" | "right" | null;
  /** From an end screen only: the streamer's result. */
  result: "win" | "loss" | "tie" | null;
  map: string | null;
  /** The model's own 0..1 on the reading. */
  sure: number;
}

export interface FrameSource {
  /** The stream's HLS playlist now, or null when the platform gives none. */
  playlist(platform: Platform, slug: string): Promise<string | null>;
  /** One picture of the stream, JPEG, or null when none could be taken. */
  grab(playlistUrl: string): Promise<Buffer | null>;
  /** What the picture shows, or null when the reader did not answer in JSON. */
  read(jpeg: Buffer): Promise<FrameReading | null>;
}

/** The model that reads the picture: the fast one, as in src/matching/semantic.ts. */
export const FRAME_MODEL = process.env.INFERENCE_FAST_MODEL ?? "claude-haiku-4-5-20251001";
/** The picture's width as sent: wide enough for the digits, small enough to be ~300 tokens. */
export const FRAME_WIDTH = 640;
const READ_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 10_000;
const DECODE_TIMEOUT_MS = 15_000;

export const FRAME_PROMPT = `You are looking at one frame of a live stream. Say what the streamer's game shows, as JSON only, no prose:
{"view":"match"|"end"|"other","game":"cs2"|"dota2"|null,"score":{"left":L,"right":R}|null,"side":"left"|"right"|null,"result":"win"|"loss"|"tie"|null,"map":"name"|null,"sure":0..1}
- "match": the in-game HUD of a Counter-Strike 2 or Dota 2 match the streamer is playing is on screen (the round timer and the two team scores at the top, the player cards, the minimap). Give the two scores exactly as drawn, left then right.
- "end": the match's own end screen (VICTORY, DEFEAT, TIE, or the final scoreboard shown after the last round). Give "result" as the streamer's own: win, loss or tie.
- "other": anything else: menu, lobby, queue, warmup, a replay or demo, another game, a camera or "be right back" screen, an ad.
- "side": which side of the HUD the streamer's own team is on, only when the picture shows it (the local player's card is highlighted, team chat lines carry the side, the lower HUD shows the player's own team). Otherwise null.
- "map": the map's name when it is visible (Mirage, Inferno, Nuke, Dust2, Ancient, Anubis, Vertigo, Overpass, Train), otherwise null.
- "sure": 0 to 1, how sure you are of the whole reading.`;

/* ----------------------------------------------------------- the reading -- */

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);

/** The model's text as a reading, or null when it is not one. Tolerates prose
 *  and code fences around the JSON: the object is read from its first brace
 *  to its last. */
export function parseReading(text: string): FrameReading | null {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let r: Record<string, unknown>;
  try { r = JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>; } catch { return null; }
  if (!r || typeof r !== "object") return null;
  const view = str(r.view);
  if (view !== "match" && view !== "end" && view !== "other") return null;
  const g = str(r.game);
  const game: FrameGame | null = g === "cs2" || g === "dota2" ? g : null;
  const sc = r.score && typeof r.score === "object" ? r.score as Record<string, unknown> : null;
  const left = sc ? int(sc.left) : null, right = sc ? int(sc.right) : null;
  const side = r.side === "left" || r.side === "right" ? r.side : null;
  const result = r.result === "win" || r.result === "loss" || r.result === "tie" ? r.result : null;
  const sureRaw = typeof r.sure === "number" ? r.sure : Number(r.sure);
  const sure = Number.isFinite(sureRaw) ? Math.max(0, Math.min(1, sureRaw)) : 0;
  return {
    view, game,
    score: view === "match" && left !== null && right !== null ? { left, right } : null,
    side, result: view === "end" ? result : null,
    map: str(r.map)?.replace(/^de_/i, "").replace(/^\w/, (c) => c.toUpperCase()) ?? null,
    sure,
  };
}

/* ----------------------------------------------------------------- HLS -- */

/** The variant playlist of a master: the smallest one at least 720 tall, or
 *  the tallest there is below that; never taller than 1080. The picture is
 *  scaled to FRAME_WIDTH anyway, and digits scaled up from 480 blur.
 *  Relative urls are resolved against the master's own. */
export function pickVariant(master: string, masterUrl: string, want = 720): string | null {
  const lines = master.split(/\r?\n/);
  let best: { url: string; h: number } | null = null;
  const better = (h: number, than: number) => (h >= want ? than < want || h < than : h > than);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith("#EXT-X-STREAM-INF")) continue;
    const url = lines.slice(i + 1).find((x) => x && !x.startsWith("#"));
    if (!url) continue;
    const m = /RESOLUTION=(\d+)x(\d+)/.exec(l);
    const h = m ? Number(m[2]) : 0;
    if (h > 1080) continue;
    if (!best || better(h, best.h)) best = { url, h };
  }
  if (!best) return null;
  try { return new URL(best.url, masterUrl).toString(); } catch { return null; }
}

/** The last segment of a media playlist: the newest two seconds of the stream. */
export function lastSegment(media: string, mediaUrl: string): string | null {
  const url = media.split(/\r?\n/).reverse().find((x) => x && !x.startsWith("#"));
  if (!url) return null;
  try { return new URL(url, mediaUrl).toString(); } catch { return null; }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`frames playlist ${res.status}`);
  return res.text();
}

async function fetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`frames segment ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/* The id Twitch's own web player sends: the playback token any browser gets
   for any live channel. Not a secret and not ours; it names the player, not
   an account. */
const TWITCH_PLAYER_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

/** Twitch: the channel's master playlist, through the public playback token. */
export async function twitchPlaylist(login: string): Promise<string | null> {
  const res = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: { "client-id": TWITCH_PLAYER_ID, "content-type": "application/json" },
    body: JSON.stringify({
      operationName: "PlaybackAccessToken_Template",
      query: "query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: \"web\", playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isLive) { value signature } videoPlaybackAccessToken(id: $vodID, params: {platform: \"web\", playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isVod) { value signature } }",
      variables: { isLive: true, login, isVod: false, vodID: "", playerType: "site" },
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`frames twitch token ${res.status}`);
  const j = (await res.json()) as { data?: { streamPlaybackAccessToken?: { value?: string; signature?: string } | null } };
  const t = j.data?.streamPlaybackAccessToken;
  if (!t?.value || !t.signature) return null;
  const q = new URLSearchParams({ client_id: TWITCH_PLAYER_ID, token: t.value, sig: t.signature, allow_source: "true", fast_bread: "true", p: String(Math.floor(Math.random() * 1e7)) });
  return `https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(login)}.m3u8?${q}`;
}

/** Kick: the channel's playback url, as its own page reads it. */
export async function kickPlaylist(slug: string): Promise<string | null> {
  const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; oddie/1.0; +https://oddie.fun)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`frames kick channel ${res.status}`);
  const j = (await res.json()) as { playback_url?: string | null };
  return str(j.playback_url);
}

/* -------------------------------------------------------------- ffmpeg -- */

let ffmpegFound: string | null | undefined;
/** The ffmpeg this host has: FFMPEG_PATH, the one npm installed
 *  (@ffmpeg-installer/ffmpeg), or one on the PATH. Null when none runs. */
export function ffmpegPath(): string | null {
  if (ffmpegFound !== undefined) return ffmpegFound;
  const candidates = [process.env.FFMPEG_PATH, installedFfmpeg(), "ffmpeg"].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    try { if (spawnSync(c, ["-version"], { timeout: 5_000, stdio: "ignore" }).status === 0) return (ffmpegFound = c); } catch { /* not this one */ }
  }
  return (ffmpegFound = null);
}
function installedFfmpeg(): string | null {
  try { return (createRequire(import.meta.url)("@ffmpeg-installer/ffmpeg") as { path?: string }).path ?? null; } catch { return null; }
}
/** Test seam. */
export function _setFfmpeg(path: string | null | undefined): void { ffmpegFound = path; }

/** One picture out of a segment: the first frame, scaled to FRAME_WIDTH, JPEG. */
export function decodeFrame(segment: Buffer, ffmpeg: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ["-loglevel", "error", "-i", "pipe:0", "-frames:v", "1", "-vf", `scale=${FRAME_WIDTH}:-2`, "-f", "image2", "-c:v", "mjpeg", "-q:v", "5", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"] });
    const out: Buffer[] = [];
    const timer = setTimeout(() => { p.kill("SIGKILL"); }, DECODE_TIMEOUT_MS);
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.on("error", () => { clearTimeout(timer); resolve(null); });
    p.on("close", (code) => { clearTimeout(timer); const b = Buffer.concat(out); resolve(code === 0 && b.length > 1000 ? b : null); });
    p.stdin.on("error", () => { /* ffmpeg closed its input after the first frame: expected */ });
    p.stdin.end(segment);
  });
}

/** One picture of the stream behind a master playlist. */
export async function grabFrame(masterUrl: string, ffmpeg: string): Promise<Buffer | null> {
  const variant = pickVariant(await fetchText(masterUrl), masterUrl);
  if (!variant) return null;
  const seg = lastSegment(await fetchText(variant), variant);
  if (!seg) return null;
  return decodeFrame(await fetchBytes(seg), ffmpeg);
}

/* ---------------------------------------------------------------- model -- */

/** What the picture shows, asked of the fast model. Throws on a refused or
 *  failed call (src/inference.ts personFixOutage reads the message); null
 *  when the answer was not a reading. */
export async function readFrame(jpeg: Buffer): Promise<FrameReading | null> {
  const res = await fetch(messagesUrl(), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: FRAME_MODEL, max_tokens: 160,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
        { type: "text", text: FRAME_PROMPT },
      ] }],
    }),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`frames ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return parseReading(j.content?.find((c) => c.type === "text")?.text ?? "");
}

/** The source the server uses, or null with the reason it cannot: no ffmpeg
 *  on this host, or no inference key. */
export function frameSource(): { source: FrameSource | null; why: string } {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) return { source: null, why: "no ffmpeg (FFMPEG_PATH, @ffmpeg-installer/ffmpeg or PATH)" };
  if (!inferenceEnabled()) return { source: null, why: "no inference key" };
  return {
    why: `ffmpeg ${ffmpeg}, ${FRAME_MODEL}`,
    source: {
      playlist: (platform, slug) => (platform === "twitch" ? twitchPlaylist(slug) : kickPlaylist(slug)),
      grab: (url) => grabFrame(url, ffmpeg),
      read: readFrame,
    },
  };
}
