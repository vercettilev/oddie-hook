// The mention loop's decision tree, offline.
//
// Every dependency that would touch the world (X, Anthropic, Solana) is a fake
// here, which is the whole reason runMentionSweep takes them as arguments. What
// is being pinned is not "does it call X" but the four rules that make an
// autonomous poster safe to leave running:
//
//   1. it never answers the same mention twice, even across a crash
//   2. it never answers itself
//   3. a claim that fails the gate gets silence, not a public refusal
//   4. the watermark advances only over what was actually looked at
//
// Rule 4 is the subtle one and it is why the cap exists at all: taking X's own
// newest_id would permanently skip every mention past the cap, because they are
// older than the new watermark and no later poll would return them.
//
// Against the in-memory store.
//
// Run with: npm run test-x-loop

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database. Unset DATABASE_URL.");
  process.exit(1);
}

import { runMentionSweep, stripLeadingMentions, tweetUrl, SWEEP_CAP } from "../src/x/mentionLoop.js";
import type { SweepDeps, MintResult } from "../src/x/mentionLoop.js";
import { botStateGet, _memMentionOutcome, _resetBotState } from "../src/store/markets.js";
import { SINCE_KEY } from "../src/x/client.js";
import type { Extraction } from "../src/matching/extractClaim.js";
import type { Mention } from "../src/x/client.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

const BOT = "botuser1";

const mention = (id: string, over: Partial<Mention> = {}): Mention => ({
  id,
  text: "@oddiefun price this",
  authorId: "u-someone",
  authorHandle: "someone",
  repliedToId: `parent-${id}`,
  createdAt: null,
  ...over,
});

const goodExtraction = (q: string): Extraction => ({
  question: q,
  resolution_criteria: "Coinbase BTC-USD daily close.",
  close_time: "2027-01-01T00:00:00Z",
  close_time_inferred: false,
  category: "Crypto",
  resolvability: "clean",
  appropriate: true,
  reason: "clean",
  hook: "big if true",
});

interface Spy {
  posted: Array<{ text: string; inReplyTo: string; mediaIds?: string[] }>;
  minted: string[];
  uploads: number;
}

function harness(over: Partial<SweepDeps> = {}): { deps: SweepDeps; spy: Spy } {
  const spy: Spy = { posted: [], minted: [], uploads: 0 };
  const deps: SweepDeps = {
    mentions: async () => ({ items: [], newestId: null }),
    tweet: async (id) => ({ id, text: "Bitcoin will never hit $200k, cope harder.", authorHandle: "cryptonate" }),
    extract: async () => goodExtraction("Will Bitcoin hit $200k before 2027?"),
    openMarket: async (input) => {
      spy.minted.push(input.question);
      return { ok: true, slug: `slug-${spy.minted.length}` } as MintResult;
    },
    cardPng: async () => Buffer.from("png"),
    uploadMedia: async () => { spy.uploads++; return `media-${spy.uploads}`; },
    postReply: async (o) => { spy.posted.push(o); return { id: `reply-${spy.posted.length}` }; },
    baseUrl: "https://oddie.fun",
    botUserId: BOT,
    dryRun: false,
    // These tests exercise the REAL posting path, so they assert the ledger is
    // durable. The guard that enforces it for real is checked on its own below.
    durable: true,
    ...over,
  };
  return { deps, spy };
}

async function main() {
  console.log("\nX mention loop\n");

  /* ------------------------------------------------------- the happy path -- */
  {
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("100")], newestId: "100" }),
    });
    const r = await runMentionSweep(deps);
    check("a tagged claim becomes one market and one reply", r.replied === 1 && spy.minted.length === 1 && spy.posted.length === 1);
    check("the reply carries the market's permalink", spy.posted[0]?.text.includes("https://oddie.fun/m/slug-1"),
      spy.posted[0]?.text);
    check("the reply carries the card", spy.posted[0]?.mediaIds?.length === 1);
    check("the ledger records it as replied", _memMentionOutcome("100") === "replied");
    check("the watermark advanced to the tweet it handled", (await botStateGet(SINCE_KEY)) === "100");
  }

  /* ---------------------------------------------- the claim is the PARENT -- */
  {
    _resetBotState();
    const seen: string[] = [];
    const { deps } = harness({
      mentions: async () => ({ items: [mention("200")], newestId: "200" }),
      extract: async (text) => { seen.push(text); return goodExtraction("Will Bitcoin hit $200k before 2027?"); },
    });
    await runMentionSweep(deps);
    check("it grades the tweet being replied to, not the word @oddiefun",
      seen[0] === "Bitcoin will never hit $200k, cope harder.", seen[0]);
  }

  /* ------------------------- provenance follows the claim, not the tagger -- */
  {
    _resetBotState();
    let sourceUrl = "";
    const { deps } = harness({
      mentions: async () => ({ items: [mention("210")], newestId: "210" }),
      openMarket: async (i) => { sourceUrl = i.sourceUrl; return { ok: true, slug: "s" }; },
    });
    await runMentionSweep(deps);
    check("the 3% points at whoever made the claim, not whoever tagged it",
      sourceUrl === "https://x.com/cryptonate/status/parent-210", sourceUrl);
  }

  /* ------------------------------------------------------ never answers itself -- */
  {
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("300", { authorId: BOT, authorHandle: "oddiefun" })], newestId: "300" }),
    });
    const r = await runMentionSweep(deps);
    check("its own reply coming back as a mention is skipped", r.skipped === 1 && spy.posted.length === 0);
    check("...and recorded, so it is not reconsidered", _memMentionOutcome("300") === "skipped");
  }

  /* ---------------------------------------------------------- exactly once -- */
  {
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("400")], newestId: "400" }),
    });
    await runMentionSweep(deps);
    // The same mention served again, which is what X does around a window
    // boundary and what a lost watermark guarantees.
    const r2 = await runMentionSweep(deps);
    check("the same mention served twice produces one reply, not two",
      spy.posted.length === 1 && r2.replied === 0, `posted=${spy.posted.length}`);
  }

  /* ------------------------------ a crash after claiming does not re-post -- */
  {
    _resetBotState();
    let attempt = 0;
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("500")], newestId: "500" }),
      openMarket: async () => {
        attempt++;
        if (attempt === 1) throw new Error("solana unreachable");
        return { ok: true, slug: "later" };
      },
    });
    await runMentionSweep(deps);
    const r2 = await runMentionSweep(deps);
    check("a failure is not retried into a duplicate reply on the next sweep",
      spy.posted.length === 0 && r2.replied === 0, `posted=${spy.posted.length}`);
    check("the failure is recorded as such", _memMentionOutcome("500") === "failed");
  }

  /* --------------------------------------------------- the gate is silent -- */
  {
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("600")], newestId: "600" }),
      extract: async () => ({ ...goodExtraction(""), resolvability: "unresolvable", question: "", reason: "vibes" }),
    });
    const r = await runMentionSweep(deps);
    check("an unresolvable claim gets no market", r.skipped === 1 && spy.minted.length === 0);
    check("...and no public refusal under someone's post", spy.posted.length === 0);
  }
  {
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("610")], newestId: "610" }),
      extract: async () => ({ ...goodExtraction("Will X be fired?"), appropriate: false }),
    });
    await runMentionSweep(deps);
    check("a resolvable but inappropriate claim is refused too", spy.minted.length === 0 && spy.posted.length === 0);
  }

  /* ------------------------------------------- a mint failure costs no reply */
  {
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("700")], newestId: "700" }),
      openMarket: async () => ({ ok: false, status: 502, error: "no vault" }),
    });
    const r = await runMentionSweep(deps);
    check("a market that could not be minted is never advertised", r.failed === 1 && spy.posted.length === 0);
  }

  /* ------------------------------------- a card failure still gets a reply -- */
  {
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("800")], newestId: "800" }),
      cardPng: async () => { throw new Error("render died"); },
    });
    const r = await runMentionSweep(deps);
    check("a broken card degrades to a text reply rather than losing it",
      r.replied === 1 && spy.posted.length === 1 && !spy.posted[0].mediaIds);
  }

  /* ------------------------------------------------- the cap and watermark -- */
  {
    _resetBotState();
    const many = Array.from({ length: SWEEP_CAP + 3 }, (_, i) => mention(String(900 + i)));
    const { deps, spy } = harness({
      // X returns newest first; the loop must not inherit that order.
      mentions: async () => ({ items: [...many].reverse(), newestId: String(900 + many.length - 1) }),
    });
    const r = await runMentionSweep(deps);
    check(`one sweep acts on at most ${SWEEP_CAP} mentions`, r.replied === SWEEP_CAP, `replied=${r.replied}`);
    check("it answers oldest first", spy.posted.length > 1 && spy.posted[0].inReplyTo === "900");
    const mark = await botStateGet(SINCE_KEY);
    check("the watermark stops at the last one LOOKED AT, not X's newest",
      mark === String(900 + SWEEP_CAP - 1), `mark=${mark}`);

    // The proof that matters: the ones past the cap are still reachable.
    const r2 = await runMentionSweep({
      ...deps,
      mentions: async (since) => ({
        items: many.filter((m) => !since || m.id > since).reverse(),
        newestId: String(900 + many.length - 1),
      }),
    });
    check("the mentions past the cap are picked up by the next sweep, not lost",
      r2.replied === 3, `second sweep replied=${r2.replied}`);
  }

  /* --------------------------------------------------------------- dry run -- */
  {
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("1000")], newestId: "1000" }),
      dryRun: true,
    });
    const r = await runMentionSweep(deps);
    check("dry run posts nothing", spy.posted.length === 0 && spy.uploads === 0);
    check("dry run still shows the exact text it would have posted",
      Boolean(r.decisions[0]?.text?.includes("https://oddie.fun/m/")), r.decisions[0]?.text);
    check("dry run marks the mention decided, so a later real run does not repost it",
      _memMentionOutcome("1000") === "skipped");
  }

  /* ---------------------------------------------------- a bare mention ----- */
  {
    _resetBotState();
    let graded = "";
    const { deps } = harness({
      mentions: async () => ({
        items: [mention("1100", { repliedToId: null, text: "@oddiefun @someone will the Fed cut rates in March?" })],
        newestId: "1100",
      }),
      extract: async (t) => { graded = t; return goodExtraction("Will the Fed cut in March 2027?"); },
    });
    await runMentionSweep(deps);
    check("a mention with no parent is graded on its own text, minus the handles",
      graded === "will the Fed cut rates in March?", graded);
  }
  {
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("1200", { repliedToId: null, text: "@oddiefun" })], newestId: "1200" }),
    });
    const r = await runMentionSweep(deps);
    check("a bare @oddiefun with nothing to price is skipped, not guessed at",
      r.skipped === 1 && spy.minted.length === 0);
  }

  /* -------------------------------------- the guard on an ephemeral ledger -- */
  {
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("1300")], newestId: "1300" }),
      durable: false,
    });
    let threw = "";
    await runMentionSweep(deps).catch((e) => { threw = (e as Error).message; });
    check("it refuses to post at all when the once-only ledger is in memory",
      threw.includes("DATABASE_URL") && spy.posted.length === 0, threw || "did not throw");
  }
  {
    _resetBotState();
    const { deps } = harness({
      mentions: async () => ({ items: [mention("1310")], newestId: "1310" }),
      durable: false, dryRun: true,
    });
    const r = await runMentionSweep(deps);
    check("...but a dry run is still allowed there, which is what local dev is",
      r.looked === 1 && r.decisions[0]?.reason === "dry-run");
  }

  /* --------------------------------------------------------------- helpers -- */
  check("stripLeadingMentions only takes handles off the FRONT",
    stripLeadingMentions("@a @b real text @c") === "real text @c");
  check("tweetUrl falls back to the handle-free form",
    tweetUrl(null, "42") === "https://x.com/i/web/status/42");

  console.log(failures ? `\n${failures} check(s) failed.\n` : "\nall X loop checks passed.\n");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
