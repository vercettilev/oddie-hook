// Read-only prod counts for the settlement/handle rollout. No writes.
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const one = async (label: string, sql: string) => console.log(label.padEnd(16), (await pool.query(sql)).rows[0].c);
await one("calls total", "SELECT count(*)::int c FROM market_call");
await one("closed", "SELECT count(*)::int c FROM market_call WHERE closed_at IS NOT NULL");
await one("closed+scored", "SELECT count(*)::int c FROM market_call WHERE closed_at IS NOT NULL AND pct_at IS NOT NULL AND exit_pct IS NOT NULL AND device_id IS NOT NULL");
await one("open", "SELECT count(*)::int c FROM market_call WHERE closed_at IS NULL");
await one("balances", "SELECT count(*)::int c FROM device_balance");
await one("handles set", "SELECT count(*)::int c FROM device_balance WHERE handle IS NOT NULL");
await one("notices", "SELECT count(*)::int c FROM notice");
await pool.end();
