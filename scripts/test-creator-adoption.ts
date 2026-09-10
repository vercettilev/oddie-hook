/**
 * THE 2% HAS TO REACH THE PERSON THE HEADLINE PROMISES IT TO.
 *
 * "Tag @oddiefun under any claim on X. Keep 2% of its pool." describes tagging
 * FIRST, and tagging first was the one order that could never be paid.
 *
 * The fee is paid to an on-chain `creator`, written by a step that finds a
 * person's markets by DEVICE. recordSurfacer resolved handle to device once, at
 * tag time, and nothing ever revisited it. So a stranger's market carried a null
 * device forever: they could connect X, link a wallet, and still never be named,
 * while resolve_market went on deducting their 2% and stranding it in the vault
 * against the all-zero sentinel.
 *
 * These run against the in-memory store, which is the same code path the
 * Postgres branch mirrors, so they check the RULE rather than the SQL.
 *
 * Run with: npm run test-creator-adoption
 */
import { recordSurfacer, adoptSurfacedMarkets, surfacerFor } from "../src/store/markets.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

async function main() {
  console.log("\nthe market opener's 2%\n");

  // The shape the product actually advertises: a stranger tags, and has never
  // touched oddie before, so there is no device to resolve.
  await recordSurfacer("tagged-first", { handle: "stranger", sourceUrl: "https://x.com/stranger/status/1" });
  const before = await surfacerFor("tagged-first");
  check("a market opened by a tag records the handle", before?.handle === "stranger", JSON.stringify(before));
  check("...and carries no device, because they had not connected yet",
    !before?.deviceId, JSON.stringify(before));

  // They come to the app afterwards. This is the moment that used to change
  // nothing at all.
  const n = await adoptSurfacedMarkets("@Stranger", "device-abc");
  check("connecting X adopts the markets they already opened", n === 1, String(n));
  const after = await surfacerFor("tagged-first");
  check("...so the row can now be found by device", after?.deviceId === "device-abc", JSON.stringify(after));

  // Idempotent, and never a thief: a row that already names somebody is theirs.
  const again = await adoptSurfacedMarkets("@stranger", "device-xyz");
  check("a second connect adopts nothing, because the hole is filled", again === 0, String(again));
  const still = await surfacerFor("tagged-first");
  check("...and the first owner keeps it", still?.deviceId === "device-abc", JSON.stringify(still));

  // Somebody else's market is not adopted by a matching device.
  await recordSurfacer("someone-else", { handle: "other", sourceUrl: "https://x.com/other/status/2" });
  const none = await adoptSurfacedMarkets("stranger", "device-abc");
  check("adopting is scoped to the handle, never to everything unclaimed", none === 0, String(none));
  const other = await surfacerFor("someone-else");
  check("...and the other handle's row is untouched", !other?.deviceId, JSON.stringify(other));

  console.log(failures ? `\n${failures} check(s) failed.\n` : "\nall creator-adoption checks passed.\n");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
