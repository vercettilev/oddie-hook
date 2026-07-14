// Read-only: every device in the window with whatever identity it carries.
// The account lookup goes through canonical_device — the same join the
// leaderboard uses — because that is where an identity actually lives.
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const { rows } = await pool.query(`
  SELECT e.device_id,
         min(e.at) first_seen, max(e.at) last_seen, count(*)::int events,
         count(*) FILTER (WHERE e.name='amount_confirm')::int calls,
         db.handle,
         acct.provider, acct.handle AS acct_handle
    FROM event e
    LEFT JOIN device_balance db ON db.device_id = e.device_id
    LEFT JOIN LATERAL (
      SELECT a.provider, a.handle FROM account a
       WHERE a.canonical_device = e.device_id
          OR a.canonical_device = (SELECT a2.canonical_device FROM device_account da
                                    JOIN account a2 ON a2.id = da.account_id
                                   WHERE da.device_id = e.device_id LIMIT 1)
       ORDER BY a.created_at LIMIT 1
    ) acct ON true
   WHERE e.at > now() - interval '7 days'
   GROUP BY e.device_id, db.handle, acct.provider, acct.handle
   ORDER BY min(e.at)`);
for (const r of rows) {
  const who = r.acct_handle ? `${r.acct_handle} — ${r.provider} BAGLI, KESIN OPERATOR` : (r.handle ? `@${r.handle}` : "(handle yok)");
  console.log(`${r.device_id.slice(0,8)}…  ${String(r.events).padStart(3)} olay, ${String(r.calls).padStart(2)} call  ${new Date(r.first_seen).toISOString().slice(5,16)} → ${new Date(r.last_seen).toISOString().slice(5,16)}  ${who}`);
}
await pool.end();
