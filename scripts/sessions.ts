// Read-only: one device's full event sequence, in order, with the drop-off
// diagnosis the funnel can't show — did they bounce on the landing card,
// scroll and leave, or tap a side and abandon the amount picker?
//
//   DATABASE_URL=... npx tsx scripts/sessions.ts <device_id_prefix> [...more]
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const prefixes = process.argv.slice(2);
for (const p of prefixes) {
  const { rows } = await pool.query(
    `SELECT name, slug, idx, side, cat, at FROM event
      WHERE device_id LIKE $1 || '%' AND at > now() - interval '7 days' ORDER BY at, id`, [p]);
  if (!rows.length) { console.log(`\n══ ${p}…  (olay yok)`); continue; }
  const t0 = new Date(rows[0].at).getTime();
  const tEnd = new Date(rows[rows.length - 1].at).getTime();
  const dur = Math.round((tEnd - t0) / 1000);
  const cards = rows.filter((r) => r.name === "card_view");
  const maxIdx = Math.max(-1, ...cards.map((r) => r.idx ?? 0));
  const taps = rows.filter((r) => r.name === "side_tap").length;
  const confirms = rows.filter((r) => r.name === "amount_confirm").length;
  console.log(`\n══ ${p}…  ${rows.length} olay, ${dur >= 60 ? Math.round(dur / 60) + "dk" : dur + "s"} — kart ${cards.length} goruntuleme (en derin #${maxIdx}), ${taps} side_tap, ${confirms} confirm`);
  if (taps > 0 && confirms === 0) console.log(`   >>> PICKER TERKI: taraf secti, miktar onaylamadi <<<`);
  for (const r of rows) {
    const dt = Math.round((new Date(r.at).getTime() - t0) / 1000);
    const bits = [r.name.padEnd(14),
      r.idx !== null && r.idx !== undefined ? `#${r.idx}` : "",
      r.side ?? "", r.cat ?? "",
      r.slug ? String(r.slug).slice(0, 34) : ""].filter(Boolean).join(" ");
    console.log(`   +${String(dt).padStart(4)}s ${bits}`);
  }
}
await pool.end();
