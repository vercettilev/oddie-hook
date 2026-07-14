// Read-only: ground truth for post-fix conversion + settlement reach.
import pg from "pg";
import { readFileSync } from "node:fs";
const ops = [...(JSON.parse(readFileSync("scripts/operators.json","utf8")).confirmed??[]),
             ...(JSON.parse(readFileSync("scripts/operators.json","utf8")).suspected??[])];
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const CUT = "2026-07-11T11:57:11Z";

console.log("── POST-FIX gercek call satirlari (market_call, event degil):");
const calls = (await pool.query(`
  SELECT left(device_id,8) dev, count(*)::int calls FROM market_call
   WHERE at >= $1 AND device_id != ALL($2) GROUP BY device_id ORDER BY calls DESC`, [CUT, ops])).rows;
let total = 0; for (const r of calls) { total += r.calls; console.log(`   ${r.dev}… ${r.calls} call`); }
console.log(`   TOPLAM: ${total} gercek call (event confirm sayisi 4 idi)`);

console.log("\n── non-operator settled pozisyonlar (7g):");
const settled = (await pool.query(`
  SELECT left(mc.device_id,8) dev, mc.side, mc.pct_at, mc.exit_pct, mc.proceeds, ms.question
    FROM market_call mc JOIN market_slug ms ON ms.slug = mc.slug
   WHERE mc.closed_at IS NOT NULL AND mc.exit_pct IN (0,100)
     AND mc.device_id != ALL($1) AND mc.closed_at > now() - interval '7 days'
   ORDER BY mc.closed_at`, [ops])).rows;
for (const r of settled) console.log(`   ${r.dev}… ${r.side.toUpperCase()} @${r.pct_at}% -> ${r.exit_pct}% (+${r.proceeds})  ${String(r.question).slice(0,40)}`);
if (!settled.length) console.log("   yok");

console.log("\n── notice satirlari + sonrasinda geri geldi mi (gorme proxy'si):");
const notices = (await pool.query(`
  SELECT n.device_id, left(n.device_id,8) dev, n.body, n.created_at,
         EXISTS(SELECT 1 FROM event e WHERE e.device_id = n.device_id AND e.at > n.created_at) AS came_back_after
    FROM notice n WHERE n.device_id != ALL($1) ORDER BY n.created_at`, [ops])).rows;
for (const r of notices) console.log(`   ${r.dev}… "${String(r.body).slice(0,54)}"  sonra-geldi:${r.came_back_after}`);
if (!notices.length) console.log("   yok");
await pool.end();
