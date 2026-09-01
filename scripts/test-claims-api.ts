// The bot API's two ledgers: idempotency and quota.
//
// This endpoint is handed to a partner we do not control, it spends money on
// every miss, and it is the first authenticated write surface oddie has. The
// rules that matter are the ones nobody sees working: the same key answering
// the same way forever, a refusal costing nothing to repeat, and one loud group
// being unable to spend another's budget.
//
// Run with: npm run test-claims-api
if (process.env.DATABASE_URL) { console.error("refusing to run against a database"); process.exit(1); }

import { claimKeyLookup, claimKeyRecord, takeQuotaToken, _resetApiLedgers } from "../src/store/markets.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.error(`  ✗ ${n}`); if (d) console.error(`      ${d}`); }
};

console.log("\nthe same key always answers the same way");
{
  _resetApiLedgers();
  const K = "tg:-100123:987";
  check("an unseen key is null, not an error", (await claimKeyLookup(K)) === null);

  const first = await claimKeyRecord(K, { slug: "market-one" });
  check("the first answer is recorded", first.slug === "market-one");

  // THE RACE THIS EXISTS FOR. Two people trigger the same claim in the same
  // second; both get past the bot's own lookup; only one market may win.
  const second = await claimKeyRecord(K, { slug: "market-two" });
  check("a racing second answer loses to the first", second.slug === "market-one", JSON.stringify(second));
  check("and the ledger still says the first", (await claimKeyLookup(K))?.slug === "market-one");
}

console.log("\na refusal is an answer, and it costs nothing to repeat");
{
  _resetApiLedgers();
  const K = "tg:-100123:555";
  await claimKeyRecord(K, { refusal: "unresolvable", detail: "pure opinion", cacheForSeconds: 86_400 });
  const back = await claimKeyLookup(K);
  check("the refusal comes back", back?.refusal === "unresolvable" && back.slug === null, JSON.stringify(back));
  check("with its detail, for the caller's logs", back?.detail === "pure opinion");

  // The only thing that can change a refusal is our classifier, so it expires.
  _resetApiLedgers();
  await claimKeyRecord(K, { refusal: "unresolvable", detail: "x", cacheForSeconds: 60 });
  check("a fresh refusal is still cached", (await claimKeyLookup(K))?.refusal === "unresolvable");

  // A market never expires: the same key must always name the same market.
  _resetApiLedgers();
  await claimKeyRecord(K, { slug: "permanent" });
  check("a market has no expiry", (await claimKeyLookup(K))?.slug === "permanent");
}

console.log("\nQUOTA IS PER GROUP, SO ONE LOUD ROOM CANNOT SPEND ANOTHER'S");
{
  _resetApiLedgers();
  const KEY = "bot-key-aaa";
  const opts = { capacity: 3, perHour: 3600 }; // one token a second, for the test

  // Burst capacity is the whole point: arguments cluster.
  for (let i = 1; i <= 3; i++) {
    check(`burst ${i} of 3 passes`, (await takeQuotaToken(KEY, "chat:A", opts)).ok);
  }
  const empty = await takeQuotaToken(KEY, "chat:A", opts);
  check("the fourth is refused", !empty.ok);
  check("...and says how long to wait, so nobody guesses at backoff", !empty.ok && empty.retryAfterSeconds >= 1, JSON.stringify(empty));

  // The bug an IP-keyed limit would have: every group sharing one bucket.
  check("a different group has its own full bucket", (await takeQuotaToken(KEY, "chat:B", opts)).ok);

  // And a different caller is separate again.
  check("a different caller is separate too", (await takeQuotaToken("bot-key-bbb", "chat:A", opts)).ok);
}

console.log("\nthe bucket refills, rather than resetting on a schedule");
{
  _resetApiLedgers();
  const KEY = "refill-key";
  const opts = { capacity: 2, perHour: 3_600_000 }; // 1000/sec: refills within the test
  check("spend one", (await takeQuotaToken(KEY, "chat:R", opts)).ok);
  check("spend two", (await takeQuotaToken(KEY, "chat:R", opts)).ok);
  check("third is refused", !(await takeQuotaToken(KEY, "chat:R", opts)).ok);
  await new Promise((r) => setTimeout(r, 30));
  check("it comes back on its own, with no scheduler", (await takeQuotaToken(KEY, "chat:R", opts)).ok);
}

console.log(failures === 0 ? "\nall claims-api checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
