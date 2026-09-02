/**
 * The archetype classifier's contract, checked the way the campaign needs it:
 * every type reachable, deterministic, reasons printable, numbers never
 * invented, and the LLM rescue unable to smuggle in a bad answer.
 */
import { classifyArchetype, refineArchetype, ARCHETYPE_ART, ARCHETYPE_LABEL, ProfileSignals } from "../src/genesis/archetype.js";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

const base: ProfileSignals = {
  handle: "test", bio: "", createdAt: "2019-03-01T00:00:00Z",
  tweetCount: 4000, followers: 500, following: 400, pinnedText: null,
};

console.log("\neach archetype fires on its own signal");
const cases: Array<[string, Partial<ProfileSignals>, string]> = [
  ["prophet", { pinnedText: "Solana flips Ethereum before 2027. Screenshot this." }, "prophet"],
  ["maxi", { bio: "bitcoin maxi. never selling." }, "maxi"],
  ["judge", { bio: "daily takes and ratings on everything crypto" }, "judge"],
  ["doubter", { bio: "professional contrarian, everything is overrated" }, "doubter"],
  ["loudest", { tweetCount: 20000 }, "loudest"],
  ["lurker", { tweetCount: 150 }, "lurker"],
  ["rookie", { createdAt: new Date(Date.now() - 90 * 864e5).toISOString(), tweetCount: 40 }, "rookie"],
  ["orta-sessiz -> lurker (pivot)", { tweetCount: 3000 }, "lurker"],
  ["orta-konuskan -> loudest (pivot)", { tweetCount: 6000 }, "loudest"],
  ["og (10+ yil)", { createdAt: "2012-05-01T00:00:00Z" }, "og"],
  ["main character (10x oran)", { followers: 50000, following: 300 }, "main"],
];
for (const [name, patch, want] of cases) {
  const r = classifyArchetype({ ...base, ...patch });
  check(`${name} -> ${want}`, r.archetype === want, `got ${r.archetype}`);
}

console.log("\nthe assignment is justified and honest");
{
  const r = classifyArchetype({ ...base, tweetCount: 20000 });
  check("reason is printable", r.reason.length >= 8 && r.reason.length <= 90);
  check("headline carries a REAL derived number", r.headline.includes(String(Math.round(r.derived.postsPerDay))));
  const again = classifyArchetype({ ...base, tweetCount: 20000 });
  check("same input, same type (deterministic)", JSON.stringify(r) === JSON.stringify(again));
  const lurk = classifyArchetype({ ...base, tweetCount: 150 });
  check("lurker headline uses the real post count", lurk.headline.includes("150"));
}

console.log("\ncontent beats rate: a loud prophet is still a prophet");
{
  const r = classifyArchetype({ ...base, tweetCount: 30000, pinnedText: "BTC hits 500k by 2027" });
  check("pinned dated prediction outranks post rate", r.archetype === "prophet", `got ${r.archetype}`);
  const unlu = classifyArchetype({ ...base, bio: "bitcoin maxi", followers: 90000, following: 200 });
  check("chosen words outrank fame: maxi bio beats 450x ratio", unlu.archetype === "maxi", `got ${unlu.archetype}`);
  const unluVeYasli = classifyArchetype({ ...base, createdAt: "2011-01-01T00:00:00Z", followers: 90000, following: 200 });
  check("fame outranks vintage: main beats og", unluVeYasli.archetype === "main", `got ${unluVeYasli.archetype}`);
  const kucukHesap = classifyArchetype({ ...base, followers: 40, following: 3 });
  check("40 followers is not a main character (floor)", kucukHesap.archetype !== "main", `got ${kucukHesap.archetype}`);
}

console.log("\nnobody leaves without a costume, and no costume is a horoscope");
{
  const r = classifyArchetype({ ...base, bio: "I like coffee and long walks", pinnedText: "gm" });
  check("generic profile still gets a REAL identity", r.archetype === "lurker" || r.archetype === "loudest", `got ${r.archetype}`);
  check("...decided by the rate pivot, so the refiner may improve it", r.via === "rate");
  const bday = classifyArchetype({ ...base, pinnedText: "my birthday party will be great, see you all" });
  check("'will' without a year is not a prophecy", bday.archetype !== "prophet", `got ${bday.archetype}`);
  // kostumsuzluk yapisal olarak imkansiz: her yol yedi tipten birine cikar
  const uc = [
    classifyArchetype({ ...base, bio: "", pinnedText: null, tweetCount: 1 }),
    classifyArchetype({ ...base, bio: "", pinnedText: null, tweetCount: 999999 }),
    classifyArchetype({ ...base, bio: "", pinnedText: null, createdAt: new Date().toISOString(), tweetCount: 0 }),
  ];
  check("empty-everything profiles all resolve to a type", uc.every(x => x.archetype));
}

console.log("\nthe LLM rescue cannot smuggle a bad answer");
await (async () => {
  const rateBase = { ...base, bio: "a bio long enough to be worth reading" };
  const un = classifyArchetype(rateBase);
  const good = await refineArchetype(un, rateBase, async () => ({ archetype: "doubter", reason: "The bio disputes every take it quotes." }));
  check("valid closed-set answer is accepted", good.archetype === "doubter");
  check("...and keeps the type's standard headline", good.headline.includes("BS"));
  const rogue = await refineArchetype(un, rateBase, async () => ({ archetype: "genius", reason: "totally a genius" }));
  check("out-of-set type is rejected", rogue.archetype === un.archetype);
  const silent = await refineArchetype(un, rateBase, async () => { throw new Error("model down"); });
  check("a throwing judge keeps the deterministic type", silent.archetype === un.archetype);
  const shorty = await refineArchetype(un, rateBase, async () => ({ archetype: "maxi", reason: "ok" }));
  check("an empty justification is rejected", shorty.archetype === un.archetype);
  const strong = classifyArchetype({ ...base, bio: "bitcoin maxi" });
  const untouched = await refineArchetype(strong, base, async () => ({ archetype: "doubter", reason: "should never be consulted here" }));
  check("content-assigned types are never second-guessed", untouched.archetype === "maxi");
  const bos = classifyArchetype({ ...base, bio: "", pinnedText: null });
  const boslukta = await refineArchetype(bos, { ...base, bio: "", pinnedText: null }, async () => ({ archetype: "doubter", reason: "nothing to read, should not be called" }));
  check("no language, no consultation: rate type stands", boslukta.archetype === bos.archetype && boslukta.reason === bos.reason);
})();

console.log("\nevery type has art and a label");
for (const t of Object.keys(ARCHETYPE_ART) as Array<keyof typeof ARCHETYPE_ART>) {
  check(`${t}: label + asset`, ARCHETYPE_LABEL[t].startsWith("THE ") && ARCHETYPE_ART[t].startsWith("/brand/"));
}

console.log(fail === 0 ? "\nall archetype checks passed." : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
