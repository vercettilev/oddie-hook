// Undo exactly the rows a post-deploy verification created, and nothing else.
// `schema-trigger-readonly` was minted by a GET /api/positions used to force the
// schema migration — that endpoint reads positions but calls getWallet, which
// creates a balance row. Everything else in these tables is real traffic.
//
// Dry-run by default. Pass --delete to commit.
import pg from "pg";

// Rows this session's verification created. Named explicitly, never inferred.
// Both were minted by GET /api/me — an endpoint that reads a wallet and, on a
// device it has never seen, creates one. "Read-only" was wrong twice.
const MINE = ["deployprobe-notreal-xyz"];
const commit = process.argv.includes("--delete");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL, max: 2 });

for (const t of ["event", "market_call", "device_balance"]) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE device_id = ANY($1)`, [MINE]);
  console.log(`  ${t.padEnd(15)} eslesen: ${rows[0].n}`);
}
// A call from either id would mean the verification spent tokens. It did not —
// Confirm was never pressed — but assert it rather than assume it.
const { rows: calls } = await pool.query(`SELECT count(*)::int AS n FROM market_call WHERE device_id = ANY($1)`, [MINE]);
if (calls[0].n > 0) throw new Error("verification device has a market_call — refusing to touch it blindly");

if (!commit) { console.log("\n  kuru calisma. silmek icin --delete"); await pool.end(); process.exit(0); }

for (const t of ["event", "device_balance"]) {
  const r = await pool.query(`DELETE FROM ${t} WHERE device_id = ANY($1)`, [MINE]);
  console.log(`  ${t}: ${r.rowCount} satir silindi`);
}
const { rows: after } = await pool.query(`
  SELECT 'event' AS t, count(*)::int AS n FROM event
  UNION ALL SELECT 'market_call', count(*)::int FROM market_call
  UNION ALL SELECT 'device_balance', count(*)::int FROM device_balance`);
console.log("\n  silme sonrasi toplam:");
for (const r of after) console.log(`    ${String(r.t).padEnd(15)} ${r.n}`);
await pool.end();
