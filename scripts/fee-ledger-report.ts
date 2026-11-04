// Does every settled market's fee row say what resolve_market fixed?
//
// WHY THIS EXISTS. Until 3 Nov 2026 the resolve path read the market beside
// resolve_market instead of after it. That read usually saw the market
// unsettled, and logRealFee then booked the rate times the pool, which is more
// than the program takes from a one-sided pool (nothing) or a capped one
// (never more than the losing side staked). The money on chain was right. The
// rows in market_fee_log, and anything reading them, said more.
//
// READ ONLY, by Postgres's word and not only by this file's: the one query
// runs inside a READ ONLY transaction, which refuses any write, and the
// transaction is rolled back. The chain is only read. Nothing here books,
// corrects or deletes a row; putting a row right is a separate step, decided
// after reading this.
//
//   npm run fee-ledger-report            the markets whose rows disagree
//   npm run fee-ledger-report -- --all   every minted market, agreeing ones too
//
// Needs the production database and the chain layer configured as for
// resolve-reconcile: readMarkets builds its client with the admin key, and
// nothing here signs with it. It never prints key material. From a laptop the
// database is the Postgres service's DATABASE_PUBLIC_URL, because oddie-hook's
// own DATABASE_URL is a `*.railway.internal` host that resolves only inside
// Railway, and the chain is oddie-hook's, so the two runs nest:
//
//   railway run -p 508d41c0-e0ab-4dfd-94e8-a00881cd9e2e -e production -s Postgres -- railway run -p 508d41c0-e0ab-4dfd-94e8-a00881cd9e2e -e production -s oddie-hook -- npm run -s fee-ledger-report
//
// The comparison is src/feeLedger.ts (auditFeeLedger), tested in
// scripts/test-fee-after-resolve.ts.

import pg from "pg";
import { cluster, isChainEnabled, readMarkets } from "../src/chain/oddieChain.js";
import { FEE_LEDGER_SQL, auditFeeLedger, ledgerMarketFrom, type FeeAudit, type FeeLedgerRow, type FeeVerdict } from "../src/feeLedger.js";

const ALL = process.argv.includes("--all");

function die(msg: string): never {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

// The public URL first, as check-sql reads it: see the header.
const url = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
if (!url) die("This reads market_fee_log, so it needs the production database: DATABASE_PUBLIC_URL from a laptop (see the header).");
if (!isChainEnabled()) {
  die("This reads what resolve_market fixed, so it needs ONCHAIN_ENABLED and the chain layer resolve-reconcile uses. It signs nothing.");
}

const internal = /railway\.internal/.test(url);
const client = new pg.Client({ connectionString: url, ssl: internal ? false : { rejectUnauthorized: false } });
await client.connect().catch((e: Error) => die(internal
  ? "DATABASE_URL is Railway's private host, which resolves only inside Railway. Run it as the header says, with the Postgres service's DATABASE_PUBLIC_URL."
  : `Could not reach the database: ${e.message}`));
let rows: FeeLedgerRow[];
try {
  await client.query("BEGIN READ ONLY");
  rows = (await client.query<FeeLedgerRow>(FEE_LEDGER_SQL)).rows;
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await client.end();
}

const markets = rows.map(ledgerMarketFrom);
if (markets.length === 0) die("No minted markets in the database. DATABASE_URL is probably not pointed at production.");

console.log(`\n  ${markets.length} minted markets, against ${cluster()}.\n`);

const reads = await readMarkets(markets.map((m) => m.pubkey));
const audits: Array<FeeAudit & { lastBookedAt: string | null }> = markets.map((m) => ({
  ...auditFeeLedger(m, reads.get(m.pubkey) ?? { ok: false, reason: "unreadable", error: "not read" }),
  lastBookedAt: m.lastBookedAt,
}));

const sol = (lamports: number): string => (lamports / 1e9).toFixed(6);
const signed = (lamports: number): string => `${lamports > 0 ? "+" : ""}${sol(lamports)}`;
const QUIET: ReadonlySet<FeeVerdict> = new Set(["agrees", "open", "closed"]);

for (const a of audits) {
  if (!ALL && QUIET.has(a.verdict)) continue;
  const booked = `${a.logged.rows} row${a.logged.rows === 1 ? "" : "s"}${a.lastBookedAt ? `, last ${a.lastBookedAt.slice(0, 10)}` : ""}`;
  const mark = QUIET.has(a.verdict) ? " " : "!";
  if (a.chain && a.diff) {
    console.log(`  ${mark} ${a.slug} ${a.verdict}: creator ${sol(a.logged.creator)} booked vs ${sol(a.chain.creator)} fixed (${signed(a.diff.creator)}),`
      + ` protocol ${sol(a.logged.protocol)} vs ${sol(a.chain.protocol)} (${signed(a.diff.protocol)}), pool ${sol(a.pool ?? 0)} SOL, ${booked}`);
  } else if (a.verdict === "other-pool") {
    const b = a.logged.basis!;
    console.log(`  ${mark} ${a.slug} other-pool: booked against ${sol(b.min)}${b.max !== b.min ? `..${sol(b.max)}` : ""} SOL, the account holds ${sol(a.pool ?? 0)}, ${booked}`);
  } else {
    console.log(`  ${mark} ${a.slug} ${a.verdict}${a.error ? `: ${a.error}` : ""}, ${booked}`);
  }
}

const count = (v: FeeVerdict) => audits.filter((a) => a.verdict === v).length;
/** What the ledger holds too much (sign 1) or too little (sign -1) of, on one half. */
const total = (v: FeeVerdict, half: "creator" | "protocol", sign: 1 | -1) =>
  audits.filter((a) => a.verdict === v).reduce((n, a) => n + Math.max(0, sign * (a.diff?.[half] ?? 0)), 0);

console.log(`\n  ${count("agrees")} agree, ${count("open")} still open, ${count("closed")} closed empty.`);
if (count("over")) console.log(`  ${count("over")} booked MORE than the chain fixed: creator ${sol(total("over", "creator", 1))} SOL, protocol ${sol(total("over", "protocol", 1))} SOL too much.`);
if (count("under")) console.log(`  ${count("under")} booked less than the chain fixed: creator ${sol(total("under", "creator", -1))} SOL, protocol ${sol(total("under", "protocol", -1))} SOL short.`);
if (count("missing")) console.log(`  ${count("missing")} settled with a fee and no row: creator ${sol(total("missing", "creator", -1))} SOL, protocol ${sol(total("missing", "protocol", -1))} SOL unbooked.`);
if (count("not-settled")) console.log(`  ${count("not-settled")} carry rows the chain has not settled.`);
if (count("other-pool")) console.log(`  ${count("other-pool")} carry rows booked against another pool (the devnet weeks), not compared.`);
if (count("unreadable")) console.log(`  ${count("unreadable")} unreadable.`);
console.log("");

// A row that disagrees with the chain is a number somebody may be paid from,
// so a run that found one fails, like resolve-reconcile: this belongs in a
// health check, not only in a terminal somebody is watching.
if (count("over") || count("under") || count("missing") || count("not-settled")) process.exit(1);
