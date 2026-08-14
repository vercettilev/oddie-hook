// Split two X identities that ended up sharing one canonical device.
//
// linkAccount now gives a second identity of the same provider its own stream
// (see "signing in as somebody else switches you"), but that only stops NEW
// merges. Production already had one: @Oddiefun and @levvercetti sat on the
// same canonical device, which made /@levvercetti answer with the brand's
// name, hid the human from the leaderboard (the board excludes the brand by
// device, so it took both), and credited one person's calls to the other.
//
// THAT CASE IS CLOSED, and this script did not close it. Once the linkAccount
// fix was live, the next sign-in on the shared browser handed @Oddiefun a
// fresh empty device and left the history where it belonged: /@levvercetti now
// answers with the human's name and 22 resolved calls, @Oddiefun reads empty,
// and the human is back on the leaderboard. Run with no --apply, this reports
// "already on separate devices" and exits.
//
// It is kept because the repair and the prevention are different problems: the
// fix stops two identities from ever sharing a stream again, and cannot undo a
// pair that already does. If one is ever found — restored from an old backup,
// or made by hand — this is the tool.
//
// WHAT THIS DOES, and what it deliberately does not:
//
//   - the KEEP account stays exactly where it is, with the whole shared
//     history: every call, every oddie, the handle the device answers to.
//   - the DETACH account is moved to a fresh, empty canonical device. Nothing
//     is deleted; the row survives and can be moved back by hand.
//   - any browser currently following the DETACH account on the shared device
//     is repointed at KEEP, so nobody is left staring at an empty profile.
//
// It does NOT try to divide the history. Both identities played through one
// device id and the rows carry no second signal, so any split would be a
// guess. The judgement here is that the play belongs to the human and the
// brand account should never have carried a record at all.
//
// DRY RUN by default, same as backfill-source-posts: it reports and writes
// nothing. Pass --apply to write.
//
//   npm run unmerge -- --keep levvercetti --detach oddiefun
//   npm run unmerge -- --keep levvercetti --detach oddiefun --apply

import { randomUUID } from "node:crypto";
import pg from "pg";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const argOf = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1].replace(/^@+/, "").toLowerCase() : null;
};
const keep = argOf("--keep");
const detach = argOf("--detach");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is unset — this only makes sense against a real database.");
  process.exit(1);
}
if (!keep || !detach) {
  console.error("usage: --keep <handle> --detach <handle> [--apply]");
  process.exit(1);
}

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? undefined : { rejectUnauthorized: false },
});

const norm = "lower(ltrim(handle,'@'))";

try {
  const { rows: accounts } = await db.query<{ id: number; handle: string; canonical_device: string; provider: string }>(
    `SELECT id, handle, canonical_device, provider FROM account
      WHERE provider = 'twitter' AND ${norm} IN ($1, $2) ORDER BY created_at`, [keep, detach]);

  console.log("\naccounts found:");
  // Handles are stored WITH their leading @, so print the stored value as-is
  // rather than prefixing a second one.
  for (const a of accounts) console.log(`  #${a.id} ${a.handle} -> ${a.canonical_device}`);

  const k = accounts.find((a) => a.handle.replace(/^@+/, "").toLowerCase() === keep);
  const d = accounts.find((a) => a.handle.replace(/^@+/, "").toLowerCase() === detach);
  if (!k || !d) { console.error(`\nboth handles must exist as X accounts. keep=${!!k} detach=${!!d}`); process.exit(1); }
  if (k.canonical_device !== d.canonical_device) {
    console.log("\nthese two are already on separate devices — nothing to unmerge.");
    process.exit(0);
  }

  const shared = k.canonical_device;
  const fresh = randomUUID();

  const { rows: [counts] } = await db.query<{ calls: string; oddies: string }>(
    `SELECT (SELECT count(*) FROM market_call WHERE device_id = $1)::text AS calls,
            (SELECT COALESCE(SUM(amount),0) FROM season_points_log WHERE device_id = $1)::text AS oddies`, [shared]);
  const { rows: browsers } = await db.query<{ device_id: string }>(
    `SELECT device_id FROM device_account WHERE account_id = $1`, [d.id]);

  console.log(`\nshared device ${shared}`);
  console.log(`  ${counts.calls} calls and ${counts.oddies} ledger points STAY with @${k.handle}`);
  console.log(`  @${d.handle} moves to a fresh empty device ${fresh}`);
  console.log(`  ${browsers.length} browser(s) following @${d.handle} get repointed at @${k.handle}`);

  if (!apply) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to make these changes.\n");
    process.exit(0);
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO device_balance (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING`, [fresh]);
    await client.query(`UPDATE account SET canonical_device = $1 WHERE id = $2`, [fresh, d.id]);
    // Repoint browsers BEFORE anyone reloads: following the detached account
    // now would land them on the empty device.
    await client.query(`UPDATE device_account SET account_id = $1, linked_at = now() WHERE account_id = $2`, [k.id, d.id]);
    await client.query("COMMIT");
    console.log(`\napplied. @${k.handle} keeps ${shared}; @${d.handle} now lives on ${fresh}.\n`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
} finally {
  await db.end();
}
