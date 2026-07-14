// READ-ONLY. The funnel, split by allowlist cohort. A device is attributed to a
// cohort once it signs in and its account's email/x_uid matches an allowlist row.
//   DATABASE_URL=<app> npx tsx scripts/cohort-funnel.ts [days]
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const days = Number(process.argv[2] ?? 30);
const CTE = `
WITH canon AS (
  SELECT d AS device_id, COALESCE(
    (SELECT a.canonical_device FROM device_account da JOIN account a ON a.id=da.account_id WHERE da.device_id=d LIMIT 1), d) AS c
  FROM (SELECT DISTINCT device_id d FROM event WHERE at > now() - interval '${days} days') s
),
coh AS (
  SELECT canon.device_id, COALESCE(al.cohort,'default') cohort FROM canon
  LEFT JOIN account a ON a.canonical_device = canon.c
  LEFT JOIN allowlist al ON (al.email IS NOT NULL AND lower(al.email)=lower(a.email))
                         OR (al.x_uid IS NOT NULL AND a.provider='twitter' AND al.x_uid=a.provider_uid)
)`;
const { rows } = await pool.query(`${CTE}
  SELECT coh.cohort,
    count(DISTINCT e.device_id)::int devices,
    count(*) FILTER (WHERE e.name='feed_view')::int views,
    count(*) FILTER (WHERE e.name='side_tap')::int taps,
    count(*) FILTER (WHERE e.name='amount_confirm')::int confirms,
    count(*) FILTER (WHERE e.name='alerts_view')::int alerts
  FROM event e JOIN coh ON coh.device_id=e.device_id
  WHERE e.at > now() - interval '${days} days'
  GROUP BY coh.cohort ORDER BY devices DESC`);
console.log(`\nfunnel by cohort — last ${days}d\n`);
for (const r of rows as any[]) {
  const depth = (await pool.query(`${CTE} SELECT COALESCE(max(idx)+1,0)::int d FROM event e JOIN coh ON coh.device_id=e.device_id
    WHERE e.name='card_view' AND coh.cohort=$1 AND e.at > now() - interval '${days} days' GROUP BY e.device_id ORDER BY d`, [r.cohort])).rows.map((x:any)=>x.d);
  const med = depth.length ? depth[Math.floor(depth.length/2)] : 0;
  console.log(`  ${r.cohort.padEnd(14)} devices ${String(r.devices).padStart(3)} · views ${String(r.views).padStart(3)} · tap ${String(r.taps).padStart(3)} · confirm ${String(r.confirms).padStart(3)} · tap→call ${r.taps?Math.round(100*r.confirms/r.taps)+"%":"—"} · depth med ${med}/max ${Math.max(0,...depth)} · alerts ${r.alerts}`);
}
await pool.end();
