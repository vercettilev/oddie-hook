// Read-only: what the overnight sweep actually did. No writes.
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const { rows } = await pool.query(`
  SELECT mc.id, left(mc.device_id,8) dev, mc.slug, mc.side, mc.tokens, mc.pct_at, mc.exit_pct, mc.proceeds,
         (mc.exit_pct - mc.pct_at) edge, mc.closed_at
    FROM market_call mc WHERE mc.closed_at IS NOT NULL ORDER BY mc.closed_at`);
console.log("── settled positions:");
for (const r of rows)
  console.log(`  #${r.id} ${r.dev}… ${r.side.toUpperCase().padEnd(3)} stake ${String(r.tokens).padStart(3)} @${r.pct_at}% -> ${String(r.exit_pct).padStart(3)}%  proceeds ${String(r.proceeds).padStart(3)}  edge ${r.edge>0?"+":""}${r.edge}  (${r.slug.slice(0,38)})`);
const n = await pool.query(`SELECT left(device_id,8) dev, kind, body, delta FROM notice ORDER BY id`);
console.log("\n── notices:");
for (const r of n.rows) console.log(`  ${r.dev}… ${r.kind.padEnd(11)} ${r.body.slice(0,86)}`);
await pool.end();
