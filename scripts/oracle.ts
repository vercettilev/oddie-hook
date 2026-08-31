// Settle what can be settled; hand the rest to a person.
//
//   npm run oracle                     dry run over every market past its close
//   npm run oracle -- --slug a-market  one market, dry run
//   npm run oracle -- --apply          settle the ones that passed every gate
//   npm run oracle -- --force          ask again even where the record says not to
//
// EVERY DECISION IS RECORDED, including the refusals, and the record is what
// decides whether a market is asked about again at all. Without it this script
// paid the full propose loop for every open market on every run, forever: a
// market stuck behind a post-propose gate cost the same on the hundredth run as
// on the first, and a dry run cost exactly what --apply costs.
//
// DRY RUN IS THE DEFAULT and --apply is the only thing that moves money. A dry
// run makes the same calls and reaches the same decision; it simply stops
// before announcing it.
//
// IT DOES NOT SETTLE ANYTHING ITSELF. --apply posts to /api/community/resolve,
// the same route the admin panel uses, so the whole tail — the off-chain
// settlement, the on-chain resolve, the emails, the reply in the X thread —
// happens exactly once and in exactly one place. A second settlement path here
// would be a second set of rules to keep in step, and the first thing to drift
// would be the one nobody watches.
//
// Needs DATABASE_URL to read the board. --apply additionally needs ODDIE_BASE_URL
// and ODDIE_ADMIN_TOKEN, and the token is only ever sent as a header.

import { adminListCommunity, communityMarketDetail, oracleAttemptFor, recordOracleDecision } from "../src/store/markets.js";
import { decide, shouldRetry, decisionWasPaid, type OracleDecision } from "../src/oracle/oracle.js";
import { oracleAvailable } from "../src/oracle/verdict.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const FORCE = args.includes("--force");
/**
 * Open the "not closed yet" gate, to see what the rest of the pipeline says.
 *
 * WHAT THIS DOES NOT DO, because the first version of this comment claimed it
 * did: it does not show you the future. The clock moves for the CODE gates
 * only. The proposer builds its own timestamp from the real clock and searches
 * the real internet, so on a market whose event has not happened it correctly
 * reports that nothing has happened and abstains. Measured: three markets, all
 * three abstained with reasoning that named today's real date.
 *
 * That makes it useful for exactly two things and nothing else: proving the
 * oracle refuses to invent outcomes for events still in the future, and seeing
 * which markets are blocked by criteria rather than by the calendar. To measure
 * how often the oracle can actually settle, use scripts/oracle-backtest.ts,
 * which asks it about events that have already happened.
 *
 * It NEVER combines with --apply. Settling a market as though time had passed is
 * settling an open market.
 */
const asOfIdx = args.indexOf("--as-of");
if (asOfIdx >= 0 && (!args[asOfIdx + 1] || args[asOfIdx + 1].startsWith("--"))) {
  console.error(`\n  --as-of needs an ISO timestamp after it, for example --as-of 2027-01-01\n`);
  process.exit(1);
}
const AS_OF = asOfIdx >= 0 ? new Date(args[asOfIdx + 1]) : null;
if (AS_OF && Number.isNaN(AS_OF.getTime())) {
  console.error(`\n  --as-of could not read "${args[asOfIdx + 1]}" as a date.\n`);
  process.exit(1);
}
if (AS_OF && APPLY) {
  console.error(`\n  --as-of and --apply cannot be used together. Pretending time has passed and then settling would settle a market that is still open.\n`);
  process.exit(1);
}
// A --slug whose value is missing, or is itself a flag, is a TYPO, not "all
// markets". It used to fall through to null and leave the board unfiltered, so
// `npm run oracle -- --apply --slug` (flag pasted, slug forgotten) settled
// everything that passed the gates. The board-empty check below cannot catch
// that, because no slug was ever parsed.
const slugIdx = args.indexOf("--slug");
if (slugIdx >= 0 && (!args[slugIdx + 1] || args[slugIdx + 1].startsWith("--"))) {
  console.error(`\n  --slug needs a market slug after it. Leave it off entirely to run the whole board.\n`);
  process.exit(1);
}
const slugArg = slugIdx >= 0 ? args[slugIdx + 1] : null;

const avail = oracleAvailable();
console.log(`\n  oracle: ${avail.ok ? avail.why : `UNAVAILABLE — ${avail.why}`}`);
if (!avail.ok) {
  console.log("");
  process.exit(1);
}

const BASE = (process.env.ODDIE_BASE_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.ODDIE_ADMIN_TOKEN ?? "";
if (APPLY && (!BASE || !TOKEN)) {
  console.error(`\n  --apply settles real markets, so it needs ODDIE_BASE_URL and ODDIE_ADMIN_TOKEN.\n`);
  process.exit(1);
}

// adminListCommunity, not openCommunityMarkets: the latter returns venue_id,
// which is a separate column from slug and only looks like it on a good day.
// Retired markets are off the board and must not be settled: the oracle would
// be deciding a market nobody can see or stake in.
const all = (await adminListCommunity()).filter((m) => !m.resolvedOutcome && !m.retiredAt);
const board = slugArg ? all.filter((m) => m.slug === slugArg) : all;
if (slugArg && board.length === 0) {
  console.error(`\n  ${slugArg} is not an open market.\n`);
  process.exit(1);
}

console.log(`  ${board.length} open market(s)${APPLY ? ", APPLYING" : ", dry run"}${AS_OF ? `, as of ${AS_OF.toISOString()}` : ""}.\n`);

const decisions: OracleDecision[] = [];
let skipped = 0;
for (const m of board) {
  // A database error here is NOT the same as a market created without criteria,
  // and swallowing it into null said exactly that: an operator reading
  // "this market carries no resolution criteria" would go and rewrite criteria
  // that were sitting in the database all along. The loop holds a connection
  // through minutes of model calls per market, so a mid-run reset is realistic.
  let detail: Awaited<ReturnType<typeof communityMarketDetail>> | null = null;
  let detailError: string | null = null;
  try {
    detail = await communityMarketDetail(m.slug);
  } catch (e) {
    detailError = (e as Error).message;
  }
  if (detailError) {
    console.log(`     ${"could not be read".padEnd(28 - 5)} ${m.slug.slice(0, 44)}`);
    console.log(`      the database did not answer: ${detailError}`);
    console.log("");
    continue;
  }

  // Ask the record before spending anything. A market whose criteria the model
  // has already judged uncheckable will answer the same way at the same price
  // every run until a person rewrites them.
  const attempt = await oracleAttemptFor(m.slug).catch(() => ({ lastGate: null, lastDecidedAt: null, paidAttempts: 0 }));
  const again = shouldRetry(attempt);
  if (!again.retry && !FORCE) {
    skipped++;
    console.log(`     ${"held".padEnd(23)} ${m.slug.slice(0, 44)}`);
    console.log(`      ${again.why}`);
    console.log("");
    continue;
  }

  const d = await decide({
    slug: m.slug,
    question: m.question,
    criteria: detail?.resolutionCriteria ?? null,
    closeTime: m.closesAt,
  }, AS_OF ?? undefined);
  decisions.push(d);

  // Recorded before anything is announced, and best-effort by construction: the
  // log going down must not take a settlement with it.
  await recordOracleDecision({
    slug: d.slug, settle: d.settle, gate: d.gate, reason: d.reason,
    confidence: d.proposal?.confidence ?? null,
    secondOpinion: d.secondOpinion ?? null,
    citations: d.audit?.citations ?? [],
    verified: d.audit?.verified ?? 0, undated: d.audit?.undated ?? 0, stale: d.audit?.stale ?? 0,
    absent: d.audit?.absent ?? 0, unreachable: d.audit?.unreachable ?? 0,
    paid: decisionWasPaid(d),
  });

  const head = d.settle ? `-> ${d.settle.toUpperCase()}` : `   ${d.gate}`;
  console.log(`  ${head.padEnd(28)} ${m.slug.slice(0, 44)}`);
  console.log(`      ${d.reason}`);
  for (const c of d.audit?.citations ?? []) {
    console.log(`      [${c.status}] ${c.url.slice(0, 78)}`);
    if (c.status === "quote-absent") console.log(`         quoted: "${c.quote.slice(0, 90)}"`);
  }
  console.log("");
}

const settleable = decisions.filter((d) => d.settle);
// A citation that fetched cleanly and did not contain its own quote gets its own
// line, because it is the outcome worth actually looking at: either a source was
// invented, or a page changed under us between the search and the check. The
// first is a problem with the process, the second is a problem with citing pages
// that move, and both are worth knowing rather than counting as one more market
// that happened to be hard.
const unchecked = decisions.filter((d) => (d.audit?.absent ?? 0) > 0);

if (unchecked.length) {
  console.log(`  ! ${unchecked.length} market(s) cited a page that no longer shows the quoted words:`);
  for (const d of unchecked) console.log(`      ${d.slug}`);
  console.log("");
}

// Dead URLs are the strongest signal available that sources are being invented,
// and they were counted against nothing and printed nowhere: a proposal with
// four 404s and one real page settled, and the summary said nothing at all.
// They do not block on their own, because an unreachable page is often just a
// site that refuses us, so this is a thing to LOOK at rather than a gate.
const dead = decisions.filter((d) => (d.audit?.unreachable ?? 0) > 0);
if (dead.length) {
  console.log(`  ? ${dead.length} market(s) cited pages we could not reach:`);
  for (const d of dead) console.log(`      ${d.audit?.unreachable} unreachable  ${d.slug}`);
  console.log("");
}

if (!APPLY) {
  const byGate = new Map<string, number>();
  for (const d of decisions) byGate.set(d.gate, (byGate.get(d.gate) ?? 0) + 1);
  console.log(`  gates: ${[...byGate.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g} ${n}`).join(", ")}`);
  const paid = decisions.filter((d) => d.proposal !== undefined || d.gate === "error").length;
  console.log(`  ${paid} of ${decisions.length} reached the model; the rest were decided for free.`);
  console.log(`  ${settleable.length} of ${decisions.length} would settle${skipped ? `, ${skipped} held by the record` : ""}. Pass --apply to do it.\n`);
  process.exit(0);
}

let done = 0, failed = 0;
for (const d of settleable) {
  const res = await fetch(`${BASE}/api/community/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-oddie-admin": TOKEN },
    body: JSON.stringify({ slug: d.slug, outcome: d.settle }),
  }).catch(() => null);
  if (res?.ok) {
    done++;
    console.log(`  settled ${d.slug} -> ${d.settle}`);
  } else {
    failed++;
    console.error(`  ! ${d.slug} did not settle: ${res ? `http ${res.status}` : "request failed"}`);
  }
}
console.log(`\n  ${done} settled, ${failed} failed, ${decisions.length - settleable.length} left for a person.\n`);
if (failed) process.exit(1);
