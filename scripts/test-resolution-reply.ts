// The resolution announcement: what oddie says in the thread when a market
// settles, and every state where it must stay quiet instead.
//
// Run with: npm run test-resolution-reply
if (process.env.DATABASE_URL) { console.error("refusing to run against a database"); process.exit(1); }

import { postResolution, resolutionText, type ResolutionDeps } from "../src/x/resolutionReply.js";
import { createCommunityMarket, openCommunityMarkets } from "../src/store/markets.js";
import { renderCard, VOICE_SETTLED, VOICE_ANY, VOICE_UNPRICED } from "../src/card/renderCard.js";
import type { Market } from "../src/venues/types.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.error(`  ✗ ${n}`); if (d) console.error(`      ${d}`); }
};
const deps = (over: Partial<ResolutionDeps> = {}): ResolutionDeps => ({
  dryRun: true,
  cardPng: async () => null,
  uploadMedia: async () => "media-1",
  postReply: async () => ({ id: "posted-1" }),
  log: () => {},
  ...over,
});

console.log("\nthe public sentence is about the MARKET, never about a person");
{
  const t = resolutionText("Will Bitcoin hit $200k?", "no", "https://oddie.fun/m/x");
  check("names the side", t.includes("NO"), t);
  check("carries the link", t.includes("https://oddie.fun/m/x"));
  // It sits under a stranger's tweet, and it can be read by somebody who never
  // staked. Anything second-person is a taunt aimed at whoever is reading.
  for (const bad of ["you lost", "you won", "wrong", "told you", "@"]) {
    check(`never says "${bad}"`, !t.toLowerCase().includes(bad), t);
  }
  check("does not repeat the question back at the thread", !t.includes("Bitcoin"), t);
}

console.log("\nit stays quiet in every state where there is nothing to answer");
{
  const r1 = await postResolution("no-such-market", "yes", deps());
  check("an unknown market posts nothing", !r1.posted && r1.reason === "no-market", JSON.stringify(r1));

  const m = await createCommunityMarket({ question: "Will it rain?", category: "Other", yesPct: 50, closeTime: Math.floor(Date.now() / 1000) + 86400 });
  const r2 = await postResolution(m.slug, "yes", deps());
  // A market made in the app was never tagged, so there is no thread of ours.
  check("a market with no thread posts nothing", !r2.posted && r2.reason === "no-thread", JSON.stringify(r2));
}

console.log("\nthe settled card is a different card, and never invites a stake");
{
  const live = (await openCommunityMarkets()) as unknown as Market[];
  const m = live[0];
  const settled = renderCard(m, { settled: "no" });
  check("the hero is the outcome", settled.includes(">NO<"), settled.match(/>NO</)?.[0] ?? "no NO");
  check("it says it settled on chain", settled.includes("settled on chain"));
  check("the voice comes from the settled pool", VOICE_SETTLED.some((v) => settled.includes(v)));
  check("...and never from the open ones",
    ![...VOICE_ANY, ...VOICE_UNPRICED].some((v) => settled.includes(v)));
  // A settled market has nothing to invite and no clock pressure left.
  check("no open-market invitation", !settled.includes("pick a side") && !settled.includes("your move"));
  check("settled beats unpriced when both are passed",
    renderCard(m, { unpriced: true, settled: "yes" }).includes(">YES<"));
}

console.log(failures === 0 ? "\nall resolution-reply checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
