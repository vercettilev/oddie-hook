// The weekly Loudest Callers award: the ISO-week clock it dedups on, and the
// award itself — credited to the right person, once per (person, week), and a
// polite "no" (never a throw) for a handle nobody has connected.
//
// In-memory backend throughout: awardLoud resolves handles through the same
// deviceForHandle the public profile uses, so a mem-linked X account is enough.
//
// Run with: npm run test-loud

import { linkAccount } from "../src/store/accounts.js";
import { loudMultiplierOf, oddieScoreFrom } from "../src/store/economy.js";
import {
  SEASON_POINTS, awardLoud, isoWeekOf, seasonPointsFor,
  parseTweetUrl, submitLoudPost, loudPostsFor, loudQueue, decideLoudPost, LOUD_DAILY_CAP,
  loudWinners, loudStatusFor, surfacedSlugs,
  createCommunityMarket, openCommunityMarkets, placeCall, recordSurfacer, _memGrant,
  callsMadeFor, DAILY_EARNING_MARKETS, positionsFor,
} from "../src/store/markets.js";
import { CALL_COST } from "../src/store/economy.js";
import type { Market } from "../src/venues/types.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

console.log("\nisoWeekOf: the dedup clock");
{
  // 2026 starts on a Thursday, which makes it a 53-week ISO year — both edges
  // of that are the cases a naive week formula gets wrong.
  check("a mid-year date", isoWeekOf(new Date("2026-08-13T12:00:00Z")) === "2026-W33", isoWeekOf(new Date("2026-08-13T12:00:00Z")));
  check("Jan 1 2026 (a Thursday) is W01", isoWeekOf(new Date("2026-01-01T00:00:00Z")) === "2026-W01");
  check("Dec 29 2025 already belongs to 2026-W01", isoWeekOf(new Date("2025-12-29T00:00:00Z")) === "2026-W01",
    isoWeekOf(new Date("2025-12-29T00:00:00Z")));
  check("Dec 31 2026 is W53 (53-week year)", isoWeekOf(new Date("2026-12-31T00:00:00Z")) === "2026-W53",
    isoWeekOf(new Date("2026-12-31T00:00:00Z")));
  check("Sunday closes the same week Thursday opened", isoWeekOf(new Date("2026-08-16T23:59:00Z")) === "2026-W33");
  check("Monday opens the next", isoWeekOf(new Date("2026-08-17T00:00:00Z")) === "2026-W34");
}

console.log("\nawardLoud: once per person per week, to the right person");
{
  const DEV = "device-loudloudloud1";
  await linkAccount(DEV, { provider: "twitter", uid: "9001", handle: "@Loudest" });

  check("a handle nobody connected is a no, not a throw",
    (await awardLoud("ghost_handle", "2026-W33")).ok === false);
  check("...with the reason named",
    (await awardLoud("ghost_handle", "2026-W33") as { reason?: string }).reason === "no_account");

  const first = await awardLoud("@Loudest", "2026-W33");
  check("the first award of the week lands", first.ok === true, JSON.stringify(first));
  check("...and pays SEASON_POINTS.loud", (await seasonPointsFor(DEV)) === SEASON_POINTS.loud,
    String(await seasonPointsFor(DEV)));

  const again = await awardLoud("@Loudest", "2026-W33");
  check("the same week pays nothing twice", again.ok === false && (again as { reason?: string }).reason === "already");
  const cased = await awardLoud("LOUDEST", "2026-W33");
  check("...however the handle is cased or @-prefixed", cased.ok === false);
  check("the balance did not move", (await seasonPointsFor(DEV)) === SEASON_POINTS.loud);

  check("a new week is a new award", (await awardLoud("loudest", "2026-W34")).ok === true);
  check("...and the balance shows both", (await seasonPointsFor(DEV)) === 2 * SEASON_POINTS.loud,
    String(await seasonPointsFor(DEV)));
}

console.log("\nloudWinners: real handles, newest week first, one row per person");
{
  // @Loudest won W33 and W34 above. The list must carry the person once —
  // with the newest week — and never invent an entry for an unnamed device.
  const w = await loudWinners();
  check("the winner appears", w.some((x) => x.handle === "Loudest"), JSON.stringify(w));
  check("...once, despite two weekly wins", w.filter((x) => x.handle.toLowerCase() === "loudest").length === 1);
  check("...with the newest week", w.find((x) => x.handle === "Loudest")?.week === "2026-W34");
}

console.log("\nparseTweetUrl: only a real status URL is a submission");
{
  const good = [
    "https://x.com/somebody/status/1234567890",
    "https://twitter.com/somebody/status/1234567890",
    "https://www.x.com/somebody/status/1234567890",
    "https://mobile.twitter.com/somebody/statuses/1234567890",
    "https://x.com/somebody/status/1234567890?s=20&t=abc",
  ];
  for (const u of good) check(`accepts ${u.slice(8, 40)}…`, parseTweetUrl(u)?.tweetId === "1234567890");
  check("...and reads the author handle", parseTweetUrl(good[0])?.handle === "somebody");
  const bad = [
    "https://x.com/somebody",                         // a profile, not a post
    "https://x.com/somebody/likes",                   // not a status
    "https://example.com/somebody/status/1234567890", // wrong site
    "x.com/somebody/status/1234567890",               // no scheme
    "https://x.com/way-too-long-for-a-handle-x/status/1234567890",
    "not a url at all",
  ];
  for (const u of bad) check(`refuses ${u.slice(0, 40)}`, parseTweetUrl(u) === null);
}

console.log("\nsubmitLoudPost: your own post, once, capped");
{
  const DEV = "device-loudpost00001";
  const tweet = (n: number) => `https://x.com/Poster/status/90000000${n}`;

  check("no linked X account is refused, with the reason named",
    JSON.stringify(await submitLoudPost(DEV, tweet(1))) === '{"ok":false,"reason":"no_x_account"}');

  await linkAccount(DEV, { provider: "twitter", uid: "9002", handle: "@Poster" });

  check("garbage is bad_url, not a throw",
    (await submitLoudPost(DEV, "hello") as { reason?: string }).reason === "bad_url");
  check("someone else's post is refused",
    (await submitLoudPost(DEV, "https://x.com/NotMe/status/900000001") as { reason?: string }).reason === "not_your_account");

  const first = await submitLoudPost(DEV, tweet(1));
  check("their own post lands as pending", first.ok === true && first.status === "pending", JSON.stringify(first));
  check("the handle check is case-insensitive",
    (await submitLoudPost(DEV, "https://x.com/pOSTER/status/900000002")).ok === true);
  check("the same tweet cannot be submitted twice",
    (await submitLoudPost(DEV, tweet(1)) as { reason?: string }).reason === "already_submitted");

  for (let n = 3; n <= LOUD_DAILY_CAP; n++) await submitLoudPost(DEV, tweet(n));
  check(`submission ${LOUD_DAILY_CAP + 1} in 24h hits the cap`,
    (await submitLoudPost(DEV, tweet(LOUD_DAILY_CAP + 1)) as { reason?: string }).reason === "daily_cap");

  const mine = await loudPostsFor(DEV);
  check("their own list shows every submission, newest first",
    mine.length === LOUD_DAILY_CAP && mine[0].url.endsWith(`90000000${LOUD_DAILY_CAP}`), JSON.stringify(mine.map((p) => p.url)));
  check("...all pending", mine.every((p) => p.status === "pending"));

  const queue = await loudQueue();
  check("the operator queue carries them with the author handle",
    queue.length >= LOUD_DAILY_CAP && queue.some((q) => q.handle === "Poster"), JSON.stringify(queue[0] ?? null));

  console.log("\ndecideLoudPost: once, and only approve pays");
  const before = await seasonPointsFor(DEV);
  const target = queue.find((q) => q.handle === "Poster")!;
  const ok = await decideLoudPost(target.id, true);
  check("approve settles the row", ok.ok === true && (ok as { status?: string }).status === "approved");
  check("...and pays SEASON_POINTS.loud_post",
    (await seasonPointsFor(DEV)) === before + SEASON_POINTS.loud_post, String(await seasonPointsFor(DEV)));
  check("a decided row never flips",
    (await decideLoudPost(target.id, false) as { reason?: string }).reason === "already_decided");
  check("...and the points did not move", (await seasonPointsFor(DEV)) === before + SEASON_POINTS.loud_post);
  check("an unknown id is not_found",
    (await decideLoudPost(999_999, true) as { reason?: string }).reason === "not_found");

  const second = (await loudQueue()).find((q) => q.handle === "Poster")!;
  const rej = await decideLoudPost(second.id, false, "off-topic");
  check("reject settles without paying",
    rej.ok === true && (await seasonPointsFor(DEV)) === before + SEASON_POINTS.loud_post);
  check("...and the note lands on the row",
    (await loudPostsFor(DEV)).some((p) => p.status === "rejected" && p.note === "off-topic"));
  check("the queue shrinks as rows are decided",
    (await loudQueue()).filter((q) => q.handle === "Poster").length === LOUD_DAILY_CAP - 2);
}

console.log("\nthe loud multiplier: posting upgrades the printer, never itself");
{
  check("no posts is 1×", loudMultiplierOf(0, false) === 1);
  check("one cleared post is 1.25×", loudMultiplierOf(1, false) === 1.25);
  check("three is 1.5×", loudMultiplierOf(3, false) === 1.5);
  check("a weekly Loudest win tops the ladder at 2×", loudMultiplierOf(0, true) === 2);

  // The formula: play is multiplied, the flat ledger never is — a post cannot
  // raise the price of the next post.
  const base = { callsMade: 10, resolvedCalls: 0, marketsCreated: 0, meanEdge: 0 as number | null };
  check("2× doubles play earnings (50 → 100)",
    oddieScoreFrom({ ...base, contributionPoints: 0, loudMultiplier: 2 }) === 100);
  check("...but a ledger event still pays exactly its face value on top",
    oddieScoreFrom({ ...base, contributionPoints: 75, loudMultiplier: 2 }) === 100 + 150);
  check("an absent multiplier is 1×",
    oddieScoreFrom({ ...base, contributionPoints: 0 }) === 50);
  check("a rogue multiplier clamps to the cap",
    oddieScoreFrom({ ...base, contributionPoints: 0, loudMultiplier: 99 }) ===
    oddieScoreFrom({ ...base, contributionPoints: 0, loudMultiplier: 2 }));

  // Wired through the store: the approved post from the decide section above
  // puts its device on 1.25×; @Loudest's weekly wins put theirs on 2×.
  const poster = await loudStatusFor("device-loudpost00001");
  check("one approval in 30d reads 1.25× from the store",
    poster.clearedIn30d === 1 && poster.multiplier === 1.25, JSON.stringify(poster));
  const winner = await loudStatusFor("device-loudloudloud1");
  check("a weekly win in 30d reads 2×",
    winner.weeklyWinIn30d === true && winner.multiplier === 2, JSON.stringify(winner));
}

console.log("\nthe crowd ladder: geometric rungs, once per market, to the surfacer");
{
  const SURFACER = "device-laddersurface1";
  const { slug } = await createCommunityMarket({
    question: "Will the ladder market fill up?",
    closeTime: Math.floor(Date.now() / 1000) + 86_400,
  });
  await recordSurfacer(slug, { deviceId: SURFACER });
  const live = (await openCommunityMarkets()) as unknown as Market[];
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const caller = (n: number) => `device-laddercall-${String(n).padStart(3, "0")}`;
  const call = async (n: number) => {
    _memGrant(caller(n), 10);
    const r = await placeCall(slug, n % 2 ? "yes" : "no", 5, caller(n), live);
    if (!r.ok) throw new Error(JSON.stringify(r));
    await flush();
  };

  const before = await seasonPointsFor(SURFACER);
  for (let n = 1; n <= 10; n++) await call(n);
  // 10 fresh players: the 3-player rung (100) + the 10-player rung (250) +
  // ten first-timer awards (10 × 100), all credited to the surfacer.
  const atTen = await seasonPointsFor(SURFACER);
  check("10 players pays three_players + ten_players + the first-timers",
    atTen - before === 100 + 250 + 10 * 100, `delta ${atTen - before}`);

  _memGrant(caller(1), 10);
  await placeCall(slug, "yes", 5, caller(1), live); await flush();
  check("a repeat caller moves nothing — rungs are distinct-player rungs",
    (await seasonPointsFor(SURFACER)) === atTen);

  for (let n = 11; n <= 25; n++) await call(n);
  const atTwentyFive = await seasonPointsFor(SURFACER);
  check("25 players adds the 750 rung (+ the new first-timers)",
    atTwentyFive - atTen === 750 + 15 * 100, `delta ${atTwentyFive - atTen}`);
}

console.log("\nsurfacedSlugs: the membership the tagged feed partitions on");
{
  // The distinction this exists for: an ANONYMOUS tag (a real surfacer row with
  // no handle and no source URL) is still tagged. surfacersFor cannot say so —
  // it returns the same all-null shape for "no row" — which is why the feed
  // asks this instead.
  await recordSurfacer("venue-tagged-anon", { deviceId: "device-anontagger01" });
  await recordSurfacer("venue-tagged-named", { handle: "@someone" });

  const hit = await surfacedSlugs(["venue-tagged-anon", "venue-tagged-named", "venue-untouched"]);
  check("a named tag is a member", hit.has("venue-tagged-named"));
  check("an ANONYMOUS tag is a member too — the whole point of this function",
    hit.has("venue-tagged-anon"));
  check("an untagged slug is not", !hit.has("venue-untouched"));
  check("...and nothing else sneaks in", hit.size === 2, [...hit].join(", "));
  check("an empty ask is an empty answer, with no query",
    (await surfacedSlugs([])).size === 0);
}

console.log("\nthe daily earning cap: bounds the reward, never the playing");
{
  const DEV = "device-dailycap000001";
  const live = (await openCommunityMarkets()) as unknown as Market[];
  const flush = () => new Promise((r) => setTimeout(r, 0));
  // More distinct markets in one day than the cap allows.
  const slugs: string[] = [];
  for (let i = 0; i < DAILY_EARNING_MARKETS + 6; i++) {
    const { slug } = await createCommunityMarket({
      question: `Cap market ${i}?`, closeTime: Math.floor(Date.now() / 1000) + 86_400,
    });
    slugs.push(slug);
  }
  const fresh = (await openCommunityMarkets()) as unknown as Market[];
  for (const slug of slugs) {
    _memGrant(DEV, 10);
    const r = await placeCall(slug, "yes", 0, DEV, fresh);
    check(`call on ${slug.slice(0, 12)} is accepted`, r.ok === true, JSON.stringify(r));
    if (!r.ok) break;
    await flush();
  }
  check("every call was accepted — the cap never blocks playing",
    (await positionsFor(DEV, fresh)).open.length === slugs.length,
    String((await positionsFor(DEV, fresh)).open.length));
  check(`...but only ${DAILY_EARNING_MARKETS} of them earn`,
    (await callsMadeFor(DEV)) === DAILY_EARNING_MARKETS, String(await callsMadeFor(DEV)));

  // The same market twice is not twice the volume.
  const before = await callsMadeFor(DEV);
  _memGrant(DEV, 10);
  await placeCall(slugs[0], "no", 0, DEV, fresh); await flush();
  check("a repeat call on a market already counted adds nothing",
    (await callsMadeFor(DEV)) === before, String(await callsMadeFor(DEV)));

  check("a device that never called earns nothing", (await callsMadeFor("device-nevercalled01")) === 0);
  check("...and calling is free, so an empty balance is not a wall", CALL_COST === 0);
}

console.log(failures === 0 ? "\nall loud checks passed.\n" : `\n${failures} loud check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
