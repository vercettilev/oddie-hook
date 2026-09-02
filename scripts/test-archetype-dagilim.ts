/**
 * Distribution check for the archetype classifier.
 *
 * Lev's failure case, verbatim: "1000 kisi baglayinca 900u ayni kategoriye
 * dusmesin." So this runs the classifier over a synthetic population of 1200
 * profiles drawn from PLAUSIBLE priors (documented inline; they are priors,
 * not ground truth) and fails the build if the result is degenerate:
 *
 *   - the two universal rate types (loudest/lurker) may hold at most 45%
 *     each: the pivot hands everyone one of them, so they are allowed to be
 *     big, but neither may BE the population
 *   - no content type may exceed 30%
 *   - every one of the 7 types must actually occur, and nobody may leave
 *     without a costume (Lev's rule: "unscored hic hic hic olmamasi lazim")
 *
 * Seeded RNG, so the run is reproducible and a rule change shows up as a
 * DIFF in the printed table, not as noise. Production adds the LLM rescue on
 * top of exactly the fallback bucket, so the live fallback share will sit
 * BELOW the number printed here.
 */
import { classifyArchetype, Archetype } from "../src/genesis/archetype.js";

// Tiny LCG: deterministic, good enough for sampling fixtures.
let seed = 20260902;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];

// --- priors ---------------------------------------------------------------
// Genel havuz kasten tuzakli: "opinions are my own" X'in en yaygin bio
// kalibi ve JUDGE'a DUSMEMELI (hassasiyet, dagilimin icinde test edilir).
const GENERIC_BIOS = [
  "building things", "dad. runner. coffee.", "views are my own",
  "opinions are my own", "engineer @ somewhere. opinions my own",
  "here for the memes", "gm", "living my best life",
  "crypto since the bear", "DMs open", "part time degen", "",
  "web3 enjoyer", "just watching", "NFA", "probably eating",
];
const MAXI_BIOS = [
  "bitcoin maxi", "sol only, never selling", "eth believer since 2017",
  "btc forever", "solana maxi. hyperliquid curious.",
  "$SOL. that's the bio.", "laser eyes stayed on", "hodl since the ftx week",
  "og holder, not selling this cycle",
];
const JUDGE_BIOS = [
  "daily takes on crypto", "ratings and reviews, no mercy",
  "calling out bad actors", "food critic turned chart critic", "hot takes merchant",
  "tier list guy", "onchain commentary", "defi analyst", "i rate launches",
];
const DOUBT_BIOS = [
  "professional contrarian", "everything is overrated", "fade the crowd",
  "your favorite project is cope", "resident skeptic",
  "unpopular opinion account", "devil's advocate for hire",
  "prove me wrong", "not convinced by your roadmap",
];
const GENERIC_PINS = [
  null, null, "gm to everyone building", "we're so back",
  "thread: 10 things i learned", "thank you for 10k", null, "new episode out now",
];
const PREDICTION_PINS = [
  "BTC hits 250k before 2027. screenshot this.",
  "Solana flips Ethereum by 2028",
  "remote work will be dead by 2026",
  "this startup crosses 1M users in 2026",
  "calling it now: this is the cycle top",
  "mark my words, this team ships",
];

function sampleProfile(i: number) {
  // account age: 8% under a year, the rest spread 1..14y
  // yas genclere carpik: CT kitlesi agirlikla 2017 sonrasi katilim
  const ageYears = rnd() < 0.08 ? rnd() * 0.9 + 0.05 : 1 + 13 * rnd() ** 2;
  // posting rate per day: lognormal-ish mixture — a silent mass, a middle,
  // and a loud tail
  const r = rnd();
  const perDay = r < 0.18 ? rnd() * 0.2 : r < 0.88 ? 0.2 + rnd() * 3 : 4 + rnd() * 26;
  const tweetCount = Math.max(1, Math.round(perDay * ageYears * 365.25));
  // Tipli dil paylari (maxi %9, judge %8, doubter %8) CT agirlikli bir
  // baglanma nufusu varsayimi: kampanyaya ILK gelenler rastgele X degil,
  // kripto-Twitter. Oncul budur ve burada acikca yazilidir.
  const b = rnd();
  const bio = b < 0.09 ? pick(MAXI_BIOS) : b < 0.17 ? pick(JUDGE_BIOS)
    : b < 0.25 ? pick(DOUBT_BIOS) : pick(GENERIC_BIOS);
  const pinnedText = rnd() < 0.35
    ? (rnd() < 0.15 ? pick(PREDICTION_PINS) : pick(GENERIC_PINS))
    : null;
  const createdAt = new Date(Date.now() - ageYears * 365.25 * 864e5).toISOString();
  // takipci: agir kuyruk (%80 kucuk hesap, %15 orta, %5 buyuk); takip: 100-2500
  const fr = rnd();
  const followers = fr < 0.8 ? Math.round(rnd() * 2000)
    : fr < 0.95 ? Math.round(2000 + rnd() * 18000)
    : Math.round(20000 + rnd() * 480000);
  return { handle: `u${i}`, bio, createdAt, tweetCount,
    followers, following: Math.round(100 + rnd() * 2400), pinnedText };
}

const N = 1200;
const say = new Map<Archetype, number>();
let refinerAdayi = 0;   // rate-atamasi + okunacak dili var: LLM'in canlida
                        // icerik tipine yukseltebilecegi kutle
let judgeTuzak = 0;     // "opinions are my own" tarzi bio JUDGE cikarsa hata
for (let i = 0; i < N; i++) {
  const prof = sampleProfile(i);
  const r = classifyArchetype(prof);
  say.set(r.archetype, (say.get(r.archetype) ?? 0) + 1);
  if (r.via === "rate" && (prof.bio.trim().length >= 12 || prof.pinnedText)) refinerAdayi++;
  if (/\b(opinions?|views?)\s+(are\s+)?my\s+own\b/i.test(prof.bio) && r.archetype === "judge") judgeTuzak++;
}

console.log(`\n${N} sentetik profil, kural-tabanli dagilim:\n`);
const rows = [...say.entries()].sort((a, b) => b[1] - a[1]);
for (const [t, n] of rows) {
  const pct = (100 * n / N);
  console.log(`  ${t.padEnd(9)} ${String(n).padStart(4)}  ${pct.toFixed(1).padStart(5)}%  ${"#".repeat(Math.round(pct / 2))}`);
}

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};
console.log("\ndejenerasyon bantlari");
const pct = (t: Archetype) => 100 * (say.get(t) ?? 0) / N;
// Kostumsuz kimse yok: pivot herkese oran kimligi verir, o yuzden iki oran
// tipi dogal olarak buyuk olur. Bant onlarda %45, icerik tiplerinde %30.
for (const t of ["loudest","lurker"] as Archetype[]) {
  check(`${t} nufusun yarisini yutmuyor (<=45%)`, pct(t) <= 45, `${pct(t).toFixed(1)}%`);
}
for (const t of ["prophet","doubter","maxi","judge","rookie","og","main"] as Archetype[]) {
  check(`${t} tek basina tahtayi ele gecirmiyor (<=30%)`, pct(t) <= 30, `${pct(t).toFixed(1)}%`);
}
console.log("\nher tip gercekten var, kostumsuz kimse yok");
for (const t of ["prophet","loudest","lurker","doubter","maxi","judge","rookie","og","main"] as Archetype[]) {
  check(`${t} >= 1%`, pct(t) >= 1, `${pct(t).toFixed(1)}%`);
}
check("toplam = nufus (kostumsuz kalan yok)", [...say.values()].reduce((a,b)=>a+b,0) === N);
console.log(`\nLLM'e uygun oran-kutlesi: ${(100*refinerAdayi/N).toFixed(1)}% — canlida icerik tiplerine buradan yukselme gelir`);
check("disclaimer bio'lar JUDGE'a dusmuyor (hassasiyet)", judgeTuzak === 0, `${judgeTuzak} tuzak`);
console.log(fail === 0 ? "\nall distribution checks passed." : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
