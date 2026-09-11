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

import { readFileSync } from "node:fs";
import { runMentionSweep, stripLeadingMentions, stripBotHandle, tweetUrl, SWEEP_CAP, TEACH_CAP } from "../src/x/mentionLoop.js";
import type { SweepDeps, MintResult } from "../src/x/mentionLoop.js";
import { botStateGet, _memMentionOutcome, _memMentionReason, _resetBotState } from "../src/store/markets.js";
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
  /** Who each mint was told OPENED the market. The 2% follows this. */
  taggers: Array<string | null>;
  uploads: number;
}

function harness(over: Partial<SweepDeps> = {}): { deps: SweepDeps; spy: Spy } {
  const spy: Spy = { posted: [], minted: [], taggers: [], uploads: 0 };
  const deps: SweepDeps = {
    mentions: async () => ({ items: [], newestId: null }),
    tweet: async (id) => ({ id, text: "Bitcoin will never hit $200k, cope harder.", authorHandle: "cryptonate" }),
    extract: async () => goodExtraction("Will Bitcoin hit $200k before 2027?"),
    openMarket: async (input) => {
      spy.minted.push(input.question);
      spy.taggers.push(input.taggerHandle);
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

  /* ------------------------------------ where it threw is the whole question */
  {
    // BEFORE we hand X anything, a throw is the world failing and the claim
    // deserves another go. This used to be swallowed: one bad minute on Solana
    // and a perfectly good take was decided "failed" forever, with nobody told.
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
    const r1 = await runMentionSweep(deps);
    check("a crash before any post leaves the tag for the next sweep",
      r1.retried === 1 && spy.posted.length === 0, JSON.stringify(r1.decisions));
    check("...and the watermark does not step over it",
      (await botStateGet(SINCE_KEY)) === null, String(await botStateGet(SINCE_KEY)));
    const r2 = await runMentionSweep(deps);
    check("...and the next sweep lands it, exactly once",
      r2.replied === 1 && spy.posted.length === 1, `posted=${spy.posted.length}`);
  }
  {
    // AFTER we hand X a reply it is terminal and stays terminal. postReply
    // throwing does NOT prove the post did not land - a timeout on a successful
    // write throws exactly the same way - and double-posting is the one failure
    // this file treats as unrecoverable.
    _resetBotState();
    let attempts = 0;
    const { deps } = harness({
      mentions: async () => ({ items: [mention("505")], newestId: "505" }),
      postReply: async () => { attempts++; throw new Error("X 504 gateway timeout"); },
    });
    const r1 = await runMentionSweep(deps);
    const r2 = await runMentionSweep(deps);
    check("a post that may have landed is never sent again",
      r1.failed === 1 && r2.replied === 0 && attempts === 1, `attempts=${attempts}`);
    check("...and is recorded as failed, not as a retry", _memMentionOutcome("505") === "failed");
  }
  {
    // A claim that fails the same way three times is not going to work on the
    // fourth, and an unbounded retry pins the watermark and stops the bot dead.
    _resetBotState();
    let calls = 0;
    const { deps } = harness({
      mentions: async () => ({ items: [mention("506")], newestId: "506" }),
      openMarket: async () => { calls++; throw new Error("solana unreachable"); },
    });
    for (let i = 0; i < 6; i++) await runMentionSweep(deps);
    check("a tag that keeps failing is given up on after three goes", calls === 3, `calls=${calls}`);
    check("...and the watermark is released so the bot is not stuck",
      (await botStateGet(SINCE_KEY)) === "506", String(await botStateGet(SINCE_KEY)));
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

  /* --------------------------------- a reply costs a tag, silence is free -- */
  // ONE COUNTER, and it is the ticket book. There used to be two that
  // disagreed: the reply stopped at two per handle while the charge ran to
  // five, so tags three, four and five were taken after we had gone quiet -
  // the exact thing this loop refuses to do to an inappropriate tag, done to a
  // spammer instead.
  {
    _resetBotState();
    const spent: string[] = [];
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("700")], newestId: "700" }),
      extract: async () => ({ ...goodExtraction(""), resolvability: "unresolvable", question: "", reason: "vibes" }),
      teachPng: async () => Buffer.from("teach"),
      ticketsLeft: async () => 5,
      spendMiss: async (id) => { spent.push(id); return { spent: true, left: 4 }; },
    });
    await runMentionSweep(deps);
    check("a miss we answered costs a tag", spent.length === 1 && spent[0] === "700", spent.join(","));
    check("...and the reply says what it left them", 
      Boolean(spy.posted[0]?.text.includes("4 tags left")), spy.posted[0]?.text);
  }
  {
    // THE RULE, as a test. The card carries the entire lesson, so an upload
    // failure ends in silence - and silence is free however much it cost us to
    // arrive at it.
    _resetBotState();
    const spent: string[] = [];
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("710")], newestId: "710" }),
      extract: async () => ({ ...goodExtraction(""), resolvability: "unresolvable", question: "", reason: "vibes" }),
      teachPng: async () => Buffer.from("teach"),
      ticketsLeft: async () => 5,
      uploadMedia: async () => { throw new Error("403 media.write missing"); },
      spendMiss: async (id) => { spent.push(id); return { spent: true, left: 4 }; },
    });
    await runMentionSweep(deps);
    check("a miss we stayed silent on costs nothing",
      spent.length === 0 && spy.posted.length === 0, spent.join(","));
  }
  {
    // A refusal on content is not a mistake they can fix, we never explain it,
    // and a silent charge for a judgement we will not defend is unfair.
    _resetBotState();
    const spent: string[] = [];
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("720")], newestId: "720" }),
      extract: async () => ({ ...goodExtraction("Will X be fired?"), appropriate: false }),
      teachPng: async () => Buffer.from("teach"),
      ticketsLeft: async () => 5,
      spendMiss: async (id) => { spent.push(id); return { spent: true, left: 4 }; },
    });
    await runMentionSweep(deps);
    check("an inappropriate tag is never charged", spent.length === 0, spent.join(","));
    check("...and never answered", spy.posted.length === 0);
  }
  {
    // A dry run changes nothing in the world, and a ticket is part of the world.
    _resetBotState();
    const spent: string[] = [];
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("725")], newestId: "725" }),
      extract: async () => ({ ...goodExtraction(""), resolvability: "unresolvable", question: "", reason: "vibes" }),
      teachPng: async () => Buffer.from("teach"),
      ticketsLeft: async () => 5,
      spendMiss: async (id) => { spent.push(id); return { spent: true, left: 4 }; },
      dryRun: true,
    });
    await runMentionSweep(deps);
    check("a dry run charges no tag", spent.length === 0 && spy.posted.length === 0, spent.join(","));
  }
  {
    // THE FIFTH ONE STILL GETS ITS ANSWER, and it says so. After it the gate at
    // the top of the sweep drops every tag before anything reads it, so this is
    // the only moment the silence that follows can still be explained.
    _resetBotState();
    const spent: string[] = [];
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("730")], newestId: "730" }),
      extract: async () => ({ ...goodExtraction(""), resolvability: "unresolvable", question: "", reason: "vibes" }),
      teachPng: async () => Buffer.from("teach"),
      ticketsLeft: async () => 1,
      spendMiss: async (id) => { spent.push(id); return { spent: true, left: 0 }; },
    });
    await runMentionSweep(deps);
    check("the last tag is answered, not swallowed by a cap", spy.posted.length === 1 && spent.length === 1);
    check("...and says so instead of printing a zero",
      Boolean(spy.posted[0]?.text.includes("that was your last tag")), spy.posted[0]?.text);
  }
  {
    // And the sixth costs nothing, because nothing is read: the gate is the
    // first thing in the item, above the parent read and the model call.
    _resetBotState();
    const spent: string[] = [];
    let extracted = 0;
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("735")], newestId: "735" }),
      extract: async () => { extracted++; return { ...goodExtraction(""), resolvability: "unresolvable", question: "", reason: "vibes" }; },
      teachPng: async () => Buffer.from("teach"),
      ticketsLeft: async () => 0,
      spendMiss: async (id) => { spent.push(id); return { spent: true, left: 0 }; },
    });
    await runMentionSweep(deps);
    check("an empty ticket book is silent, free, and pays for no extraction",
      spy.posted.length === 0 && spent.length === 0 && extracted === 0);
  }
  {
    // The cap that is left: a caller with no season wired has no balance to
    // count down, and something still has to stop us posting under strangers'
    // tweets forever.
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("745")], newestId: "745" }),
      extract: async () => ({ ...goodExtraction(""), resolvability: "unresolvable", question: "", reason: "vibes" }),
      teachPng: async () => Buffer.from("teach"),
      refusalsUsed: async () => TEACH_CAP,
    });
    await runMentionSweep(deps);
    check("with no ticket book the old cap still stops us", spy.posted.length === 0);
  }

  /* ------------------------------ the good news says what it cost, too ----- */
  {
    // The tag was charged either way. A reply that spends somebody's ticket and
    // never mentions it is silent charging with a market attached.
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("760")], newestId: "760" }),
      ticketsLeft: async () => 5,
      spendTicket: async () => true,
    });
    await runMentionSweep(deps);
    check("a market that opened says what the tag left them",
      Boolean(spy.posted[0]?.text.includes("you have 4 tags left")), spy.posted[0]?.text);
  }
  {
    // The one surface where the refund rule is an instruction rather than
    // documentation, and it rides only where it is urgent.
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("761")], newestId: "761" }),
      ticketsLeft: async () => 1,
      spendTicket: async () => true,
    });
    await runMentionSweep(deps);
    check("the last tag is told how to get it back",
      Boolean(spy.posted[0]?.text.includes("one new bettor here brings it back")), spy.posted[0]?.text);
  }
  {
    // Nothing is charged for a reply that never went out, on this branch either.
    // The market stands; it is theirs and it is on their profile. What it is
    // not is announced, and charging for our own failure to announce it is the
    // same fault the miss branch just had removed.
    _resetBotState();
    const spends: string[] = [];
    const { deps } = harness({
      mentions: async () => ({ items: [mention("762")], newestId: "762" }),
      ticketsLeft: async () => 5,
      spendTicket: async (slug) => { spends.push(slug); return true; },
      postReply: async () => { throw new Error("X 503"); },
    });
    await runMentionSweep(deps);
    check("a market minted but never announced costs no ticket", spends.length === 0, spends.join(","));
  }
  {
    // No season, no number: a sentence about somebody's remaining chances has
    // to be true or it must not be said.
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("763")], newestId: "763" }),
    });
    await runMentionSweep(deps);
    check("with no ticket book the reply names no count",
      !/tags? left/.test(spy.posted[0]?.text ?? ""), spy.posted[0]?.text);
  }

  /* --------------------------- one answer per person per market ------------ */
  {
    // The branch that answers the second, third and fortieth person to tag one
    // post stays free - they opened nothing and taxing the behaviour we want is
    // absurd. What it stopped being is unbounded: the SAME handle tagging the
    // same post ten times got ten near-identical replies out of us, which is
    // the shape X's automation policy is written about.
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("770")], newestId: "770" }),
      existingMarket: async () => ({ slug: "already-open", question: "Will it?" }),
      alreadyTold: async () => true,
    });
    const r = await runMentionSweep(deps);
    check("tagging the same post twice gets one answer, not two",
      spy.posted.length === 0 && r.decisions[0]?.reason === "already-told", JSON.stringify(r.decisions));
  }
  {
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("771")], newestId: "771" }),
      existingMarket: async () => ({ slug: "already-open", question: "Will it?" }),
      alreadyTold: async () => false,
    });
    await runMentionSweep(deps);
    check("...but somebody new tagging it still gets one", spy.posted.length === 1);
  }
  {
    // A lookup failure must not silence a legitimate answer.
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("772")], newestId: "772" }),
      existingMarket: async () => ({ slug: "already-open", question: "Will it?" }),
      alreadyTold: async () => { throw new Error("db down"); },
    });
    await runMentionSweep(deps);
    check("a failed dedup lookup falls through to answering", spy.posted.length === 1);
  }

  /* -------------------------------------------------- the gate teaches once */
  // The gate stays silent above because those harnesses carry no teachPng, which
  // IS the contract: teaching is opt-in and its absence must behave exactly as
  // the loop did before it existed. With the card wired, the same tag answers.
  {
    _resetBotState();
    let taught = 0;
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("620")], newestId: "620" }),
      extract: async () => ({ ...goodExtraction(""), resolvability: "unresolvable", question: "", reason: "vibes" }),
      teachPng: async () => { taught++; return Buffer.from("teach"); },
      refusalsUsed: async () => 0,
    });
    const r = await runMentionSweep(deps);
    check("an unmarketable tag gets a reply instead of silence", spy.posted.length === 1 && r.skipped === 1);
    check("...and still no market", spy.minted.length === 0);
    check("...with the teaching card attached", taught === 1 && spy.posted[0]?.mediaIds?.length === 1);
    check("...and NO link, because there is nothing to link to",
      !/https?:\/\//.test(spy.posted[0]?.text ?? "x"), spy.posted[0]?.text);
    check("...recorded under a reason the cap can count",
      String(_memMentionReason("620")).startsWith("taught"), _memMentionReason("620") ?? "");
  }
  {
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("630")], newestId: "630" }),
      extract: async () => ({ ...goodExtraction(""), resolvability: "unresolvable", question: "", reason: "vibes" }),
      teachPng: async () => Buffer.from("teach"),
      refusalsUsed: async () => TEACH_CAP,
    });
    await runMentionSweep(deps);
    check("a handle already taught its fill hears nothing further", spy.posted.length === 0);
  }
  {
    // The one refusal that is never taught: there is no version of a public
    // reply under a post we refused on content grounds that does not read as
    // oddie commenting on it.
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("640")], newestId: "640" }),
      extract: async () => ({ ...goodExtraction("Will X be fired?"), appropriate: false }),
      teachPng: async () => Buffer.from("teach"),
      refusalsUsed: async () => 0,
    });
    await runMentionSweep(deps);
    check("an inappropriate tag stays silent even with the card wired", spy.posted.length === 0);
  }
  {
    // The card carries the entire lesson now that the text is one sentence, so
    // a reply without it is a bare public "no" - the exact post this branch was
    // written to avoid. An upload failure has to end in silence, not in text.
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("660")], newestId: "660" }),
      extract: async () => ({ ...goodExtraction(""), resolvability: "unresolvable", question: "", reason: "vibes" }),
      teachPng: async () => Buffer.from("teach"),
      refusalsUsed: async () => 0,
      uploadMedia: async () => { throw new Error("403 media.write missing"); },
    });
    await runMentionSweep(deps);
    check("a card that will not upload sends nothing at all", spy.posted.length === 0);
  }
  {
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("650")], newestId: "650" }),
      extract: async () => ({ ...goodExtraction(""), resolvability: "unresolvable", question: "", reason: "vibes" }),
      teachPng: async () => Buffer.from("teach"),
      refusalsUsed: async () => 0,
      dryRun: true,
    });
    const r = await runMentionSweep(deps);
    check("a dry run composes the teaching without posting it",
      spy.posted.length === 0 && !!r.decisions[0]?.text, r.decisions[0]?.text);
  }

  /* ------------------------------------------- a mint failure costs no reply */
  {
    // Nothing was posted, provably, so picking it back up cannot double-post -
    // and what was lost was a real market on a claim we had already paid to
    // read. Silence was right; terminal was not.
    _resetBotState();
    let tries = 0;
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("707")], newestId: "707" }),
      openMarket: async () => {
        tries++;
        return tries === 1 ? { ok: false, status: 502, error: "no vault" } : { ok: true, slug: "second-go" };
      },
    });
    const r = await runMentionSweep(deps);
    check("a market that could not be minted is never advertised",
      r.retried === 1 && spy.posted.length === 0, JSON.stringify(r.decisions));
    const r2 = await runMentionSweep(deps);
    check("...and is tried again rather than dropped on the floor",
      r2.replied === 1 && tries === 2, JSON.stringify(r2.decisions));
  }
  {
    // A media upload that 403'd once used to cost somebody an answer for good.
    // A renderer is the world, not a verdict on their claim.
    _resetBotState();
    let uploads = 0;
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("708")], newestId: "708" }),
      extract: async () => ({ ...goodExtraction(""), resolvability: "unresolvable", question: "", reason: "vibes" }),
      teachPng: async () => Buffer.from("teach"),
      refusalsUsed: async () => 0,
      uploadMedia: async () => { uploads++; if (uploads === 1) throw new Error("403 media.write"); return "media-1"; },
    });
    const r = await runMentionSweep(deps);
    check("a teach card that would not upload leaves the tag for next time",
      r.retried === 1 && spy.posted.length === 0, JSON.stringify(r.decisions));
    const r2 = await runMentionSweep(deps);
    check("...and the lesson lands on the second go", spy.posted.length === 1, JSON.stringify(r2.decisions));
  }

  /* ------------------------- the claim can be in the mention, not the parent */
  {
    // A post can be an image, a chart, or four words. The parent branch used to
    // take its text unconditionally and throw the mention's own away, so a
    // perfectly marketable sentence sitting right there in the tweet we were
    // reading was dropped because of WHERE it was written.
    _resetBotState();
    let graded = "";
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("1400", { text: "@oddiefun will this ship before June 2027?" })], newestId: "1400" }),
      tweet: async (id) => ({ id, text: "lmao", authorHandle: "someoneelse" }),
      extract: async (t) => { graded = t; return goodExtraction("Will it ship before June 2027?"); },
    });
    await runMentionSweep(deps);
    check("a textless parent falls back to the sentence in the tag itself",
      graded === "will this ship before June 2027?", graded);
    check("...and it opens a market instead of being dropped", spy.minted.length === 1);
  }
  {
    // The fallback must never displace a real take with "@oddiefun price this".
    _resetBotState();
    let graded = "";
    const { deps } = harness({
      mentions: async () => ({ items: [mention("1401")], newestId: "1401" }),
      extract: async (t) => { graded = t; return goodExtraction("Will Bitcoin hit $200k before 2027?"); },
    });
    await runMentionSweep(deps);
    check("a parent with a real take is still what gets graded",
      graded === "Bitcoin will never hit $200k, cope harder.", graded);
  }
  {
    // The likeliest first tag a newcomer ever sends, and the one we answered
    // least: a bare @oddiefun under a picture. It costs no model call, so this
    // is the cheapest reply in the product.
    _resetBotState();
    let extracted = 0;
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("1402", { repliedToId: null, text: "@oddiefun" })], newestId: "1402" }),
      extract: async () => { extracted++; return goodExtraction("x"); },
      teachPng: async () => Buffer.from("teach"),
      ticketsLeft: async () => 5,
    });
    await runMentionSweep(deps);
    check("a tag with nothing to price is taught, not ignored",
      spy.posted.length === 1 && Boolean(spy.posted[0]?.mediaIds?.length), spy.posted[0]?.text);
    check("...without paying for an extraction to find that out", extracted === 0);
    check("...and it counts down like any other answer",
      Boolean(spy.posted[0]?.text.includes("4 tags left")), spy.posted[0]?.text);
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
    // The one that was missing, and it cost a rent deposit and a season ticket
    // every time a tag arrived: a dry run must not change the world either. A
    // minted market is real, stakeable and listed, and the tagger who paid for
    // it is never told it exists, because the reply is the part being suppressed.
    check("dry run mints NOTHING", spy.minted.length === 0, spy.minted.join(" | "));
    check("...and spends no ticket", spy.taggers.length === 0);
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

  /* ------------------------------------------------- one post, one market -- */
  {
    // Several people tagging the SAME hot take is the expected case, not an
    // edge one: it is the distribution model. Each used to mint its own market,
    // which is a second rent deposit out of our own wallet, a second extraction
    // call, and one question with its pool split across two pari-mutuel
    // markets. Two thin markets are not one good market.
    _resetBotState();
    let extracted = 0;
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("400")], newestId: "400" }),
      extract: async () => { extracted++; return goodExtraction("Will Bitcoin hit $200k before 2027?"); },
      existingMarket: async () => ({ slug: "already-open", question: "Will Bitcoin hit $200k before 2027?" }),
    });
    const r = await runMentionSweep(deps);
    check("no second market is minted for a post that has one", spy.minted.length === 0, JSON.stringify(spy.minted));
    // The check is a database lookup and it runs BEFORE the model, so knowing
    // we already answered this post costs nothing.
    check("...and no extraction is spent finding that out", extracted === 0, String(extracted));
    check("the person who tagged still gets an answer", r.replied === 1, JSON.stringify(r.decisions));
    check("...pointing at the market that already exists", r.decisions[0]?.slug === "already-open");
    check("...with that permalink in the reply", (spy.posted[0]?.text ?? "").includes("/m/already-open"), spy.posted[0]?.text);
    check("...and the card still goes with it", spy.posted[0]?.mediaIds?.length === 1);
  }
  {
    // The guard must not swallow a genuinely new post.
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("401")], newestId: "401" }),
      existingMarket: async () => null,
    });
    const r = await runMentionSweep(deps);
    check("a post with no market still mints one", spy.minted.length === 1 && r.replied === 1);
  }
  {
    // A lookup failure must fall through to minting: a database blip must not
    // silently stop answering mentions.
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("402")], newestId: "402" }),
      existingMarket: async () => { throw new Error("db down"); },
    });
    await runMentionSweep(deps);
    check("a failed lookup falls through to minting", spy.minted.length === 1);
  }

  /* ------------------------------------------------------ genesis tickets -- */
  {
    // OUT OF TICKETS. The gate must fire BEFORE the model call and before the
    // mint: an exhausted tagger costs neither an opus call nor a rent deposit.
    _resetBotState();
    let extracted = 0;
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("500")], newestId: "500" }),
      extract: async () => { extracted++; return goodExtraction("Will it?"); },
      ticketsLeft: async () => 0,
    });
    const r = await runMentionSweep(deps);
    check("an empty ticket book mints nothing", spy.minted.length === 0 && r.skipped === 1);
    check("and does not pay for an extraction first", extracted === 0);
    check("recorded as no-tickets, not as a failure",
      r.decisions[0]?.reason === "no-tickets" && r.failed === 0);
  }
  {
    // The spend is charged with the TAGGER and the CLAIM's author, in that
    // order: the person who tagged pays, the person quoted does not.
    _resetBotState();
    const spends: Array<[string, string, string | null]> = [];
    const { deps } = harness({
      mentions: async () => ({ items: [mention("501", { authorHandle: "tagger1" })], newestId: "501" }),
      ticketsLeft: async () => 3,
      spendTicket: async (slug, tagger, source) => { spends.push([slug, tagger, source]); return true; },
    });
    await runMentionSweep(deps);
    check("a minted market charges the tagger, naming the claim's author",
      spends.length === 1 && spends[0][1] === "tagger1" && spends[0][2] === "cryptonate", JSON.stringify(spends));
  }
  {
    // A market that already exists is a reply, not a new market, so it is free.
    _resetBotState();
    const spends: string[] = [];
    const { deps } = harness({
      mentions: async () => ({ items: [mention("502")], newestId: "502" }),
      existingMarket: async () => ({ slug: "already", question: "Will it?" }),
      ticketsLeft: async () => 3,
      spendTicket: async (slug) => { spends.push(slug); return true; },
    });
    await runMentionSweep(deps);
    check("joining a market somebody else opened costs no ticket", spends.length === 0);
  }
  {
    // The season must never be able to break the bot: a ledger that throws
    // leaves the market minted and the reply posted.
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("503")], newestId: "503" }),
      ticketsLeft: async () => { throw new Error("ledger down"); },
      spendTicket: async () => { throw new Error("ledger down"); },
    });
    const r = await runMentionSweep(deps);
    check("a broken ledger still mints and still replies",
      spy.minted.length === 1 && spy.posted.length === 1 && r.replied === 1);
  }

  {
    // THE MONEY. Lev's rule: the 2% goes to whoever OPENED the market. On a
    // reply-tag that is the tagger, never the author of the claim being
    // priced, and the mint has to be TOLD which is which.
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("800", { authorHandle: "tagger1" })], newestId: "800" }),
      // parent (the claim) is by somebody else entirely
      tweet: async (id) => ({ id, text: "Bitcoin will never hit $200k, cope harder.", authorHandle: "cryptonate" }),
    });
    await runMentionSweep(deps);
    check("the mint is told the TAGGER opened it, not the claim's author",
      spy.taggers.length === 1 && spy.taggers[0] === "tagger1", JSON.stringify(spy.taggers));
  }
  {
    // Standalone: tagger and claim author are the same person, and the answer
    // is still the tagger.
    _resetBotState();
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("801", { repliedToId: null, authorHandle: "solo1",
        text: "GTA 6 ships before 2027 @oddiefun" })], newestId: "801" }),
      tweet: async () => { throw new Error("no parent"); },
    });
    await runMentionSweep(deps);
    check("a standalone tag names its own author as the opener",
      spy.taggers[0] === "solo1", JSON.stringify(spy.taggers));
  }

  /* --------------------------------------- tag without a reply (standalone) -- */
  {
    // A TAG DOES NOT HAVE TO BE A REPLY. With no parent the person's own post
    // is the claim, and the tag usually sits at the END of it.
    _resetBotState();
    let graded = "";
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("600", {
        repliedToId: null,
        text: "GTA 6 comes out before 2027, what do you say @oddiefun",
      })], newestId: "600" }),
      tweet: async () => { throw new Error("no parent should ever be fetched"); },
      extract: async (t) => { graded = t; return goodExtraction("Will GTA 6 ship before 2027?"); },
    });
    const r = await runMentionSweep(deps);
    check("a standalone tagged post still opens a market", spy.minted.length === 1 && r.replied === 1);
    check("and our own handle is not graded as part of the claim",
      graded === "GTA 6 comes out before 2027, what do you say", JSON.stringify(graded));
  }

  {
    // The composer prefill "On the record @oddiefun: <claim>" must grade as
    // the claim: not a leading mention (so no strip), our handle removed
    // mid-sentence, preamble left for the extractor to see through.
    _resetBotState();
    let graded = "";
    const { deps, spy } = harness({
      mentions: async () => ({ items: [mention("700", {
        repliedToId: null,
        text: "On the record @oddiefun: GTA 6 ships before 2027.",
      })], newestId: "700" }),
      tweet: async () => { throw new Error("no parent should be fetched"); },
      extract: async (t) => { graded = t; return goodExtraction("Will GTA 6 ship before 2027?"); },
    });
    const r = await runMentionSweep(deps);
    check("the composer prefill shape mints a market", spy.minted.length === 1 && r.replied === 1);
    check("with our handle out and the claim intact",
      graded === "On the record : GTA 6 ships before 2027.", JSON.stringify(graded));
  }

  /* ------------------------------------------------- the wire, statically -- */
  // Both of these were wrong for the whole life of the bot and neither could be
  // caught by a test that fakes the X client: the endpoint was retired in June
  // 2025 and the grant never asked for the scope that endpoint needs. Read off
  // the source, because that is where the mistake lives.
  {
    const client = readFileSync("src/x/client.ts", "utf8");
    // Matched on the CONSTANT, not on the file: the comment above it names the
    // retired host on purpose, so that a future reader knows what this replaced.
    const uploadUrl = client.match(/const UPLOAD_URL = "([^"]+)"/)?.[1] ?? "";
    check("media uploads go to the v2 endpoint, not the sunset v1.1 one",
      uploadUrl === "https://api.x.com/2/media/upload", uploadUrl);
    check("...and declare a media_category, which v2 rejects the request without",
      /media_category/.test(client));
    const authz = readFileSync("scripts/x-authorize.ts", "utf8");
    check("the OAuth grant asks for media.write, or no card can ever attach",
      /SCOPES = "[^"]*\bmedia\.write\b/.test(authz));
  }

  /* --------------------------------------------------------------- helpers -- */
  check("stripBotHandle takes our handle out wherever it sits",
    stripBotHandle("GTA before 2027 @oddiefun what do you say", "oddiefun") === "GTA before 2027 what do you say");
  check("stripBotHandle leaves somebody else's handle alone, even at the end",
    stripBotHandle("the next CEO will be @jack", "oddiefun") === "the next CEO will be @jack");
  check("stripBotHandle does not eat a longer handle that starts the same way",
    stripBotHandle("ask @oddiefunny about it", "oddiefun") === "ask @oddiefunny about it");
  check("stripLeadingMentions only takes handles off the FRONT",
    stripLeadingMentions("@a @b real text @c") === "real text @c");
  check("tweetUrl falls back to the handle-free form",
    tweetUrl(null, "42") === "https://x.com/i/web/status/42");

  console.log(failures ? `\n${failures} check(s) failed.\n` : "\nall X loop checks passed.\n");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
