/**
 * /@handle is a door onto the wallet's record, not a second record.
 *
 * walletForTwitterHandle is the inverse of twitterHandleForWallet and shares
 * its join: X account and wallet account on the same canonical device. If the
 * join is wrong in either direction the board shows base58 for a named person
 * or, worse, sends one person's handle to another person's money.
 *
 * Mem backend only; the pg branch is the same join in SQL.
 */
import { linkAccount, walletForTwitterHandle, twitterHandleForWallet } from "../src/store/accounts.js";

let failed = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
};

const W1 = "7dHbWXmci3dT8UFYWYZweBLXgycu4LNvBQzVQrqDVwPZ";
const W2 = "3VR6quBFcHbg3ZQ7aBViq7T4CaQATNBNLhHMJBv4qiVS";

console.log("\nhandle door\n");

// One person: X then wallet on the same device.
await linkAccount("dev-A", { provider: "twitter", uid: "x-1", handle: "@LevVercetti", name: "Lev" });
check("a handle with no wallet yet resolves to null, not to a stranger",
  (await walletForTwitterHandle("levvercetti")) === null);

await linkAccount("dev-A", { provider: "phantom", uid: W1, handle: "7dHb…VwPZ", name: null });
check("after linking a wallet the handle resolves to it", (await walletForTwitterHandle("levvercetti")) === W1);
check("case and the leading @ do not matter", (await walletForTwitterHandle("@LEVVERCETTI")) === W1);
check("and the join reads the same in the other direction",
  (await twitterHandleForWallet(W1)) === "levvercetti");

// A second person on a different device must not bleed in.
await linkAccount("dev-B", { provider: "twitter", uid: "x-2", handle: "@gabelaster", name: null });
await linkAccount("dev-B", { provider: "phantom", uid: W2, handle: "3VR6…qiVS", name: null });
check("two people, two devices, two answers",
  (await walletForTwitterHandle("levvercetti")) === W1 && (await walletForTwitterHandle("gabelaster")) === W2);

check("an unknown handle is null", (await walletForTwitterHandle("nobody_here")) === null);
check("a malformed handle is null, never a lookup", (await walletForTwitterHandle("not a handle!")) === null);

// Wallet first, X later: the order people actually arrive in from a bot link.
await linkAccount("dev-C", { provider: "phantom", uid: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", handle: "9xQe…VFin", name: null });
await linkAccount("dev-C", { provider: "twitter", uid: "x-3", handle: "@latecomer", name: null });
check("wallet first, X second still joins (naming is retroactive)",
  (await walletForTwitterHandle("latecomer")) === "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");

console.log(failed === 0 ? "\nall handle door checks passed.\n" : `\n${failed} FAILED\n`);
if (failed > 0) process.exit(1);
