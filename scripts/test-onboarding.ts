// New-user onboarding — isNewUserFor (stage 1's gate), placeCall's firstEver
// flag, claimTagTeachingMoment (stage 2's one-shot gate), and claimGuidedTour
// (the first-visit tour's one-shot gate) — against the real store on the
// in-memory backend.
//
// Run with: npm run test-onboarding

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database — unset DATABASE_URL");
  process.exit(1);
}

import {
  createCommunityMarket, openCommunityMarkets, placeCall, isNewUserFor, claimTagTeachingMoment,
  claimGuidedTour,
} from "../src/store/markets.js";
import type { Market } from "../src/venues/types.js";
import type { PlaceResult } from "../src/store/markets.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
}

const soon = () => Math.floor(Date.now() / 1000) + 86_400;
const mk = async (question: string, yesPct = 50): Promise<string> =>
  (await createCommunityMarket({ question, category: "Sports", yesPct, closeTime: soon() })).slug;
const call = async (slug: string, deviceId: string, side: "yes" | "no" = "yes", tokens = 10): Promise<PlaceResult> => {
  const live = (await openCommunityMarkets()) as unknown as Market[];
  const r = await placeCall(slug, side, tokens, deviceId, live);
  if (!r.ok) throw new Error(`placeCall ${slug} ${deviceId}: ${JSON.stringify(r)}`);
  return r;
};

// Same collision-proof helper as the other in-memory test scripts — see
// test-return-triggers.ts for why String(n).repeat(...) is wrong.
const DEV = (n: number) => `dev-${String(n).padStart(8, "0")}${"a".repeat(24)}`;

console.log("\nisNewUserFor: stage 1's gate — zero calls ever, not just zero OPEN calls");
{
  const dev = DEV(1);
  check("a device with no history at all is new", await isNewUserFor(dev));

  const slug = await mk("onboarding pick one?");
  await call(slug, dev);
  check("one call later, no longer new", !(await isNewUserFor(dev)));

  const dev2 = DEV(2);
  check("a different, untouched device is still new (no cross-device leakage)", await isNewUserFor(dev2));
}

console.log("\nplaceCall's firstEver: true exactly once per device, on the very first call");
{
  const dev = DEV(3);
  const slugA = await mk("onboarding pick three-a?");
  const r1 = await call(slugA, dev);
  check("the first call ever reports firstEver:true", r1.ok && r1.firstEver === true, JSON.stringify(r1));

  const slugB = await mk("onboarding pick three-b?");
  const r2 = await call(slugB, dev, "no"); // a SECOND market, same device
  check("a second call, on a DIFFERENT market, is not firstEver", r2.ok && r2.firstEver === false, JSON.stringify(r2));

  const r3 = await call(slugA, dev, "no", 5); // a second position on the SAME market
  check("a second call on the SAME market is also not firstEver", r3.ok && r3.firstEver === false, JSON.stringify(r3));
}

console.log("\nclaimTagTeachingMoment: shown once, ever, per device");
{
  const dev = DEV(4);
  check("the first claim for a fresh device succeeds (show:true)", await claimTagTeachingMoment(dev) === true);
  check("a second claim for the SAME device is refused", await claimTagTeachingMoment(dev) === false);
  check("a third claim is still refused — not just 'once per process tick'", await claimTagTeachingMoment(dev) === false);

  const other = DEV(5);
  check("a DIFFERENT device gets its own independent first claim", await claimTagTeachingMoment(other) === true);
  check("...and that device is now also spent", await claimTagTeachingMoment(other) === false);

  // The realistic client sequence: firstEver:true call -> claim -> claim again
  // on the (impossible, but defensively tested) second "first" call.
  const seq = DEV(6);
  const slug = await mk("onboarding pick six?");
  const r = await call(slug, seq);
  check("setup: this call really is firstEver", r.ok && r.firstEver === true);
  check("the client's claim right after locking succeeds", await claimTagTeachingMoment(seq) === true);
  // Even if some bug made a LATER call also report firstEver:true (it can't —
  // see the block above — but the server-side gate must not depend on the
  // client getting that right), the persisted flag alone must still refuse it.
  check("a stray extra claim call is refused regardless of what the client believed", await claimTagTeachingMoment(seq) === false);
}

console.log("\nclaimGuidedTour: the first-visit tour fires once, ever, per device");
{
  const dev = DEV(7);
  check("a fresh device gets the tour", await claimGuidedTour(dev) === true);
  check("a reload (second claim, same device) does NOT re-fire it", await claimGuidedTour(dev) === false);
  check("...and neither does a third", await claimGuidedTour(dev) === false);

  const other = DEV(8);
  check("a different device gets its own tour", await claimGuidedTour(other) === true);
  check("...and is then spent too", await claimGuidedTour(other) === false);
}

console.log("\nthe two one-shot flags are independent — one never consumes the other");
{
  const dev = DEV(9);
  check("the tour claim succeeds", await claimGuidedTour(dev) === true);
  // Different column, different flag: taking the tour must not silently spend
  // this device's (later, unrelated) tag-teaching moment.
  check("the tag-teaching moment is still available afterwards", await claimTagTeachingMoment(dev) === true);
  check("...and the tour is still spent", await claimGuidedTour(dev) === false);
  check("...and the teaching moment is now spent too", await claimTagTeachingMoment(dev) === false);
}

console.log(failures === 0 ? "\nall onboarding checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
