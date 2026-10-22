/**
 * A MARKET WHOSE RULE NAMES AN X ACCOUNT SETTLES FROM THAT ACCOUNT'S POSTS.
 *
 * Showdown names its champions on X and Discord. The page audit cannot read
 * X (a post renders its text in JavaScript) and search rarely holds a fresh
 * post, so a rule like "per the official announcement on the @Showdown_TCG X
 * account" could never settle. src/oracle/xPosts.ts reads the named account
 * through the X API and audit.ts checks a cited post the same way.
 *
 * Each check below is a way this could settle what it must not:
 *
 *   - a post by an account the rule does not name settles nothing, so the
 *     first person to tweet "GPPoker won" decides no market
 *   - the author is the one X reports, not the handle in the address, so a
 *     named handle pasted in front of somebody else's post id proves nothing
 *   - a quote that is not in the post discards the verdict, as on a page
 *   - a post from before the close can carry a YES and never a NO
 *   - nothing is read from X for a rule that names no account: posts cost money
 *   - our own account is never a source
 *
 * No network: X, the model and the second read are all injected.
 * Run with: npm run test-oracle-xposts
 */
if (process.env.DATABASE_URL) { console.error("refusing to run against a database"); process.exit(1); }

import { xSourcesIn, xStatusUrl, xPostsFor, _setXPostReader, type XPostReader } from "../src/oracle/xPosts.js";
import { auditCitations, auditSupports } from "../src/oracle/audit.js";
import { decide, _setSecondOpinion } from "../src/oracle/oracle.js";
import { _setProposer, type Proposal } from "../src/oracle/verdict.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.error(`  ✗ ${n}`); if (d) console.error(`      ${d}`); }
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log("\nwhich accounts a rule names");
{
  const rule = "Resolves YES if GPPoker is named the Lucky 13 winner in the official announcement on the @Showdown_TCG X account. Resolves NO otherwise.";
  check("an @handle in the rule is its source", same(xSourcesIn(rule), ["Showdown_TCG"]), JSON.stringify(xSourcesIn(rule)));
  const both = xSourcesIn("per x.com/Showdown_TCG or https://twitter.com/solanagaming/status/123");
  check("...so is an x.com or twitter.com address", same(both, ["Showdown_TCG", "solanagaming"]), JSON.stringify(both));
  check("an email address and our own account are not sources",
    same(xSourcesIn("write to support@showdown.game, or tag @oddiefun and @Oddiefun"), []), JSON.stringify(xSourcesIn("write to support@showdown.game, or tag @oddiefun and @Oddiefun")));
  check("one account named twice is one source", xSourcesIn("@Showdown_TCG or @showdown_tcg").length === 1);
  check("a list of people is not a source list: at most three", xSourcesIn("@a1 @b2 @c3 @d4 @e5").length === 3);
}

console.log("\nwhich addresses are X posts");
{
  const id = "2112142491898012125";
  check("x.com/<handle>/status/<id>", same(xStatusUrl(`https://x.com/Showdown_TCG/status/${id}`), { handle: "Showdown_TCG", id }));
  check("...twitter.com and mobile, with a query", same(xStatusUrl(`https://mobile.twitter.com/Showdown_TCG/status/${id}?s=20`), { handle: "Showdown_TCG", id }));
  check("the /i/web/status/ form names no account", same(xStatusUrl(`https://x.com/i/web/status/${id}`), { handle: null, id }));
  check("a profile, another site, or a look-alike host is not a post",
    xStatusUrl("https://x.com/Showdown_TCG") === null && xStatusUrl(`https://notx.com/a/status/${id}`) === null && xStatusUrl(`https://x.com.evil.test/a/status/${id}`) === null);
}

const CLOSE = new Date("2026-10-25T18:00:00Z");
const SRC = ["Showdown_TCG"];
const POSTS: Record<string, { text: string; createdAt: string | null; authorHandle: string | null }> = {
  "1001": { text: "GPPoker is our Lucky 13 champion and takes home the $13,000 🏆", createdAt: "2026-10-25T21:04:00.000Z", authorHandle: "Showdown_TCG" },
  "1002": { text: "trust me GPPoker is our Lucky 13 champion", createdAt: "2026-10-25T21:05:00.000Z", authorHandle: "randomguy" },
  "1003": { text: "GPPoker is our Lucky 13 champion and takes home the $13,000 🏆", createdAt: "2026-10-25T17:00:00.000Z", authorHandle: "Showdown_TCG" },
};
let postReads = 0;
let accountReads: Array<{ handle: string; since: string; max: number }> = [];
let accountFails = false;
const reader: XPostReader = {
  async post(id) { postReads++; return POSTS[id] ?? null; },
  async account(handle, since, max) {
    accountReads.push({ handle, since, max });
    if (accountFails) throw new Error("x GET /users -> 503");
    return [{ id: "1001", text: POSTS["1001"].text, createdAt: POSTS["1001"].createdAt }];
  },
};
_setXPostReader(reader);
const cite = (url: string, quote = "GPPoker is our Lucky 13 champion") => ({ url, quote });

console.log("\nan X post is checked through X, and only from an account the rule names");
{
  let a = await auditCitations([cite("https://x.com/Showdown_TCG/status/1001")], CLOSE, { xSources: SRC });
  check("the named account's post, after the close, with the words in it: verified",
    a.verified === 1 && a.citations[0].datedAt === POSTS["1001"].createdAt, `${a.citations[0].status} / ${a.citations[0].note}`);
  check("...and it carries a NO as well as a YES", auditSupports("yes", a).ok && auditSupports("no", a).ok);

  postReads = 0;
  a = await auditCitations([cite("https://x.com/randomguy/status/1002")], CLOSE, { xSources: SRC });
  check("a post by an account the rule does not name is not evidence", a.unreachable === 1 && !auditSupports("yes", a).ok, a.citations[0].note);
  check("...and is not even read, because reading costs money", postReads === 0, String(postReads));

  a = await auditCitations([cite("https://x.com/Showdown_TCG/status/1002")], CLOSE, { xSources: SRC });
  check("a named handle in front of somebody else's post proves nothing: X says who wrote it",
    a.unreachable === 1 && /randomguy/.test(a.citations[0].note), a.citations[0].note);

  a = await auditCitations([cite("https://x.com/i/web/status/1001")], CLOSE, { xSources: SRC });
  check("an address that names no account is judged by the post's real author", a.verified === 1, a.citations[0].note);

  a = await auditCitations([cite("https://x.com/Showdown_TCG/status/1001", "GPPoker finished second in Lucky 13")], CLOSE, { xSources: SRC });
  check("words that are not in the post discard the verdict, as on a page", a.absent === 1 && !auditSupports("yes", a).ok, a.citations[0].note);

  a = await auditCitations([cite("https://x.com/Showdown_TCG/status/1003")], CLOSE, { xSources: SRC });
  check("a post from before the close can carry a YES...", a.stale === 1 && auditSupports("yes", a).ok, a.citations[0].note);
  check("...and never a NO", !auditSupports("no", a).ok, auditSupports("no", a).why);

  a = await auditCitations([cite("https://x.com/Showdown_TCG/status/9999")], CLOSE, { xSources: SRC });
  check("a post that is gone is unreachable, not absent", a.unreachable === 1 && a.absent === 0, a.citations[0].note);

  a = await auditCitations([cite("https://x.com/Showdown_TCG/status/1001")], CLOSE);
  check("with no account named, no X post counts", a.unreachable === 1, a.citations[0].note);

  _setXPostReader({ ...reader, async post() { throw new Error("x GET /tweets -> 429"); } });
  a = await auditCitations([cite("https://x.com/Showdown_TCG/status/1001")], CLOSE, { xSources: SRC });
  check("X not answering is unreachable, never a pass", a.unreachable === 1 && a.verified === 0, a.citations[0].note);
  _setXPostReader(reader);
}

console.log("\nthe named accounts' posts are read for the proposer");
{
  accountReads = [];
  const posts = await xPostsFor(SRC, "2026-10-25T18:00:00.000Z");
  check("from a week before the close, a bounded number",
    accountReads.length === 1 && accountReads[0].handle === "Showdown_TCG" && accountReads[0].since === "2026-10-18T18:00:00.000Z" && accountReads[0].max === 40,
    JSON.stringify(accountReads));
  check("...each with the address the audit will check", posts.length === 1 && posts[0].url === "https://x.com/Showdown_TCG/status/1001");
  accountFails = true;
  check("an account X will not show us is just not there", (await xPostsFor(SRC, null)).length === 0);
  accountFails = false;
}

const proposal = (o: Partial<Proposal> = {}): Proposal =>
  ({ outcome: "yes", confidence: "high", checkable: true, citations: [], reasoning: "test", dropped: 0, ...o });
const RULE = "Resolves YES if GPPoker is announced as the Lucky 13 winner in the official announcement on the @Showdown_TCG X account. Resolves NO if another player is announced as the winner.";
const AFTER = new Date("2026-10-26T12:00:00Z");

console.log("\nend to end: a rule naming @Showdown_TCG settles from its post");
{
  let seen: string[] = [];
  _setProposer(async (m) => {
    seen = (m.xPosts ?? []).map((p) => p.url);
    return proposal({ citations: [cite("https://x.com/Showdown_TCG/status/1001")] });
  });
  _setSecondOpinion(async () => ({ outcome: "yes", why: "" }));
  accountReads = [];
  const d = await decide({ slug: "lucky13-gppoker", question: "Will GPPoker win Lucky 13?", criteria: RULE, closeTime: CLOSE.toISOString() }, AFTER);
  check("it settles YES from the account's own post", d.settle === "yes" && d.gate === "settled", `${d.gate}: ${d.reason}`);
  check("...which the proposer was given, read from X", same(seen, ["https://x.com/Showdown_TCG/status/1001"]), JSON.stringify(seen));

  _setProposer(async () => proposal({ citations: [cite("https://x.com/randomguy/status/1002")] }));
  const spoof = await decide({ slug: "lucky13-gppoker", question: "Will GPPoker win Lucky 13?", criteria: RULE, closeTime: CLOSE.toISOString() }, AFTER);
  check("a YES resting on a stranger's post is refused", spoof.settle === null && spoof.gate === "citations-failed", `${spoof.gate}: ${spoof.reason}`);

  accountReads = [];
  _setProposer(async (m) => { seen = (m.xPosts ?? []).map((p) => p.url); return proposal({ outcome: "undetermined" }); });
  await decide({ slug: "plain", question: "Did Arsenal beat Chelsea?", criteria: "Resolves YES if Arsenal won, per the final score on the Premier League site. NO otherwise.", closeTime: CLOSE.toISOString() }, AFTER);
  check("a rule naming no X account reads nothing from X", accountReads.length === 0 && seen.length === 0, JSON.stringify(accountReads));
}

_setProposer(null);
_setSecondOpinion(null);
_setXPostReader(null);

console.log(failures ? `\n${failures} failure(s)\n` : "\nall green\n");
process.exit(failures ? 1 : 0);
