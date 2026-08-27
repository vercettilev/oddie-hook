// The oracle's rules, exercised without the internet deciding them.
//
// Everything the oracle does that MATTERS is a refusal, and a refusal is
// invisible in production: a market that quietly abstains looks exactly like a
// market nobody got to. So the gates are pinned here, one at a time, against a
// fake page fetcher and a fake proposer.
//
// The two that would be silently wrong if nobody checked, and are checked
// hardest: a quote that is not on the page must never pass, and a NO must never
// rest on documents written before the deadline it claims was missed.
//
// Run with: npm run test-oracle
if (process.env.DATABASE_URL) { console.error("refusing to run against a database"); process.exit(1); }

import {
  auditCitation, auditCitations, auditSupports, normalizeText, htmlToText, documentDateOf,
  _setPageFetcher, type AuditResult,
} from "../src/oracle/audit.js";
import { decide, _setSecondOpinion } from "../src/oracle/oracle.js";
import { _setProposer, type Proposal, type Side } from "../src/oracle/verdict.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.error(`  ✗ ${n}`); if (d) console.error(`      ${d}`); }
};

const CLOSE = "2026-08-20T23:59:00Z";
const AFTER = new Date("2026-08-25T00:00:00Z");

/** A page whose body says `text`, optionally declaring a publication date. */
const page = (text: string, published?: string) =>
  `<html><head>${published ? `<meta property="article:published_time" content="${published}">` : ""}</head>` +
  `<body><script>var junk="${text}";</script><p>${text}</p></body></html>`;

function servePages(map: Record<string, string>): void {
  _setPageFetcher(async (url) =>
    map[url] !== undefined ? { ok: true, html: map[url], status: 200 } : { ok: false, html: "", status: 404 },
  );
}

console.log("\nnormalisation makes an honest quote findable and cannot invent a match");
{
  check("smart quotes collapse", normalizeText("Arsenal’s “win”") === normalizeText("Arsenal's \"win\""));
  check("runs of whitespace collapse", normalizeText("a\n\n  b") === "a b");
  // Words must not fuse across a tag boundary, or "<b>Ars</b>enal" reads as one
  // token and a real quote silently stops matching.
  check("tags become separators, not deletions", htmlToText("<b>Ars</b>enal").includes("Ars enal"));
  check("script bodies are not searchable text", !htmlToText("<script>secret words here</script>").includes("secret"));
  check("a declared date is read", documentDateOf(page("x", "2026-08-25T10:00:00Z"))?.startsWith("2026-08-25") === true);
  check("no declared date is null, not a guess", documentDateOf(page("x")) === null);
  // Measured on the real Wikipedia: its JSON-LD says the article was published
  // in 2001 and modified today. Reading the first signal instead of the newest
  // dated every Wikipedia citation to 2001, which marked it stale, which blocked
  // every NO verdict citing one of the few sources that can be cited at all.
  const wiki = '<html><head><script type="application/ld+json">{"datePublished":"2001-09-30T23:36:15Z","dateModified":"2026-08-26T08:00:00Z"}</script></head><body>x</body></html>';
  check("the NEWEST date wins, not the first found", documentDateOf(wiki)?.startsWith("2026-08-26") === true, String(documentDateOf(wiki)));
  const strayTime = '<html><head><meta property="article:published_time" content="2026-08-25T10:00:00Z"></head><body><time datetime="1999-01-01">old</time></body></html>';
  check("an out-of-range stray date is ignored", documentDateOf(strayTime)?.startsWith("2026-08-25") === true, String(documentDateOf(strayTime)));
}

console.log("\na citation is checked against the page it names");
{
  servePages({ "https://a.test/1": page("Arsenal beat Chelsea 3-1 on Saturday", "2026-08-25T10:00:00Z") });

  const good = await auditCitation({ url: "https://a.test/1", quote: "Arsenal beat Chelsea 3-1" }, new Date(CLOSE));
  check("words that are there verify", good.status === "verified", good.note);

  // The one that matters. A page that loaded fine and does not contain its own
  // quote means the words were made up somewhere in the chain.
  const bad = await auditCitation({ url: "https://a.test/1", quote: "Arsenal beat Chelsea 5-0" }, new Date(CLOSE));
  check("words that are NOT there fail", bad.status === "quote-absent", bad.note);

  const gone = await auditCitation({ url: "https://a.test/missing", quote: "anything at all here" }, null);
  check("a page we cannot fetch is unreachable, not verified", gone.status === "unreachable");

  const local = await auditCitation({ url: "file:///etc/passwd", quote: "root:x:0:0:root:/root" }, null);
  check("a non-http address is never fetched", local.status === "unreachable", local.note);

  // A two-word quote appears on half the web. It is not evidence of anything.
  const tiny = await auditCitation({ url: "https://a.test/1", quote: "Arsenal" }, null);
  check("a quote too short to mean anything fails", tiny.status === "quote-absent");
}

console.log("\nTHE ASYMMETRY: a pre-close document proves an early event, never a missed deadline");
{
  servePages({
    "https://a.test/early": page("Arsenal beat Chelsea 3-1 on Saturday", "2026-08-15T10:00:00Z"),
    "https://a.test/late": page("Arsenal beat Chelsea 3-1 on Saturday", "2026-08-25T10:00:00Z"),
  });
  const early = await auditCitations([{ url: "https://a.test/early", quote: "Arsenal beat Chelsea 3-1" }], new Date(CLOSE));
  const late = await auditCitations([{ url: "https://a.test/late", quote: "Arsenal beat Chelsea 3-1" }], new Date(CLOSE));

  check("a pre-close page is marked stale, not rejected", early.stale === 1 && early.fabricated === 0);
  check("a YES may stand on a stale citation", auditSupports("yes", early).ok);
  // The event could still have happened the day after this was written.
  check("a NO may NOT stand on a stale citation", !auditSupports("no", early).ok, auditSupports("no", early).why);
  check("a NO stands on a post-close citation", auditSupports("no", late).ok);
  check("a YES stands on a post-close citation", auditSupports("yes", late).ok);
}

console.log("\none fabricated citation discards the verdict, whatever else is in the pile");
{
  servePages({
    "https://a.test/real": page("Arsenal beat Chelsea 3-1 on Saturday", "2026-08-25T10:00:00Z"),
    "https://a.test/fake": page("An entirely unrelated article about gardening", "2026-08-25T10:00:00Z"),
  });
  const mixed = await auditCitations([
    { url: "https://a.test/real", quote: "Arsenal beat Chelsea 3-1" },
    { url: "https://a.test/fake", quote: "Arsenal have secured the title outright" },
  ], new Date(CLOSE));
  check("the real one still verifies", mixed.verified === 1);
  check("the invented one is caught", mixed.fabricated === 1);
  check("YES is refused anyway", !auditSupports("yes", mixed).ok, auditSupports("yes", mixed).why);
  check("NO is refused anyway", !auditSupports("no", mixed).ok);
}

console.log("\nno citations at all is an abstention, not a free pass");
{
  const empty: AuditResult = { citations: [], verified: 0, stale: 0, fabricated: 0, unreachable: 0 };
  check("YES needs at least one verified citation", !auditSupports("yes", empty).ok);
  check("NO needs at least one verified citation", !auditSupports("no", empty).ok);
}

console.log("\nthe pipeline refuses before it spends anything");
{
  let proposerCalls = 0;
  _setProposer(async () => { proposerCalls++; throw new Error("the proposer should not have been reached"); });

  const noCriteria = await decide({ slug: "m1", question: "Will it?", criteria: null, closeTime: CLOSE }, AFTER);
  check("a market with no criteria abstains", noCriteria.settle === null && noCriteria.gate === "no-criteria");

  const thin = await decide({ slug: "m1", question: "Will it?", criteria: "yes if it happens", closeTime: CLOSE }, AFTER);
  check("criteria too thin to check abstain", thin.gate === "no-criteria", thin.reason);

  // Early resolution is legitimate for an operator and wrong for an unattended
  // process: the question is still open and the evidence is still arriving.
  const open = await decide(
    { slug: "m1", question: "Will it?", criteria: "Resolves YES if the official site shows a win by 20 Aug.", closeTime: "2026-09-30T00:00:00Z" },
    AFTER,
  );
  check("a market that has not closed abstains", open.gate === "not-closed", open.reason);
  check("none of those cost a model call", proposerCalls === 0);
  _setProposer(null);
}

console.log("\nevery gate downstream is a veto on its own");
{
  const CRIT = "Resolves YES if the Premier League site shows Arsenal beat Chelsea before 20 Aug 2026; otherwise NO.";
  servePages({ "https://a.test/late": page("Arsenal beat Chelsea 3-1 on Saturday", "2026-08-25T10:00:00Z") });

  const propose = (over: Partial<Proposal> = {}): Proposal => ({
    outcome: "yes", confidence: "high", checkable: true,
    citations: [{ url: "https://a.test/late", quote: "Arsenal beat Chelsea 3-1" }],
    reasoning: "the league site reports the result",
    ...over,
  });
  const run = async (p: Partial<Proposal>, second: Side = "yes") => {
    _setProposer(async () => propose(p));
    _setSecondOpinion(async () => second);
    return decide({ slug: "m1", question: "Did Arsenal beat Chelsea?", criteria: CRIT, closeTime: CLOSE }, AFTER);
  };

  check("everything passing settles", (await run({})).settle === "yes");

  const unchecked = await run({ checkable: false });
  check("not-checkable abstains", unchecked.settle === null && unchecked.gate === "not-checkable");

  const undet = await run({ outcome: "undetermined" });
  check("an undetermined proposer abstains", undet.settle === null && undet.gate === "proposer-abstained");

  // Confidence is a veto and never a licence: low stops it, high never causes it.
  const lowConf = await run({ confidence: "low" });
  check("low confidence abstains", lowConf.settle === null && lowConf.gate === "low-confidence");

  const faked = await run({ citations: [{ url: "https://a.test/late", quote: "Arsenal won the league outright" }] });
  check("a fabricated quote abstains", faked.settle === null && faked.gate === "citations-failed", faked.reason);
  check("...and reports it as a citation failure, not as low confidence", faked.audit?.fabricated === 1);

  const bare = await run({ citations: [] });
  check("high confidence with no evidence abstains", bare.settle === null && bare.gate === "citations-failed");

  const split = await run({}, "no");
  check("a disagreeing second read abstains", split.settle === null && split.gate === "second-opinion-disagreed");

  const shrug = await run({}, "undetermined");
  check("a second read that will not conclude abstains", shrug.settle === null);

  // The audit runs before confidence so the two never get confused: both abstain,
  // but only one of them means something in the chain invented a source.
  const both = await run({ confidence: "low", citations: [{ url: "https://a.test/late", quote: "Arsenal won the league outright" }] });
  check("a fabrication is reported even when confidence was also low", both.gate === "citations-failed", both.gate);

  _setProposer(null);
  _setSecondOpinion(null);
}

console.log("\na thrown proposer is an abstention, never a crash");
{
  _setProposer(async () => { throw new Error("upstream 500"); });
  const d = await decide(
    { slug: "m1", question: "q", criteria: "Resolves YES if the official site shows a win by 20 Aug 2026.", closeTime: CLOSE },
    AFTER,
  );
  check("the run survives and abstains", d.settle === null && d.gate === "error", d.reason);
  _setProposer(null);
}

_setPageFetcher(null);
console.log(failures === 0 ? "\nall oracle checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
