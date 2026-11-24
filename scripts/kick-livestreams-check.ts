// Does Kick's "livestreams for users" answer for every channel that is live, and what does it
// answer for one that is not?
//
// kickStreamInfo (src/kick/client.ts) asks GET /public/v1/users/livestreams for one channel and
// reads "no row" as "not live": open calls end with the stream, and the went-live mail, the
// player and the picture pass all wait for a row. It was written from the docs (24 Nov 2026),
// and a report on Kick's own tracker says the operation answered an empty list for a channel
// that was live, while /channels and the deprecated /livestreams both had it live
// (github.com/KickEngineering/KickDevDocs/issues/448, 4 Nov 2026).
//
// So this asks Kick itself, three things.
//   1. Channels that are live, in two samples: the ones Kick's own list starts with (GET
//      /public/v2/livestreams, the longest-running streams) and, while the deprecated operation
//      still answers, the ones it lists by viewers. Each sample is asked for again by user id:
//      who came back, and does each row carry what kickStreamInfo reads. Whoever did not come
//      back is asked of /channels, because a stream can end in between.
//   2. kickStreamInfo itself, for a channel that is live.
//   3. kickStreamInfo for a channel that is off air: oddie's own, or the user ids given as
//      arguments. "No row" has to come back as an answer, not as a refusal.
//
// Measured 24 Nov 2026, with production's credentials: the hundred channels Kick's own list
// starts with and the hundred the deprecated list has as most watched (211,037 down to 2,224
// watching) all came back, 200 of 200, every row with a count and a category name.
// kickStreamInfo read the most watched of them, and said "not live" for oddie's own channel,
// which /channels had off air. That is one moment: a call that ends "with the stream" on a
// Kick channel still on air is the sign to run this again.
//
// It reads only: about ten GETs with the app's own token. It prints no credential.
//
//   railway run -p 508d41c0-e0ab-4dfd-94e8-a00881cd9e2e -e production -s oddie-hook -- npx tsx scripts/kick-livestreams-check.ts
import { kickAppToken, kickConfigured, kickStreamInfo } from "../src/kick/client.js";

if (!kickConfigured()) {
  console.error("no KICK_CLIENT_ID and KICK_CLIENT_SECRET here: run it under railway run, as the top of this file shows.");
  process.exit(2);
}

/** A request Kick refused ends the check there, saying which one and what Kick said. */
function refused(e: unknown): never {
  console.error(`\nNOT ok: ${(e as Error).message}\n`);
  process.exit(1);
}

const KICK = "https://api.kick.com/public";
/** oddie's own Kick channel, oddiefun: the voice in other chats, almost never on air itself. */
const OWN_CHANNEL = 131980691;
const token = await kickAppToken().catch(refused);

/** One GET, and the rows of its answer: a list that is missing or null is no rows. */
async function rows<T>(path: string): Promise<T[]> {
  const res = await fetch(`${KICK}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET /public${path.split("?")[0]} answered ${res.status} ${text.slice(0, 200)}`);
  const data = (JSON.parse(text) as { data?: unknown }).data;
  return Array.isArray(data) ? (data as T[]) : [];
}
const ask = (name: string, ids: number[]): string => ids.map((i) => `${name}=${i}`).join("&");
const userIds = (xs: unknown[]): number[] => [...new Set(xs.filter((i): i is number => typeof i === "number"))];

interface Livestream { viewer_count?: unknown; category?: { name?: unknown } | null; broadcaster_user?: { id?: unknown } | null }
interface Channel { broadcaster_user_id?: unknown; slug?: unknown; stream?: { is_live?: unknown; viewer_count?: unknown } | null }

/** What /channels has on these users, by user id: fifty to a request. */
async function channelsOf(ids: number[]): Promise<Map<number, Channel>> {
  const out = new Map<number, Channel>();
  for (let i = 0; i < ids.length; i += 50) {
    for (const c of await rows<Channel>(`/v1/channels?${ask("broadcaster_user_id", ids.slice(i, i + 50))}`)) {
      if (typeof c.broadcaster_user_id === "number") out.set(c.broadcaster_user_id, c);
    }
  }
  return out;
}

// Across both samples, each channel once.
const asked = new Set<number>();
const came = new Set<number>();
const leftOut = new Set<number>();
let uncounted = 0;
let named = 0;

/** One sample of live channels, asked for again by user id: up to a hundred in one request.
 *  It returns the ones that came back. */
async function sample(what: string, ids: number[]): Promise<number[]> {
  const got = await rows<Livestream>(`/v1/users/livestreams?${ask("user_id", ids)}`).catch(refused);
  const back = new Set(got.map((s) => s.broadcaster_user?.id));
  const missing = ids.filter((i) => !back.has(i));
  const counted = got.filter((s) => typeof s.viewer_count === "number").length;
  const withName = got.filter((s) => typeof s.category?.name === "string" && s.category.name).length;
  console.log(`${what}: asked /public/v1/users/livestreams for ${ids.length}, ${ids.length - missing.length} came back, in ${got.length} rows`);
  console.log(`  viewer_count is a number in ${counted} of ${got.length} rows, category.name is a name in ${withName}`);
  // Whoever did not come back: did the stream end in between, or is a live channel left out?
  const channels = missing.length ? await channelsOf(missing).catch(refused) : new Map<number, Channel>();
  for (const id of missing) {
    const c = channels.get(id);
    const live = c?.stream?.is_live === true;
    if (live) leftOut.add(id);
    const says = live ? `LIVE with ${String(c?.stream?.viewer_count)} watching: left out` : c ? "off air: it ended in between" : "nothing about it";
    console.log(`  did not come back: ${String(c?.slug ?? "?")} (user id ${id}), and /public/v1/channels says ${says}`);
  }
  const backIds = ids.filter((i) => back.has(i));
  for (const i of ids) asked.add(i);
  for (const i of backIds) came.add(i);
  uncounted += got.length - counted; named += withName;
  return backIds;
}

// 1. Who is live, by Kick's own list: it starts with the longest-running streams.
const listed = await rows<Livestream>("/v2/livestreams?limit=100").catch(refused);
const listedIds = userIds(listed.map((s) => s.broadcaster_user?.id));
if (!listedIds.length) {
  console.error(`\nNOT ok: /public/v2/livestreams gave nothing to ask about: the list is empty, or a row is not shaped as the docs say. Its first row: ${JSON.stringify(listed[0] ?? null).slice(0, 400)}\n`);
  process.exit(1);
}
console.log("");
const listedBack = await sample(`Kick's own list (/public/v2/livestreams, ${listed.length} rows, the longest-running first)`, listedIds);

// And by the deprecated operation, while it still answers: it is the one that sorts by viewers.
let watchedBack: number[] = [];
try {
  const old = await rows<{ broadcaster_user_id?: unknown; viewer_count?: unknown }>("/v1/livestreams?limit=100&sort=viewer_count");
  const counts = old.map((s) => s.viewer_count).filter((n): n is number => typeof n === "number");
  const range = counts.length ? `, ${Math.max(...counts)} to ${Math.min(...counts)} watching` : "";
  const ids = userIds(old.map((s) => s.broadcaster_user_id));
  if (ids.length) watchedBack = await sample(`the deprecated list by viewers (/public/v1/livestreams, ${old.length} rows${range})`, ids);
  else console.log("the deprecated /public/v1/livestreams answered, with no rows to ask about");
} catch (e) {
  console.log(`the deprecated /public/v1/livestreams no longer answers, so its list by viewers is not sampled: ${(e as Error).message}`);
}

// 2. The function itself, for a channel that came back. A stream can end in between: three tries.
let reads = false;
for (const id of [...watchedBack.slice(0, 2), ...listedBack.slice(0, 3)].slice(0, 3)) {
  const info = await kickStreamInfo(String(id)).catch((e) => `threw: ${(e as Error).message}`);
  console.log(`kickStreamInfo("${id}") -> ${JSON.stringify(info)}`);
  reads = typeof info === "object" && info.live && typeof info.viewers === "number";
  if (reads) break;
}

// 3. A channel that is off air: "no row" has to come back as an answer, not as a refusal.
const given = userIds(process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number));
const offAir = given.length ? given : [OWN_CHANNEL];
const records = await channelsOf(offAir).catch(() => null);
let refusals = 0;
let notLiveSeen = false;
for (const id of offAir) {
  const info = await kickStreamInfo(String(id)).catch((e) => `threw: ${(e as Error).message}`);
  const c = records?.get(id);
  const channelLive = c?.stream?.is_live === true;
  const says = !records ? "could not be asked" : !c ? "has nothing about it" : channelLive ? `says LIVE with ${String(c.stream?.viewer_count)} watching` : "says off air";
  console.log(`kickStreamInfo("${id}") -> ${JSON.stringify(info)}, and /public/v1/channels ${says}`);
  if (typeof info === "string") refusals++;
  else if (!info.live && channelLive) leftOut.add(id);
  else if (!info.live) notLiveSeen = true;
}

const ok = leftOut.size === 0 && came.size > 0 && uncounted === 0 && named > 0 && reads && refusals === 0;
if (!ok) {
  console.log(`\nNOT ok: ${leftOut.size} live channel(s) left out, ${came.size} of ${asked.size} came back, ${uncounted} row(s) without a count, ${named} with a category name, `
    + `kickStreamInfo ${reads ? "reads a live channel" : "does not read a live channel"}${refusals ? `, and threw for ${refusals} channel(s) that should read "not live"` : ""}.\n`);
} else if (!notLiveSeen) {
  console.log(`\nok for live channels (${came.size} of ${asked.size} came back, every row carries a count), but no channel asked about was off air, so the "not live" answer was not seen. Give the user id of one that is off air as an argument.\n`);
} else {
  console.log(`\nok: every live channel asked for came back (${came.size} of ${asked.size}), every row carries a count, and kickStreamInfo reads a live channel and says "not live" for one that is off air.\n`);
}
process.exit(ok ? 0 : 1);
