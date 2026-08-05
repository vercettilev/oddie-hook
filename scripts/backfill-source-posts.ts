// Fill in the source-post text for markets recorded before we started
// fetching it. See backfillSourcePosts in the store for the actual work and
// for why it is deliberately slow and bounded.
//
// DRY RUN by default — it fetches and reports, and writes nothing. Pass
// --apply to write. That default is on purpose: this makes external requests
// and mutates a table, and the first thing anyone should do is look at what
// it WOULD do.
//
//   npm run backfill-posts                 # dry run, 25 rows
//   npm run backfill-posts -- --limit 100  # dry run, 100 rows
//   npm run backfill-posts -- --apply      # write, 25 rows
//
// Against production this needs DATABASE_URL set to the production database.
// It is resumable: every run picks up rows that still have no text, so it can
// be run repeatedly until `candidates` comes back 0.

import { backfillSourcePosts } from "../src/store/markets.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const limIdx = args.indexOf("--limit");
const limit = limIdx >= 0 ? Number(args[limIdx + 1]) || 25 : 25;

if (!process.env.DATABASE_URL) {
  console.log("note: DATABASE_URL is unset — running against the in-memory store,");
  console.log("      which is empty in a fresh process. Set it to backfill real rows.\n");
}

console.log(`${apply ? "APPLYING" : "DRY RUN"} · up to ${limit} row(s)\n`);
const r = await backfillSourcePosts(limit, { apply });

console.log(`candidates (had a URL, no text): ${r.candidates}`);
console.log(`fetched successfully           : ${r.fetched}`);
console.log(`written                        : ${r.written}${apply ? "" : "  (dry run — pass --apply)"}`);
console.log(`failed (deleted/private/error) : ${r.failed}`);

if (!apply && r.fetched > 0) {
  console.log(`\n${r.fetched} post(s) would be filled in. Re-run with --apply to write them.`);
}
if (r.candidates === limit) {
  console.log(`\nHit the limit — there are probably more. Run again to continue.`);
}
process.exit(0);
