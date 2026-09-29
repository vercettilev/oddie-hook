/**
 * EVERY SQL STATEMENT IN A STORE FILE, CHECKED BY THE REAL DATABASE.
 *
 * The memory stores the test suite runs against never see a line of SQL, so a
 * query can be wrong in exactly the way no test notices. The first live Kick
 * test found one: the standings query ordered by a column aliased `right`,
 * RIGHT is reserved in Postgres, the query was a syntax error, and the page
 * showed empty standings over two scored calls.
 *
 * This asks Postgres to PREPARE each statement, which parses it and checks it
 * against the real tables and types without executing anything, then drops
 * it. Nothing is read or written.
 *
 *   railway run --service Postgres -- npm run -s check-sql -- src/store/live.ts
 *
 * Statements are the template literals passed to query(); `${CALL_COLS}` is
 * expanded from the same file.
 */
import { readFileSync } from "node:fs";
import pg from "pg";

const files = process.argv.slice(2);
if (!files.length) files.push("src/store/live.ts");
const url = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
if (!url) { console.error("no DATABASE_PUBLIC_URL or DATABASE_URL: run it through railway run"); process.exit(1); }

const client = new pg.Client({ connectionString: url, ssl: /railway\.internal/.test(url) ? false : { rejectUnauthorized: false } });
await client.connect();
let bad = 0, n = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const cols = /const CALL_COLS = `([^`]*)`/.exec(src)?.[1] ?? "";
  const stmts = [...src.matchAll(/query(?:<[^>]*>)?\(\s*`([\s\S]*?)`/g)].map((m) => m[1].replace(/\$\{CALL_COLS\}/g, cols));
  for (const sql of stmts) {
    const name = `chk_${n++}`;
    const head = sql.trim().split(/\s+/).slice(0, 5).join(" ");
    try {
      await client.query(`PREPARE ${name} AS ${sql}`);
      await client.query(`DEALLOCATE ${name}`);
      console.log(`  ✓ ${f}: ${head}`);
    } catch (e) {
      bad++;
      console.log(`  ✗ ${f}: ${head}  ${(e as Error).message}`);
    }
  }
}
await client.end();
console.log(bad ? `\n${bad} of ${n} statement(s) FAILED\n` : `\nall ${n} statements parse against the real database.\n`);
process.exit(bad ? 1 : 0);
