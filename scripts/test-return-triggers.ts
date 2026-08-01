// The return-triggers layer — opposite-side notifications, closing-soon
// notifications, and the home page's open-calls summary — against the real
// store on the in-memory backend.
//
// Run with: npm run test-return-triggers

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database — unset DATABASE_URL");
  process.exit(1);
}

import {
  createCommunityMarket, openCommunityMarkets, placeCall, setHandle,
  noticesFor, notifyClosingSoon, openCallsSummaryFor,
  _memGrant,
} from "../src/store/markets.js";
import type { Market } from "../src/venues/types.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
}

const mkAt = async (question: string, yesPct: number, closeTime: number): Promise<string> =>
  (await createCommunityMarket({ question, category: "Sports", yesPct, closeTime })).slug;
const soon = (hoursOut: number) => Math.floor(Date.now() / 1000) + Math.round(hoursOut * 3600);
// notifyOppositeSide is fired with `void` inside placeCall — deliberately not
// awaited, the same "best-effort side job, must never block the call itself"
// idiom awardParticipation already uses. That means placeCall's own promise
// resolves before the notification write lands, so a caller that wants to
// assert on the notification needs to give the event loop a tick first.
const flush = () => new Promise((r) => setTimeout(r, 0));
const call = async (slug: string, deviceId: string, side: "yes" | "no", tokens = 10): Promise<void> => {
  const live = (await openCommunityMarkets()) as unknown as Market[];
  _memGrant(deviceId, tokens); // see test-settlement.ts's note: production only ever stakes CALL_COST now
  const r = await placeCall(slug, side, tokens, deviceId, live);
  if (!r.ok) throw new Error(`placeCall ${slug} ${deviceId}: ${JSON.stringify(r)}`);
  await flush();
};

// NOT String(n).repeat(32).slice(0,32) — for single-repeated-digit n (1, 11,
// 111...) that collapses to the same 32-char string for every n sharing a
// digit, so DEV(1) and DEV(11) silently collided (both "1111...1", 32 chars).
// Padding n into a fixed-width prefix BEFORE any repetition makes collision
// impossible for n up to 8 digits.
const DEV = (n: number) => `dev-${String(n).padStart(8, "0")}${"a".repeat(24)}`;
const noticesOfKind = async (deviceId: string, kind: string) =>
  (await noticesFor(deviceId)).filter((n) => n.kind === kind);

console.log("\nopposite-side: a holder gets notified when someone joins against them");
{
  const A = DEV(1), B = DEV(2);
  await setHandle(B, "latenightlurker");
  const slug = await mkAt("Will the Lakers make the playoffs?", 50, soon(48));
  await call(slug, A, "yes", 10);
  check("no notice yet — nobody has taken the other side", (await noticesOfKind(A, "opposite_side")).length === 0);
  await call(slug, B, "no", 10);
  const rows = await noticesOfKind(A, "opposite_side");
  check("exactly one opposite-side notice", rows.length === 1, String(rows.length));
  check("names the caller and both sides correctly", rows[0]?.body === `@latenightlurker just called NO on "Will the Lakers make the playoffs?" — you're on YES.`, rows[0]?.body);
  check("caller B is not notified about their own call", (await noticesOfKind(B, "opposite_side")).length === 0);
}

console.log("\nopposite-side: an anonymous caller (no handle) uses the fallback wording");
{
  const A = DEV(3), Anon = DEV(4);
  const slug = await mkAt("Will Bitcoin close above 100k?", 50, soon(48));
  await call(slug, A, "yes", 10);
  await call(slug, Anon, "no", 10);
  const rows = await noticesOfKind(A, "opposite_side");
  check("anonymous caller renders as 'anonymous caller', not a device stub",
    rows[0]?.body?.startsWith("anonymous caller just called NO"), rows[0]?.body);
}

console.log("\nopposite-side: same side never notifies (not opposite)");
{
  const A = DEV(5), B = DEV(6);
  const slug = await mkAt("Will the Fed cut rates?", 50, soon(48));
  await call(slug, A, "yes", 10);
  await call(slug, B, "yes", 10); // same side as A
  check("no notice — B agreed with A, didn't oppose", (await noticesOfKind(A, "opposite_side")).length === 0);
}

console.log("\nopposite-side: max one per market per user per day — batches instead of spamming");
{
  const A = DEV(7), B = DEV(8), C = DEV(9), D = DEV(10);
  const slug = await mkAt("Will the album debut at number one?", 50, soon(48));
  await call(slug, A, "yes", 10);
  await call(slug, B, "no", 10);
  await call(slug, C, "no", 10);
  await call(slug, D, "no", 10);
  const rows = await noticesOfKind(A, "opposite_side");
  check("still exactly ONE row after three opposing callers", rows.length === 1, String(rows.length));
  check("body evolved into the batched count wording", rows[0]?.body === `3 people took the other side of "Will the album debut at number one?" today — you're on YES.`, rows[0]?.body);
}

console.log("\nopposite-side: independent per market — one market's activity doesn't leak into another's count");
{
  const A = DEV(11), B = DEV(12);
  const slug1 = await mkAt("Market one for the isolation check?", 50, soon(48));
  const slug2 = await mkAt("Market two for the isolation check?", 50, soon(48));
  await call(slug1, A, "yes", 10);
  await call(slug2, A, "yes", 10);
  await call(slug1, B, "no", 10);
  const rows1 = await noticesOfKind(A, "opposite_side");
  check("only market one produced a notice", rows1.length === 1 && rows1[0]?.slug === slug1, JSON.stringify(rows1.map((r) => r.slug)));
}

console.log("\nclosing-soon: a market closing within 24h notifies every open holder, once");
{
  const A = DEV(13), B = DEV(14);
  const slug = await mkAt("Will this market close in 2 hours?", 50, soon(2));
  await call(slug, A, "yes", 10);
  await call(slug, B, "no", 10);
  const sent = await notifyClosingSoon();
  check("two notices sent (one per holder)", sent === 2, String(sent));
  const aRows = await noticesOfKind(A, "closing_soon");
  check("A got exactly one closing-soon notice", aRows.length === 1, String(aRows.length));
  check("body names the question and a real hour count", aRows[0]?.body === `"Will this market close in 2 hours?" closes in 2h — resolution coming.`, aRows[0]?.body);
  check("B got one too", (await noticesOfKind(B, "closing_soon")).length === 1);

  const sentAgain = await notifyClosingSoon();
  check("a second sweep sends nothing new — fires once, not on every tick", sentAgain === 0, String(sentAgain));
  check("still exactly one notice for A after the second sweep", (await noticesOfKind(A, "closing_soon")).length === 1);
}

console.log("\nclosing-soon: a market closing beyond the 24h window is left alone");
{
  const A = DEV(15);
  const slug = await mkAt("Will this market close in 3 days?", 50, soon(72));
  await call(slug, A, "yes", 10);
  await notifyClosingSoon();
  check("no notice — outside the 24h window", (await noticesOfKind(A, "closing_soon")).length === 0);
}

console.log("\nclosing-soon: a market with no open positions is never touched");
{
  await mkAt("An empty market nobody called, closing soon?", 50, soon(1));
  const sent = await notifyClosingSoon();
  check("nothing sent for a market with zero callers", sent === 0, String(sent));
}

console.log("\nopen-calls summary: the home page's Zeigarnik hook");
{
  const dev = DEV(16);
  const cold = await openCallsSummaryFor(dev);
  check("zero open positions -> count 0, no next-close", cold.count === 0 && cold.nextCloseAt === null, JSON.stringify(cold));

  const sooner = await mkAt("Which of two closes first?", 50, soon(5));
  const later = await mkAt("Which of two closes second?", 50, soon(30));
  await call(later, dev, "yes", 10);
  await call(sooner, dev, "yes", 10);
  const warm = await openCallsSummaryFor(dev);
  check("counts both open positions", warm.count === 2, String(warm.count));
  const soonerCloseAt = (await openCallsSummaryFor(dev)).nextCloseAt;
  const expected = new Date(soon(5) * 1000).toISOString().slice(0, 16); // minute precision
  check("nextCloseAt is the EARLIER of the two markets, not the later or an average",
    soonerCloseAt !== null && soonerCloseAt.slice(0, 16) === expected, `${soonerCloseAt} vs expected ~${expected}`);
}

console.log(failures === 0 ? "\nall return-trigger checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
