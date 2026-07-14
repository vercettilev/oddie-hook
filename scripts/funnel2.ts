// Read-only: the post-seeding funnel, by day and by gate.
import pg from "pg";
import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync("scripts/operators.json","utf8"));
const ops = [...(j.confirmed??[]), ...(j.suspected??[])];
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const q = async (sql: string, p: unknown[] = [ops]) => (await pool.query(sql, p)).rows;
const NOTOP = `device_id != ALL($1)`;

console.log("═══ TEMIZ HUNI (7g)");
const [f] = await q(`SELECT count(DISTINCT device_id)::int devices,
    count(*) FILTER (WHERE name='feed_view')::int views,
    count(*) FILTER (WHERE name='feed_view' AND slug IS NOT NULL AND slug NOT LIKE '%%5B%%' AND slug != '[slug]')::int real_gate,
    count(*) FILTER (WHERE name='feed_view' AND (slug LIKE '%%5B%%' OR slug = '[slug]'))::int broken_gate,
    count(*) FILTER (WHERE name='feed_view' AND slug IS NULL)::int direct,
    count(*) FILTER (WHERE name='side_tap')::int taps,
    count(*) FILTER (WHERE name='amount_confirm')::int confirms,
    count(*) FILTER (WHERE name='alerts_view')::int alerts_views,
    count(*) FILTER (WHERE name='notice_view')::int notice_views
  FROM event WHERE ${NOTOP} AND at > now() - interval '7 days'`);
console.log(`  cihaz ${f.devices} · view ${f.views} (gercek-kapi ${f.real_gate} / bozuk-[slug] ${f.broken_gate} / dogrudan ${f.direct})`);
console.log(`  tap ${f.taps} · confirm ${f.confirms} · tap→call ${f.taps?Math.round(100*f.confirms/f.taps)+"%":"—"}`);
console.log(`  alerts_view ${f.alerts_views} · notice_view ${f.notice_views}`);
const depth = (await q(`SELECT max(idx)+1 d FROM event WHERE name='card_view' AND ${NOTOP} AND at > now() - interval '7 days' GROUP BY device_id ORDER BY d`)).map(r=>Number(r.d));
console.log(`  derinlik: median ${depth[Math.floor(depth.length/2)]??0}, max ${Math.max(0,...depth)}, dagilim [${depth.join(",")}]`);
const [ret] = await q(`SELECT count(*)::int n FROM (SELECT device_id FROM event WHERE name='feed_view' AND ${NOTOP} AND at > now() - interval '7 days' GROUP BY device_id HAVING count(DISTINCT date_trunc('day', at))>1) t`);
console.log(`  farkli gunde donen: ${ret.n}`);

console.log("\\n═══ INIS KAPILARI (slug -> cihaz sayisi, 7g)");
for (const r of await q(`SELECT slug, count(DISTINCT device_id)::int devs, to_char(min(at) AT TIME ZONE 'UTC','MM-DD') first_seen
  FROM event WHERE name='feed_view' AND slug IS NOT NULL AND ${NOTOP} AND at > now() - interval '7 days'
  GROUP BY slug ORDER BY devs DESC, first_seen`))
  console.log(`  ${String(r.slug).slice(0,52).padEnd(53)} ${r.devs} cihaz  (ilk: ${r.first_seen})`);

console.log("\\n═══ GUN KIRILIMI");
for (const r of await q(`SELECT to_char(at AT TIME ZONE 'UTC', 'MM-DD') d,
    count(DISTINCT device_id)::int devices,
    count(*) FILTER (WHERE name='feed_view')::int views,
    count(*) FILTER (WHERE name='side_tap')::int taps,
    count(*) FILTER (WHERE name='amount_confirm')::int confirms
  FROM event WHERE ${NOTOP} AND at > now() - interval '7 days' GROUP BY 1 ORDER BY 1`))
  console.log(`  ${r.d}  cihaz ${String(r.devices).padStart(2)} · view ${String(r.views).padStart(3)} · tap ${String(r.taps).padStart(2)} · confirm ${r.confirms}`);

console.log("\\n═══ SETTLED + BILDIRIM ERISIMI");
for (const r of await q(`SELECT left(n.device_id,8) dev, left(n.body,50) body,
    EXISTS(SELECT 1 FROM event e WHERE e.device_id=n.device_id AND e.name='notice_view' AND e.at>n.created_at) AS seen
  FROM notice n WHERE n.device_id != ALL($1) ORDER BY n.created_at`))
  console.log(`  ${r.dev}… "${r.body}"  GORDU:${r.seen}`);
await pool.end();
