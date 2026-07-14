// Settlement, against a real Postgres.
//
// The settlement write is time-stamped (closed_at, exit_pct, proceeds) —
// exactly the shape of the top-up write that silently failed in production
// (NOTES/lessons.md #1). This script proves, on the real column types:
//
//   1. The guard is ROW STATE (`WHERE closed_at IS NULL`), and the source is
//      grep-asserted to contain no timestamp-equality predicate.
//   2. A double-settle touches zero rows and credits zero tokens — and the
//      MUTATED query (guard removed) demonstrably WOULD have double-credited,
//      so the test is known to be able to fail.
//
// One temporary device + slug + calls, created and removed by this script.
//
//   DATABASE_URL=<url> npx tsx scripts/test-settle-db.ts

import pg from "pg";
import { readFileSync } from "node:fs";
import { settleMarket, getWallet } from "../src/store/markets.js";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL required — this test is about the database"); process.exit(1); }

const DEV = `settle-test-${process.pid}`;
const SLUG = `settle-test-slug-${process.pid}`;
const pool = new pg.Pool({ connectionString: url, max: 2 });

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

try {
  console.log("\nthe lesson is followed in the source");
  {
    const src = readFileSync("src/store/markets.ts", "utf8");
    const settleBlock = src.slice(src.indexOf("export async function settleMarket"));
    check("settlement guards on closed_at IS NULL", settleBlock.includes("closed_at IS NULL"));
    check("...and never compares a timestamp for equality",
      !/closed_at\s*=\s*\$/.test(settleBlock) && !/topped_up_at\s*=\s*\$/.test(settleBlock));
  }

  // A device holding one open YES call at entry 40, stake 80.
  await getWallet(DEV); // materialise the balance row (default 1000)
  await pool.query(
    `INSERT INTO market_slug (slug, venue, venue_id, question, yes_pct)
     VALUES ($1, 'polymarket', $2, 'Will the settle-db test pass?', 40)`,
    [SLUG, `settle-test-cond-${process.pid}`],
  );
  await pool.query(
    `INSERT INTO market_call (slug, side, tokens, device_id, pct_at) VALUES ($1, 'yes', 80, $2, 40)`,
    [SLUG, DEV],
  );

  console.log("\nsettlement pays through the real columns");
  {
    const settled = await settleMarket(SLUG, "yes");
    check("one position settles", settled.length === 1);
    check("...at exit 100 for 200 tokens", settled[0]?.exitPct === 100 && settled[0]?.proceeds === 200, JSON.stringify(settled[0]));

    const row = await pool.query(`SELECT closed_at, exit_pct, proceeds FROM market_call WHERE slug = $1`, [SLUG]);
    check("the row genuinely reads closed", row.rows[0].closed_at !== null && row.rows[0].exit_pct === 100 && row.rows[0].proceeds === 200);
    const bal = await pool.query(`SELECT tokens FROM device_balance WHERE device_id = $1`, [DEV]);
    check("the balance genuinely reads 1200", Number(bal.rows[0].tokens) === 1200, `${bal.rows[0].tokens}`);
    const n = await pool.query(`SELECT kind, body, delta FROM notice WHERE device_id = $1`, [DEV]);
    check("a real notice row exists", n.rows.length === 1 && n.rows[0].kind === "settle_win" && n.rows[0].delta === 200, JSON.stringify(n.rows[0]));
  }

  console.log("\nthe double-settle: zero rows, zero tokens");
  {
    const again = await settleMarket(SLUG, "yes");
    check("second settle returns nothing", again.length === 0, `${again.length}`);
    const bal = await pool.query(`SELECT tokens FROM device_balance WHERE device_id = $1`, [DEV]);
    check("balance still 1200 — no double credit", Number(bal.rows[0].tokens) === 1200, `${bal.rows[0].tokens}`);
    const n = await pool.query(`SELECT count(*)::int AS c FROM notice WHERE device_id = $1`, [DEV]);
    check("still exactly one notice", n.rows[0].c === 1, `${n.rows[0].c}`);
  }

  console.log("\nmutation: WITHOUT the state guard, the same statement re-pays");
  {
    // The settlement UPDATE with `closed_at IS NULL` deleted — the bug this
    // test exists to keep dead. Run it and show it matches the already-settled
    // row, which is exactly the double-credit the guard prevents.
    const mutant = await pool.query(
      `UPDATE market_call SET
         closed_at = now(),
         exit_pct  = CASE WHEN side = 'yes' THEN 100 ELSE 0 END,
         proceeds  = CASE WHEN side = 'yes' THEN CAST(round(tokens * 100.0 / pct_at) AS integer) ELSE 0 END
       WHERE slug = $1 AND pct_at IS NOT NULL
       RETURNING id`,
      [SLUG],
    );
    check("the guard-less mutant re-touches the settled row (the test CAN fail)",
      mutant.rows.length === 1, `${mutant.rows.length}`);
  }
} finally {
  const del1 = await pool.query(`DELETE FROM notice WHERE device_id = $1`, [DEV]);
  const del2 = await pool.query(`DELETE FROM market_call WHERE slug = $1`, [SLUG]);
  const del3 = await pool.query(`DELETE FROM market_slug WHERE slug = $1`, [SLUG]);
  const del4 = await pool.query(`DELETE FROM device_balance WHERE device_id = $1`, [DEV]);
  console.log(`\ncleanup: ${del1.rowCount} notice, ${del2.rowCount} call, ${del3.rowCount} slug, ${del4.rowCount} balance row(s) removed`);
  if (del2.rowCount !== 1 || del4.rowCount !== 1) console.error("CLEANUP LOOKS WRONG — check the rows above by hand");
  await pool.end();
}

console.log(failures === 0 ? "all settle-db checks passed.\n" : `${failures} settle-db check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
