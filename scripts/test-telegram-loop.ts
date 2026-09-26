// oddie in Telegram groups. These pin the rules that were each paid for on X,
// plus the one Telegram adds: an offset that has moved past an update means
// Telegram will never send it again.
import type { Extraction } from "../src/matching/extractClaim.js";
import type { MintResult } from "../src/x/mentionLoop.js";
import type { TgMessage, TgUpdate } from "../src/telegram/client.js";
import {
  runTelegramSweep, tagsBot, stripBotTag, messageLink, claimOf, tgAuthor, TG_COPY, TG_OFFSET_KEY,
  type TgSweepDeps,
} from "../src/telegram/loop.js";
import { botStateGet, _memMentionOutcome, _memMentionReason, _resetBotState, sourceUrlKind } from "../src/store/markets.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

const BOT = "oddiefunbot";
const PUBLIC = { id: -1001234567890, type: "supergroup" as const, username: "cryptoroom", title: "Crypto Room" };
const PRIVATE = { id: -1009876543210, type: "supergroup" as const, title: "Private Room" };
const BASIC = { id: -4444, type: "group" as const, title: "Old Group" };
const DM = { id: 555, type: "private" as const };

const alice = { id: 111, is_bot: false, first_name: "Alice", username: "alice" };
const noname = { id: 222, is_bot: false, first_name: "Bob" }; // no @name: legal on Telegram
const botUser = { id: 999, is_bot: true, first_name: "oddie", username: BOT };

const msg = (over: Partial<TgMessage> & Pick<TgMessage, "message_id" | "chat">): TgMessage => ({
  date: 0, from: alice, text: `@${BOT}`, ...over,
});
const upd = (id: number, m: TgMessage): TgUpdate => ({ update_id: id, message: m });

const goodExtraction = (q: string): Extraction => ({
  question: q,
  resolution_criteria: "Coinbase BTC-USD daily close.",
  price_claim: null,
  close_time: "2027-01-01T00:00:00Z",
  close_time_inferred: false,
  category: "Crypto",
  resolvability: "clean",
  appropriate: true,
  reason: "clean",
  hook: "BTC to 200k?",
} as Extraction);

interface Spy {
  replies: Array<{ chatId: number; replyTo: number; text: string; photoUrl: string | null }>;
  minted: Array<{ question: string; sourceUrl: string | null; openerId?: string | null }>;
  extracted: string[];
  people: Array<[string, string | null]>;
}

function harness(updates: TgUpdate[], over: Partial<TgSweepDeps> = {}): { deps: TgSweepDeps; spy: Spy } {
  const spy: Spy = { replies: [], minted: [], extracted: [], people: [] };
  const deps: TgSweepDeps = {
    botUsername: BOT,
    /* FAITHFUL TO TELEGRAM: an offset confirms every earlier update and those
       are never sent again. A fake that ignored the offset would pass every
       redelivery test whether or not the loop held it, which is exactly the
       rule these tests exist to protect. */
    updates: async (offset) => updates.filter((u) => offset === null || u.update_id >= offset),
    extract: async (t) => { spy.extracted.push(t); return goodExtraction("Will Bitcoin hit $200k before 2027?"); },
    existingMarket: async () => null,
    /* THE REAL MINT'S CONTRACT, using the real validator. openMarketFromClaim
       refuses a market whose source is not a linkable x.com or t.me post, and a
       fake that accepted anything is exactly how the first live tag -- in a
       basic group, with no link -- passed every test here and then failed three
       times in production. */
    openMarket: async (i) => {
      if (!sourceUrlKind(i.sourceUrl)) {
        return { ok: false, status: 400, error: "source_url required: a market with no source can never show who it came from" } as MintResult;
      }
      spy.minted.push({ question: i.question, sourceUrl: i.sourceUrl, openerId: i.openerId ?? null });
      return { ok: true, slug: `slug-${spy.minted.length}` } as MintResult;
    },
    reply: async (o) => { spy.replies.push(o); },
    rememberPerson: async (id, h) => { spy.people.push([id, h]); return { renamedFrom: null }; },
    baseUrl: "https://app.oddie.fun",
    cardUrl: (s) => `https://oddie.fun/card/${s}.png`,
    ...over,
  };
  return { deps, spy };
}

/* ------------------------------------------------------------ recognition -- */
{
  check("a tag is recognised", tagsBot(msg({ message_id: 1, chat: PUBLIC, text: `hey @${BOT} price this` }), BOT));
  check("...case-insensitively", tagsBot(msg({ message_id: 1, chat: PUBLIC, text: "@OddieFunBot" }), BOT));
  check("a LONGER name is not our tag",
    !tagsBot(msg({ message_id: 1, chat: PUBLIC, text: `@${BOT}x hello` }), BOT));
  check("the tag is stripped from the claim text",
    stripBotTag(`@${BOT} BTC hits 200k by 2027`, BOT) === "BTC hits 200k by 2027");
}

/* ------------------------------------------------------------ the link -- */
{
  check("a public group links by its name", messageLink(PUBLIC, 42) === "https://t.me/cryptoroom/42");
  check("a private supergroup links by its internal id",
    messageLink(PRIVATE, 42) === "https://t.me/c/9876543210/42", String(messageLink(PRIVATE, 42)));
  check("a basic group has no message link, and says so rather than faking one",
    messageLink(BASIC, 42) === null);
  check("...nor does a private chat", messageLink(DM, 42) === null);
}

/* ------------------------------------------------------------ the claim -- */
{
  const parent = msg({ message_id: 10, chat: PUBLIC, from: noname, text: "BTC is going to 200k before 2027, mark it" });
  const tag = msg({ message_id: 11, chat: PUBLIC, text: `@${BOT}`, reply_to_message: parent });
  const c = claimOf(tag, BOT);
  check("on a reply-tag the PARENT is the claim", c.text === parent.text, c.text);
  check("...and the parent is the source post", c.source.message_id === 10);

  const own = msg({ message_id: 12, chat: PUBLIC, text: `@${BOT} ETH flips BTC this year` });
  check("a bare tag carries the claim in its own words", claimOf(own, BOT).text === "ETH flips BTC this year");

  const toBot = msg({
    message_id: 13, chat: PUBLIC, text: `@${BOT} SOL to 500`,
    reply_to_message: msg({ message_id: 9, chat: PUBLIC, from: botUser, text: "market is live" }),
  });
  check("a reply to the BOT is not a claim about the world",
    claimOf(toBot, BOT).text === "SOL to 500", claimOf(toBot, BOT).text);
}

/* --------------------------------------------------------- the happy path -- */
{
  _resetBotState();
  const parent = msg({ message_id: 10, chat: PUBLIC, from: noname, text: "BTC is going to 200k before 2027" });
  const { deps, spy } = harness([upd(100, msg({ message_id: 11, chat: PUBLIC, reply_to_message: parent }))]);
  const r = await runTelegramSweep(deps);
  check("a reply-tag opens a market and answers", r.replied === 1 && spy.minted.length === 1 && spy.replies.length === 1,
    JSON.stringify(r.decisions));
  check("...sourced to the CLAIM's message, not the tag's",
    spy.minted[0]?.sourceUrl === "https://t.me/cryptoroom/10", String(spy.minted[0]?.sourceUrl));
  check("...answered under the tag, with the card",
    spy.replies[0]?.replyTo === 11 && spy.replies[0]?.photoUrl === "https://oddie.fun/card/slug-1.png");
  check("...and the answer links the market", /app\.oddie\.fun\/m\/slug-1/.test(spy.replies[0]?.text ?? ""));
  check("the offset confirms the batch", (await botStateGet(TG_OFFSET_KEY)) === "101");
}

/* ------------------------------------------------------ who earns the 2% -- */
{
  /* THE RATE IS FROZEN AT MINT. If the opener is not handed to the mint, the
     market is created at 0 and can never pay them, whatever they link later. */
  _resetBotState();
  const parent = msg({ message_id: 10, chat: PUBLIC, from: noname, text: "BTC 200k before 2027" });
  const { deps, spy } = harness([upd(1, msg({ message_id: 11, chat: PUBLIC, from: alice, reply_to_message: parent }))]);
  await runTelegramSweep(deps);
  check("the mint is told who OPENED it", spy.minted[0]?.openerId === "tg:111", String(spy.minted[0]?.openerId));
  check("...which is the tagger, not the claim's author (Lev: the 2% goes to whoever opened it)",
    spy.minted[0]?.openerId !== "tg:222");
}

/* ----------------------------------------------------------- identity -- */
{
  _resetBotState();
  const { deps, spy } = harness([upd(1, msg({ message_id: 1, chat: PUBLIC, from: noname, text: `@${BOT} BTC 200k` }))]);
  await runTelegramSweep(deps);
  check("the ledger author is the numeric id, never the @name",
    tgAuthor(222) === "tg:222" && _memMentionOutcome("tg:-1001234567890:1") === "replied");
  check("a person with no @name is recorded, not refused",
    spy.people.length === 1 && spy.people[0][0] === "222" && spy.people[0][1] === null, JSON.stringify(spy.people));
  check("...and still gets their market", spy.minted.length === 1);
}

/* ------------------------------------------------------- what is ignored -- */
{
  _resetBotState();
  const { deps, spy } = harness([
    upd(1, msg({ message_id: 1, chat: PUBLIC, text: "just chatting, no tag" })),
    upd(2, msg({ message_id: 2, chat: PUBLIC, from: botUser, text: `@${BOT} loop` })),
  ]);
  const r = await runTelegramSweep(deps);
  check("an untagged group message is not looked at", r.looked === 0 && spy.extracted.length === 0);
  check("the bot never answers a bot", spy.replies.length === 0);
  check("...and the ignored batch is still confirmed", (await botStateGet(TG_OFFSET_KEY)) === "3");
}

/* -------------------------------------------------- one post, one market -- */
{
  _resetBotState();
  const parent = msg({ message_id: 10, chat: PUBLIC, text: "BTC 200k before 2027" });
  const { deps, spy } = harness([upd(1, msg({ message_id: 11, chat: PUBLIC, reply_to_message: parent }))], {
    existingMarket: async () => ({ slug: "already", question: "Will BTC hit 200k before 2027?" }),
  });
  await runTelegramSweep(deps);
  check("a claim that already has a market is answered with it", spy.minted.length === 0 && spy.replies.length === 1);
  check("...without paying for an extraction", spy.extracted.length === 0);
  check("...and it does not count against the person's cap",
    _memMentionReason("tg:-1001234567890:11") === "existing");
}

/* ------------------------------------------------------------ the cap -- */
{
  _resetBotState();
  const { deps, spy } = harness([upd(1, msg({ message_id: 1, chat: PUBLIC, text: `@${BOT} BTC 200k` }))], {
    openedToday: async () => 5, dailyCap: 5,
  });
  const r = await runTelegramSweep(deps);
  check("over the cap, nothing opens", spy.minted.length === 0 && r.skipped === 1);
  check("...and the person is TOLD, rather than met with silence",
    spy.replies.length === 1 && spy.replies[0].text === TG_COPY.cap(5), spy.replies[0]?.text);
}

/* --------------------------------------------------------- unmarketable -- */
{
  _resetBotState();
  const { deps, spy } = harness([upd(1, msg({ message_id: 1, chat: PUBLIC, text: `@${BOT} vibes are good` }))], {
    extract: async () => ({ ...goodExtraction(""), resolvability: "unresolvable", question: "" } as Extraction),
  });
  await runTelegramSweep(deps);
  check("an unmarketable claim opens nothing", spy.minted.length === 0);
  check("...and says what would work instead", spy.replies[0]?.text === TG_COPY.unmarketable);
}
{
  _resetBotState();
  const { deps, spy } = harness([upd(1, msg({ message_id: 1, chat: PUBLIC, text: `@${BOT}` }))]);
  await runTelegramSweep(deps);
  check("a bare tag with nothing to read gets told how to use it",
    spy.replies[0]?.text === TG_COPY.empty && spy.extracted.length === 0);
}

/* ------------------------------------------- Telegram forgets confirmed -- */
{
  /* A FAILED MINT MUST COME BACK. Passing an offset confirms every earlier
     update and Telegram never resends it, so a mint that failed would be lost
     for good if the offset moved past it. */
  _resetBotState();
  let calls = 0;
  const { deps, spy } = harness([
    upd(50, msg({ message_id: 1, chat: PUBLIC, text: `@${BOT} BTC 200k` })),
    upd(51, msg({ message_id: 2, chat: PUBLIC, text: `@${BOT} ETH 10k` })),
  ], {
    openMarket: async (i) => {
      calls++;
      if (i.question && calls === 1) return { ok: false, status: 503, error: "solana unreachable" } as MintResult;
      spy.minted.push({ question: i.question, sourceUrl: i.sourceUrl });
      return { ok: true, slug: `slug-${calls}` } as MintResult;
    },
  });
  const r = await runTelegramSweep(deps);
  check("a failed mint is a retry, not a failure", r.retried === 1 && _memMentionOutcome("tg:-1001234567890:1") === "retry");
  check("...and the offset is HELD at it, so Telegram sends it again",
    (await botStateGet(TG_OFFSET_KEY)) === "50", String(await botStateGet(TG_OFFSET_KEY)));
  const r2 = await runTelegramSweep(deps);
  check("on redelivery the retry opens and the settled one is not answered twice",
    r2.replied === 1 && spy.replies.length === 2, `r2=${JSON.stringify(r2.decisions)} replies=${spy.replies.length}`);
  check("...and only then is the batch confirmed", (await botStateGet(TG_OFFSET_KEY)) === "52");
}
{
  // Bounded: the same attempt limit the X ledger enforces.
  _resetBotState();
  let mints = 0;
  const { deps } = harness([upd(60, msg({ message_id: 1, chat: PUBLIC, text: `@${BOT} BTC 200k` }))], {
    openMarket: async () => { mints++; return { ok: false, status: 503, error: "down" } as MintResult; },
  });
  for (let i = 0; i < 6; i++) await runTelegramSweep(deps);
  check("a mint that keeps failing is given up on after three goes", mints === 3, `mints=${mints}`);
  check("...and the offset finally moves on", (await botStateGet(TG_OFFSET_KEY)) === "61");
}

/* ------------------------------------------------------ never post twice -- */
{
  _resetBotState();
  let sent = 0;
  const { deps } = harness([upd(70, msg({ message_id: 1, chat: PUBLIC, text: `@${BOT} BTC 200k` }))], {
    reply: async () => { sent++; throw new Error("telegram sendPhoto -> 0 timed out"); },
  });
  const r1 = await runTelegramSweep(deps);
  const r2 = await runTelegramSweep(deps);
  check("a reply that may have landed is never sent again",
    sent === 1 && r1.failed === 1 && r2.replied === 0, `sent=${sent}`);
  check("...and is recorded as failed, not as a retry", _memMentionOutcome("tg:-1001234567890:1") === "failed");
}

/* ------------------------------------- bookkeeping never blocks the answer -- */
{
  _resetBotState();
  const { deps, spy } = harness([upd(80, msg({ message_id: 1, chat: PUBLIC, text: `@${BOT} BTC 200k` }))], {
    rememberPerson: async () => { throw new Error("person store down"); },
  });
  const r = await runTelegramSweep(deps);
  check("a failed identity write still opens and answers", r.replied === 1 && spy.replies.length === 1);
}

/* ------------------------------------------- where a market can come from -- */
{
  /* THE FIRST LIVE TAG. A basic group's messages have no t.me link, the mint
     refuses a sourceless market, and it used to find that out after a paid
     extraction -- then retry three times -- then say nothing at all. */
  _resetBotState();
  const { deps, spy } = harness([upd(1, msg({ message_id: 2, chat: BASIC, text: `@${BOT} BTC hits 200k before 2027` }))]);
  const r = await runTelegramSweep(deps);
  check("a basic group opens nothing", spy.minted.length === 0);
  check("...WITHOUT paying for an extraction first", spy.extracted.length === 0, `extracted=${spy.extracted.length}`);
  check("...is not retried, because nothing will change on another go", r.retried === 0 && r.skipped === 1);
  check("...and the person is told the one setting that fixes it",
    spy.replies.length === 1 && spy.replies[0].text === TG_COPY.needsLinks, spy.replies[0]?.text);
}
{
  _resetBotState();
  const { deps, spy } = harness([upd(1, msg({ message_id: 3, chat: DM, text: "/start" }))]);
  await runTelegramSweep(deps);
  check("the /start Telegram sends on opening a chat costs no extraction", spy.extracted.length === 0);
  check("...and a DM is answered with how oddie works", spy.replies[0]?.text === TG_COPY.dm && spy.minted.length === 0);
}
{
  _resetBotState();
  const { deps, spy } = harness([upd(1, msg({ message_id: 4, chat: DM, text: "BTC hits 200k before 2027" }))]);
  await runTelegramSweep(deps);
  check("a claim sent in a DM opens no market (no public post to come from)",
    spy.minted.length === 0 && spy.extracted.length === 0);
}
{
  /* A REFUSAL IS AN ANSWER. A 4xx from the mint is the same answer on every
     attempt, so asking again only buys another paid extraction. */
  _resetBotState();
  let calls = 0;
  const { deps, spy } = harness([upd(1, msg({ message_id: 5, chat: PUBLIC, text: `@${BOT} $BTC 200k` }))], {
    openMarket: async () => { calls++; return { ok: false, status: 422, error: "price claim could not be pinned to a token" } as MintResult; },
  });
  for (let i = 0; i < 4; i++) await runTelegramSweep(deps);
  check("a mint refusal is asked exactly once", calls === 1, `calls=${calls}`);
  check("...extracted exactly once", spy.extracted.length === 1, `extracted=${spy.extracted.length}`);
  check("...and the person hears why", spy.replies.length === 1 && spy.replies[0].text === TG_COPY.unmarketable);
}
{
  // A supergroup reached through its t.me/c/ form is linkable and opens.
  _resetBotState();
  const { deps, spy } = harness([upd(1, msg({ message_id: 6, chat: PRIVATE, text: `@${BOT} BTC 200k before 2027` }))]);
  await runTelegramSweep(deps);
  check("a PRIVATE supergroup opens markets (its messages do have links)",
    spy.minted[0]?.sourceUrl === "https://t.me/c/9876543210/6", String(spy.minted[0]?.sourceUrl));
}

/* ---------------------------------------------------- collecting the 2% -- */
{
  // The deep link under a market sends "/start earn" into the tapper's OWN chat.
  _resetBotState();
  const { deps, spy } = harness([upd(1, msg({ message_id: 7, chat: DM, from: alice, text: "/start earn" }))],
    { earnLink: (id) => `https://app.oddie.fun/tg/earn?t=TOKEN-FOR-${id}` });
  await runTelegramSweep(deps);
  check("/start earn in a DM answers with that person's own link",
    /TOKEN-FOR-111/.test(spy.replies[0]?.text ?? ""), spy.replies[0]?.text);
  check("...without extracting anything", spy.extracted.length === 0);
}
{
  _resetBotState();
  const { deps, spy } = harness([upd(1, msg({ message_id: 8, chat: DM, from: noname, text: "/earn" }))],
    { earnLink: (id) => `https://app.oddie.fun/tg/earn?t=TOKEN-FOR-${id}` });
  await runTelegramSweep(deps);
  check("/earn typed by hand works too, for a person with no @name",
    /TOKEN-FOR-222/.test(spy.replies[0]?.text ?? ""), spy.replies[0]?.text);
}
{
  /* THE LINK NEVER GOES TO A GROUP. It binds a wallet to one person's markets;
     posted publicly, anybody could point that person's 2% at themselves. */
  _resetBotState();
  const links: number[] = [];
  const { deps, spy } = harness([upd(1, msg({ message_id: 9, chat: PUBLIC, text: `@${BOT} /earn BTC 200k before 2027` }))],
    { earnLink: (id) => { links.push(id); return `https://app.oddie.fun/tg/earn?t=TOKEN-FOR-${id}`; } });
  await runTelegramSweep(deps);
  check("a /earn inside a GROUP never produces a link", links.length === 0, `links=${links.length}`);
  check("...and no reply in a group carries one", !spy.replies.some((r) => /tg\/earn\?t=/.test(r.text)));
}
{
  _resetBotState();
  const { deps, spy } = harness([upd(1, msg({ message_id: 10, chat: DM, text: "/earn" }))]); // no earnLink
  await runTelegramSweep(deps);
  check("with collecting switched off, the person is told their 2% is kept", spy.replies[0]?.text === TG_COPY.earnOff);
}
{
  /* THE INCENTIVE, WHERE THE ROOM CAN SEE IT. */
  _resetBotState();
  const { deps, spy } = harness([upd(1, msg({ message_id: 11, chat: PUBLIC, from: alice, text: `@${BOT} BTC 200k before 2027` }))]);
  await runTelegramSweep(deps);
  const text = spy.replies[0]?.text ?? "";
  check("a new market names who opened it", /Opened by @alice, who earns 2% of the pool/.test(text), text);
  check("...with the PUBLIC deep link, not a private token",
    text.includes(`https://t.me/${BOT}?start=earn`) && !/tg\/earn\?t=/.test(text));
}
{
  _resetBotState();
  const { deps, spy } = harness([upd(1, msg({ message_id: 12, chat: PUBLIC, from: noname, text: `@${BOT} BTC 200k before 2027` }))]);
  await runTelegramSweep(deps);
  check("an opener with no @name is named by their first name", /Opened by Bob,/.test(spy.replies[0]?.text ?? ""));
}
{
  // A pointer to a market somebody else opened must not credit the tagger.
  _resetBotState();
  const parent = msg({ message_id: 13, chat: PUBLIC, text: "BTC 200k before 2027" });
  const { deps, spy } = harness([upd(1, msg({ message_id: 14, chat: PUBLIC, from: alice, reply_to_message: parent }))], {
    existingMarket: async () => ({ slug: "already", question: "Will BTC hit 200k before 2027?" }),
  });
  await runTelegramSweep(deps);
  check("a pointer to an existing market credits nobody", !/Opened by/.test(spy.replies[0]?.text ?? ""));
}

/* -------------------------------------------------------------- dry run -- */
{
  _resetBotState();
  const { deps, spy } = harness([upd(90, msg({ message_id: 1, chat: PUBLIC, text: `@${BOT} BTC 200k` }))], { dryRun: true });
  await runTelegramSweep(deps);
  check("a dry run posts nothing", spy.replies.length === 0);
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall telegram checks passed.\n");
process.exit(failures ? 1 : 0);
