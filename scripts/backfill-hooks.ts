// Fill in the hook for markets opened before the column existed.
//
// extractClaim has always produced a short headline and it went straight into
// the X reply and was then dropped: never stored, never served. The column
// landed in 2d1d3fd, so every market opened before that carries NULL and every
// surface falls back to the full question -- the 15-word rewrite rather than
// the headline the tweet already used.
//
// This does NOT invent one. It re-runs the same extractor the market was born
// from, over the question already stored, and takes only what that returns. A
// blank stays blank: NULL means "nothing crisp fits", which is a legitimate
// answer that every reader already handles.
//
// DRY RUN by default -- it extracts and prints what it WOULD write, and writes
// nothing. Pass --apply to write.
//
//   npm run backfill-hooks                  # dry run, 25 rows
//   npm run backfill-hooks -- --limit 100   # dry run, 100 rows
//   npm run backfill-hooks -- --apply       # write, 25 rows
//
// Needs ANTHROPIC_API_KEY, because it costs one model call per row. Against
// production it also needs DATABASE_URL set to the production database.
// Resumable: every run picks up rows that still have no hook, so it can be run
// until `candidates` comes back 0.

import { backfillHooks } from "../src/store/markets.js";
import { extractClaim } from "../src/matching/extractClaim.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const limIdx = args.indexOf("--limit");
const limit = limIdx >= 0 ? Number(args[limIdx + 1]) || 25 : 25;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is unset. Extraction is what produces the hook,");
  console.error("so there is nothing this can do without it.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.log("note: DATABASE_URL is unset — running against the in-memory store,");
  console.log("      which is empty in a fresh process. Set it to backfill real rows.\n");
}

console.log(`${apply ? "APPLYING" : "DRY RUN"} · up to ${limit} row(s)\n`);
const r = await backfillHooks(extractClaim, limit, { apply });
console.log(`\ncandidates ${r.candidates} · produced ${r.produced} · written ${r.written}`
  + ` · blank ${r.blank} · failed ${r.failed}`);
if (!apply && r.produced) console.log("\nnothing was written. re-run with --apply to keep these.");
