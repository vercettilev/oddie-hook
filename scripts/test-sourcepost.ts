// Parsing the source post out of X's oEmbed response.
//
// Pure assertions only, deliberately no network: this suite runs on every
// commit and must not depend on X being reachable or on a particular post
// still existing. The fetch wrapper itself (fetchSourcePost) is a thin
// try/catch over this parser plus a URL guard, and the backfill that uses it
// is verified by hand against a live post — what actually breaks silently is
// the HTML shape, which is what's pinned here.
//
// Run with: npm run test-sourcepost

import { readFileSync } from "node:fs";
import { extractPostText } from "../src/venues/xOembed.js";
import { handleFromSourceUrl } from "../src/store/markets.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};
const eq = (name: string, got: string, want: string) =>
  check(name, got === want, got === want ? "" : `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

// The exact shape X returns, confirmed live against x.com/jack/status/20.
const REAL = '<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">just setting up my twttr</p>&mdash; jack (@jack) <a href="https://x.com/jack/status/20?ref_src=twsrc%5Etfw">March 21, 2006</a></blockquote>';

console.log("\nextractPostText: the post, and nothing around it");
{
  eq("pulls the post text out of a real oEmbed payload", extractPostText(REAL), "just setting up my twttr");

  // The attribution after </p> is X's, not the author's. Showing it as part of
  // the post would put words in someone's mouth.
  check("drops X's own trailing attribution line",
    !extractPostText(REAL).includes("jack (@jack)") && !extractPostText(REAL).includes("March 21"),
    extractPostText(REAL));

  eq("keeps link TEXT, drops the anchor tags",
    extractPostText('<p dir="ltr">see <a href="https://x.com/y">this thread</a> now</p>'),
    "see this thread now");
  eq("in-post line breaks become spaces, not run-together words",
    extractPostText("<p>line one<br>line two</p>"), "line one line two");
  eq("collapses runaway whitespace", extractPostText("<p>a   b\n\n  c</p>"), "a b c");
}

console.log("\nentity decoding — order matters");
{
  eq("quotes and apostrophes", extractPostText("<p>&quot;won&#39;t&quot;</p>"), '"won\'t"');
  eq("angle brackets", extractPostText("<p>&lt;not a tag&gt;</p>"), "<not a tag>");
  // &amp; must decode LAST or "&amp;lt;" would turn into a real "<".
  eq("an escaped entity stays escaped (&amp; decoded last)",
    extractPostText("<p>&amp;lt;</p>"), "&lt;");
  eq("ampersands in ordinary text", extractPostText("<p>rock &amp; roll</p>"), "rock & roll");
}

console.log("\nnothing to show is an empty string, never a guess");
{
  eq("no paragraph at all", extractPostText("<blockquote>bare text</blockquote>"), "");
  eq("empty payload", extractPostText(""), "");
  eq("an empty post", extractPostText("<p></p>"), "");
  eq("whitespace-only post", extractPostText("<p>   </p>"), "");
}

console.log("\nonly the FIRST paragraph is the post");
{
  // A quote-tweet payload can carry a second <p> for the quoted post; that
  // belongs to someone else and must not be concatenated into this one.
  eq("a second paragraph is not appended",
    extractPostText("<p>mine</p><p>someone else's</p>"), "mine");
}

// --- the handle in the URL is now load-bearing --------------------------------
//
// handleFromSourceUrl went untested while it was a convenience. It is now the
// gate on /api/community/create: a market is refused unless its source URL
// yields a handle, because that handle is what puts a name on the card and a
// payee on the creator fee. Everything it wrongly accepts becomes a market
// that renders with no attribution; everything it wrongly rejects is a market
// the operator cannot publish at all.
console.log("\nthe handle a market is named after");
{
  const h = handleFromSourceUrl;
  check("a plain x.com status URL yields the author", h("https://x.com/levvercetti/status/1234567890") === "levvercetti");
  check("...twitter.com too", h("https://twitter.com/levvercetti/status/123") === "levvercetti");
  check("...and the embed mirrors people actually paste", h("https://fixupx.com/Someone/status/9") === "someone");
  check("...case is normalised, since it keys the device lookup",
    h("https://x.com/LevVercetti/status/1") === "levvercetti");
  check("...www and query strings do not defeat it",
    h("https://www.x.com/levvercetti/status/1?s=20&t=abc") === "levvercetti");

  // The rejections matter as much: each of these would previously have created
  // a market with no name on it.
  check("a profile URL is refused — no post means no claim", h("https://x.com/levvercetti") === null);
  check("...the bare host is refused", h("https://x.com/") === null);
  check("...another site's status path is refused", h("https://example.com/levvercetti/status/1") === null);
  check("...empty and null are refused", h("") === null && h(null) === null && h(undefined) === null);
}

// --- no card may claim a person chose to be anonymous -------------------------
//
// The feed rendered "tagged by anonymous" for every market with no surfacer,
// which was every community market in production. It was untrue (nobody chose
// anonymity; the source was simply never recorded) and it read to a first-time
// visitor as though oddie lists these markets itself.
console.log("\nthe market page never invents an anonymous person");
{
  // Provenance now lives on the rebuilt market page (public/app/market.html):
  // an "Opened by @handle" eyebrow and, when the originating post is known, a
  // quoted source card with a link to check it at source. The rule this
  // guards is unchanged from the feed's author row: a market with no recorded
  // source shows NOTHING about who opened it, never a made-up "anonymous", and
  // a named tagger is a link, not a label.
  const page = readFileSync(new URL("../public/app/market.html", import.meta.url), "utf8");
  const from = page.indexOf("function render(m)");
  const body = from < 0 ? "" : page.slice(from, page.indexOf("\n  }\n", from) + 4);
  check("the market page's render() is where the test thinks it is", from > 0);
  check("provenance never asserts an anonymous tagger", body.length > 0 && !/anonymous/i.test(body));
  // The wording is deliberately terse (hypercasual: the byline is just the
  // handle). What is pinned is the GUARD, not the phrasing.
  check("the eyebrow only names an opener when one is recorded",
    body.includes('if (m.taggedBy) bits.push('));
  // THE QUOTE IS GONE, ON PURPOSE (the market page's own comment: "ALINTI
  // GITTI, KAYNAK KALDI"). Two lines of somebody's tweet were not changing
  // anybody's YES/NO and were pushing the pool and the buttons down the page,
  // so the claim's provenance moved out of a card and into one link on the
  // eyebrow. These checks were pinned to the quote's exact expression and went
  // red the moment it left, which is a stale guard rather than a regression.
  //
  // What still has to hold is the rule underneath, and it is NARROWER than
  // before: with no quote on the page, the link is the ONLY way to check the
  // claim at source. The question above it is an LLM rewrite of the post, not
  // the post, so losing this link would leave a market whose claim cannot be
  // verified without guessing. It is therefore pinned harder than the quote
  // ever was.
  check("the source row only renders when a post url is actually known",
    body.includes("if (m.sourcePost && m.sourcePost.url)"));
  check("the source is a link to the post on X, and it is the ONLY way left to check the claim",
    body.includes("'<a class=\"src__a\" href=\"' + esc(m.sourcePost.url)") && body.includes("See the post"));
  check("no code path prints the post's text any more, so nothing can half-quote it",
    !/sourcePost\.text|\bsp\.text\b/.test(page));
  check("...in a new tab, without leaking the referrer chain",
    body.includes('target="_blank" rel="noopener noreferrer"'));
}

console.log(failures === 0 ? "\nall source-post checks passed.\n" : `\n${failures} source-post check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
