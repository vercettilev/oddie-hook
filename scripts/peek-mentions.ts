// Read-only. What the mention ledger says happened to every tag, and where each
// market actually came from. No writes, no arguments.
import pg from "pg";

const url = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: url, max: 2 });
const rows = async (sql: string) => (await pool.query(sql)).rows;

const m = await rows(`SELECT tweet_id, author, outcome, reason, slug, reply_id, claim_text, at
                        FROM x_mention ORDER BY at DESC LIMIT 25`);
console.log(`x_mention: ${m.length} row(s)`);
for (const r of m) {
  console.log(`  ${r.at?.toISOString().slice(0, 16)} | ${String(r.outcome).padEnd(8)}`
    + ` | @${r.author ?? "?"} | reply=${r.reply_id ?? "-"} | slug=${r.slug ?? "-"} | ${r.reason ?? ""}`);
  if (r.claim_text) console.log(`      graded: ${JSON.stringify(String(r.claim_text).slice(0, 160))}`);
}

const c = await rows(`SELECT cm.slug, cm.created_at, g.handle AS tagger, g.source_handle,
                             ms.source_url
                        FROM community_market cm
                        LEFT JOIN genesis_tag g ON g.slug = cm.slug
                        LEFT JOIN market_surfacer ms ON ms.slug = cm.slug
                       ORDER BY cm.created_at DESC LIMIT 10`);
console.log(`\ncommunity_market: ${c.length} row(s)`);
for (const r of c) {
  console.log(`  ${r.created_at?.toISOString().slice(0, 16)} | ${r.slug}`);
  console.log(`      tagger=${r.tagger ?? "-"}  claimAuthor=${r.source_handle ?? "-"}  src=${r.source_url ?? "-"}`);
}
await pool.end();
