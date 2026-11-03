/**
 * LOCAL PREVIEW OF THE LIVE PAGES, with nothing to sign in to.
 *
 * `npm run dev` starts with an empty in-memory store, so the front door's real
 * call, a channel page's stream and the season podium all render their empty
 * states. This fills the store with calls shaped like the real ones from
 * Showdown's and Aleksa's streams, with the pictures Oddie actually read
 * (fetched from the public frame route), then starts the server in this same
 * process so it reads the same store.
 *
 *   npx tsx scripts/dev-live.ts                 the newest settled call on the front door
 *   DEV_LIVE_CALL=1 npx tsx scripts/dev-live.ts a call taking answers instead
 *   DEV_STREAM_LIVE=twitch:bee_empire ...       that channel's page shows its player
 *
 * Refuses to run with a DATABASE_URL: it writes test rows.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.DATABASE_URL) {
  console.error("dev-live writes made-up calls: run it without DATABASE_URL.");
  process.exit(1);
}
process.env.APP_OPEN ??= "true";

const { liveStore, saveChannel, saveCallFrame } = await import("../src/store/live.js");
type Side = "yes" | "no";

const PROD = "https://app.oddie.fun";
const here = path.dirname(fileURLToPath(import.meta.url));
const fallbackPicture = readFileSync(path.join(here, "..", "public", "portal.png"));

/** The real pictures Oddie settled Aleksa's calls on, newest first; a stand-in offline. */
async function realFrames(): Promise<Buffer[]> {
  try {
    const j = await fetch(`${PROD}/api/live/x/AleksaFlamingo`, { signal: AbortSignal.timeout(8_000) }).then((r) => r.json()) as { recent?: Array<{ frame: string | null }> };
    const urls = (j.recent ?? []).map((r) => r.frame).filter((f): f is string => !!f).slice(0, 3);
    const got: Array<Buffer | null> = await Promise.all(urls.map((u) => fetch(PROD + u, { signal: AbortSignal.timeout(8_000) })
      .then(async (r): Promise<Buffer | null> => (r.ok ? Buffer.from(await r.arrayBuffer()) : null)).catch(() => null)));
    return got.filter((b): b is Buffer => b !== null);
  } catch {
    return [];
  }
}

const DAY = 86_400_000;
const now = Date.now();
const channels = [
  { platform: "x" as const, channelId: "1836067494009671680", slug: "Showdown_TCG", name: "Showdown" },
  { platform: "x" as const, channelId: "1084242319", slug: "AleksaFlamingo", name: "Aleksa Flamingo 🦩" },
  { platform: "twitch" as const, channelId: "1372956063", slug: "bee_empire", name: "Bee_Empire" },
];
for (const c of channels) {
  await saveChannel({ ...c, avatar: null, accessToken: null, refreshToken: null, tokenExpiresAt: null, active: true });
}

/** One call: opened, answered, settled at the given times, with the picture when there is one. */
async function call(ch: (typeof channels)[number], question: string, openedAt: number, picks: Array<[string, Side, number]>,
  outcome: Side | null, settledAfter: number, frame?: Buffer): Promise<void> {
  const c = await liveStore.open({ platform: ch.platform, channelId: ch.channelId, question, openedById: "host", openedByName: ch.slug,
    openedAt, closesAt: openedAt + 30 * 60_000, timed: false });
  if (!c) throw new Error(`could not open "${question}"`);
  for (const [name, side, after] of picks) await liveStore.pick(c, name.toLowerCase(), name, side, openedAt + after);
  if (!outcome) return;
  await liveStore.settle(c.id, outcome, 100, openedAt + settledAfter);
  if (frame) await saveCallFrame(c.id, frame, "");
}

const [showdown, aleksa, bee] = channels;
const frames = await realFrames();
const pic = (i: number) => frames[i] ?? fallbackPicture;

await call(showdown, "Can Ondrej beat StanCifka?", now - 8 * DAY, [["uncleogac", "no", 40_000], ["pink_peony_rose", "no", 90_000], ["levvercetti", "yes", 20_000]], "no", 16 * 60_000);
await call(bee, "will BTC close the next 5m candle green?", now - 3 * DAY, [["litre46", "yes", 30_000], ["cryptonana", "no", 60_000]], "yes", 5 * 60_000);
await call(aleksa, "Will Aleksa finish the run in under 8:00?", now - 2 * DAY - 3 * 3_600_000, [["VSProtocol", "no", 25_000], ["sol_mika", "yes", 70_000]], "no", 9 * 60_000, pic(2));
await call(aleksa, "will aleksa finish the run in under 10:00?", now - 2 * DAY - 2 * 3_600_000, [["VSProtocol", "yes", 15_000], ["sol_mika", "yes", 50_000], ["degenpanda", "no", 80_000]], "yes", 11 * 60_000, pic(1));
await call(aleksa, "Will Aleksa crack the top 10 with 1066+ points this run?", now - 2 * DAY - 3_600_000, [["VSProtocol", "no", 30_000], ["degenpanda", "yes", 45_000], ["sol_mika", "no", 90_000]], "no", 12 * 60_000, pic(0));
await call(showdown, "Can Roothlus beat StanCifka?", now - DAY, [["mozaiiic", "yes", 50_000], ["uncleogac", "no", 70_000]], "no", 16 * 60_000);
if (process.env.DEV_LIVE_CALL) {
  await call(showdown, "Can StanCifka win this game?", now - 3 * 60_000, [["mozaiiic", "yes", 20_000], ["uncleogac", "yes", 40_000], ["pink_peony_rose", "no", 60_000]], null, 0);
}
console.log(`dev-live: ${channels.length} channels, ${frames.length ? `${frames.length} real frames` : "stand-in pictures (offline)"}${process.env.DEV_LIVE_CALL ? ", one call taking answers" : ""}`);

await import("../src/server.js");
