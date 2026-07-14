// READ-ONLY against prod-postgres. Computes an invite wave and writes it to a
// local JSON for approval. NO writes to any database here.
//   TIER=1|2  DATABASE_URL=<prod> npx tsx scripts/wave-read.ts <out.json>
import pg from "pg";
import { writeFileSync } from "node:fs";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const out = process.argv[2];
const tier = process.env.TIER ?? "1";

const NU = `u.id NOT IN (SELECT user_id FROM uninstalls WHERE user_id IS NOT NULL)`;
const HAS_ID = `((u.twitter_id IS NOT NULL AND u.twitter_id <> '') OR (u.google_id IS NOT NULL AND u.google_id <> ''))`;
const P30 = `u.id IN (SELECT user_id FROM website_posts WHERE created_at > now()-interval '30 days' AND deleted_at IS NULL)`;
const DL30 = `u.id IN (SELECT user_id FROM daily_logins WHERE login_date > current_date - 30)`;

// Tier 1: posted 30d + has an oauth identity + not uninstalled.
// Tier 2: daily-login 30d + has an oauth identity + not uninstalled, EXCLUDING Tier 1.
const where = tier === "2"
  ? `${DL30} AND ${HAS_ID} AND ${NU} AND NOT (${P30})`
  : `${P30} AND ${HAS_ID} AND ${NU}`;

const { rows } = await pool.query(`
  SELECT u.id, u.username, u.email, u.twitter_id, u.google_id,
         (SELECT max(created_at) FROM website_posts wp WHERE wp.user_id = u.id AND wp.deleted_at IS NULL)::date::text AS last_post,
         (SELECT count(*) FROM website_posts wp WHERE wp.user_id = u.id AND wp.deleted_at IS NULL)::int AS posts,
         (SELECT max(login_date) FROM daily_logins dl WHERE dl.user_id = u.id)::date::text AS last_login
    FROM users u WHERE ${where}
   ORDER BY posts DESC NULLS LAST, last_post DESC NULLS LAST`);

const mask = (e: unknown) => String(e ?? "").replace(/(.{2}).*(@.*)/, "$1…$2");
console.log(`\n═══ WAVE ${tier} — ${rows.length} users\n`);
console.log("handle".padEnd(20), "email".padEnd(24), "X id".padEnd(14), "google", "posts", "last_post", "last_login");
for (const r of rows)
  console.log(
    ("@"+(r.username??"?")).slice(0,19).padEnd(20),
    mask(r.email).slice(0,23).padEnd(24),
    String(r.twitter_id??"—").slice(0,13).padEnd(14),
    (r.google_id?"yes":"no").padEnd(6),
    String(r.posts??0).padStart(5),
    String(r.last_post??"—").padStart(10),
    String(r.last_login??"—").padStart(10));

// Full (unmasked) payload for the write step — stays local, never printed.
const payload = rows.map((r) => ({
  email: r.email, xUid: r.twitter_id || null, xHandle: r.username || null,
  source: `wave${tier}`, hasGoogle: Boolean(r.google_id),
}));
writeFileSync(out, JSON.stringify(payload, null, 2));
console.log(`\nfull payload -> ${out} (${payload.length} rows; not written to any DB)`);
await pool.end();
