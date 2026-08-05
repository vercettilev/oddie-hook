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

import { extractPostText } from "../src/venues/xOembed.js";

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

console.log(failures === 0 ? "\nall source-post checks passed.\n" : `\n${failures} source-post check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
