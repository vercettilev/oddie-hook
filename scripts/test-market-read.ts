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

import { readMarket, readMarkets, readPositions, fetchMarketOnChain, forgetMarket, chainMarketIdFor } from "../src/chain/oddieChain.js";
import { readFileSync } from "node:fs";

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

// --- positions ------------------------------------------------------------
// The same distinction, about the reader's OWN money, where getting it wrong
// tells a winner they have nothing to collect.
const WALLET = "7dHbWXmci3dT8UFYWYZweBLXgycu4LNvBQzVQrqDVwPZ";
const pos = await readPositions([A, B], WALLET);
check("an unreachable chain marks every position UNREADABLE, not absent",
  pos.size === 2 && [...pos.values()].every((v) => !v.ok && v.reason === "unreadable"), [...pos.entries()]);
check("positions answer for every market key asked about", pos.has(A) && pos.has(B));

const dupPos = await readPositions([A, A, B], WALLET);
check("duplicate markets collapse to one position entry each", dupPos.size === 2);

check("an empty position request is an empty map", (await readPositions([], WALLET)).size === 0);

// A malformed wallet must not be answered with "you hold nothing": that is a
// confident answer to a question we were never able to ask.
const bad = await readPositions([A], "not-a-real-pubkey");
check("a malformed wallet reads unreadable, never absent",
  bad.size === 1 && !bad.get(A)!.ok && (bad.get(A) as { reason: string }).reason === "unreadable", bad.get(A));

console.log("\nthe id a market goes on chain with\n");
{
  /* Audit, 22 Oct: create_market is open to anybody and the address comes from
     the id alone, so a guessable id (the millisecond the market opened) was an
     address somebody could take first and block the market from the chain. */
  const key = new Uint8Array(64).map((_, i) => i * 7 + 3);
  const other = new Uint8Array(64).map((_, i) => i * 11 + 5);
  const a = chainMarketIdFor(key, "market:will-eth-trade-above-2400-at-e7bd97");
  check("the same market always asks for the same id, so racing mints meet at one address",
    a === chainMarketIdFor(key, "market:will-eth-trade-above-2400-at-e7bd97"));
  check("...a different market for a different one", a !== chainMarketIdFor(key, "market:will-eth-trade-above-2400-at-e7bd98"));
  check("...and nobody without the admin key can compute it", a !== chainMarketIdFor(other, "market:will-eth-trade-above-2400-at-e7bd97"));
  const ids = Array.from({ length: 2000 }, (_, i) => chainMarketIdFor(key, `market:m${i}`));
  check("every id is a whole number a JavaScript number holds exactly, never zero",
    ids.every((n) => Number.isSafeInteger(n) && n > 0 && n < 2 ** 52), ids.find((n) => !(Number.isSafeInteger(n) && n > 0 && n < 2 ** 52)));
  const upper = ids.filter((n) => n >= 2 ** 51).length;
  check("...spread over the whole range, not clustered like milliseconds", upper > 850 && upper < 1150, upper);
  const server = readFileSync("src/server.ts", "utf8");
  check("both mints derive the id: from the slug, or from the claim before it has one",
    server.includes("idSeed: `market:${slug}`") && server.includes("idSeed: `claim:${marketId}:${question}`"));
}

console.log(failed === 0 ? "\nall market read checks passed.\n" : `\n${failed} FAILED\n`);
if (failed > 0) process.exit(1);
