// People follow people: the edges, what a follower may see, who hears about
// what and how often, and the wiring no memory test can reach (read, not
// guessed).
if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database: unset DATABASE_URL");
  process.exit(1);
}
import { existsSync, readFileSync } from "node:fs";
import {
  saveProfile, _resetProfiles, setFollow, isFollowing, followCounts, followersOf, followeesOf,
  recordSocialEvent, eventsBy, peopleToFollow, openerProfile, _resetSocial, type SocialEvent,
  ensureProfile, profileFor,
} from "../src/store/markets.js";
import { notifyFollowers, followText, FOLLOW_PING_GAP_MS, type FollowNotifyDeps } from "../src/social/follow.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

console.log("who follows whom");
{
  _resetSocial(); _resetProfiles();
  await setFollow("ann", "bob", true);
  await setFollow("cat", "bob", true);
  await setFollow("bob", "ann", true);
  await setFollow("ann", "ann", true);
  check("a follow is kept", await isFollowing("ann", "bob"));
  check("...one way only", !(await isFollowing("bob", "cat")));
  check("nobody follows themselves", !(await isFollowing("ann", "ann")));
  const c = await followCounts("bob");
  check("counts both directions", c.followers === 2 && c.following === 1, JSON.stringify(c));
  check("the followers of a person", (await followersOf("bob")).sort().join() === "ann,cat");
  check("the people a person follows", (await followeesOf("ann")).join() === "bob");
  await setFollow("cat", "bob", false);
  check("an unfollow is kept too", !(await isFollowing("cat", "bob")) && (await followCounts("bob")).followers === 1);
}

console.log("\na name from the moment they sign in");
{
  _resetSocial(); _resetProfiles();
  check("their X handle, first", (await ensureProfile("p1", ["@LevX", "levtg"])).username === "levx");
  check("...kept, and never overwritten by a later look", (await ensureProfile("p1", ["other"])).username === "levx"
    && (await profileFor("p1"))?.username === "levx");
  check("their Telegram one when the X handle is somebody else's", (await ensureProfile("p2", ["levx", "levtg"])).username === "levtg");
  check("no name when neither fits, until they pick one", (await ensureProfile("p3", ["a_telegram_name_far_too_long"])).username === null);
  check("...and a picture either way", Boolean((await profileFor("p3"))?.avatar));
}

console.log("\nwhat a follower may see");
{
  _resetSocial(); _resetProfiles();
  await saveProfile("ann", { username: "ann" });
  await saveProfile("bob", { username: "bob", showName: true });
  const open: SocialEvent = { actor: "ann", kind: "open", slug: "m1", side: null, lamports: null, dedup: "open:m1" };
  check("an event is recorded once", (await recordSocialEvent(open)) && !(await recordSocialEvent(open)));
  await recordSocialEvent({ actor: "ann", kind: "bet", slug: "m1", side: "yes", lamports: 5e8, dedup: "bet:m1:W1:yes" });
  await recordSocialEvent({ actor: "bob", kind: "bet", slug: "m1", side: "no", lamports: 2e8, dedup: "bet:m1:W2:no" });
  await recordSocialEvent({ actor: "zed", kind: "open", slug: "m2", side: null, lamports: null, dedup: "open:m2" });
  const annSees = await eventsBy(["ann"]);
  check("a market opened is always public", annSees.some((e) => e.kind === "open" && e.username === "ann"));
  check("a side taken with the name switch off is not", !annSees.some((e) => e.kind === "bet"));
  const bobSees = await eventsBy(["bob"]);
  check("a side taken with it on is", bobSees.length === 1 && bobSees[0].side === "no" && bobSees[0].lamports === 2e8);
  const all = await eventsBy("all");
  check("everyone: every public event, newest first", all.map((e) => e.username + ":" + e.kind).join() === "bob:bet,ann:open", all.map((e) => e.username).join());
  check("somebody with no oddie name is never shown", !all.some((e) => e.slug === "m2"));
  check("nobody followed, nothing to show", (await eventsBy([])).length === 0);
  const later = await eventsBy("all", 40, new Date(Date.now() + 60_000).toISOString());
  check("only what is newer than asked for", later.length === 0);
  check("the opener of a market, by their oddie name", (await openerProfile("m1"))?.username === "ann");
  check("...and no name when they have none", (await openerProfile("m2")) === null);
  await saveProfile("bob", { showName: false });
  check("turning the switch off hides the past too", (await eventsBy(["bob"])).length === 0);
}

console.log("\npeople to follow");
{
  _resetSocial(); _resetProfiles();
  await saveProfile("ann", { username: "ann" });
  await saveProfile("bob", { username: "bob" });
  await saveProfile("cat", { username: "cat", showName: true });
  await saveProfile("dan", { username: "dan" });
  await recordSocialEvent({ actor: "ann", kind: "open", slug: "a1", side: null, lamports: null, dedup: "open:a1" });
  await recordSocialEvent({ actor: "ann", kind: "open", slug: "a2", side: null, lamports: null, dedup: "open:a2" });
  await recordSocialEvent({ actor: "bob", kind: "bet", slug: "a1", side: "yes", lamports: 1e8, dedup: "bet:a1:B:yes" });
  await recordSocialEvent({ actor: "cat", kind: "bet", slug: "a1", side: "no", lamports: 1e8, dedup: "bet:a1:C:no" });
  const forDan = await peopleToFollow("dan");
  check("the busiest public people first", forDan.map((p) => p.username).join() === "ann,cat", forDan.map((p) => p.username).join());
  check("somebody whose only calls are private is not listed", !forDan.some((p) => p.username === "bob"));
  check("somebody who only signed in is not listed", !forDan.some((p) => p.username === "dan"));
  check("never yourself", !(await peopleToFollow("ann")).some((p) => p.username === "ann"));
  await setFollow("dan", "ann", true);
  check("never somebody you already follow", !(await peopleToFollow("dan")).some((p) => p.username === "ann"));
}

console.log("\nwho hears about it, and how often");
{
  const T0 = 1_800_000_000_000;
  const mk = (over: Partial<FollowNotifyDeps> = {}) => {
    const dms: Array<{ to: number; text: string }> = []; const pushes: Array<{ to: string; body: string; tag: string }> = [];
    const pace = new Map<string, number>();
    let now = T0;
    const deps: FollowNotifyDeps = {
      now: () => now,
      followersOf: async () => ["f1", "f2", "ann"],
      actor: async () => ({ username: "ann", tgHandle: "anntg" }),
      market: async () => ({ headline: "BTC to $100k?", url: "https://app.oddie.fun/m/x" }),
      tgUserFor: async (c) => (c === "f1" ? 111 : null),
      pushTo: async (c, p) => { pushes.push({ to: c, body: p.body, tag: p.tag }); },
      pacing: { get: async (k) => pace.get(k) ?? null, set: async (k, at) => { pace.set(k, at); } },
      dm: async (to, text) => { dms.push({ to, text }); },
      log: () => {},
      ...over,
    };
    return { deps, dms, pushes, tick: (ms: number) => { now += ms; } };
  };
  const open: SocialEvent = { actor: "ann", kind: "open", slug: "x", side: null, lamports: null, dedup: "open:x" };
  const bet: SocialEvent = { actor: "ann", kind: "bet", slug: "x", side: "yes", lamports: 5e8, dedup: "bet:x:W:yes" };

  const a = mk();
  await notifyFollowers(open, a.deps);
  check("a follower on Telegram gets a message", a.dms.length === 1 && a.dms[0].to === 111);
  check("...naming them by their Telegram @handle", a.dms[0]?.text === "@anntg just opened a market: “BTC to $100k?”\n\nhttps://app.oddie.fun/m/x");
  check("every follower gets the browser push, named by their oddie name",
    a.pushes.length === 2 && a.pushes.every((p) => p.body.startsWith("@ann just opened a market")));
  check("the person who did it is never told about themselves", !a.pushes.some((p) => p.to === "ann"));

  const b = mk({ actor: async () => ({ username: "ann", tgHandle: null }) });
  await notifyFollowers(bet, b.deps);
  check("in Telegram an oddie name goes WITHOUT an @, which would mention a stranger",
    b.dms[0]?.text.startsWith("ann just took YES on “BTC to $100k?” with 0.5 SOL."));

  const c = mk();
  await notifyFollowers(bet, c.deps);
  await notifyFollowers({ ...bet, side: "no", dedup: "bet:x:W:no" }, c.deps);
  check("a second side inside half an hour stays quiet", c.dms.length === 1 && c.pushes.length === 2);
  c.tick(FOLLOW_PING_GAP_MS + 1);
  await notifyFollowers({ ...bet, slug: "y", dedup: "bet:y:W:yes" }, c.deps);
  check("...and is heard again after it", c.dms.length === 2 && c.pushes.length === 4);
  await notifyFollowers({ ...open, slug: "z", dedup: "open:z" }, c.deps);
  check("a market opened is never held back", c.dms.length === 3);

  const d = mk({ actor: async () => null });
  await notifyFollowers(bet, d.deps);
  check("a hidden person is heard by nobody", d.dms.length === 0 && d.pushes.length === 0);

  const e = mk({ dryRun: true });
  await notifyFollowers(open, e.deps);
  check("a dry run sends nothing", e.dms.length === 0 && e.pushes.length === 0);

  check("the words for a side taken", followText(bet, "@ann", "Q", "U") === "@ann just took YES on “Q” with 0.5 SOL.\n\nU");
}

console.log("\nthe lines no memory test reaches");
{
  const server = readFileSync("src/server.ts", "utf8");
  const pp = server.slice(server.indexOf("async function publicPerson"), server.indexOf("/** A person's public page, by their oddie name. */"));
  check("a person is public once they did something public, and always to themselves",
    /if \(me !== who\.canonical && !who\.showName && !events\.length\) return null;/.test(pp));
  const fol = server.slice(server.indexOf('app.post("/api/follow"'), server.indexOf('app.get("/api/following"'));
  check("the follow button asks the same question, so it cannot be used to probe", /publicPerson\(/.test(fol) && !/personByUsername\(/.test(fol));
  check("...and needs a signed-in browser", /if \(!me\) return res\.status\(401\)/.test(fol));
  const page = server.slice(server.indexOf('app.get("/u/:username"'), server.indexOf('app.get("/following"'));
  check("the page's unfurl names only a public person", /publicPerson\(req\.params\.username, null\)/.test(page));
  check("a stake is an event for its owner's followers, after the ledger has it",
    /await onBetLanded\([\s\S]{0,400}await socialBet\(slug, stake\.user, stake\.side, stake\.lamports\)/.test(server));
  check("a market opened is an event for its opener's followers",
    /await recordSurfacer\(slug, \{ sourceUrl, handle: payeeHandle \}\);[\s\S]{0,300}socialOpen\(slug, identifiablePayee, creatorWallet\)/.test(server));
  check("the live paths and the backfill write the same keys",
    /dedup: `bet:\$\{slug\}:\$\{wallet\}:\$\{side\}`/.test(server) && /dedup: `open:\$\{slug\}`/.test(server));
  const store = readFileSync("src/store/markets.ts", "utf8");
  const bf = store.slice(store.indexOf("export async function backfillSocialEvents"), store.indexOf("/** The handles on a person's account"));
  check("...there too", /'open:' \|\| s\.slug/.test(bf) && /'open:' \|\| m\.slug/.test(bf)
    && /'bet:' \|\| ce\.slug \|\| ':' \|\| ce\.wallet \|\| ':' \|\| ce\.side/.test(bf));
  check("the backfill never tells anybody", !/notify|push|sendMessage/i.test(bf.replace(/Nobody is told/g, "")));
  check("history is written in at boot, after the names it is shown under",
    /void ensureProfilesForAll\(\)[\s\S]{0,300}\.then\(\(\) => backfillSocialEvents\(\)\)/.test(server));
  check("an X sign-in names the person", /evt: "auth_link"[\s\S]{0,300}await ensureProfile\(result\.canonicalDevice\)/.test(server));
  check("...and so does a Telegram one", /provider: "telegram", uid: String\(user\.id\)[\s\S]{0,200}await ensureProfile\(linked\.canonicalDevice\)/.test(server));
  check("the market names its opener as somebody to follow", /opener: await openerProfile\(slug\)/.test(server));
  const ptf = store.slice(store.indexOf("export async function peopleToFollow"), store.indexOf("export async function backfillSocialEvents"));
  check("suggestions list only public people", /\(e\.kind = 'open' OR p\.show_name\)/.test(ptf) && /JOIN social_event e/.test(ptf) && !/LEFT JOIN social_event/.test(ptf));
  const evs = store.slice(store.indexOf("export async function eventsBy"), store.indexOf("export async function openerProfile"));
  check("a stored side is read only through its owner's switch", /\(e\.kind = 'open' OR p\.show_name\)/.test(evs));
  check("the two pages exist", existsSync("public/app/person.html") && existsSync("public/app/following.html"));
  check("they live on the app host", /\(m\|market\|w\|u\)/.test(server) && /\|following\)/.test(server));
  for (const f of ["markets", "market", "you", "leaderboard", "who", "person", "following"]) {
    check(`Following is in the nav on ${f}`, readFileSync(`public/app/${f}.html`, "utf8").includes('<a href="/following"'));
  }
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall social checks passed.\n");
process.exit(failures ? 1 : 0);
