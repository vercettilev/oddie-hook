// Writes an approved wave into the APP allowlist (DATABASE_URL = app Postgres).
// Reads the JSON produced by wave-read.ts. Idempotent (addToAllowlist upserts).
// Only run AFTER the operator approves the printed preview.
//   DATABASE_URL=<app> npx tsx scripts/wave-write.ts <wave.json>
import { readFileSync } from "node:fs";
import { addToAllowlist, allowlistRows } from "../src/store/markets.js";
const file = process.argv[2];
const cohort = process.env.COHORT ?? "default";
const rows = JSON.parse(readFileSync(file, "utf8")) as { email: string; xUid: string | null; xHandle: string | null; source: string }[];
console.log(`cohort: ${cohort}`);
console.log(`seeding ${rows.length} rows from ${file}…`);
let ok = 0;
for (const r of rows) {
  const done = await addToAllowlist(r.email, r.source, true, r.xUid, r.xHandle, cohort);
  if (done) ok++;
  console.log(`  ${done ? "✓" : "✗"} ${r.email.replace(/(.{2}).*(@.*)/, "$1…$2")}  x:${r.xUid ?? "—"} @${r.xHandle ?? "—"}`);
}
console.log(`\nseeded ${ok}/${rows.length}. allowlist now holds ${(await allowlistRows(500)).length} rows.`);
process.exit(0);
