// Accounts, linking and the one-time bonus, against the in-memory store.
// The provider identity is injected, so no browser and no consent screen is
// involved: OAuth's job is to produce an `Identity`, and everything downstream
// of that is what this file tests.
//
// Run with: npm run test-accounts

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database — unset DATABASE_URL");
  process.exit(1);
}

import { createSlug, getWallet, placeCall, positionsFor, sellPosition, slugFor, STARTING_PREDICTIONS, CALL_COST } from "../src/store/markets.js";
import { linkAccount, accountsFor, CONNECT_BONUS } from "../src/store/accounts.js";
import type { Market } from "../src/venues/types.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

const mk = (id: string, q: string, yesPct: number): Market => ({
  venue: "polymarket", venueId: id, question: q, yesPct,
  closesAt: "2026-12-31T00:00:00Z", volumeUsd: 1000, venueUrl: "x", tags: [],
});
const move = async (m: Market, yesPct: number) => { const n = { ...m, yesPct }; await createSlug(n); return n; };

const btc = mk("BTC", "Will Bitcoin close above $70,000 in July?", 39);
const cup = mk("CUP", "Will France win the 2026 FIFA World Cup?", 40);
await createSlug(btc); await createSlug(cup);

const ALICE_X = { provider: "twitter", uid: "1111", handle: "@alice", name: "Alice" } as const;
const ALICE_G = { provider: "google", uid: "g-1111", handle: null, name: "Alice A" } as const;
const BOB_X = { provider: "twitter", uid: "2222", handle: "@bob", name: "Bob" } as const;

const PHONE = "alice-phone-0001";
const LAPTOP = "alice-laptop-001";
const BOB_PHONE = "bob-phone-00001";

console.log("\nan anonymous device plays, then signs in");
{
  await placeCall(slugFor(btc), "yes", CALL_COST, PHONE, [btc]);   // 5 -> 4
  const before = (await getWallet(PHONE)).tokens;
  check("staked its one prediction", before === STARTING_PREDICTIONS - CALL_COST, `${before}`);

  const r = await linkAccount(PHONE, ALICE_X);
  check("the first link seeds the account", r.seeded === true);
  check("...pays the bonus once", r.bonus === CONNECT_BONUS);
  check("...and makes this device the account's stream", r.canonicalDevice === PHONE);

  const after = (await getWallet(PHONE)).tokens;
  check("the bonus lands in the balance", after === before + CONNECT_BONUS, `${after}`);

  const pos = await positionsFor(PHONE, [btc]);
  check("the open position survived the link", pos.open.length === 1, `${pos.open.length}`);

  const accts = await accountsFor(PHONE);
  check("Profile can name the account", accts.length === 1 && accts[0].handle === "@alice", JSON.stringify(accts));
}

console.log("\nthe same identity on a second browser");
{
  // The laptop is a brand-new device: it is born with the free starting predictions.
  const fresh = (await getWallet(LAPTOP)).tokens;
  check("the laptop starts anonymous with the starting handful", fresh === STARTING_PREDICTIONS, `${fresh}`);

  const r = await linkAccount(LAPTOP, ALICE_X);
  check("no second bonus for the same identity", r.bonus === 0, JSON.stringify(r));
  check("...and it did not seed a new account", r.seeded === false);
  check("...it points at the phone's stream", r.canonicalDevice === PHONE);

  const w = await getWallet(LAPTOP);
  const phoneStreamBalance = STARTING_PREDICTIONS - CALL_COST + CONNECT_BONUS; // 5 - 1 + 5 = 9
  check("the laptop now reads the ACCOUNT's balance", w.tokens === phoneStreamBalance, `${w.tokens}`);
  // The whole anti-farming rule, stated as a number: the laptop's own free
  // starting predictions did not arrive. It reads staked-down-phone + bonus,
  // NOT the account balance plus the laptop's fresh grant, nor the fresh grant alone.
  check("...and its own free starting predictions were NOT added",
    w.tokens !== phoneStreamBalance + STARTING_PREDICTIONS && w.tokens !== STARTING_PREDICTIONS);

  const pos = await positionsFor(LAPTOP, [btc]);
  check("the laptop sees the phone's open position", pos.open.length === 1, `${pos.open.length}`);
}

console.log("\nplay on one device shows up on the other");
{
  const moved = await move(btc, 44);
  const open = (await positionsFor(LAPTOP, [moved])).open[0];
  const sold = await sellPosition(open.id, LAPTOP, [moved]);   // sell from the laptop
  // A CALL_COST-sized (1) position cashed out early: round((1/0.39) * 0.44) = 1.
  // This is the flagged side effect of the fixed-cost redesign — cash-out lost
  // its granularity along with variable staking (see markets.ts positionsFor's
  // valueNow comment) — not a bug in sellPosition itself.
  check("the laptop can sell a position the phone opened", sold.ok && sold.proceeds === 1, JSON.stringify(sold));

  const fromPhone = await positionsFor(PHONE, []);
  check("the phone sees it closed", fromPhone.closed.length === 1 && fromPhone.open.length === 0);
  check("...and the edge is on the account's reputation", fromPhone.overall.avgEdge === 5, `${fromPhone.overall.avgEdge}`);
  const bal = (await getWallet(PHONE)).tokens;
  const expected = (STARTING_PREDICTIONS - CALL_COST + CONNECT_BONUS) + 1; // + the 1 just sold for
  check("one balance, both browsers", bal === (await getWallet(LAPTOP)).tokens && bal === expected, `${bal}`);
}

console.log("\na second provider on the same person");
{
  const r = await linkAccount(PHONE, ALICE_G);
  check("Google creates its own account row", r.seeded === true);
  check("...pays its own bonus (once per identity, as specified)", r.bonus === CONNECT_BONUS);
  check("...on the SAME canonical device", r.canonicalDevice === PHONE);

  const accts = await accountsFor(LAPTOP);
  check("Profile shows both connections from either browser", accts.length === 2, JSON.stringify(accts.map((a) => a.provider)));

  const again = await linkAccount(LAPTOP, ALICE_G);
  check("re-connecting Google grants nothing", again.bonus === 0);
}

console.log("\nsomeone else is someone else");
{
  const r = await linkAccount(BOB_PHONE, BOB_X);
  check("a different X id seeds its own account", r.seeded && r.bonus === CONNECT_BONUS);
  check("...with its own stream", r.canonicalDevice === BOB_PHONE);
  const bob = await positionsFor(BOB_PHONE, []);
  check("Bob sees none of Alice's positions", bob.closed.length === 0 && bob.open.length === 0);
  const bal = (await getWallet(BOB_PHONE)).tokens;
  check("Bob has his own starting handful + the connect bonus", bal === STARTING_PREDICTIONS + CONNECT_BONUS, `${bal}`);
}

console.log("\nthe bonus cannot be re-claimed by deleting devices");
{
  // Re-linking the original identity from a third, unseen browser.
  const r = await linkAccount("alice-tablet-001", ALICE_X);
  check("a third browser gets no bonus", r.bonus === 0, JSON.stringify(r));
  check("...and still lands on the same stream", r.canonicalDevice === PHONE);
}

console.log(failures === 0 ? "\nall account checks passed.\n" : `\n${failures} account check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
