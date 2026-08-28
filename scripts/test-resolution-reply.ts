// The resolution announcement: what oddie says in the thread when a market
// settles, and every state where it must stay quiet instead.
//
// Run with: npm run test-resolution-reply
if (process.env.DATABASE_URL) { console.error("refusing to run against a database"); process.exit(1); }

import { postResolution, resolutionText, authorCreditText, type ResolutionDeps } from "../src/x/resolutionReply.js";
import { createCommunityMarket, openCommunityMarkets, _setMemReplyId, _resetMemReplyId } from "../src/store/markets.js";
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

console.log("\nTHE AUTHOR CREDIT: the one @-mention, and only when there is money");
{
  // The copy first, purely. It is a payout notice, not a pitch, which is the
  // whole reason the @-mention is defensible: there is real SOL behind the link.
  const t = authorCreditText("takeguy", "https://oddie.fun/m/x");
  check("names the author with exactly one @", t.startsWith("@takeguy,") && !t.includes("@@"), t);
  check("a handle that already had an @ is not doubled", authorCreditText("@takeguy", "u").startsWith("@takeguy,"));
  check("carries the collect link", t.includes("https://oddie.fun/m/x"));
  check("is about the earning, never about who won or lost", !/won|lost|wrong|beat/i.test(t), t);
}
{
  // Now the gate, end to end. A market with a thread, an author, and a fee owed
  // gets a SECOND reply that mentions the author.
  _resetMemReplyId();
  const m = await createCommunityMarket({ question: "Will it snow?", category: "Other", yesPct: 50, closeTime: Math.floor(Date.now() / 1000) + 86400 });
  _setMemReplyId(m.slug, "oddie-reply-1");
  const posts: Array<{ text: string; inReplyTo: string }> = [];
  const base = (over: Partial<ResolutionDeps> = {}): ResolutionDeps => ({
    dryRun: false, cardPng: async () => null, uploadMedia: async () => "media",
    postReply: async (o) => { posts.push({ text: o.text, inReplyTo: o.inReplyTo }); return { id: `id-${posts.length}` }; },
    log: () => {},
    authorHandle: async () => "takeguy",
    authorFeeLamports: async () => 4_000_000,
    ...over,
  });

  const r = await postResolution(m.slug, "yes", base());
  check("the result announcement posts", r.posted && posts.some((p) => p.text.startsWith("Settled: YES")), JSON.stringify(posts));
  check("the author gets a credit reply", Boolean(r.creditReplyId) && posts.some((p) => p.text.startsWith("@takeguy")), JSON.stringify(posts));
  check("the credit is a SEPARATE reply, under the announcement", posts.length === 2 && posts[1].inReplyTo === "id-1");

  // No fee owed (nobody backed the winner): no tag. This is what stops us
  // spraying a mention at every market that resolved on an empty side.
  posts.length = 0;
  const r2 = await postResolution(m.slug, "yes", base({ authorFeeLamports: async () => 0 }));
  check("no fee owed means no @-mention", !r2.creditReplyId && posts.length === 1, JSON.stringify(posts));

  // No author handle (a market made in the app, not from a tag): nobody to
  // credit, and still just the announcement.
  posts.length = 0;
  const r3 = await postResolution(m.slug, "no", base({ authorHandle: async () => null }));
  check("no known author means no @-mention", !r3.creditReplyId && posts.length === 1);

  // The credit is best-effort: if it throws, the resolution still counts as
  // posted, because the announcement already went out.
  posts.length = 0;
  const r4 = await postResolution(m.slug, "yes", base({
    postReply: async (o) => { posts.push({ text: o.text, inReplyTo: o.inReplyTo }); if (o.text.startsWith("@")) throw new Error("x down"); return { id: `id-${posts.length}` }; },
  }));
  check("a failed credit never unwinds a posted resolution", r4.posted && !r4.creditReplyId, JSON.stringify(r4));

  // Dry run credits nobody: it must be exactly as quiet as the announcement.
  posts.length = 0;
  const r5 = await postResolution(m.slug, "yes", base({ dryRun: true }));
  check("dry run posts nothing at all", !r5.posted && posts.length === 0 && r5.reason === "dry-run");
  _resetMemReplyId();
}


console.log(failures === 0 ? "\nall resolution-reply checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
