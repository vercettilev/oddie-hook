// Read-only. Prints the whole Week-1 baseline: every row of every table we write.
// No arguments, no deletes. If this prints anything after seeding starts, it is
// a real visitor.
import pg from "pg";

// `railway run` injects the private-network host, which does not resolve from a
// laptop. The public URL is the same database, reachable from outside.
const url = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: url, max: 2 });

const rows = async (sql: string) => (await pool.query(sql)).rows;

const counts = await rows(`
  SELECT 'event' AS t, count(*)::int AS n FROM event
  UNION ALL SELECT 'market_call', count(*)::int FROM market_call
  UNION ALL SELECT 'device_balance', count(*)::int FROM device_balance`);
for (const r of counts) console.log(`  ${String(r.t).padEnd(15)} ${r.n}`);

const bal = await rows(`SELECT device_id, tokens, created_at FROM device_balance ORDER BY created_at`);
if (bal.length) {
  console.log(`\n  device_balance:`);
  for (const r of bal) console.log(`    ${r.device_id}  ${r.tokens} token  ${r.created_at.toISOString()}`);
}
const evs = await rows(`SELECT name, device_id, count(*)::int AS n FROM event GROUP BY 1,2 ORDER BY 3 DESC`);
if (evs.length) {
  console.log(`\n  event:`);
  for (const r of evs) console.log(`    ${String(r.name).padEnd(14)} ${r.device_id}  x${r.n}`);
}
const calls = await rows(`SELECT slug, side, tokens, device_id FROM market_call ORDER BY at`);
if (calls.length) {
  console.log(`\n  market_call:`);
  for (const r of calls) console.log(`    ${r.slug}  ${r.side}  ${r.tokens}  ${r.device_id}`);
}
await pool.end();
