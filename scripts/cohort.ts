// Operator-clean before/after around the one-tap deploy. Read-only.
//   DATABASE_URL=... npx tsx scripts/cohort.ts <cutoff-iso>
import pg from "pg";
import { readFileSync } from "node:fs";
const cutoff = process.argv[2];
if (!cutoff) { console.error("cutoff ISO required"); process.exit(1); }
const ops = (() => { try { const j = JSON.parse(readFileSync("scripts/operators.json", "utf8"));
  return [...(j.confirmed ?? []), ...(j.suspected ?? [])]; } catch { return []; } })();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const NOTOP = `device_id != ALL($2)`;

async function cohort(label: string, cond: string) {
  const q = async (sql: string) => (await pool.query(sql, [cutoff, ops])).rows;
  const [a] = await q(`SELECT count(DISTINCT device_id)::int devices,
      count(*) FILTER (WHERE name='feed_view')::int views,
      count(*) FILTER (WHERE name='side_tap')::int taps,
      count(*) FILTER (WHERE name='amount_confirm')::int confirms
    FROM event WHERE ${cond} AND ${NOTOP} AND at > now() - interval '7 days'`);
  console.log(`\n═══ ${label}`);
  console.log(`  devices ${a.devices} · feed views ${a.views} · side_taps ${a.taps} · confirms ${a.confirms}`
    + ` · tap→call ${a.taps ? Math.round(100 * a.confirms / a.taps) + "%" : "—"}`);
  return a;
}
await cohort("PRE-FIX (one-tap oncesi)", `at < $1`);
const post = await cohort("POST-FIX (one-tap sonrasi)", `at >= $1`);

if (post.devices > 0) {
  console.log(`\n  post-fix detay:`);
  const depth = (await pool.query(`SELECT device_id, max(idx)+1 d FROM event
    WHERE name='card_view' AND at >= $1 AND ${NOTOP} GROUP BY device_id ORDER BY d`, [cutoff, ops])).rows;
  const ds = depth.map((r) => Number(r.d));
  console.log(`  kart derinligi: median ${ds.length ? ds[Math.floor(ds.length / 2)] : 0}, dagilim [${ds.join(", ")}]`);
  const slugs = (await pool.query(`SELECT slug, count(DISTINCT device_id)::int devs FROM event
    WHERE name='feed_view' AND slug IS NOT NULL AND at >= $1 AND ${NOTOP} GROUP BY slug ORDER BY devs DESC`, [cutoff, ops])).rows;
  console.log(`  inis slug'lari:`); for (const s of slugs) console.log(`    ${String(s.slug).slice(0, 48)}  ${s.devs} cihaz`);
  const ret = (await pool.query(`SELECT count(*)::int n FROM (
    SELECT device_id FROM event WHERE name='feed_view' AND device_id != ALL($1) AND at > now() - interval '7 days'
    GROUP BY device_id HAVING count(DISTINCT date_trunc('day', at)) > 1) t`, [ops])).rows[0];
  console.log(`  farkli gunde geri donen (7g, tum pencere): ${ret.n}`);
  // per-device post-fix mini timeline: taps vs confirms per visitor
  const per = (await pool.query(`SELECT left(device_id,8) dev,
      count(*) FILTER (WHERE name='side_tap')::int taps,
      count(*) FILTER (WHERE name='amount_confirm')::int confirms,
      max(idx) FILTER (WHERE name='card_view') depth
    FROM event WHERE at >= $1 AND ${NOTOP} GROUP BY device_id ORDER BY taps DESC`, [cutoff, ops])).rows;
  console.log(`  cihaz bazinda: ` + per.map((r) => `${r.dev}…(tap ${r.taps}/conf ${r.confirms}/derinlik ${r.depth ?? 0})`).join("  "));
}
await pool.end();
