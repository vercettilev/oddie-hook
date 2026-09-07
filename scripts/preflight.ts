/**
 * IS THIS DEPLOYMENT ACTUALLY ABLE TO TAKE A REAL BET?
 *
 *   npm run preflight
 *
 * Every line below is a way the app can look completely healthy and still be
 * unable to move a single lamport. None of them raise, none of them show up in
 * a test suite, and most of them are invisible until a person has already
 * pressed a yellow button with their own money behind it.
 *
 * This exists because the move to mainnet is a set of independent switches --
 * a program deployed, an RPC pointed somewhere, an authority funded, an IDL
 * that matches, a gate opened -- and the failure mode of getting one wrong is
 * never an error. It is a market that mints at 0 bps, or an explorer link to
 * the wrong chain, or a mint that is refused with a log line nobody reads.
 *
 * It only READS. It signs nothing, spends nothing and changes nothing, so it is
 * safe to run against production at any time, and it is the thing to run
 * immediately after a deploy rather than the thing to write afterwards.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { cluster, onchainEnabled, isChainEnabled, adminAddress, adminBalanceSol, chainRunway } from "../src/chain/oddieChain.js";

let bad = 0, warn = 0;
const ok = (name: string, detail = "") => console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
const no = (name: string, detail = "") => { bad++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); };
const hm = (name: string, detail = "") => { warn++; console.log(`  ! ${name}${detail ? ` — ${detail}` : ""}`); };

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const C = cluster();

console.log(`\nORACLE, CHAIN AND GATES, as this process sees them\n`);

// ---- 1. which chain, and does the answer come from a decision or a default --
console.log("cluster");
{
  const explicit = Boolean(process.env.SOLANA_CLUSTER);
  ok(`cluster is ${C}`, explicit ? "from SOLANA_CLUSTER" : "derived from the RPC url");
  if (!explicit && C === "mainnet-beta") {
    // Deriving mainnet is the DEFAULT branch: any RPC host whose name does not
    // contain devnet or testnet lands here, including a typo. On the chain
    // where the SOL is real, that guess should be a decision.
    hm("mainnet was derived, not declared", "set SOLANA_CLUSTER=mainnet-beta so a bad RPC url cannot mislabel real money");
  }
  if (!process.env.SOLANA_RPC_URL) {
    hm("SOLANA_RPC_URL is unset", "falling back to the public devnet endpoint");
  }
}

// ---- 2. the flags that decide whether any of this runs at all --------------
console.log("\nswitches");
{
  onchainEnabled() ? ok("ONCHAIN_ENABLED is on") : no("ONCHAIN_ENABLED is off", "no market can mint and no stake can be taken");
  isChainEnabled() ? ok("the chain layer is usable") : no("the chain layer is not usable", "onchain flag on but the client will not load; check ODDIE_CHAIN_SECRET");
  const appOpen = (process.env.APP_OPEN ?? "false").toLowerCase() === "true";
  appOpen ? ok("APP_OPEN is true", "the app serves; /markets is reachable")
          : hm("APP_OPEN is false", "every app route redirects to /genesis, so nobody can reach a market");
  const oracleOn = (process.env.ORACLE_ENABLED ?? "false").toLowerCase() === "true";
  const oracleDry = (process.env.ORACLE_DRY_RUN ?? "true").toLowerCase() !== "false";
  oracleOn ? ok(`oracle loop on`, oracleDry ? "DRY RUN, nothing settles" : "SETTLING FOR REAL")
           : hm("oracle loop off", "markets only close when a person clicks resolve");
  const botOn = (process.env.X_BOT_ENABLED ?? "false").toLowerCase() === "true";
  const botDry = (process.env.X_BOT_DRY_RUN ?? "true").toLowerCase() !== "false";
  botOn ? ok(`x bot on`, botDry ? "DRY RUN, nothing is posted" : "POSTING FOR REAL")
        : hm("x bot off", "a tag on X opens nothing; the product's front door is shut");
}

// ---- 3. the program, on the chain we claim to be on ------------------------
console.log("\nprogram");
const conn = new Connection(RPC, "confirmed");
let programId: string | null = null;
{
  try {
    const idl = JSON.parse(readFileSync("src/chain/oddie_chain_idl.json", "utf8"));
    programId = process.env.ODDIE_CHAIN_PROGRAM_ID ?? idl.address;
    ok(`program id ${programId}`, process.env.ODDIE_CHAIN_PROGRAM_ID ? "from env" : "from the IDL");
  } catch (e) {
    no("could not read the IDL", (e as Error).message);
  }
}
if (programId) {
  try {
    const info = await conn.getAccountInfo(new PublicKey(programId));
    if (!info) {
      // The exact shape of the Phantom wall: a transaction against a program
      // that is not on the chain the wallet simulates against cannot be
      // simulated, so the wallet blocks it and blames the site.
      no(`the program is NOT deployed on ${C}`, "every bet will fail simulation and the wallet will call this dApp malicious");
    } else if (!info.executable) {
      no("the program account exists but is not executable", "a deploy did not finish");
    } else {
      ok(`deployed and executable on ${C}`, `${info.data.length} bytes`);
    }
  } catch (e) {
    no("could not read the program account", (e as Error).message);
  }
}

// ---- 4. the wallet that pays rent for every market ------------------------
console.log("\nauthority");
{
  const addr = await adminAddress().catch(() => null);
  if (!addr) {
    no("no authority key loaded", "ODDIE_CHAIN_SECRET is missing or unreadable; nothing can mint or resolve");
  } else {
    ok(`authority ${addr}`);
    const sol = await adminBalanceSol().catch(() => null);
    if (sol === null) {
      // Not zero. An unreadable balance is unknown, and drawing it as empty is
      // the same class of lie the app refuses to tell about a pool.
      hm("balance could not be read", "unknown, not zero");
    } else {
      const r = chainRunway(Math.round(sol * 1e9));
      const line = `${sol.toFixed(4)} SOL, about ${r.marketsLeft} more market(s)`;
      if (r.state === "stopped") no("authority cannot mint", `${line} — below the floor, mints are refused`);
      else if (r.state === "low") hm("authority is low", line);
      else ok("authority funded", line);
    }
  }
}

// ---- 5. the IDL the server decodes with vs the program that was deployed ---
console.log("\nidl");
{
  // A drifted IDL does not throw on load. It throws on the first market read,
  // one market at a time, and anchor's fetchMultiple takes the whole board down
  // with a single undecodable account.
  try {
    const idl = JSON.parse(readFileSync("src/chain/oddie_chain_idl.json", "utf8"));
    const names: string[] = (idl.instructions ?? []).map((i: { name: string }) => i.name);
    const need = ["create_market", "take_position", "resolve_market", "claim_winnings", "claim_creator_fee", "refund_after_deadline"];
    const missing = need.filter((n) => !names.includes(n));
    missing.length
      ? no("the IDL is missing instructions the server calls", missing.join(", "))
      : ok(`IDL carries all ${need.length} instructions the server calls`);
  } catch (e) {
    no("could not check the IDL", (e as Error).message);
  }
}

console.log(
  bad === 0 && warn === 0 ? "\nready.\n"
  : bad === 0 ? `\n${warn} thing(s) worth a look, nothing blocking.\n`
  : `\n${bad} BLOCKING, ${warn} worth a look.\n`,
);
process.exit(bad === 0 ? 0 : 1);
