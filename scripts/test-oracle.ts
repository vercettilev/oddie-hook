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
import { decide, shouldRetry, backoffMs, decisionWasPaid, _setSecondOpinion } from "../src/oracle/oracle.js";
import { recordOracleDecision, oracleAttemptFor, oracleGateCounts, _memOracleDecisions, _memBackdateOracle, _resetOracleDecisions } from "../src/store/markets.js";
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
  // A CMS emitting &#8217; for an apostrophe is the default, not the exception.
  // Undecoded, it failed an honest quote with the status that blames the source.
  check("numeric character references decode", normalizeText("The company&#8217;s board") === normalizeText("The company’s board"), normalizeText("The company&#8217;s board"));
  check("hex references decode", normalizeText("caf&#xE9; open") === normalizeText("café open"));
  check("named typographic entities decode", normalizeText("a &mdash; b") === normalizeText("a - b"));
  check("a malformed reference does not throw", normalizeText("&#999999999; x").includes("x"));
  check("runs of whitespace collapse", normalizeText("a\n\n  b") === "a b");
  // Words must not fuse across a tag boundary, or "<b>Ars</b>enal" reads as one
  // token and a real quote silently stops matching.
  check("tags become separators, not deletions", htmlToText("<b>Ars</b>enal").includes("Ars enal"));
  check("script bodies are not searchable text", !htmlToText("<script>secret words here</script>").includes("secret"));
  check("a declared date is read", documentDateOf(page("x", "2026-08-25T10:00:00Z"))?.startsWith("2026-08-25") === true);
  check("no declared date is null, not a guess", documentDateOf(page("x")) === null);
  // Wikipedia's JSON-LD says published 2001, modified today. Reading the FIRST
  // signal dated it 2001. Reading the NEWEST date anywhere was worse and in the
  // dangerous direction, so now: document-level only, published over modified,
  // earliest wins.
  const wiki = '<html><head><script type="application/ld+json">{"datePublished":"2001-09-30T23:36:15Z","dateModified":"2026-08-26T08:00:00Z"}</script></head><body>x</body></html>';
  check("published beats modified", documentDateOf(wiki)?.startsWith("2001-09-30") === true, String(documentDateOf(wiki)));

  // THE ONE THAT MATTERS. Every templated news page carries a sidebar of
  // today's stories. Taking the newest date anywhere certified a 2024 article
  // as post-close, which defeats the only rule this file exists for.
  const sidebar = '<html><head><meta property="article:published_time" content="2024-03-02T10:00:00Z"></head>' +
    '<body><article><p>The Commission has not approved the application.</p></article>' +
    '<aside class="latest"><time datetime="2026-08-28T09:00:00Z">today</time></aside></body></html>';
  check("a sidebar date cannot make an old article fresh", documentDateOf(sidebar)?.startsWith("2024-03-02") === true, String(documentDateOf(sidebar)));

  // A boilerplate or footer edit bumps dateModified without the document
  // learning anything.
  const bumped = '<html><head><script type="application/ld+json">{"datePublished":"2023-01-05T00:00:00Z","dateModified":"2026-08-27T00:00:00Z"}</script></head><body>x</body></html>';
  check("a modified-date bump cannot certify an old article", documentDateOf(bumped)?.startsWith("2023-01-05") === true, String(documentDateOf(bumped)));

  // Nothing but <time> is now the same as nothing: measured, no real article
  // relies on it, and it was the sidebar's way in.
  check("a bare <time> is not a date signal", documentDateOf('<html><body><time datetime="2026-08-28T09:00:00Z">x</time></body></html>') === null);

  // Date() reads a zoneless datetime in the HOST's timezone, so the same page
  // verified on a UTC server and went stale on a laptop.
  check("a zoneless datetime is read as UTC", documentDateOf('<meta name="date" content="2026-08-21T07:00:00">') === "2026-08-21T07:00:00.000Z");

  // Only modified declared: that is what we have.
  check("modified is used when nothing else is declared", documentDateOf('<meta property="article:modified_time" content="2026-08-25T10:00:00Z">')?.startsWith("2026-08-25") === true);

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

  check("a pre-close page is marked stale, not rejected", early.stale === 1 && early.absent === 0);
  check("a YES may stand on a stale citation", auditSupports("yes", early).ok);
  // The event could still have happened the day after this was written.
  check("a NO may NOT stand on a stale citation", !auditSupports("no", early).ok, auditSupports("no", early).why);
  check("a NO stands on a post-close citation", auditSupports("no", late).ok);
  check("a YES stands on a post-close citation", auditSupports("yes", late).ok);
}

console.log("\nA PAGE THAT DECLARES NO DATE CANNOT ESTABLISH A NON-EVENT");
{
  // Measured on real permalinks: 3 of 23 verified pages declared no date, and
  // they were both SEC press releases and a NASA release. Those are precisely
  // what a NO on a regulatory or announcement market would cite. The staleness
  // test short-circuited on a null date, so the citation came back "verified"
  // and the operator was told it was "dated at or after the close".
  servePages({ "https://a.test/undated": page("The Commission has not approved the application") });
  const und = await auditCitations([{ url: "https://a.test/undated", quote: "The Commission has not approved" }], new Date(CLOSE));
  check("an undated page is its own status, not verified", und.citations[0].status === "undated", und.citations[0].status);
  check("...and is not counted as verified", und.verified === 0 && und.undated === 1);
  check("a YES may stand on an undated page", auditSupports("yes", und).ok);
  check("a NO may NOT stand on an undated page", !auditSupports("no", und).ok, auditSupports("no", und).why);
  check("...and the refusal says why", auditSupports("no", und).why.includes("no citation declares a date"));

  // With no deadline nothing can be stale, so the citation is simply verified.
  const noClose = await auditCitations([{ url: "https://a.test/undated", quote: "The Commission has not approved" }], null);
  check("with no close time an undated page is simply verified", noClose.verified === 1 && noClose.undated === 0);
  check("...and supports a YES", auditSupports("yes", noClose).ok);
  // But a NO says a DEADLINE was missed, and there is no deadline here. This
  // used to settle on any reachable page at all, and report it as "dated at or
  // after the close" about a close that did not exist.
  check("...but never a NO, because there is no deadline to miss", !auditSupports("no", noClose).ok);
  check("...and says exactly that", auditSupports("no", noClose).why.includes("no close time"), auditSupports("no", noClose).why);
}

console.log("\none unverifiable citation discards the verdict, whatever else is in the pile");
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
  check("the invented one is caught", mixed.absent === 1);
  check("YES is refused anyway", !auditSupports("yes", mixed).ok, auditSupports("yes", mixed).why);
  check("NO is refused anyway", !auditSupports("no", mixed).ok);
}

console.log("\nthe sentence written into the record says what the evidence actually is");
{
  servePages({
    "https://a.test/late": page("Arsenal beat Chelsea 3-1 on Saturday", "2026-08-25T10:00:00Z"),
    "https://a.test/nodate": page("Arsenal beat Chelsea 3-1 on Saturday"),
  });
  const mix = await auditCitations([
    { url: "https://a.test/late", quote: "Arsenal beat Chelsea 3-1" },
    { url: "https://a.test/nodate", quote: "Arsenal beat Chelsea 3-1" },
    { url: "https://a.test/gone", quote: "Arsenal beat Chelsea 3-1" },
  ], new Date(CLOSE));
  const why = auditSupports("yes", mix).why;
  // It used to call all of these "verified", which is the exact word this file
  // reserves for "quote found AND dated at or after the close".
  check("a dateless citation is not called verified", !why.includes("2 verified"), why);
  check("the composition is spelled out", why.includes("1 dated at or after the close") && why.includes("1 undated"), why);
  // Dead URLs are the strongest signal available that sources are being made
  // up, and they were counted nowhere and printed nowhere.
  check("unreachable citations are surfaced", why.includes("1 unreachable"), why);
}

console.log("\na page that renders in JavaScript was not read, so it is not accused");
{
  // Measured on fifa.com: 4,551 bytes of markup, zero characters of prose,
  // because the content arrives via a script we never run. quote-absent is the
  // status that discards a verdict AND says a source was invented; a page we
  // could not read has done neither.
  const shell = "<html><head><title>x</title></head><body><div id=\"root\"></div>" +
    "<script>window.__DATA__=" + JSON.stringify({ pad: "x".repeat(1200) }) + "</script></body></html>";
  _setPageFetcher(async () => ({ ok: true, html: shell, status: 200 }));
  const j = await auditCitation({ url: "https://a.test/spa", quote: "Full Time, New York Stadium, 2026" }, null);
  check("a JS shell is unreachable, not an absent quote", j.status === "unreachable", `${j.status} / ${j.note}`);
  check("...and says why", j.note.includes("JavaScript"), j.note);

  // A tiny page that is ALL content must still be read normally: a plain API
  // response is a few hundred bytes and every one of them is prose.
  _setPageFetcher(async () => ({ ok: true, html: '{"bitcoin":{"usd":105690}}', status: 200 }));
  const api = await auditCitation({ url: "https://a.test/api", quote: '"bitcoin":{"usd":105690}' }, null);
  check("a small API response is still readable", api.status === "verified", `${api.status} / ${api.note}`);
}

console.log("\na page we only half-read is not a page missing its words");
{
  _setPageFetcher(async () => ({ ok: true, html: page("nothing relevant here"), status: 200, truncated: true }));
  const t = await auditCitation({ url: "https://a.test/huge", quote: "Arsenal beat Chelsea 3-1" }, null);
  // quote-absent is the status that discards the verdict AND accuses the source.
  // A page we truncated did nothing wrong.
  check("truncation reads as unreachable, not as an absent quote", t.status === "unreachable", t.status);
  check("...and says why", t.note.includes("too large"), t.note);
}

console.log("\nordinary markup does not break an honest quote");
{
  // Drop caps are standard on longform news. Spacing every tag turned
  // "<span>T</span>he Commission" into "t he commission" and failed the quote
  // with the status that blames the source.
  servePages({
    "https://a.test/dropcap": '<html><body><p><span class="dropcap">T</span>he Commission has not approved the application.</p></body></html>',
    "https://a.test/split": "<html><body><p>The counter<wbr>terrorism unit issued no statement.</p></body></html>",
    "https://a.test/entity": "<html><body><p>The company&#8217;s board approved the merger on Tuesday.</p></body></html>",
    "https://a.test/blocks": "<html><body><p>Arsenal won</p><p>the league</p></body></html>",
  });
  const q = async (u: string, quote: string) => (await auditCitation({ url: u, quote }, null)).status;
  check("a drop cap does not break the quote", await q("https://a.test/dropcap", "The Commission has not approved the application") === "verified");
  check("a word split by <wbr> does not break it", await q("https://a.test/split", "The counterterrorism unit issued no statement") === "verified");
  check("a numeric entity does not break it", await q("https://a.test/entity", "The company’s board approved the merger") === "verified");
  // ...and the other direction still holds: separate blocks must not fuse.
  check("separate blocks still read as separate words", await q("https://a.test/blocks", "Arsenal won the league") === "verified");
  check("...but not fused into one", await q("https://a.test/blocks", "Arsenal wonthe league") === "verified");
}

console.log("\ntext no reader ever sees is not quotable");
{
  servePages({
    "https://a.test/meta": '<html><head><meta name="description" content="Arsenal beat Chelsea 3-1 -> the title race is over"></head><body><p>Nothing here.</p></body></html>',
  });
  // The naive tag regex stopped at the first ">", so the tail of any attribute
  // containing one leaked into the searchable text.
  const a = await auditCitation({ url: "https://a.test/meta", quote: "the title race is over" }, null);
  check("an attribute value is not quotable prose", a.status === "quote-absent", `${a.status} / ${a.note}`);
}

console.log("\nno citations at all is an abstention, not a free pass");
{
  const empty: AuditResult = { citations: [], verified: 0, undated: 0, stale: 0, absent: 0, unreachable: 0, closeKnown: true };
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
    dropped: 0,
    ...over,
  });
  const run = async (p: Partial<Proposal>, second: Side = "yes") => {
    _setProposer(async () => propose(p));
    _setSecondOpinion(async () => ({ outcome: second, why: "" }));
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
  check("a quote absent from its page abstains", faked.settle === null && faked.gate === "citations-failed", faked.reason);
  check("...and reports it as a citation failure, not as low confidence", faked.audit?.absent === 1);

  const bare = await run({ citations: [] });
  check("high confidence with no evidence abstains", bare.settle === null && bare.gate === "citations-failed");

  const split = await run({}, "no");
  check("a disagreeing second read abstains", split.settle === null && split.gate === "second-opinion-disagreed");

  const shrug = await run({}, "undetermined");
  check("a second read that will not conclude abstains", shrug.settle === null);

  // AN OUTAGE IS NOT A DISAGREEMENT. Both stop the settlement and they are
  // completely different news: during a rate limit every market on the board
  // printed "a blind second read said undetermined", so a board of API failures
  // read as a board of weak evidence.
  _setProposer(async () => propose({}));
  _setSecondOpinion(async () => ({ outcome: null, why: "the second read could not be obtained (429)" }));
  const down = await decide({ slug: "m1", question: "Did Arsenal beat Chelsea?", criteria: CRIT, closeTime: CLOSE }, AFTER);
  check("an unobtainable second read has its own gate", down.gate === "second-opinion-unavailable", down.gate);
  check("...and does not claim anybody disagreed", !down.reason.includes("said"), down.reason);

  // decide() promises never to throw and is called in a loop over a whole
  // board. An unwrapped rejection killed the run at whichever market hit it.
  _setSecondOpinion(async () => { throw new Error("fetch failed"); });
  const boom = await decide({ slug: "m1", question: "Did Arsenal beat Chelsea?", criteria: CRIT, closeTime: CLOSE }, AFTER);
  check("a thrown second read does not kill the run", boom.settle === null && boom.gate === "second-opinion-unavailable", boom.gate);
  check("...and the cause survives", boom.reason.includes("fetch failed"), boom.reason);

  // A YES resting only on undated pages passes the audit, and used to be handed
  // an EMPTY evidence list, so it was refused for a disagreement that never
  // happened.
  servePages({ "https://a.test/nodate": page("Arsenal beat Chelsea 3-1 on Saturday") });
  let sawEvidence = -1;
  _setProposer(async () => propose({ citations: [{ url: "https://a.test/nodate", quote: "Arsenal beat Chelsea 3-1" }] }));
  _setSecondOpinion(async (_m, evidence) => { sawEvidence = evidence.length; return { outcome: "yes", why: "" }; });
  const und = await decide({ slug: "m1", question: "Did Arsenal beat Chelsea?", criteria: CRIT, closeTime: CLOSE }, AFTER);
  check("undated evidence reaches the second reader", sawEvidence === 1, String(sawEvidence));
  check("...so a YES on undated pages can settle", und.settle === "yes", `${und.gate}: ${und.reason}`);

  // Evidence beyond the audit limit is never checked, so the rule that one
  // unverifiable citation discards a verdict would only cover the part we saw.
  servePages({ "https://a.test/late": page("Arsenal beat Chelsea 3-1 on Saturday", "2026-08-25T10:00:00Z") });
  _setProposer(async () => propose({ dropped: 3 }));
  _setSecondOpinion(async () => ({ outcome: "yes", why: "" }));
  const trimmed = await decide({ slug: "m1", question: "Did Arsenal beat Chelsea?", criteria: CRIT, closeTime: CLOSE }, AFTER);
  check("unaudited evidence abstains", trimmed.settle === null && trimmed.gate === "evidence-not-audited", trimmed.gate);

  // The audit runs before confidence so the two never get confused: both abstain,
  // but only one of them means something in the chain invented a source.
  const both = await run({ confidence: "low", citations: [{ url: "https://a.test/late", quote: "Arsenal won the league outright" }] });
  check("an absent quote is reported even when confidence was also low", both.gate === "citations-failed", both.gate);

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

console.log("\nasking the same stuck market again, forever, at full price");
{
  const H = 3600_000;
  // Never tried: ask.
  check("a market never tried is asked", shouldRetry({ lastGate: null, lastDecidedAt: null, paidAttempts: 0 }).retry);

  // The free code gates decide before a token is spent, so re-asking costs
  // nothing and must never be held back.
  for (const g of ["no-criteria", "not-closed"]) {
    check(`"${g}" is free, so it is always re-asked`, shouldRetry({ lastGate: g, lastDecidedAt: new Date().toISOString(), paidAttempts: 3 }).retry);
  }

  // THE ONE THAT MATTERS FOR COST. The model looked and said the QUESTION is
  // not checkable. Waiting changes nothing; only a person rewriting the
  // criteria does. Asked daily it buys the same sentence at full price forever.
  const stuck = shouldRetry({ lastGate: "not-checkable", lastDecidedAt: new Date(Date.now() - 400 * H).toISOString(), paidAttempts: 9 });
  check("an uncheckable question is never re-asked on a schedule", !stuck.retry);
  check("...and says a person has to act", stuck.why.includes("person"), stuck.why);

  // Transient gates back off rather than stopping.
  const t = (paid: number, agoH: number) =>
    shouldRetry({ lastGate: "proposer-abstained", lastDecidedAt: new Date(Date.now() - agoH * H).toISOString(), paidAttempts: paid });
  check("one attempt, an hour ago: held", !t(1, 1).retry);
  check("one attempt, seven hours ago: asked", t(1, 7).retry);
  check("two attempts, seven hours ago: held", !t(2, 7).retry);
  check("two attempts, thirteen hours ago: asked", t(2, 13).retry);
  check("the wait is quoted in hours", t(2, 7).why.includes("h"), t(2, 7).why);
  check("backoff doubles", backoffMs(1) === 6 * H && backoffMs(2) === 12 * H && backoffMs(3) === 24 * H);
  check("...and caps at a week", backoffMs(20) === 7 * 24 * H);
  check("no paid attempt means no wait", backoffMs(0) === 0);

  // A market whose every attempt times out would otherwise be free to retry at
  // full price forever, because runPropose can throw AFTER the request went out.
  check("an error counts as paid", decisionWasPaid({ slug: "s", settle: null, gate: "error", reason: "" }));
  check("a free gate does not", !decisionWasPaid({ slug: "s", settle: null, gate: "no-criteria", reason: "" }));
}

console.log("\nthe record is written, and it is what the policy reads");
{
  _resetOracleDecisions();
  await recordOracleDecision({ slug: "m9", settle: null, gate: "proposer-abstained", reason: "no conclusion", paid: true, confidence: "medium" });
  await recordOracleDecision({ slug: "m9", settle: null, gate: "no-criteria", reason: "none", paid: false });
  await recordOracleDecision({ slug: "other", settle: "yes", gate: "settled", reason: "ok", paid: true });

  const a = await oracleAttemptFor("m9");
  check("the latest gate is the one read back", a.lastGate === "no-criteria", String(a.lastGate));
  // The count is of PAID attempts, not of rows: a free gate must not push a
  // market further down the backoff for having cost nothing.
  check("only paid attempts are counted", a.paidAttempts === 1, String(a.paidAttempts));
  check("another market's rows do not leak in", (await oracleAttemptFor("other")).paidAttempts === 1);
  check("a market with no history is empty, not an error", (await oracleAttemptFor("nope")).lastGate === null);

  check("refusals are recorded, not just settlements", _memOracleDecisions().filter((r) => r.settle === null).length === 2);
  const counts = await oracleGateCounts(7);
  check("gates can be counted across the board", counts["proposer-abstained"] === 1 && counts["settled"] === 1, JSON.stringify(counts));

  // The window matures without anybody sleeping.
  _resetOracleDecisions();
  await recordOracleDecision({ slug: "m9", settle: null, gate: "citations-failed", reason: "x", paid: true });
  check("freshly decided, it is held", !shouldRetry(await oracleAttemptFor("m9")).retry);
  _memBackdateOracle("m9", 7 * 60);
  check("seven hours later, it is asked again", shouldRetry(await oracleAttemptFor("m9")).retry);
  _resetOracleDecisions();
}

_setPageFetcher(null);
console.log(failures === 0 ? "\nall oracle checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
