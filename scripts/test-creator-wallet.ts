/**
 * THE 2% HAS TO REACH WHOEVER OPENED THE MARKET.
 *
 * The reply-tag flow names its creator LATER: somebody tags an argument on X,
 * the market mints with the program's unnamed sentinel, and set_creator writes
 * their address when they connect. An API caller has no device row, so nothing
 * ever binds it to a wallet, and the fee fell through to handleFromSourceUrl --
 * i.e. to the author of the tweet. An integrator paying us to open markets was
 * paying to hand 2% to a stranger.
 *
 * The fix is a wallet named at creation. What makes it worth a test is WHERE it
 * had to survive to: /api/v1/claims mints ON DEMAND, so the market reaches the
 * chain inside ensureMinted, long after the request that named the creator is
 * gone. A wallet passed at create time and not persisted would be dropped
 * exactly there, and the change would look complete while doing nothing on the
 * one route it was written for. That is the same shape as the bug creator_fee_bps
 * was stored to fix.
 *
 * So: two checks that the value survives the round trip through the store, and
 * two that read server.ts, because the drop would happen in a line no in-memory
 * test can reach.
 *
 * Against the in-memory store. Run with: npm run test-creator-wallet
 */
if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database — unset DATABASE_URL");
  process.exit(1);
}

import { readFileSync } from "node:fs";
import { createCommunityMarket, communityMarketDetail } from "../src/store/markets.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const WALLET = "6Ypk8jZiSNgFiwxnyUvWNtv8ni77wQEv8oThbVsiGzz2";
const closeTime = Math.floor(Date.now() / 1000) + 86_400;

console.log("\na wallet named at creation survives to the mint");
{
  const { slug } = await createCommunityMarket({
    question: "Will the caller of this API be paid its own creator fee?",
    closeTime, creatorWallet: WALLET,
  });
  const detail = await communityMarketDetail(slug);
  check("the market exists", Boolean(detail));
  check("and it remembers the wallet that opened it", detail?.creatorWallet === WALLET,
    `got ${detail?.creatorWallet ?? "null"}`);
}

console.log("\nand a market opened without one is unchanged");
{
  const { slug } = await createCommunityMarket({
    question: "Will a tagged market still name its creator later?",
    closeTime,
  });
  const detail = await communityMarketDetail(slug);
  // Null, not undefined and not an empty string: ensureMinted hands this
  // straight to mintMarket, whose contract is "null means unnamed".
  check("creatorWallet is null", detail?.creatorWallet === null,
    `got ${JSON.stringify(detail?.creatorWallet)}`);
}

console.log("\nthe on-demand mint reads it, which is the whole point");
{
  const src = readFileSync("src/server.ts", "utf8");
  const fn = src.slice(src.indexOf("async function ensureMinted"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  check("ensureMinted mints with the row's creator",
    /creator:\s*detail\.creatorWallet\b/.test(body),
    "a market minted on demand has no other way to learn who opened it");
  check("and never hard-codes an unnamed creator",
    !/creator:\s*null\b/.test(body),
    "creator: null here silently drops the wallet the caller paid to name");
}

console.log("\nthe column is actually added to existing deployments");
{
  const store = readFileSync("src/store/markets.ts", "utf8");
  // CREATE TABLE IF NOT EXISTS never alters an existing table, so a column
  // declared only in the create block reaches a fresh test database and never
  // reaches production. It has to be an ALTER.
  check("creator_wallet is added by ALTER, not just declared",
    /ALTER TABLE community_market ADD COLUMN IF NOT EXISTS creator_wallet/.test(store));
  check("and the insert writes it",
    /INSERT INTO community_market[^`]*creator_wallet/.test(store));
}

console.log(failures === 0
  ? "\nall creator-wallet checks passed.\n"
  : `\n${failures} creator-wallet check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
