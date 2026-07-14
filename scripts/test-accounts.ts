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

import { createSlug, getWallet, placeCall, positionsFor, sellPosition, slugFor, STARTING_TOKENS } from "../src/store/markets.js";
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
  await placeCall(slugFor(btc), "yes", 50, PHONE, [btc]);       // 1000 -> 950
  const before = (await getWallet(PHONE)).tokens;
  check("staked 50 of its free 1000", before === 950, `${before}`);

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
  // The laptop is a brand-new device: it is born with 1000 free tokens.
  const fresh = (await getWallet(LAPTOP)).tokens;
  check("the laptop starts anonymous at 1000", fresh === STARTING_TOKENS, `${fresh}`);

  const r = await linkAccount(LAPTOP, ALICE_X);
  check("no second bonus for the same identity", r.bonus === 0, JSON.stringify(r));
  check("...and it did not seed a new account", r.seeded === false);
  check("...it points at the phone's stream", r.canonicalDevice === PHONE);

  const w = await getWallet(LAPTOP);
  check("the laptop now reads the ACCOUNT's balance (1050)", w.tokens === 1050, `${w.tokens}`);
  // The whole anti-farming rule, stated as a number: the laptop's free 1000 did
  // not arrive. 1050 = 950 staked-down phone + 100 bonus.
  check("...and its own free 1000 was NOT added", w.tokens !== 2050 && w.tokens !== 1000);

  const pos = await positionsFor(LAPTOP, [btc]);
  check("the laptop sees the phone's open position", pos.open.length === 1, `${pos.open.length}`);
}

console.log("\nplay on one device shows up on the other");
{
  const moved = await move(btc, 44);
  const open = (await positionsFor(LAPTOP, [moved])).open[0];
  const sold = await sellPosition(open.id, LAPTOP, [moved]);   // sell from the laptop
  check("the laptop can sell a position the phone opened", sold.ok && sold.proceeds === 56, JSON.stringify(sold));

  const fromPhone = await positionsFor(PHONE, []);
  check("the phone sees it closed", fromPhone.closed.length === 1 && fromPhone.open.length === 0);
  check("...and the edge is on the account's reputation", fromPhone.overall.avgEdge === 5, `${fromPhone.overall.avgEdge}`);
  const bal = (await getWallet(PHONE)).tokens;
  check("one balance, both browsers", bal === (await getWallet(LAPTOP)).tokens && bal === 1050 + 56, `${bal}`);
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
  check("Bob has his own 1000 + 100", bal === STARTING_TOKENS + CONNECT_BONUS, `${bal}`);
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
