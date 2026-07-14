// Show, then (only with --delete) remove, rows belonging to named test devices.
//
//   npm run cleanup                     -- dry run: print EVERYTHING that would go
//   npm run cleanup -- --delete         -- actually delete, then re-verify
//
// Dry run is the default because this is the one script in the repo that can
// destroy real data. It prints every row it would touch, and separately prints
// every device id it is NOT touching, so "nothing real was nuked" is something
// you can see rather than something you have to trust.
//
// Test devices are named explicitly. There is no pattern match on `%probe%` or
// similar: a real user's random device id could contain anything, and a rule
// that guesses is a rule that eventually guesses wrong.

import pg from "pg";

const TEST_DEVICES = [
  "ed238db0-a84c-491b-ab2e-273c585e929a", // poppin.so-origin session (the /api/ev proof)
  "ddb3938c-8243-46cf-abe7-7aef4b0e416e", // paper-trading session, production
  "6292e497-81e2-4241-9654-c534dc696f66", // analytics session, production
  "race-test-device-0001", // balance race test
  "deploy-probe-0001",
  "deploy-probe-0002",
  "deploy-probe-0003",
  "rewrite-probe-01",
  "rewrite-probe-02",
  ...(process.env.EXTRA_TEST_DEVICES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
];

const DATABASE_URL = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("No database URL. Try: railway run --service Postgres -- npx tsx scripts/cleanup-test-rows.ts");
  process.exit(1);
}
const DELETE = process.argv.includes("--delete");
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
const q = async <T>(sql: string, p: unknown[] = []): Promise<T[]> => (await pool.query(sql, p)).rows as T[];

console.log(`\n  mode: ${DELETE ? "DELETE" : "dry run (nothing will be removed)"}`);
console.log(`  test devices named: ${TEST_DEVICES.length}\n`);

// --- what exists, in full ---------------------------------------------------

const balances = await q<{ device_id: string; tokens: number; created_at: Date }>(
  `SELECT device_id, tokens, created_at FROM device_balance ORDER BY created_at`,
);
const calls = await q<{ id: string; device_id: string | null; slug: string; side: string; tokens: number; at: Date }>(
  `SELECT id, device_id, slug, side, tokens, at FROM market_call ORDER BY at`,
);
const events = await q<{ device_id: string; name: string; n: string; first: Date; last: Date }>(
  `SELECT device_id, name, count(*) n, min(at) first, max(at) last
     FROM event GROUP BY device_id, name ORDER BY device_id, name`,
);

const isTest = (d: string | null) => d !== null && TEST_DEVICES.includes(d);
const short = (d: string | null) => (d === null ? "(null — pre-device_id row)" : d.length > 20 ? d.slice(0, 8) + "…" : d);

console.log("  === device_balance ===");
for (const b of balances)
  console.log(`    ${isTest(b.device_id) ? "REMOVE" : "keep  "}  ${short(b.device_id).padEnd(26)} ${String(b.tokens).padStart(4)} tokens   ${b.created_at.toISOString().slice(0, 19)}`);
if (!balances.length) console.log("    (none)");

console.log("\n  === market_call ===");
for (const c of calls)
  console.log(`    ${isTest(c.device_id) ? "REMOVE" : "keep  "}  #${String(c.id).padStart(3)}  ${short(c.device_id).padEnd(26)} ${c.side.padEnd(3)} ${String(c.tokens).padStart(3)}  ${c.slug.slice(0, 34)}`);
if (!calls.length) console.log("    (none)");

console.log("\n  === event (grouped) ===");
for (const e of events)
  console.log(`    ${isTest(e.device_id) ? "REMOVE" : "keep  "}  ${short(e.device_id).padEnd(26)} ${e.name.padEnd(15)} ${String(e.n).padStart(3)}   ${e.first.toISOString().slice(5, 19)}`);
if (!events.length) console.log("    (none)");

// --- what survives ----------------------------------------------------------

const survivors = new Set<string>();
for (const b of balances) if (!isTest(b.device_id)) survivors.add(b.device_id);
for (const c of calls) if (!isTest(c.device_id)) survivors.add(short(c.device_id));
for (const e of events) if (!isTest(e.device_id)) survivors.add(e.device_id);

console.log(`\n  === devices that will SURVIVE (${survivors.size}) ===`);
if (!survivors.size) console.log("    (none — after this the baseline is empty)");
for (const s of survivors) console.log(`    ${s}`);

const named = new Set(TEST_DEVICES);
const unknownNamed = TEST_DEVICES.filter(
  (d) => !balances.some((b) => b.device_id === d) && !calls.some((c) => c.device_id === d) && !events.some((e) => e.device_id === d),
);
if (unknownNamed.length) console.log(`\n  (named but already absent: ${unknownNamed.join(", ")})`);

// --- delete -----------------------------------------------------------------

if (!DELETE) {
  console.log(`\n  Nothing deleted. Re-run with --delete to remove the rows marked REMOVE.\n`);
  await pool.end();
  process.exit(0);
}

const ids = [...named];
const client = await pool.connect();
try {
  await client.query("BEGIN");
  // market_call before device_balance: no FK between them today, but the order
  // is the one that stays correct if a FK is ever added.
  const de = await client.query(`DELETE FROM event WHERE device_id = ANY($1)`, [ids]);
  const dc = await client.query(`DELETE FROM market_call WHERE device_id = ANY($1)`, [ids]);
  const db = await client.query(`DELETE FROM device_balance WHERE device_id = ANY($1)`, [ids]);
  await client.query("COMMIT");
  console.log(`\n  deleted: ${de.rowCount} event, ${dc.rowCount} market_call, ${db.rowCount} device_balance`);
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
}

// --- verify -----------------------------------------------------------------

const [left] = await q<{ e: string; c: string; b: string }>(
  `SELECT (SELECT count(*) FROM event WHERE device_id = ANY($1)) e,
          (SELECT count(*) FROM market_call WHERE device_id = ANY($1)) c,
          (SELECT count(*) FROM device_balance WHERE device_id = ANY($1)) b`,
  [ids],
);
const [total] = await q<{ e: string; c: string; b: string }>(
  `SELECT (SELECT count(*) FROM event) e, (SELECT count(*) FROM market_call) c, (SELECT count(*) FROM device_balance) b`,
);
console.log(`  test rows remaining: event=${left.e}  market_call=${left.c}  device_balance=${left.b}`);
console.log(`  table totals now  : event=${total.e}  market_call=${total.c}  device_balance=${total.b}\n`);
await pool.end();
process.exit(Number(left.e) + Number(left.c) + Number(left.b) === 0 ? 0 : 1);
