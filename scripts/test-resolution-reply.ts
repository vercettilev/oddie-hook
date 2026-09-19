// The resolution announcement: what oddie says in the thread when a market
// settles, and every state where it must stay quiet instead.
//
// Run with: npm run test-resolution-reply
if (process.env.DATABASE_URL) { console.error("refusing to run against a database"); process.exit(1); }

import { postResolution, resolutionText, authorCreditText, type ResolutionDeps } from "../src/x/resolutionReply.js";
import { buildResolutionQuote } from "../src/matching/tweetReply.js";
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

console.log("\nand it says the true thing about the money, in all three states");
{
  // THE STATE THAT SHIPPED WRONG. buildResolutionQuote already got this right
  // and resolutionText did not, so the suite was green while the reply under a
  // real tweet said everyone who called it had been paid, on a market where
  // every lamport was on the losing side and the winning side held nothing.
  const none = resolutionText("Q?", "no", "https://oddie.fun/m/x", 0);
  check("no winners: refunds in full and charges nothing",
    none.includes("goes back in full") && none.includes("no fee"), none);
  check("...and never claims a payout", !none.includes("paid from the pool"), none);

  const some = resolutionText("Q?", "no", "https://oddie.fun/m/x", 1);
  check("winners: says they are paid", some.includes("paid from the pool"), some);

  // An unreadable winner is the one case where the honest post is a shorter
  // post: the side and the link, and no sentence about money at all.
  for (const unknown of [resolutionText("Q?", "no", "https://oddie.fun/m/x", null),
                         resolutionText("Q?", "no", "https://oddie.fun/m/x")]) {
    check("unreadable: prints no money sentence rather than guessing",
      !unknown.includes("paid") && !unknown.includes("goes back"), unknown);
    check("...but still names the side and the link",
      unknown.includes("NO") && unknown.includes("https://oddie.fun/m/x"), unknown);
  }
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
    payeeHandle: async () => "takeguy",
    payeeFeeLamports: async () => 4_000_000,
    ...over,
  });

  const r = await postResolution(m.slug, "yes", base());
  check("the result announcement posts", r.posted && posts.some((p) => p.text.startsWith("Settled: YES")), JSON.stringify(posts));
  check("the opener gets a credit reply", Boolean(r.creditReplyId) && posts.some((p) => p.text.startsWith("@takeguy")), JSON.stringify(posts));
  check("the credit is a SEPARATE reply, under the announcement", posts.length === 2 && posts[1].inReplyTo === "id-1");

  // No fee owed (nobody backed the winner): no tag. This is what stops us
  // spraying a mention at every market that resolved on an empty side.
  posts.length = 0;
  const r2 = await postResolution(m.slug, "yes", base({ payeeFeeLamports: async () => 0 }));
  check("no fee owed means no @-mention", !r2.creditReplyId && posts.length === 1, JSON.stringify(posts));

  // No author handle (a market made in the app, not from a tag): nobody to
  // credit, and still just the announcement.
  posts.length = 0;
  const r3 = await postResolution(m.slug, "no", base({ payeeHandle: async () => null }));
  check("no known opener means no @-mention", !r3.creditReplyId && posts.length === 1);

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


console.log("\nthe quote is the only half of this that can reach anybody");
{
  /* A reply cannot travel: X's own ranking code filters it out for non-followers,
     discounts it for followers, and gates the mutual-follow boost on not being
     one. So the result was landing in exactly one thread and nowhere else. */
  _resetMemReplyId();
  const m = await createCommunityMarket({ question: "Will it hold?", category: "Other", yesPct: 50, closeTime: Math.floor(Date.now() / 1000) + 86400 });
  _setMemReplyId(m.slug, "oddie-reply-9");
  const replies: string[] = [];
  const quotes: Array<{ text: string; quoteTweetId: string; mediaIds?: string[] }> = [];
  const base = (over: Partial<ResolutionDeps> = {}): ResolutionDeps => ({
    dryRun: false, cardPng: async () => Buffer.from("png"), uploadMedia: async () => "media",
    postReply: async (o) => { replies.push(o.text); return { id: `r-${replies.length}` }; },
    postQuote: async (o) => { quotes.push(o); return { id: `q-${quotes.length}` }; },
    quoteTarget: async () => "2096291092820062429",
    crowd: async () => ({ stakers: 7, winners: 3, bestEntryPct: 12 }),
    payeeHandle: async () => "smolwyne",
    payeeFeeLamports: async () => 0,
    log: () => {},
    ...over,
  });

  const r = await postResolution(m.slug, "yes", base());
  check("the claim is quoted, not just replied to",
    Boolean(r.quoteId) && quotes.length === 1 && quotes[0].quoteTweetId === "2096291092820062429",
    JSON.stringify(quotes));
  check("...and the quote carries its own card",
    quotes[0]?.mediaIds?.length === 1, JSON.stringify(quotes[0]?.mediaIds));
  check("...and credits the opener by name", quotes[0].text.includes("@smolwyne"), quotes[0].text);
  check("...and tells the price story without naming who paid it",
    quotes[0].text.includes("12%") && !/\b(won|lost|winner)\b/i.test(quotes[0].text), quotes[0].text);
  check("the thread still gets its own reply", replies.length === 1 && replies[0].startsWith("Settled: YES"));

  /* A claim that never came from X has nothing to quote, and that is not a
     failure: the thread reply is the whole announcement. */
  replies.length = 0; quotes.length = 0;
  const r2 = await postResolution(m.slug, "no", base({ quoteTarget: async () => null }));
  check("a market with no X claim is not quoted, and still announces",
    r2.posted && !r2.quoteId && quotes.length === 0 && replies.length === 1);

  // Best-effort, exactly like the credit: the announcement has already gone out.
  replies.length = 0; quotes.length = 0;
  const r3 = await postResolution(m.slug, "yes", base({ postQuote: async () => { throw new Error("x down"); } }));
  check("a failed quote never unwinds a posted resolution", r3.posted && !r3.quoteId);

  replies.length = 0; quotes.length = 0;
  const r4 = await postResolution(m.slug, "yes", base({ dryRun: true }));
  check("a dry run quotes nothing", !r4.posted && quotes.length === 0 && replies.length === 0);

  /* THE THIRD POST IS GONE. The credit used to be its own reply, which meant a
     resolution cost three posts at the URL tier to tell one person something
     the quote is already @-mentioning them about. */
  replies.length = 0; quotes.length = 0;
  const r5 = await postResolution(m.slug, "yes", base({ payeeFeeLamports: async () => 4_000_000 }));
  check("a fee owed does not buy a third post",
    replies.length === 1 && quotes.length === 1 && !r5.creditReplyId,
    `${replies.length} replies, ${quotes.length} quotes`);
  check("...the quote carries the credit instead",
    quotes[0].text.includes("@smolwyne") && quotes[0].text.includes("creator cut"), quotes[0].text);

  /* But a market with nothing to quote must not silently drop somebody's payout
     notice: that opener is reachable by no other means. */
  replies.length = 0; quotes.length = 0;
  const r6 = await postResolution(m.slug, "yes", base({
    quoteTarget: async () => null, payeeFeeLamports: async () => 4_000_000,
  }));
  check("with nothing to quote, the credit reply still goes out",
    Boolean(r6.creditReplyId) && replies.length === 2 && replies[1].startsWith("@smolwyne"),
    JSON.stringify(replies));

  /* And a quote that FAILED told nobody anything, so the fallback has to fire. */
  replies.length = 0; quotes.length = 0;
  const r7 = await postResolution(m.slug, "yes", base({
    postQuote: async () => { throw new Error("x down"); }, payeeFeeLamports: async () => 4_000_000,
  }));
  check("a quote that failed does not swallow the payout notice",
    Boolean(r7.creditReplyId) && replies.length === 2, JSON.stringify(replies));
  _resetMemReplyId();
}

console.log("\na market nobody entered says nothing at all");
{
  /* Two posts at the URL tier to announce that nothing happened, on the one
     surface where strangers meet the product, under somebody else's tweet. The
     money is the smaller half: "settled, and it was empty" is a public
     statement that our markets are empty. */
  _resetMemReplyId();
  const m = await createCommunityMarket({ question: "Will anyone care?", category: "Other", yesPct: 50, closeTime: Math.floor(Date.now() / 1000) + 86400 });
  _setMemReplyId(m.slug, "oddie-reply-7");
  const replies: string[] = [];
  const quotes: string[] = [];
  const base = (over: Partial<ResolutionDeps> = {}): ResolutionDeps => ({
    dryRun: false, cardPng: async () => Buffer.from("png"), uploadMedia: async () => "media",
    postReply: async (o) => { replies.push(o.text); return { id: `r-${replies.length}` }; },
    postQuote: async (o) => { quotes.push(o.text); return { id: `q-${quotes.length}` }; },
    quoteTarget: async () => "2096291092820062429",
    crowd: async () => ({ stakers: 0, winners: 0, bestEntryPct: null }),
    payeeHandle: async () => "smolwyne",
    payeeFeeLamports: async () => 0,
    log: () => {},
    ...over,
  });

  const r = await postResolution(m.slug, "yes", base({ poolLamports: async () => 0 }));
  check("an empty pool posts nothing, anywhere",
    !r.posted && r.reason === "empty" && replies.length === 0 && quotes.length === 0,
    JSON.stringify({ r, replies, quotes }));

  /* AN UNREADABLE POOL IS NOT AN EMPTY ONE. chain_entry is a floor and an RPC
     can blink; the wrong way to fail here is silence over somebody's money. */
  replies.length = 0; quotes.length = 0;
  const r2 = await postResolution(m.slug, "yes", base({ poolLamports: async () => null }));
  check("a pool we could not read still announces", r2.posted && replies.length === 1);

  replies.length = 0; quotes.length = 0;
  const r3 = await postResolution(m.slug, "yes", base({ poolLamports: async () => { throw new Error("rpc down"); } }));
  check("...and so does one whose read threw", r3.posted && replies.length === 1);

  // One lamport is not empty.
  replies.length = 0; quotes.length = 0;
  const r4 = await postResolution(m.slug, "yes", base({ poolLamports: async () => 1 }));
  check("a pool with anything in it announces", r4.posted && replies.length === 1 && quotes.length === 1);

  // And a caller that never wired the seam behaves exactly as before.
  replies.length = 0; quotes.length = 0;
  const r5 = await postResolution(m.slug, "yes", base());
  check("a caller with no pool seam is unchanged", r5.posted && replies.length === 1);
  _resetMemReplyId();
}

console.log("\nno bettor is ever named, in any shape the quote can take");
{
  /* Connecting X to see your own page is not consent to be published to your
     followers as somebody who gambles, and neither the side nor the size was
     ever public. The market's numbers are on chain; the people are not. */
  const shapes = [
    { outcome: "yes" as const, permalink: "https://oddie.fun/m/a", opener: "opener1", stakers: 7, winners: 3, bestEntryPct: 12 },
    { outcome: "no" as const, permalink: "https://oddie.fun/m/a", opener: "opener1", stakers: 7, winners: 5, bestEntryPct: 61 },
    { outcome: "yes" as const, permalink: "https://oddie.fun/m/a", opener: null, stakers: 1, winners: 1, bestEntryPct: 50 },
    { outcome: "yes" as const, permalink: "https://oddie.fun/m/a", opener: "opener1", stakers: 4, winners: 0, bestEntryPct: null },
  ];
  for (const sh of shapes) {
    const t = buildResolutionQuote(sh);
    const ats = t.match(/@[A-Za-z0-9_]+/g) ?? [];
    check(`only the opener is @-mentioned (${sh.stakers} in, ${sh.winners} right)`,
      ats.length === (sh.opener ? 1 : 0) && (!sh.opener || ats[0] === "@opener1"), t);
    check("...and it fits in a post", t.length <= 280, String(t.length));
    check("...and never says anybody lost",
      !/\b(lost|loser|you)\b/i.test(t), t);
  }
  // A market nobody backed the winner of took no fee, and the post says so
  // rather than implying a payout that did not happen.
  check("a market with no winners says nobody was paid",
    buildResolutionQuote(shapes[3]).includes("no fee was taken"), buildResolutionQuote(shapes[3]));
}

console.log(failures === 0 ? "\nall resolution-reply checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
