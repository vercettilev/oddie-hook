// Which open markets tell a wallet "this pays you". A wrong yes here tells
// somebody a market is theirs; a wrong no hides one they just linked.
import { readFileSync } from "node:fs";
import { marketsPaying, type OpenerCandidate } from "../src/opener.js";
import type { MarketRead } from "../src/chain/oddieChain.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

const ME = "EASrFeMcAEdP6dbnHe5FvyWA4ZKcxV94S239HKRWLh12";
const OTHER = "H3aQvzY4qPnR8JgfmSN6vv5qEhD9G5SyQcK7aZNS8ej9";
const cand = (slug: string, named: boolean, pk: string | null): OpenerCandidate =>
  ({ slug, question: slug, closesAt: null, feeBps: 200, onchainPubkey: pk, named });
const state = (creator: string | null): MarketRead =>
  ({ ok: true, state: { creator } } as unknown as MarketRead);

const cands = [
  cand("row-names-me", true, null),          // unminted, wallet on the row
  cand("minted-with-me", true, "pkA"),       // minted with the wallet already known
  cand("chain-names-me", false, "pkB"),      // named on chain after minting
  cand("chain-names-other", false, "pkC"),
  cand("chain-names-nobody", false, "pkD"),
  cand("unreadable", false, "pkE"),
  cand("never-read", false, "pkF"),
];
const states = new Map<string, MarketRead>([
  ["pkB", state(ME)], ["pkC", state(OTHER)], ["pkD", state(null)],
  ["pkE", { ok: false, reason: "unreadable", error: "rpc" }],
]);
const got = marketsPaying(ME, cands, states).map((c) => c.slug);
check("a row that names the wallet counts", got.includes("row-names-me") && got.includes("minted-with-me"));
check("a market named on chain after minting counts", got.includes("chain-names-me"));
check("a market naming somebody else does not", !got.includes("chain-names-other"));
check("...nor one naming nobody yet", !got.includes("chain-names-nobody"));
check("an unreadable or unread account is left out, never guessed", !got.includes("unreadable") && !got.includes("never-read"));

/* THE PROFILE, WIRED. The page has to ask, pass the answer to the fees
   section, and stop asking a Telegram opener to link the wallet they chose. */
{
  const page = readFileSync("public/app/you.html", "utf8");
  check("the profile reads what will pay this wallet", /\/api\/chain\/opener\?wallet=/.test(page));
  check("...and hands it to the fees section", /feesSection\(fees, true, opener\)/.test(page));
  check("a wallet a Telegram opener chose is not asked to link again without X",
    /var chosen = Boolean\(opener && opener\.telegram\);/.test(page) && /else if \(HAS_X\)/.test(page));
  check("somebody who came from Telegram is not sent to the X gate", /recall\("tg"\)/.test(page));
  const earn = readFileSync("public/tg-earn.html", "utf8");
  check("...because the collect page remembers them", /remember\("tg", "1", 365\)/.test(earn) && /\/app\/id\.js/.test(earn));
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall opener checks passed.\n");
process.exit(failures ? 1 : 0);
