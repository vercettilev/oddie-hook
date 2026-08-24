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
import { linkAccount, accountsFor } from "../src/store/accounts.js";
import { _memGrant } from "../src/store/markets.js";
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
  // Linking pays NOTHING. It used to grant a connect bonus, once per account,
  // and these two checks pinned that grant. The score is earned by tagging
  // markets into existence and being loud about them; an account is how it
  // follows you, not a way to be handed some. A bonus reappearing here should
  // fail this test until somebody argues for it in the open.
  check("...and pays nothing for it", !("bonus" in r));
  check("...and makes this device the account's stream", r.canonicalDevice === PHONE);

  const after = (await getWallet(PHONE)).tokens;
  check("the balance did not move on sign-in", after === before, `${before} -> ${after}`);

  const pos = await positionsFor(PHONE, [btc]);
  check("the open position survived the link", pos.open.length === 1, `${pos.open.length}`);

  const accts = await accountsFor(PHONE);
  check("Profile can name the account", accts.length === 1 && accts[0].handle === "@alice", JSON.stringify(accts));
}

console.log("\nthe same identity on a second browser");
{
  // Deliberately shift the account's stream first. The connect bonus used to
  // make the stream's balance differ from a fresh device's handful on its own;
  // with linking paying nothing, both sit at the same number and the
  // anti-farming assertion below cannot tell "read the account" from "got a
  // fresh grant". Three test-granted tokens restore the distinction.
  _memGrant(PHONE, 3);
  // The laptop is a brand-new device: it is born with the free starting predictions.
  const fresh = (await getWallet(LAPTOP)).tokens;
  check("the laptop starts anonymous with the starting handful", fresh === STARTING_PREDICTIONS, `${fresh}`);

  const r = await linkAccount(LAPTOP, ALICE_X);
  check("...it did not seed a new account", r.seeded === false);
  check("...it points at the phone's stream", r.canonicalDevice === PHONE);

  const w = await getWallet(LAPTOP);
  const phoneStreamBalance = STARTING_PREDICTIONS - CALL_COST + 3; // the phone's ledger incl. the 3 granted above; linking added nothing
  check("the laptop now reads the ACCOUNT's balance", w.tokens === phoneStreamBalance, `${w.tokens}`);
  // The whole anti-farming rule, stated as a number: the laptop's own free
  // starting predictions did not arrive. It reads the phone's stream as-is,
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
  // Closing still WORKS across devices, which is what this section is about.
  // What it no longer returns is money: a free call stakes nothing, so there
  // is nothing to cash out — `round((0/0.39) * 0.44) = 0`. That is the honest
  // arithmetic of a free position rather than a regression, and it is the
  // argument for retiring the sell affordance from the UI: an early exit that
  // can only ever return zero is a button that cannot do anything for anyone.
  // The reputation half is untouched, and the next two checks prove it.
  check("the laptop can close a position the phone opened", sold.ok, JSON.stringify(sold));
  check("...and a free position cashes out for nothing", sold.ok && sold.proceeds === 0, JSON.stringify(sold));

  const fromPhone = await positionsFor(PHONE, []);
  check("the phone sees it closed", fromPhone.closed.length === 1 && fromPhone.open.length === 0);
  check("...and the edge is on the account's reputation", fromPhone.overall.avgEdge === 5, `${fromPhone.overall.avgEdge}`);
  const bal = (await getWallet(PHONE)).tokens;
  // Nothing was spent to call and nothing came back from closing, so the
  // balance is exactly what the grants put there.
  const expected = STARTING_PREDICTIONS + 3; // the starting handful plus this test's own 3; sign-in contributed nothing
  check("one balance, both browsers", bal === (await getWallet(LAPTOP)).tokens && bal === expected, `${bal}`);
}

console.log("\na second provider on the same person");
{
  const r = await linkAccount(PHONE, ALICE_G);
  check("Google creates its own account row", r.seeded === true);
  check("...and pays nothing either", !("bonus" in r));
  check("...on the SAME canonical device", r.canonicalDevice === PHONE);

  const accts = await accountsFor(LAPTOP);
  check("Profile shows both connections from either browser", accts.length === 2, JSON.stringify(accts.map((a) => a.provider)));

  const again = await linkAccount(LAPTOP, ALICE_G);
  check("re-connecting Google is a no-op for the ledger", !("bonus" in again));
}

console.log("\nsomeone else is someone else");
{
  const r = await linkAccount(BOB_PHONE, BOB_X);
  check("a different X id seeds its own account", r.seeded === true);
  check("...with its own stream", r.canonicalDevice === BOB_PHONE);
  const bob = await positionsFor(BOB_PHONE, []);
  check("Bob sees none of Alice's positions", bob.closed.length === 0 && bob.open.length === 0);
  const bal = (await getWallet(BOB_PHONE)).tokens;
  check("Bob has exactly his own starting handful, nothing for signing in", bal === STARTING_PREDICTIONS, `${bal}`);
}

console.log("\na third browser just lands on the same stream");
{
  const r = await linkAccount("alice-tablet-001", ALICE_X);
  check("nothing is granted, nothing is seeded", !("bonus" in r) && r.seeded === false, JSON.stringify(r));
  check("...and it lands on the same stream", r.canonicalDevice === PHONE);
}

console.log("\na second X account switches you, it does not merge you");
{
  // The production bug this prevents: two X identities sharing one canonical
  // device merged two people into one record — the public profile answered
  // with the wrong name, the leaderboard's brand exclusion took the human's
  // row with it, and one person's resolved calls were credited to the other.
  const BROWSER = "switch-browser-0001";
  const FIRST = { provider: "twitter" as const, uid: "sw-1", handle: "@first_identity" };
  const SECOND = { provider: "twitter" as const, uid: "sw-2", handle: "@second_identity" };

  const a = await linkAccount(BROWSER, FIRST);
  check("the first X account takes this browser's stream", a.canonicalDevice === BROWSER, a.canonicalDevice);

  const b = await linkAccount(BROWSER, SECOND);
  check("a SECOND X account gets a stream of its own", b.canonicalDevice !== BROWSER, b.canonicalDevice);
  check("...and it is a real, separate id", !!b.canonicalDevice && b.canonicalDevice !== a.canonicalDevice);

  // The browser now acts as the second identity, and only that one.
  const held = await accountsFor(BROWSER);
  check("the browser now holds exactly one X identity", held.filter((x) => x.provider === "twitter").length === 1,
    held.map((x) => x.handle).join(", "));
  check("...and it is the one just signed in", held.some((x) => x.handle === "@second_identity"));

  // Switching back is just signing in again — no new stream, no second bonus.
  const back = await linkAccount(BROWSER, FIRST);
  check("signing back in returns to the first stream", back.canonicalDevice === a.canonicalDevice, back.canonicalDevice);
  check("...and hands over nothing for doing so", !("bonus" in back));

  // A DIFFERENT provider still shares, because that is one person proving
  // themselves twice rather than two people.
  const g = await linkAccount(BROWSER, { provider: "google" as const, uid: "sw-g", email: "sw@example.com" });
  check("Google still joins the stream it signed in from", g.canonicalDevice === a.canonicalDevice, g.canonicalDevice);
}

console.log(failures === 0 ? "\nall account checks passed.\n" : `\n${failures} account check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
