// The real-money fee is booked once the resolve has landed, from what the
// program fixed, or not at all.
//
// resolveCommunityMarket used to read the market BESIDE resolve_market rather
// than after it. That read mostly ran before the verdict had landed, saw the
// market unsettled, and logRealFee then booked the rate times the pool: more
// than the program takes from a one-sided pool (nothing) or a capped one
// (never more than the losing side staked). The chain moved the right money;
// market_fee_log, and anything reading it, said more.
//
// Against a scripted chain read and the in-memory store. The fake chain fixes
// its fees with fixedFees, the server's own mirror of cap_fees, so it charges
// what the program charges. No chain, no database.
//
// Run with: npm run test-fee-after-resolve

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database: unset DATABASE_URL");
  process.exit(1);
}

import { readFileSync } from "node:fs";
import {
  FEE_LEDGER_SQL, FEE_REREAD_MS, auditFeeLedger, bookFeeAfterResolve, ledgerMarketFrom,
  type FeeBookDeps, type LedgerMarket,
} from "../src/feeLedger.js";
import type { MarketRead, OnChainMarketState } from "../src/chain/oddieChain.js";
import { feeLog, logRealFee } from "../src/store/markets.js";
import { CREATOR_FEE_BPS_REAL, PROTOCOL_FEE_BPS_REAL } from "../src/store/economy.js";
import { fixedFees } from "../src/odds.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

const SOL = 1_000_000_000;
const TAKEOUT = { creatorBps: CREATOR_FEE_BPS_REAL, protocolBps: PROTOCOL_FEE_BPS_REAL };
/** What the old fallback booked on each half: the rate times the pool. */
const rateTimesPool = (pool: number) => Math.floor((pool * CREATOR_FEE_BPS_REAL) / 10_000);

/** A market as the chain shows it before the verdict: both fees zero until resolve. */
const unsettled = (yes: number, no: number): OnChainMarketState => ({
  resolved: false, authority: null, closeTime: 0, winningSide: null,
  totalYesLamports: yes, totalNoLamports: no, creator: null,
  creatorFeeBps: CREATOR_FEE_BPS_REAL, creatorFeeLamports: 0, creatorFeeClaimed: false,
  protocolFeeBps: PROTOCOL_FEE_BPS_REAL, protocolFeeLamports: 0, protocolFeeClaimed: false,
  criteriaHash: null,
});
/** The same market once resolve_market has run, with the fees cap_fees fixes. */
const settled = (yes: number, no: number, side: "yes" | "no"): OnChainMarketState => {
  const fees = fixedFees(yes + no, side === "yes" ? yes : no, TAKEOUT);
  return { ...unsettled(yes, no), resolved: true, winningSide: side, creatorFeeLamports: fees.creator, protocolFeeLamports: fees.protocol };
};
const ok = (state: OnChainMarketState): MarketRead => ({ ok: true, state });
const UNREADABLE: MarketRead = { ok: false, reason: "unreadable", error: "429 Too Many Requests" };
const ABSENT: MarketRead = { ok: false, reason: "absent" };

/** A chain that answers each read with the next of `reads`, and the last one forever. */
function scripted(reads: MarketRead[]) {
  const t = {
    reads: 0,
    waits: [] as number[],
    books: [] as Array<{ slug: string; total: number; bps: number; fixed: { creator: number; protocol: number } }>,
    logs: [] as Array<Record<string, unknown>>,
  };
  const deps: FeeBookDeps = {
    read: async () => reads[Math.min(t.reads++, reads.length - 1)],
    wait: async (ms) => { t.waits.push(ms); },
    book: async (slug, total, bps, fixed) => { t.books.push({ slug, total, bps, fixed }); },
    log: (evt, extra) => { t.logs.push({ evt, ...extra }); },
  };
  return { t, deps };
}

console.log("\nbooking a landed resolve: what the program fixed, off the settled market");
{
  // 1000 SOL right against 1 SOL wrong. 4% of 1001 SOL is 40.04 SOL, and the
  // losing side staked 1, so 1 SOL is all the program takes.
  const capped = settled(1000 * SOL, 1 * SOL, "yes");
  const { t, deps } = scripted([ok(capped)]);
  const out = await bookFeeAfterResolve("capped", "PK-CAPPED", deps);
  check("a market already settled on the first read is booked at once",
    out === "booked" && t.reads === 1 && t.waits.length === 0, JSON.stringify({ out, ...t }));
  check("...with what the program fixed, the losing side's 1 SOL split in two",
    t.books.length === 1 && t.books[0].fixed.creator === capped.creatorFeeLamports
    && t.books[0].fixed.protocol === capped.protocolFeeLamports
    && capped.creatorFeeLamports + capped.protocolFeeLamports === 1 * SOL, JSON.stringify(t.books));
  check("...not the 20.02 SOL a half the rate times the pool would have said",
    rateTimesPool(1001 * SOL) === 20_020_000_000 && t.books[0]?.fixed.creator === 500_000_000, JSON.stringify(t.books[0]));
  check("...against the whole pool, at the rate this market carries",
    t.books[0]?.total === 1001 * SOL && t.books[0]?.bps === CREATOR_FEE_BPS_REAL && t.books[0]?.slug === "capped");
}

console.log("\na read still behind the verdict gets one more look, and only one");
{
  const later = settled(3 * SOL, 1 * SOL, "no");
  const { t, deps } = scripted([ok(unsettled(3 * SOL, 1 * SOL)), ok(later)]);
  const out = await bookFeeAfterResolve("behind", "PK-BEHIND", deps);
  check("an unsettled read waits once and reads again",
    t.reads === 2 && t.waits.length === 1 && t.waits[0] === FEE_REREAD_MS, JSON.stringify(t));
  check("...and books what the second read shows",
    out === "booked" && t.books.length === 1 && t.books[0].fixed.creator === later.creatorFeeLamports
    && t.books[0].fixed.protocol === later.protocolFeeLamports && later.creatorFeeLamports > 0, JSON.stringify(t.books));
  check("the wait is a short one, the Telegram notice's 4 s", FEE_REREAD_MS === 4_000);

  // One-sided, and the read never catches up. The fallback booked 2% of the
  // pool on each half here, against a market the program takes nothing from.
  const never = scripted([ok(unsettled(2 * SOL, 0))]);
  const gap = await bookFeeAfterResolve("never-seen", "PK-NEVER", never.deps);
  check("still unsettled on the second read: nothing is booked", gap === "unsettled" && never.t.books.length === 0, JSON.stringify(never.t));
  check("...after one wait and two reads, not a loop", never.t.reads === 2 && never.t.waits.length === 1);
  check("...and it is said out loud, naming the market and where to look",
    never.t.logs.length === 1 && never.t.logs[0].evt === "fee_log_gap" && never.t.logs[0].slug === "never-seen"
    && never.t.logs[0].market === "PK-NEVER" && /npm run fee-ledger-report/.test(String(never.t.logs[0].report)), JSON.stringify(never.t.logs));

  const blip = scripted([UNREADABLE, ok(settled(1 * SOL, 1 * SOL, "yes"))]);
  check("an RPC blip gets the same one more look",
    (await bookFeeAfterResolve("blip", "PK-BLIP", blip.deps)) === "booked" && blip.t.waits.length === 1 && blip.t.books.length === 1);
  const dark = scripted([UNREADABLE]);
  const darkOut = await bookFeeAfterResolve("dark", "PK-DARK", dark.deps);
  check("unreadable twice: nothing booked, and said",
    darkOut === "unreadable" && dark.t.books.length === 0 && dark.t.reads === 2 && dark.t.logs[0]?.evt === "fee_log_gap", JSON.stringify(dark.t));
}

console.log("\nnothing to book is not a gap");
{
  const closed = scripted([ABSENT]);
  check("an empty market closed for its rent: nothing to book, at once and quietly",
    (await bookFeeAfterResolve("closed", "PK-CLOSED", closed.deps)) === "closed"
    && closed.t.reads === 1 && closed.t.waits.length === 0 && closed.t.logs.length === 0 && closed.t.books.length === 0, JSON.stringify(closed.t));
  const empty = scripted([ok(unsettled(0, 0))]);
  check("an empty pool has no fee to wait for",
    (await bookFeeAfterResolve("empty", "PK-EMPTY", empty.deps)) === "empty"
    && empty.t.waits.length === 0 && empty.t.logs.length === 0 && empty.t.books.length === 0, JSON.stringify(empty.t));
}

console.log("\nend to end, into the in-memory ledger");
{
  const real = (reads: MarketRead[]): FeeBookDeps => ({ ...scripted(reads).deps, book: logRealFee });
  const rowsFor = async (slug: string) => (await feeLog(500)).filter((r) => r.slug === slug);

  await bookFeeAfterResolve("e2e-one-sided", "PK-1", real([ok(unsettled(2 * SOL, 0)), ok(settled(2 * SOL, 0, "yes"))]));
  check("a one-sided pool books no row, where the fallback booked 0.04 SOL twice",
    (await rowsFor("e2e-one-sided")).length === 0, JSON.stringify(await rowsFor("e2e-one-sided")));

  const capped = settled(1000 * SOL, 1 * SOL, "yes");
  await bookFeeAfterResolve("e2e-capped", "PK-2", real([ok(unsettled(1000 * SOL, 1 * SOL)), ok(capped)]));
  const c = await rowsFor("e2e-capped");
  check("a capped pool books each half as the program split it",
    c.length === 2 && c.find((r) => r.feeKind === "creator")?.feeAmount === capped.creatorFeeLamports
    && c.find((r) => r.feeKind === "protocol")?.feeAmount === capped.protocolFeeLamports
    && c.every((r) => r.marketKind === "real" && r.enforced && r.basisAmount === 1001 * SOL), JSON.stringify(c));

  await bookFeeAfterResolve("e2e-never-seen", "PK-3", real([ok(unsettled(5 * SOL, 5 * SOL))]));
  check("a market never seen settled gets no row at all, rather than a guess", (await rowsFor("e2e-never-seen")).length === 0);
}

console.log("\nthe report: the ledger held up against the chain");
{
  const m = (logged: Partial<LedgerMarket["logged"]>): LedgerMarket => ({
    slug: "s", pubkey: "PK", lastBookedAt: null,
    logged: { creator: 0, protocol: 0, rows: 0, basis: null, ...logged },
  });
  const basis = (pool: number) => ({ min: pool, max: pool });
  const est = rateTimesPool;

  const one = settled(2 * SOL, 0, "yes");
  const a1 = auditFeeLedger(m({ creator: est(2 * SOL), protocol: est(2 * SOL), rows: 2, basis: basis(2 * SOL) }), ok(one));
  check("a one-sided market booked by the fallback is over by all of it",
    a1.verdict === "over" && a1.diff?.creator === est(2 * SOL) && a1.diff?.protocol === est(2 * SOL) && a1.chain?.creator === 0, JSON.stringify(a1));

  const cap = settled(1000 * SOL, 1 * SOL, "yes");
  const a2 = auditFeeLedger(m({ creator: est(1001 * SOL), protocol: est(1001 * SOL), rows: 2, basis: basis(1001 * SOL) }), ok(cap));
  check("a capped market booked by the fallback is over by the rate less the cap",
    a2.verdict === "over" && a2.diff?.creator === est(1001 * SOL) - cap.creatorFeeLamports
    && a2.diff?.protocol === est(1001 * SOL) - cap.protocolFeeLamports, JSON.stringify(a2));

  const bal = settled(5 * SOL, 5 * SOL, "no");
  check("a balanced market, where the fallback was what the program took, agrees",
    auditFeeLedger(m({ creator: est(10 * SOL), protocol: est(10 * SOL), rows: 2, basis: basis(10 * SOL) }), ok(bal)).verdict === "agrees");
  check("a settled fee with no row is missing", auditFeeLedger(m({}), ok(bal)).verdict === "missing");
  check("less than the chain fixed is under",
    auditFeeLedger(m({ creator: 1, protocol: 1, rows: 2, basis: basis(10 * SOL) }), ok(bal)).verdict === "under");
  check("a one-sided settled market with no row agrees: no fee, no row", auditFeeLedger(m({}), ok(one)).verdict === "agrees");
  check("rows on a market the chain has not settled are not-settled",
    auditFeeLedger(m({ creator: est(4 * SOL), protocol: est(4 * SOL), rows: 2, basis: basis(4 * SOL) }), ok(unsettled(3 * SOL, 1 * SOL))).verdict === "not-settled");
  check("an open market with no row is just open", auditFeeLedger(m({}), ok(unsettled(3 * SOL, 1 * SOL))).verdict === "open");

  // The devnet weeks: the backfill re-minted every market at its old address,
  // so a row from then names this account and a pool it never held.
  const a4 = auditFeeLedger(m({ creator: 999, protocol: 999, rows: 2, basis: basis(7 * SOL) }), ok(bal));
  check("a row booked against another pool is set aside, not called a surplus",
    a4.verdict === "other-pool" && a4.pool === 10 * SOL && a4.diff === null, JSON.stringify(a4));

  check("an unreadable market is not judged", auditFeeLedger(m({ creator: 5, rows: 1, basis: basis(1) }), UNREADABLE).verdict === "unreadable");
  check("a closed empty market with no row is closed", auditFeeLedger(m({}), ABSENT).verdict === "closed");
  check("...but rows against an account that is not there are not judged either",
    auditFeeLedger(m({ creator: 5, rows: 1, basis: basis(1) }), ABSENT).verdict === "unreadable");

  // What node-postgres hands back: bigint as a string, an empty LEFT JOIN as nulls.
  const mapped = ledgerMarketFrom({
    slug: "x", onchain_pubkey: "PK", creator_lamports: "40000000", protocol_lamports: "40000000",
    fee_rows: 2, basis_min: "2000000000", basis_max: "2000000000", last_booked_at: new Date("2026-10-30T12:00:00Z"),
  });
  check("bigint strings become numbers",
    mapped.logged.creator === 40_000_000 && mapped.logged.protocol === 40_000_000 && mapped.logged.basis?.min === 2 * SOL
    && mapped.lastBookedAt === "2026-10-30T12:00:00.000Z", JSON.stringify(mapped));
  const bare = ledgerMarketFrom({
    slug: "y", onchain_pubkey: "PK", creator_lamports: "0", protocol_lamports: "0",
    fee_rows: 0, basis_min: null, basis_max: null, last_booked_at: null,
  });
  check("a market with no rows has no basis", bare.logged.rows === 0 && bare.logged.basis === null && bare.lastBookedAt === null);
  check("the report reads only real rows that claim a deduction", /f\.market_kind = 'real' AND f\.enforced = true/.test(FEE_LEDGER_SQL));
}

console.log("\nwired: every resolve that lands books its fee, and only then");
{
  const server = readFileSync("src/server.ts", "utf8");
  const start = server.indexOf("const resolvedOnChain = resolveMarketOnChain(");
  const end = server.indexOf("return resolvedOnChain;", start);
  const block = start >= 0 && end > start ? server.slice(start, end) : "";
  const failed = block.indexOf("if (!r.ok) {");
  check("the resolve block is where it was", block.length > 0 && failed >= 0);
  check("the fee is booked inside the ok branch, after the failure returns",
    block.indexOf("bookFeeAfterResolve(slug, pubkey, feeBooking)") > block.indexOf("return;", failed));
  check("...and only when this call's own transaction landed the verdict",
    /if \(!r\.alreadyResolved\) \{\s*void bookFeeAfterResolve\(slug, pubkey, feeBooking\)/.test(block));
  check("nothing reads the fee beside the resolve any more", !/fetchMarketOnChain\(detail\.onchainPubkey\)\.then/.test(server));
  check("the server books a fee only through bookFeeAfterResolve", !/logRealFee\(/.test(server) && /book: logRealFee,/.test(server));
  check("...with a fresh read, not the cache", /read: \(pubkey\) => readMarket\(pubkey\),/.test(server));
  check("resolveCommunityMarket is the only server path that resolves on chain",
    (server.match(/resolveMarketOnChain\(/g) ?? []).length === 1);

  // The oracle settles through the same function, so it books the same way.
  check("the oracle sweep settles through resolveCommunityMarket",
    /settle: ORACLE_DRY_RUN \? null : async \(slug, outcome\) => Boolean\(await resolveCommunityMarket\(slug, outcome\)\)/.test(server));
  check("...and so does the admin route the oracle script posts to",
    /app\.post\("\/api\/community\/resolve", requireAdmin, async[^]*?await resolveCommunityMarket\(slug, outcome\)/.test(server)
    && /\/api\/community\/resolve/.test(readFileSync("scripts/oracle.ts", "utf8")));

  const reconcile = readFileSync("scripts/resolve-reconcile.ts", "utf8");
  check("resolve-reconcile books the verdicts it lands, the same way",
    /if \(out\.ok\) \{[^]*?if \(!out\.alreadyResolved\) \{\s*const fee = await bookFeeAfterResolve\(r\.slug, r\.onchainPubkey, feeBooking\)/.test(reconcile));
  check("...only on --apply, past the report-only return",
    reconcile.indexOf("bookFeeAfterResolve(r.slug") > reconcile.indexOf("if (!APPLY) {"));

  // The code, not the header: the header names logRealFee to say why this exists.
  const report = readFileSync("scripts/fee-ledger-report.ts", "utf8").replace(/^\s*\/\/.*$/gm, "");
  const writes = /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT)\b/;
  check("the report reads in a READ ONLY transaction and rolls it back", /"BEGIN READ ONLY"/.test(report) && /"ROLLBACK"/.test(report));
  check("...writes no SQL, here or in the query it runs", !writes.test(report) && !writes.test(FEE_LEDGER_SQL));
  check("...imports only readers from the chain, and nothing from the store",
    /import \{ cluster, isChainEnabled, readMarkets \} from "\.\.\/src\/chain\/oddieChain\.js";/.test(report)
    && !/src\/store\//.test(report) && !/logRealFee|resolveMarketOnChain|closeMarketOnChain|mintMarket|\.rpc\(/.test(report));
}

console.log(failures === 0 ? "\nall fee-after-resolve checks passed.\n" : `\n${failures} fee-after-resolve check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
