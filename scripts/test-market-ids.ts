// Community market ids: nextMarketId, and what opening a market on an id that
// is already taken does, against the real store on the in-memory backend.
//
// The id is the on-chain market_id and the market_slug venue_id. It used to be
// Date.now(), so two markets opened in the same millisecond shared one: in
// memory the second read as the first, and in Postgres the second's upsert
// rewrote the first market's question and handed back the first one's slug.
//
// Run with: npm run test-market-ids

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database — unset DATABASE_URL");
  process.exit(1);
}

import { createCommunityMarket, nextMarketId, getSlug, openCommunityMarkets } from "../src/store/markets.js";
import type { Market } from "../src/venues/types.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
}

const closeTime = Math.floor(Date.now() / 1000) + 86_400;
const open = (question: string, marketId?: number) => createCommunityMarket({ question, closeTime, marketId });
const reads = async (slug: string): Promise<string | undefined> =>
  (await getSlug(slug, (await openCommunityMarkets()) as unknown as Market[]))?.market.question;

console.log("\nnextMarketId: still the clock, never the same reading twice");
{
  const before = Date.now();
  // All fifty asked for at once, so they land inside one millisecond, which
  // is exactly where Date.now() used to repeat itself.
  const ids = await Promise.all(Array.from({ length: 50 }, () => nextMarketId()));
  const after = Date.now();
  check("fifty ids asked for at once are fifty different ids", new Set(ids).size === ids.length, `${new Set(ids).size} distinct`);
  check("each one is later than the one asked for before it", ids.every((id, i) => i === 0 || id > ids[i - 1]));
  check("and they still read as the time they were issued, a bump at most past the clock",
    ids[0] >= before && ids[ids.length - 1] <= after + ids.length, `${ids[0]}..${ids[ids.length - 1]} vs clock ${before}..${after}`);
}

console.log("\ntwo markets opened together get two ids, and each reads as itself");
{
  const QA = "Will the first of two simultaneous markets resolve YES?";
  const QB = "Will the second of two simultaneous markets resolve YES?";
  const [a, b] = await Promise.all([open(QA), open(QB)]);
  check("different ids", a.marketId !== b.marketId, `${a.marketId} / ${b.marketId}`);
  check("different slugs", a.slug !== b.slug);
  check("the first market's page shows the first question", (await reads(a.slug)) === QA, await reads(a.slug));
  check("the second market's page shows the second question, not the first",
    (await reads(b.slug)) === QB, await reads(b.slug));
}

console.log("\nan id that is already taken is refused, never merged into the market holding it");
{
  const QHeld = "Will the market that holds this id keep its own question?";
  const QLate = "Will a late market on the same id overwrite the first?";
  const held = await open(QHeld);
  const late = await open(QLate, held.marketId).then(() => null, (e: Error) => e);
  check("opening a second market on a taken id throws", late instanceof Error, String(late));
  check("...and says which market holds it", late?.message.includes(held.slug) === true, late?.message);
  check("the market holding the id still reads as itself", (await reads(held.slug)) === QHeld, await reads(held.slug));
  const board = (await openCommunityMarkets()).map((m) => m.question);
  check("no market was opened for the refused question", !board.includes(QLate));
}

console.log("\ntwo requests that both carry the same id: one opens, the other is refused");
{
  // server.ts computes the id once per request and passes it in, which is how
  // two requests in one millisecond met in the first place.
  const id = await nextMarketId();
  const QX = "Will the first of two same-id requests open?";
  const QY = "Will the second of two same-id requests open?";
  const settled = await Promise.allSettled([open(QX, id), open(QY, id)]);
  check("exactly one of them opened", settled.filter((s) => s.status === "fulfilled").length === 1,
    settled.map((s) => s.status).join(", "));
  const i = settled.findIndex((s) => s.status === "fulfilled");
  const won = settled[i];
  const wonReads = won?.status === "fulfilled" ? await reads(won.value.slug) : undefined;
  check("the one that opened reads as the question IT asked for, not the other's",
    wonReads === [QX, QY][i], `${wonReads} (opened by request ${i})`);
}

console.log(failures === 0 ? "\nall market-id checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
