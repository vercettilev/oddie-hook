// Week-1 funnel, read straight out of Postgres.
//
//   npm run events              -- the whole window
//   npm run events -- 7         -- last 7 days
//   npm run events -- 7 <did>   -- one device's session, event by event
//
// Three questions, in the order CADENCE.md asks them:
//   how many came · how deep did they scroll · how many tapped
//
// Everything here is anonymous. `device_id` is a random string minted by the
// browser; it identifies a browser, not a person, and nothing a person typed is
// stored anywhere near it.

import pg from "pg";

// Inside the container DATABASE_URL points at `*.railway.internal`, which only
// resolves on Railway's private network — `railway run` executes on YOUR laptop,
// so it cannot reach it. From outside, pass the Postgres service's public URL.
const DATABASE_URL = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    "No database URL.\n" +
      "  from your laptop:  DATABASE_PUBLIC_URL='postgresql://…' npm run events\n" +
      "                     (Railway dashboard -> Postgres -> Variables -> DATABASE_PUBLIC_URL)\n" +
      "  from the container: railway ssh --service poppin-hook -- npm run events\n" +
      "                     (needs `railway ssh keys add` once)",
  );
  process.exit(1);
}

const args = process.argv.slice(2).filter((a) => a !== "--all");
const includeOperators = process.argv.includes("--all");
const days = Number(args[0] ?? 30);
const only = args[1] ?? null;
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
const since = `now() - interval '${Number.isFinite(days) ? days : 30} days'`;

// The operator's own devices poison every number they touch, so they are out
// by default and back only under an explicit --all. The list lives in
// scripts/operators.json (confirmed + suspected, both excluded); ids are
// whitelisted to uuid-shaped strings before being inlined into SQL.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const opsFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "operators.json");
let operators: string[] = [];
try {
  const j = JSON.parse(readFileSync(opsFile, "utf8"));
  operators = [...(j.confirmed ?? []), ...(j.suspected ?? [])].filter((s: string) => /^[a-f0-9-]{36}$/.test(s));
} catch { /* no list, no exclusion */ }
const opFilter = !includeOperators && operators.length
  ? ` AND device_id NOT IN (${operators.map((o) => `'${o}'`).join(",")})`
  : "";

const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "—");

if (only) {
  // One session, in order. This is the "grep by device_id" view.
  const rows = await q<{ at: Date; name: string; slug: string | null; idx: number | null; side: string | null; cat: string | null }>(
    `SELECT at, name, slug, idx, side, cat FROM event WHERE device_id = $1 ORDER BY at ASC`,
    [only],
  );
  console.log(`\n  device ${only} — ${rows.length} events\n`);
  for (const r of rows) {
    const bits = [r.idx !== null ? `#${r.idx}` : null, r.side, r.cat, r.slug].filter(Boolean).join("  ");
    console.log(`    ${r.at.toISOString().slice(11, 19)}  ${r.name.padEnd(11)} ${bits}`);
  }
  await pool.end();
  process.exit(0);
}

const [{ devices, views, from_tweet }] = await q<{ devices: string; views: string; from_tweet: string }>(
  `SELECT count(DISTINCT device_id) devices, count(*) views,
          count(*) FILTER (WHERE slug IS NOT NULL) from_tweet
     FROM event WHERE name = 'feed_view' AND at > ${since}${opFilter}`,
);

// Depth is per device, not per event: the deepest card index it ever reached,
// +1 because a session that only saw card 0 still saw one card.
const depth = await q<{ device_id: string; depth: number }>(
  `SELECT device_id, max(idx) + 1 AS depth FROM event
    WHERE name = 'card_view' AND at > ${since}${opFilter} GROUP BY device_id ORDER BY depth DESC`,
);
const depths = depth.map((d) => Number(d.depth));
const median = depths.length ? depths[Math.floor(depths.length / 2)] : 0;

const [{ tappers, taps, yes }] = await q<{ tappers: string; taps: string; yes: string }>(
  `SELECT count(DISTINCT device_id) tappers, count(*) taps,
          count(*) FILTER (WHERE side = 'yes') yes
     FROM event WHERE name = 'side_tap' AND at > ${since}${opFilter}`,
);

const [{ returners }] = await q<{ returners: string }>(
  `SELECT count(*) returners FROM (
     SELECT device_id FROM event WHERE name = 'feed_view' AND at > ${since}${opFilter}
      GROUP BY device_id HAVING count(DISTINCT date_trunc('day', at)) > 1) t`,
);

const chips = await q<{ cat: string; n: string }>(
  `SELECT cat, count(*) n FROM event WHERE name = 'cat_change' AND at > ${since}${opFilter} GROUP BY cat ORDER BY n DESC`,
);

const D = Number(devices), T = Number(tappers);
console.log(`\n  Poppin — last ${days} days${opFilter ? `  (operator-clean: ${operators.length} device(s) excluded; --all to include)` : includeOperators ? "  (--all: operators INCLUDED)" : ""}\n`);
console.log(`  how many came`);
console.log(`    devices              ${D}`);
console.log(`    feed views           ${views}   (${from_tweet} arrived on a /market/<slug> door)`);
console.log(`    came back another day ${returners}   ${pct(Number(returners), D)} of devices`);

console.log(`\n  how deep did they scroll`);
console.log(`    devices that saw a card  ${depths.length}`);
console.log(`    median depth             ${median} card(s)`);
console.log(`    depth >= 3               ${depths.filter((d) => d >= 3).length}   ${pct(depths.filter((d) => d >= 3).length, depths.length)}`);
console.log(`    deepest                  ${depths[0] ?? 0}`);

console.log(`\n  how many tapped`);
console.log(`    devices that tapped   ${T}   ${pct(T, D)} of devices`);
console.log(`    taps                  ${taps}   (${yes} yes / ${Number(taps) - Number(yes)} no)`);

if (chips.length) {
  console.log(`\n  category chips`);
  for (const c of chips) console.log(`    ${String(c.cat).padEnd(10)} ${c.n}`);
}

console.log(`\n  one device: npm run events -- ${days} ${depth[0]?.device_id ?? "<device_id>"}\n`);
await pool.end();
