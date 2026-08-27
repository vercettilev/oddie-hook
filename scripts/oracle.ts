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
const slugArg = (() => {
  const i = args.indexOf("--slug");
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
})();

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
  const detail = await communityMarketDetail(m.slug).catch(() => null);
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
// A citation that was fetched cleanly and did not contain its own quote means
// something in the chain produced words that do not exist. It is reported on its
// own line because it is the one outcome here that says the process itself is
// unwell, rather than that a market was hard.
const fabricated = decisions.filter((d) => (d.audit?.fabricated ?? 0) > 0);

if (fabricated.length) {
  console.log(`  ! ${fabricated.length} market(s) cited words that are not on the page they name:`);
  for (const d of fabricated) console.log(`      ${d.slug}`);
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
