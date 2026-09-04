/**
 * "We could not look" must never be served as "there is nothing there".
 *
 * fetchMarketOnChain answered null for both, and every caller turned that null
 * into 0, so a throttled RPC made markets holding real money advertise an empty
 * pool. This pins the distinction at the one place it is cheap to check: with
 * the chain layer switched off, which is the same not-knowing as a dead RPC.
 *
 * The cluster-dependent half (batch decode agreeing with single decode, and
 * `absent` for a pubkey that really is not there) was verified against live
 * devnet accounts and cannot run here without keys and a network.
 */
process.env.ONCHAIN_ENABLED = "false";

import { readMarket, readMarkets, fetchMarketOnChain, forgetMarket } from "../src/chain/oddieChain.js";

let failed = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
};

const A = "3SYG7hzQBYGc853BGTxcBtTLefESaP9DqP5aHbvgnYsu";
const B = "J3bEmhdy7CeZeJRXHSJe2JEDyC39kmEWfBKUrYCQuPVY";

console.log("\nmarket read\n");

const one = await readMarket(A);
check("a market we cannot reach is UNREADABLE, not absent",
  !one.ok && one.reason === "unreadable", one);
check("and it carries a reason a log can print",
  !one.ok && one.reason === "unreadable" && typeof one.error === "string" && one.error.length > 0);
check("it is never ok, so no caller can read a pool off it", one.ok === false);

// THE BUG, restated as a test. Anything that renders a number must not use
// this signature, because null here means two different things.
const legacy = await fetchMarketOnChain(A);
check("the legacy signature still collapses both answers to null (why it is deprecated)",
  legacy === null);

// --- batch -----------------------------------------------------------------
const many = await readMarkets([A, B]);
check("a batch that cannot reach the chain marks EVERY entry unreadable",
  many.size === 2 && [...many.values()].every((v) => !v.ok && v.reason === "unreadable"), [...many.entries()]);
check("every requested key is present in the result, so a caller cannot mistake",
  many.has(A) && many.has(B));

// A missing key would read as `undefined` at the call site, and `undefined` is
// exactly the shape that gets coalesced to zero again. So: never missing.
const dup = await readMarkets([A, A, B, A]);
check("duplicates collapse to one entry per market", dup.size === 2, dup.size);
check("a duplicate still answers for its key", dup.has(A) && dup.has(B));

const none = await readMarkets([]);
check("an empty request is an empty map, not a throw", none.size === 0);

// forgetMarket is called on the money path after a stake lands. It must be
// safe on a market that was never cached, which is the common case.
let threw = false;
try { forgetMarket(A); forgetMarket("not-a-pubkey"); } catch { threw = true; }
check("forgetting an uncached market is a no-op, not a throw", !threw);

console.log(failed === 0 ? "\nall market read checks passed.\n" : `\n${failed} FAILED\n`);
if (failed > 0) process.exit(1);
