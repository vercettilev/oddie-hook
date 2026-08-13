// The weekly Loudest Callers award: the ISO-week clock it dedups on, and the
// award itself — credited to the right person, once per (person, week), and a
// polite "no" (never a throw) for a handle nobody has connected.
//
// In-memory backend throughout: awardLoud resolves handles through the same
// deviceForHandle the public profile uses, so a mem-linked X account is enough.
//
// Run with: npm run test-loud

import { linkAccount } from "../src/store/accounts.js";
import { SEASON_POINTS, awardLoud, isoWeekOf, seasonPointsFor } from "../src/store/markets.js";

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

console.log(failures === 0 ? "\nall loud checks passed.\n" : `\n${failures} loud check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
