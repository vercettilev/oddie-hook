// The counter that read zero for months because nothing wrote to it.
//
// page_view existed, viewCounts read it, and the number it produced was always
// zero. Not "nobody came": nobody was ever counted, and from the outside those
// are the same picture. This pins the WIRING, end to end, because every
// individual piece was fine on its own the whole time.
import { readFileSync } from "node:fs";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

const store = readFileSync("src/store/markets.ts", "utf8");
const server = readFileSync("src/server.ts", "utf8");
const page = readFileSync("public/app/market.html", "utf8");

/* THE WRITER EXISTS AND SOMETHING CALLS IT. Either half alone is the bug. */
check("the store can record a view", /export async function recordView\(/.test(store));
check("...and it inserts into the table viewCounts reads",
  /INSERT INTO page_view/.test(store) && /FROM page_view/.test(store));
check("...and a repeat visit collides instead of raising",
  /ON CONFLICT \(slug, device_id\) DO NOTHING/.test(store));

/* CREATE TABLE IF NOT EXISTS NEVER ALTERS AN EXISTING TABLE, so a constraint
   written inside the table definition would simply not exist in production.
   It has to be its own statement. */
check("the uniqueness is its own statement, not a column in the definition",
  /CREATE UNIQUE INDEX IF NOT EXISTS page_view_once_idx/.test(store));

check("the server exposes a route", /app\.post\("\/api\/view"/.test(server));
check("...and that route calls the writer", /recordView\(/.test(server));
check("...and imports it", /import \{[^}]*recordView[^}]*\} from "\.\/store\/markets\.js"/.test(server));

/* THE BROWSER IS WHAT REPORTS, and that is the whole reason this is not a
   one-line counter in the page route: /m/<slug> is also what X fetches to
   build the unfurl card under every reply the bot posts. Counting there counts
   the crawler. */
check("the market page reports its own view", /fetch\("\/api\/view"/.test(page));
check("...sending the slug and the device", /slug: SLUG/.test(page) && /OddieId/.test(page));
check("the page route does NOT count, or the crawler would",
  !/recordView\(/.test(server.slice(server.indexOf('app.get(["/m/:slug"'), server.indexOf('app.get(["/m/:slug"') + 1200)),
  "counting in /m/:slug would count X's unfurl fetch");

console.log(failures ? `\n${failures} failure(s)\n` : "\nall green\n");
process.exit(failures ? 1 : 0);
