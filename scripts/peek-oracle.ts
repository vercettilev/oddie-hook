// Read-only: every oracle decision production has ever recorded, and which of
// them actually spent a model call.
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_PUBLIC_URL, max: 2 });
const { rows } = await pool.query(
  `SELECT gate, paid, count(*)::int AS n, min(decided_at) AS first, max(decided_at) AS last
     FROM oracle_decision GROUP BY gate, paid ORDER BY n DESC`);
console.log("gate                paid   adet   ilk               son");
for (const r of rows) {
  console.log(`${String(r.gate).padEnd(20)}${String(r.paid).padEnd(7)}${String(r.n).padEnd(7)}`
    + `${r.first?.toISOString().slice(0,16)}  ${r.last?.toISOString().slice(0,16)}`);
}
const p = await pool.query(`SELECT count(*)::int AS n FROM oracle_decision WHERE paid`);
console.log(`\nucretli karar toplami: ${p.rows[0].n}`);
await pool.end();
