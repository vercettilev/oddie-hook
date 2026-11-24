// Does Kick's "livestreams for users" answer for every channel that is live?
//
// kickStreamInfo (src/kick/client.ts) asks GET /public/v1/users/livestreams for one channel and
// reads "no row" as "not live": open calls end with the stream, and the went-live mail, the
// player and the picture pass all wait for a row. It was written from the docs (24 Nov 2026),
// and a report on Kick's own tracker says the operation answered an empty list for a channel
// that was live, while /channels and the deprecated /livestreams both had it live
// (github.com/KickEngineering/KickDevDocs/issues/448, 4 Nov 2026).
//
// So this asks Kick itself. The channels it lists as live (GET /public/v2/livestreams), then the
// same channels by user id: who came back, and does each row carry what kickStreamInfo reads.
// Whoever did not come back is asked of /channels, because a stream can end in between. Then
// kickStreamInfo itself for one of them, and the deprecated operation, to see if it still answers.
//
// It reads only: a handful of GETs with the app's own token. It prints no credential.
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

interface Livestream { viewer_count?: unknown; category?: { name?: unknown } | null; broadcaster_user?: { id?: unknown } | null; channel?: { slug?: unknown } | null }
interface Channel { broadcaster_user_id?: unknown; slug?: unknown; stream?: { is_live?: unknown; viewer_count?: unknown } | null }

// Who is live, by Kick's own list (oldest streams first, a hundred of them).
const listed = await rows<Livestream>("/v2/livestreams?limit=100").catch(refused);
const ids = [...new Set(listed.map((s) => s.broadcaster_user?.id).filter((i): i is number => typeof i === "number"))];
console.log(`\nKick lists ${listed.length} live channels (/public/v2/livestreams), ${ids.length} user ids among them`);
if (!ids.length) {
  console.error(`nothing to ask about: the list is empty, or a row is not shaped as the docs say. Its first row: ${JSON.stringify(listed[0] ?? null).slice(0, 400)}`);
  process.exit(1);
}

// The same channels, asked for by user id: up to a hundred in one request.
const got = await rows<Livestream>(`/v1/users/livestreams?${ask("user_id", ids)}`).catch(refused);
const back = new Set(got.map((s) => s.broadcaster_user?.id));
const missing = ids.filter((i) => !back.has(i));
const counted = got.filter((s) => typeof s.viewer_count === "number").length;
const named = got.filter((s) => typeof s.category?.name === "string" && s.category.name).length;
console.log(`asked /public/v1/users/livestreams for those ${ids.length}: ${ids.length - missing.length} came back, in ${got.length} rows`);
console.log(`  viewer_count is a number in ${counted} of ${got.length} rows, category.name is a name in ${named}`);

// Whoever did not come back: did the stream end in between, or is a live channel left out?
let leftOut = 0;
for (let i = 0; i < missing.length; i += 50) {
  const part = missing.slice(i, i + 50);
  const channels = await rows<Channel>(`/v1/channels?${ask("broadcaster_user_id", part)}`).catch(refused);
  for (const id of part) {
    const c = channels.find((x) => x.broadcaster_user_id === id);
    const live = c?.stream?.is_live === true;
    if (live) leftOut++;
    const says = live ? `LIVE with ${String(c?.stream?.viewer_count)} watching: left out` : c ? "off air: it ended in between" : "nothing about it";
    console.log(`  did not come back: ${String(c?.slug ?? "?")} (user id ${id}), and /public/v1/channels says ${says}`);
  }
}

// The function itself, for a channel that came back. A stream can end in between: three tries.
let reads = false;
for (const id of ids.filter((i) => back.has(i)).slice(0, 3)) {
  const info = await kickStreamInfo(String(id)).catch((e) => `threw: ${(e as Error).message}`);
  console.log(`kickStreamInfo("${id}") -> ${JSON.stringify(info)}`);
  reads = typeof info === "object" && info.live && typeof info.viewers === "number";
  if (reads) break;
}

// The deprecated operation, for comparison: does it still answer, and for how many of them?
const some = ids.slice(0, 50);
try {
  const old = await rows<{ broadcaster_user_id?: unknown }>(`/v1/livestreams?${ask("broadcaster_user_id", some)}&limit=100`);
  const had = new Set(old.map((s) => s.broadcaster_user_id));
  console.log(`the deprecated /public/v1/livestreams, asked for ${some.length} of them: ${some.filter((i) => had.has(i)).length} came back`);
} catch (e) {
  console.log(`the deprecated /public/v1/livestreams no longer answers: ${(e as Error).message}`);
}

const ok = leftOut === 0 && got.length > 0 && counted === got.length && named > 0 && reads;
console.log(ok
  ? "\nok: every channel Kick lists as live came back, every row carries a count, and kickStreamInfo reads one.\n"
  : `\nNOT ok: ${leftOut} live channel(s) left out, ${got.length - counted} of ${got.length} row(s) without a count, ${named} with a category name, kickStreamInfo ${reads ? "reads one" : "does not read one"}.\n`);
process.exit(ok ? 0 : 1);
