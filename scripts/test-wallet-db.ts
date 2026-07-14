// The top-up, against a real Postgres.
//
// This file exists because the in-memory tests cannot fail the way production
// did: they compare numbers, and the bug was that Postgres keeps timestamptz to
// the microsecond while a JS Date truncates to the millisecond, so the UPDATE's
// `WHERE topped_up_at = $jsDate` matched nothing and the grant was never
// written. Every offline assertion passed. Nobody would ever have been topped up.
//
// So: one temporary device, created and removed by this script, exercising the
// real query against the real column type.
//
//   DATABASE_URL=<url> npm run test-wallet-db
//
// It touches nothing it did not create. If it cannot clean up, it says so
// loudly rather than leaving a row behind quietly.
import pg from "pg";
import { getWallet } from "../src/store/markets.js";
import { DAILY_TOPUP, TOKEN_FLOOR, TOPUP_INTERVAL_MS } from "../src/store/economy.js";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL required — this test is about the database"); process.exit(1); }

const DEV = `wallet-test-${process.pid}`;
const pool = new pg.Pool({ connectionString: url, max: 2 });

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

try {
  // A device that spent down and last collected more than a window ago.
  await getWallet(DEV); // creates the row at the default 1000
  await pool.query(
    `UPDATE device_balance SET tokens = 40, topped_up_at = now() - make_interval(secs => $1) WHERE device_id = $2`,
    [TOPUP_INTERVAL_MS / 1000 + 60, DEV],
  );

  console.log("\na due top-up is actually written");
  const w = await getWallet(DEV);
  check("the grant is reported", w.granted === DAILY_TOPUP, `granted ${w.granted}`);
  check("the balance rises to 240", w.tokens === 240, `${w.tokens}`);

  // The bug: the API said one thing and the row said another.
  const row = await pool.query<{ tokens: number }>(`SELECT tokens FROM device_balance WHERE device_id = $1`, [DEV]);
  check("...and the ROW says 240 too", row.rows[0].tokens === 240, `row has ${row.rows[0].tokens}`);

  console.log("\nthe window closes behind it");
  const again = await getWallet(DEV);
  check("a second read in the same window grants nothing", again.granted === 0, `granted ${again.granted}`);
  check("...and the balance holds", again.tokens === 240, `${again.tokens}`);
  check("...and a countdown is reported", again.nextTopUpMs !== null && again.nextTopUpMs > TOPUP_INTERVAL_MS - 60_000);

  console.log("\na device at the floor is not topped up");
  await pool.query(
    `UPDATE device_balance SET tokens = $1, topped_up_at = now() - make_interval(secs => $2) WHERE device_id = $3`,
    [TOKEN_FLOOR, TOPUP_INTERVAL_MS / 1000 + 60, DEV],
  );
  const full = await getWallet(DEV);
  check("no grant at the floor", full.granted === 0 && full.tokens === TOKEN_FLOOR, JSON.stringify(full));
  check("...and no countdown to offer", full.nextTopUpMs === null);
  const stamped = await pool.query<{ fresh: boolean }>(
    `SELECT topped_up_at > now() - interval '1 minute' AS fresh FROM device_balance WHERE device_id = $1`, [DEV]);
  check("...but its window still advanced", stamped.rows[0].fresh === true);

  console.log("\na grant never overshoots the floor");
  await pool.query(
    `UPDATE device_balance SET tokens = $1, topped_up_at = now() - make_interval(secs => $2) WHERE device_id = $3`,
    [TOKEN_FLOOR - 50, TOPUP_INTERVAL_MS / 1000 + 60, DEV],
  );
  const capped = await getWallet(DEV);
  check("the shortfall is granted, not the full 200", capped.granted === 50 && capped.tokens === TOKEN_FLOOR, JSON.stringify(capped));
} finally {
  const del = await pool.query(`DELETE FROM device_balance WHERE device_id = $1`, [DEV]);
  const left = await pool.query<{ n: string }>(`SELECT count(*) n FROM device_balance WHERE device_id = $1`, [DEV]);
  if (Number(left.rows[0].n) !== 0) { console.error(`  !! could not remove ${DEV} — remove it by hand`); failures++; }
  else console.log(`\n  temizlendi: ${DEV} (${del.rowCount} satir)`);
  await pool.end();
}

console.log(failures === 0 ? "\nall wallet-db checks passed.\n" : `\n${failures} wallet-db check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
