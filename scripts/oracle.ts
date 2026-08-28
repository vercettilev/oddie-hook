// Settle what can be settled; hand the rest to a person.
//
//   npm run oracle                     dry run over every market past its close
//   npm run oracle -- --slug a-market  one market, dry run
//   npm run oracle -- --apply          settle the ones that passed every gate
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

import { adminListCommunity, communityMarketDetail } from "../src/store/markets.js";
import { decide, type OracleDecision } from "../src/oracle/oracle.js";
import { oracleAvailable } from "../src/oracle/verdict.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
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
const all = (await adminListCommunity()).filter((m) => !m.resolvedOutcome);
const board = slugArg ? all.filter((m) => m.slug === slugArg) : all;
if (slugArg && board.length === 0) {
  console.error(`\n  ${slugArg} is not an open market.\n`);
  process.exit(1);
}

console.log(`  ${board.length} open market(s)${APPLY ? ", APPLYING" : ", dry run"}.\n`);

const decisions: OracleDecision[] = [];
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

  const d = await decide({
    slug: m.slug,
    question: m.question,
    criteria: detail?.resolutionCriteria ?? null,
    closeTime: m.closesAt,
  });
  decisions.push(d);

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
  console.log(`  ${settleable.length} of ${decisions.length} would settle. Pass --apply to do it.\n`);
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
