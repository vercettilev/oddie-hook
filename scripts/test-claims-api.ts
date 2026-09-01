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

import {
  claimKeyLookup, claimKeyRecord, takeQuotaToken, releaseQuotaToken, callerScope,
  refusalForText, recordRefusalForText, claimTextHash, handleFromSourceUrl,
  sourceUrlKind, sourcePostKey, _resetApiLedgers,
} from "../src/store/markets.js";

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


console.log("\nATTRIBUTION CANNOT BE SPOOFED BY A URL THAT MERELY CONTAINS ONE");
{
  // This handle decides who receives the creator fee and who is written on
  // chain as the market's creator. The pattern match it replaces looked for
  // "//x.com/<handle>/status/" ANYWHERE in the string, so a caller who chose
  // the source URL chose whose name went on somebody else's market.
  check("a real status link still resolves", handleFromSourceUrl("https://x.com/realperson/status/123") === "realperson");
  check("host and case are normalised", handleFromSourceUrl("https://www.twitter.com/Someone/status/9") === "someone");
  check("a fragment cannot smuggle a handle", handleFromSourceUrl("https://evil.example.com/#https://x.com/victim/status/888") === null);
  check("nor a query string", handleFromSourceUrl("https://evil.example.com/?next=//x.com/victim/status/888") === null);
  check("nor a lookalike host", handleFromSourceUrl("https://x.com.evil.com/victim/status/1") === null);
  check("a non-http scheme is refused", handleFromSourceUrl("javascript:alert(1)//x.com/a/status/1") === null);
  check("a telegram link credits nobody", handleFromSourceUrl("https://t.me/c/1234/987") === null);
}

console.log("\nACCEPTING A SOURCE AND PAYING FOR IT ARE DIFFERENT QUESTIONS");
{
  // These were one function, and that is the bug that made the Telegram bot
  // unable to open a single market: openMarketFromClaim asked
  // handleFromSourceUrl whether to ACCEPT a source, and a t.me link has no
  // handle in it, so every claim the bot ever sent was refused -- AFTER a full
  // extraction had been billed for it.
  check("an x status link is accepted", sourceUrlKind("https://x.com/realperson/status/123") === "x");
  check("a public group link is accepted", sourceUrlKind("https://t.me/somegroup/4567") === "telegram");
  check("a private group link is accepted", sourceUrlKind("https://t.me/c/1234567890/89") === "telegram");
  check("...and still credits nobody", handleFromSourceUrl("https://t.me/somegroup/4567") === null);

  // The widened gate must not widen the attack surface the narrow one closed.
  check("a bare x profile is not a source", sourceUrlKind("https://x.com/realperson") === null);
  check("a t.me invite link is not a message", sourceUrlKind("https://t.me/joinchat/AAAA") === null);
  check("a t.me channel root is not a message", sourceUrlKind("https://t.me/somegroup") === null);
  check("a lookalike host is refused", sourceUrlKind("https://t.me.evil.com/g/1") === null);
  check("a fragment cannot smuggle a source", sourceUrlKind("https://evil.example.com/#https://t.me/g/1") === null);
  check("a non-http scheme is refused", sourceUrlKind("javascript:alert(1)//t.me/g/1") === null);
  check("null is not a source", sourceUrlKind(null) === null);
}

console.log("\nONE POST, ONE MARKET -- ON BOTH SURFACES");
{
  // The rule used to be a "/status/" regex over the raw URL. A t.me link has no
  // /status/, so it returned null and the whole rule was silently absent for
  // Telegram: every retry a fresh market.
  const a = sourcePostKey("https://x.com/someone/status/999");
  check("four spellings of one tweet share a key", a === sourcePostKey("https://vxtwitter.com/Other/status/999")
    && a === sourcePostKey("https://www.twitter.com/x/status/999")
    && a === sourcePostKey("https://fixupx.com/y/status/999"), String(a));
  check("a query string does not change the key", sourcePostKey("https://x.com/a/status/999?s=20") === a);

  const t = sourcePostKey("https://t.me/somegroup/4567");
  check("a telegram message has a key at all", t !== null, String(t));
  check("...distinct from the tweet's", t !== a);
  check("...stable across a trailing slash", sourcePostKey("https://t.me/somegroup/4567/") === t);
  check("...and case-insensitive, as telegram names are", sourcePostKey("https://t.me/SomeGroup/4567") === t);
  check("a different message is a different key", sourcePostKey("https://t.me/somegroup/4568") !== t);
  check("a different group is a different key", sourcePostKey("https://t.me/othergroup/4567") !== t);
  check("an unacceptable source has no key", sourcePostKey("https://evil.example.com/x") === null);
}

console.log("\nTHE LEDGER IS NAMESPACED, SO ONE CALLER CANNOT SQUAT ANOTHER'S KEYS");
{
  _resetApiLedgers();
  const A = callerScope("bot-key-A"), B = callerScope("bot-key-B");
  check("two callers hash to different namespaces", A !== B);

  // The attack: send the OTHER bot's key format first and their market is
  // yours forever.
  await claimKeyRecord(`${A}:tg:-100:5`, { slug: "a-market" });
  check("the other caller sees nothing", (await claimKeyLookup(`${B}:tg:-100:5`)) === null);
  check("...and gets their own answer", (await claimKeyRecord(`${B}:tg:-100:5`, { slug: "b-market" })).slug === "b-market");
  check("the first caller is untouched", (await claimKeyLookup(`${A}:tg:-100:5`))?.slug === "a-market");
}

console.log("\nA REFUSAL IS REMEMBERED BY THE CLAIM, NOT BY THE CALLER'S HEADER");
{
  _resetApiLedgers();
  const text = "  Arsenal   are THE most overrated club in Europe  ";
  check("nothing is known yet", (await refusalForText(text)) === null);
  await recordRefusalForText(text, "unresolvable", "pure opinion", 86_400);

  // The caller picks the idempotency key and can rotate it. It cannot change
  // what the claim says, which is why this is the cache that saves money:
  // measured, five keys over identical refused text cost five model calls.
  const back = await refusalForText("Arsenal are the most overrated club in Europe");
  check("spacing and case do not defeat it", back?.reason === "unresolvable", JSON.stringify(back));
  check("the detail survives for the caller's logs", back?.detail === "pure opinion");
  check("a different claim is not covered", (await refusalForText("Will Arsenal finish top four?")) === null);
  check("the hash is stable across whitespace", claimTextHash("a  b") === claimTextHash(" A B "));
}

console.log("\nA GLOBAL CEILING THE CALLER CANNOT DIAL AWAY BY INVENTING GROUPS");
{
  _resetApiLedgers();
  const KEY = "ceiling-key";
  const group = { capacity: 2, perHour: 1 };
  const all = { capacity: 3, perHour: 1 };

  // The measured attack: rotate chat_id and every request lands in a fresh
  // full bucket. Thirty fabricated groups bought thirty model calls.
  let through = 0;
  for (let i = 0; i < 10; i++) {
    const g = await takeQuotaToken(KEY, "all", all);
    if (!g.ok) break;
    const c = await takeQuotaToken(KEY, `chat:invented-${i}`, group);
    if (c.ok) through++;
  }
  check("invented groups are capped by the global bucket", through === 3, `${through} got through`);
}

console.log("\nA PATH THAT DID NO WORK GIVES THE TOKEN BACK");
{
  _resetApiLedgers();
  const KEY = "refund-key";
  const opts = { capacity: 2, perHour: 1 };
  check("spend one", (await takeQuotaToken(KEY, "chat:X", opts)).ok);
  check("spend two", (await takeQuotaToken(KEY, "chat:X", opts)).ok);
  check("empty", !(await takeQuotaToken(KEY, "chat:X", opts)).ok);
  // An inference outage locking a group out for half an hour is the outage
  // plus a penalty.
  await releaseQuotaToken(KEY, "chat:X", 2);
  check("a refund makes it spendable again", (await takeQuotaToken(KEY, "chat:X", opts)).ok);
  await releaseQuotaToken(KEY, "chat:X", 2);
  await releaseQuotaToken(KEY, "chat:X", 2);
  await releaseQuotaToken(KEY, "chat:X", 2);
  let n = 0;
  while ((await takeQuotaToken(KEY, "chat:X", opts)).ok) { n++; if (n > 5) break; }
  check("refunds cannot exceed capacity", n <= 2, `${n} tokens after over-refunding`);
}

console.log(failures === 0 ? "\nall claims-api checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
