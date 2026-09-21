// Smoke test: does the REWRITTEN client actually talk to the DEPLOYED program?
//
// The unit tests prove the program's logic on localnet. They cannot prove the
// thing that was wrong: a stale IDL, a PDA seeded differently from the program,
// and a createMarket sending three arguments to a five-argument instruction.
// All three of those are silent against a local mock and only bite against the
// real deployment, so this runs the real path.
//
// Costs a little devnet SOL and needs the network, so it is deliberately NOT
// named test-* and does not run under `npm test`.
//
// Run with: npx tsx scripts/devnet-smoke.ts
//
// DEVNET ONLY, hard-refused elsewhere. Every market it opens is a real market
// with a real vault, and the point of the script is to open several throwaway
// ones. On mainnet that is somebody's money and a row of junk markets in the
// feed. Verifying a mainnet deploy is a different job with a different script.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CREATOR_FEE_BPS_REAL, PROTOCOL_FEE_BPS_REAL } from "../src/store/economy.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
if (!/\bdevnet\b/.test(RPC)) {
  console.error(`refusing to run against ${RPC}: this script mints throwaway markets and is devnet-only`);
  process.exit(1);
}

process.env.SOLANA_ADMIN_SECRET_KEY = readFileSync(
  path.join(os.homedir(), ".config/solana/id.json"), "utf8",
).trim();
process.env.SOLANA_RPC_URL = RPC;
process.env.ONCHAIN_ENABLED = "true";

const {
  mintMarket, fetchMarketOnChain, nameCreator, preparePositionTx,
  prepareCreatorFeeTx, adminAddress, adminBalanceSol, explorerUrl, cluster,
} = await import("../src/chain/oddieChain.js");

let bad = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (pass) console.log(`  ok   ${name}`);
  else { bad++; console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
};

console.log(`\ncluster: ${cluster()}`);
console.log(`admin:   ${await adminAddress()}  (${(await adminBalanceSol())?.toFixed(3)} SOL)\n`);

// Any valid pubkey works: nothing here signs as the creator, it only checks
// that the address we name is the address that reads back.
const CREATOR = "52YvH8wXqfxgdmXpPuJkwewyw4Pwzj67PSsY3GrXL77z";

const marketId = Date.now();
const minted = await mintMarket({
  marketId,
  question: "Does the rewired client reach the deployed program?",
  criteria: "Settled by whether this script prints a signature.",
  closeTime: Math.floor(Date.now() / 1000) + 3600,
  creator: null,          // the normal case: tagger has no wallet yet
  creatorFeeBps: CREATOR_FEE_BPS_REAL,
  protocolFeeBps: PROTOCOL_FEE_BPS_REAL,
});
ok("mintMarket lands a market on devnet", !!minted, "returned null; see the [chain] log line above");
if (!minted) process.exit(1);
console.log(`       ${explorerUrl(minted.pubkey)}`);

// Reading it back is what proves the PDA derivation agrees with the program.
// A wrong seed does not throw, it points at an empty address, so a successful
// fetch here is the actual assertion.
const state = await fetchMarketOnChain(minted.pubkey);
ok("the market reads back at the derived PDA", !!state, "null means the seeds disagree with the program");
ok("it opens unresolved with an empty pool", state?.resolved === false && state?.totalYesLamports === 0 && state?.totalNoLamports === 0, JSON.stringify(state));
ok("the fee rate stored is the 3% we asked for", state?.creatorFeeBps === 300, String(state?.creatorFeeBps));
ok("creator is null, not the all-zero address leaking through", state?.creator === null, String(state?.creator));

// set_creator: the instruction the old program did not have at all.
const nameSig = await nameCreator(minted.pubkey, CREATOR);
ok("nameCreator names an unnamed market", !!nameSig);
const named = await fetchMarketOnChain(minted.pubkey);
ok("the creator is readable afterwards", named?.creator === CREATOR, String(named?.creator));

// One way: naming again must be refused by the program, not by us.
const second = await nameCreator(minted.pubkey, "11111111111111111111111111111112");
ok("naming a second time is refused on-chain", second === null);
const after = await fetchMarketOnChain(minted.pubkey);
ok("...and the creator did not move", after?.creator === CREATOR, String(after?.creator));

// The two user-signed transactions only need to BUILD here. Signing them is
// the wallet's job and is not what this test is for.
const posTx = await preparePositionTx({
  marketPubkey: minted.pubkey, userPubkey: CREATOR, side: "yes", lamports: 10_000_000,
});
ok("preparePositionTx builds against the real market", typeof posTx === "string" && posTx.length > 0);

const feeTx = await prepareCreatorFeeTx({ marketPubkey: minted.pubkey, creatorPubkey: CREATOR });
ok("prepareCreatorFeeTx builds against the real market", typeof feeTx === "string" && feeTx.length > 0);

console.log(bad === 0 ? "\nall devnet checks passed.\n" : `\n${bad} devnet check(s) FAILED.\n`);
process.exit(bad === 0 ? 0 : 1);
