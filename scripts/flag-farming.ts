// READ-ONLY. Obvious leaderboard-farming signals per device, with cohort.
//   DATABASE_URL=<app> npx tsx scripts/flag-farming.ts [hours]
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const hrs = Number(process.argv[2] ?? 48);
const { rows } = await pool.query(`
WITH canon AS (
  SELECT d device_id, COALESCE((SELECT a.canonical_device FROM device_account da JOIN account a ON a.id=da.account_id WHERE da.device_id=d LIMIT 1), d) c
  FROM (SELECT DISTINCT device_id d FROM market_call) s
),
coh AS (SELECT canon.device_id, COALESCE(al.cohort,'default') cohort FROM canon
  LEFT JOIN account a ON a.canonical_device=canon.c
  LEFT JOIN allowlist al ON (al.email IS NOT NULL AND lower(al.email)=lower(a.email)) OR (al.x_uid IS NOT NULL AND a.provider='twitter' AND al.x_uid=a.provider_uid)),
calls AS (SELECT device_id, count(*)::int c, count(DISTINCT date_trunc('minute',at))::int mins,
  max(cnt)::int burst FROM (SELECT device_id, at, count(*) OVER (PARTITION BY device_id ORDER BY at RANGE BETWEEN interval '5 min' PRECEDING AND CURRENT ROW) cnt
    FROM market_call WHERE at > now() - interval '${hrs} hours') w GROUP BY device_id),
views AS (SELECT device_id, count(*) FILTER (WHERE name='card_view')::int cv FROM event WHERE at > now() - interval '${hrs} hours' GROUP BY device_id)
SELECT left(calls.device_id,8) dev, COALESCE(coh.cohort,'default') cohort, calls.c calls, calls.burst, calls.mins active_min, COALESCE(views.cv,0) card_views,
  CASE WHEN COALESCE(views.cv,0)=0 THEN calls.c ELSE round(calls.c::numeric/views.cv,1) END AS call_per_view
FROM calls LEFT JOIN coh ON coh.device_id=calls.device_id LEFT JOIN views ON views.device_id=calls.device_id
ORDER BY calls.burst DESC, calls.c DESC`);
console.log(`\nfarming watch — last ${hrs}h  (burst = max calls in any 5-min window; high call/view = calling without reading)\n`);
console.log("dev       cohort         calls burst active_min card_views call/view  FLAGS");
for (const r of rows as any[]) {
  const flags = [];
  if (r.burst >= 8) flags.push("BURST");
  if (Number(r.call_per_view) >= 3) flags.push("no-read");
  if (r.calls >= 20 && r.active_min <= 5) flags.push("machine-gun");
  console.log(`${r.dev}  ${String(r.cohort).padEnd(14)} ${String(r.calls).padStart(5)} ${String(r.burst).padStart(5)} ${String(r.active_min).padStart(10)} ${String(r.card_views).padStart(10)} ${String(r.call_per_view).padStart(9)}  ${flags.join(" ")||"—"}`);
}
if (!rows.length) console.log("  (no calls in window)");
await pool.end();
