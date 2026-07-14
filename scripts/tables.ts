import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const { rows } = await pool.query(`SELECT table_name, (SELECT count(*) FROM information_schema.columns c WHERE c.table_name=t.table_name) cols FROM information_schema.tables t WHERE table_schema='public' ORDER BY 1`);
for (const r of rows) console.log(` ${r.table_name}`);
await pool.end();
