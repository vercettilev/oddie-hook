// oddie in Telegram groups. These pin the rules that were each paid for on X,
// plus the one Telegram adds: an offset that has moved past an update means
// Telegram will never send it again.
import type { Extraction } from "../src/matching/extractClaim.js";
import type { MintResult } from "../src/x/mentionLoop.js";
import type { TgMessage, TgUpdate } from "../src/telegram/client.js";
import {
  runTelegramSweep, tagsBot, stripBotTag, messageLink, claimOf, tgAuthor, TG_COPY, TG_OFFSET_KEY,
  privateSource, modelOutage, parkedCount, _resetParked, releaseOrphanedParks, PARK_MAX_MS, type TgSweepDeps,
} from "../src/telegram/loop.js";
import {
  botStateGet, _memMentionOutcome, _memMentionReason, _memMentionClaimText, _resetBotState, sourceUrlKind, sourcePostKey,
  isWebSourceUrl,
} from "../src/store/markets.js";
import type { GuestContent } from "../src/telegram/client.js";

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

/* ------------------------------------- a claim that already has a market -- */
{
  /* The mint found the same claim already open (another group, another post)
     and handed that market back. Nothing was opened here: no "Opened by you,
     who earns 2%", and the ledger must not count it against the daily cap. */
  _resetBotState();
  const parent = msg({ message_id: 10, chat: PUBLIC, from: noname, text: "BTC 200k before 2027" });
  const { deps, spy } = harness([upd(1, msg({ message_id: 11, chat: PUBLIC, from: alice, reply_to_message: parent }))], {
    openMarket: async () => ({ ok: true, slug: "btc-200k", existed: true, question: "Will Bitcoin hit $200k before 2027?" }) as MintResult,
  });
  const r = await runTelegramSweep(deps);
  check("a tag that matches an open market is answered with it", r.replied === 1
    && /app\.oddie\.fun\/m\/btc-200k/.test(spy.replies[0]?.text ?? ""), spy.replies[0]?.text);
  check("...without naming the tagger as its opener", !/Opened by/.test(spy.replies[0]?.text ?? ""));
  check("...and recorded as existing, not opened", _memMentionReason("tg:-1001234567890:11") === "existing",
    String(_memMentionReason("tg:-1001234567890:11")));
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
{
  // The operator tests by tagging: the day's caps are for everybody else.
  _resetBotState();
  const asked: number[] = [];
  const { deps, spy } = harness([
    upd(1, msg({ message_id: 1, chat: PUBLIC, from: alice, text: `@${BOT} BTC 200k before 2027` })),
    upd(2, msg({ message_id: 2, chat: PUBLIC, from: noname, text: `@${BOT} ETH 10k before 2027` })),
  ], {
    openedToday: async () => 5, dailyCap: 5,
    uncapped: async (u) => { asked.push(u.id); return u.id === alice.id; },
  });
  const r = await runTelegramSweep(deps);
  check("an uncapped person opens past the cap", spy.minted.length === 1 && spy.minted[0].openerId === tgAuthor(alice.id));
  check("...everybody else still meets it", r.skipped === 1 && spy.replies.some((x) => x.text === TG_COPY.cap(5)));
  check("...asked by the person's own Telegram id", asked.join() === `${alice.id},${noname.id}`);
}
{
  const { readFileSync } = await import("node:fs");
  const server = readFileSync("src/server.ts", "utf8");
  check("who is uncapped is read from TG_UNCAPPED, by id or @name",
    /process\.env\.TG_UNCAPPED/.test(server) && /TG_UNCAPPED\.includes\(String\(u\.id\)\)/.test(server)
    && /uncapped: async \(user\) => tgUncapped\(user\)/.test(server));
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
  /* A BASIC GROUP OPENS MARKETS NOW. Its messages have no t.me link, and it is
     what two friends get when they make a group. It used to be refused with a
     request to change a group setting; it records an opaque source instead. */
  _resetBotState();
  const { deps, spy } = harness([upd(1, msg({ message_id: 2, chat: BASIC, text: `@${BOT} BTC hits 200k before 2027` }))]);
  const r = await runTelegramSweep(deps);
  const src = spy.minted[0]?.sourceUrl ?? "";
  check("a basic group opens a market", r.replied === 1 && spy.minted.length === 1);
  check("...from an opaque source the real mint accepts", sourceUrlKind(src) === "telegram" && src === privateSource(BASIC.id, 2), src);
  check("...which is never a link", !isWebSourceUrl(src));
  check("...and carries neither the chat id nor the message id", !src.includes(String(Math.abs(BASIC.id))));
  check("...and still keys one post to one market", sourcePostKey(src) === `tgp:${src.slice("tg-private:".length)}`);
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

/* ------------------------------------------------------------ guest mode -- */
/* Two people in their own chat, the bot a member of nothing. The fake is
   faithful to Telegram: one answer per guest query, edits only through the
   inline id it returned, and PEER_ID_INVALID for anything sent into the chat. */
const PAIR = { id: 70001, type: "private" as const };
const gupd = (id: number, m: TgMessage, q = `gq-${id}`): TgUpdate => ({ update_id: id, guest_message: { ...m, guest_query_id: q } });
function guestHarness(updates: TgUpdate[], over: Partial<TgSweepDeps> = {}) {
  const answered = new Map<string, string>();
  const g = { answers: [] as Array<{ q: string; c: GuestContent }>, edits: [] as Array<{ id: string; c: GuestContent }> };
  const h = harness(updates, {
    reply: async (o) => { if (o.chatId === PAIR.id) throw new Error("400 PEER_ID_INVALID"); },
    guestAnswer: async (q, c) => {
      if (answered.has(q)) throw new Error("400 QUERY_ID_INVALID");
      const id = `inline-${answered.size + 1}`;
      answered.set(q, id);
      g.answers.push({ q, c });
      return id;
    },
    guestEdit: async (id, c) => {
      if (![...answered.values()].includes(id)) throw new Error("400 MESSAGE_ID_INVALID");
      g.edits.push({ id, c });
    },
    ...over,
  });
  return { ...h, g };
}
{
  _resetBotState();
  const claim = msg({ message_id: 40, chat: PAIR, from: noname, text: "BTC is going to 200k before 2027, bet?" });
  const tag = msg({ message_id: 41, chat: PAIR, from: alice, text: `@${BOT}`, reply_to_message: claim });
  const { deps, spy, g } = guestHarness([gupd(1, tag)]);
  const r = await runTelegramSweep(deps);
  const last = g.edits[g.edits.length - 1]?.c;
  check("a tag in a private chat between two people opens a market", r.replied === 1 && spy.minted.length === 1);
  check("...from the friend's message it replied to", spy.extracted[0] === claim.text);
  check("...answered once, at once, before the slow part", g.answers.length === 1 && g.answers[0].c.text === TG_COPY.reading);
  check("...and that reply edited into the market", Boolean(last && /Opened by @alice/.test(last.text)));
  check("...with the market page as its preview and its button",
    last?.previewUrl === "https://app.oddie.fun/m/slug-1" && last?.button?.url === "https://app.oddie.fun/m/slug-1");
  check("...and words that name the market once, since the preview carries the rest",
    Boolean(last && last.text.startsWith("BTC to 200k?\n\nOpened by") && !last.text.includes("/m/slug-1")), last?.text);
  check("...on its own ledger key, apart from the bot's real chats", _memMentionOutcome(`tgg:${PAIR.id}:41`) === "replied"
    && _memMentionOutcome(`tg:${PAIR.id}:41`) === null);
  check("...never storing the words from a private chat", _memMentionClaimText(`tgg:${PAIR.id}:41`) === null);
  check("...and never publishing where it came from", !isWebSourceUrl(spy.minted[0]?.sourceUrl ?? "")
    && !(spy.minted[0]?.sourceUrl ?? "").includes(String(PAIR.id)));
  check("the person who tagged is the opener", spy.minted[0]?.openerId === tgAuthor(alice.id));
}
{
  // Guest mode also delivers replies to the bot's own message: people talking.
  _resetBotState();
  const card = msg({ message_id: 50, chat: PAIR, from: botUser, text: "market is live" });
  const chat = msg({ message_id: 51, chat: PAIR, from: noname, text: "I'm on NO lol", reply_to_message: card });
  const { deps, spy, g } = guestHarness([gupd(1, chat)]);
  const r = await runTelegramSweep(deps);
  check("a reply to the bot that does not name it gets nothing, and costs nothing",
    r.looked === 0 && g.answers.length === 0 && spy.extracted.length === 0 && _memMentionOutcome(`tgg:${PAIR.id}:51`) === null);
}
{
  _resetBotState();
  const { deps, g } = guestHarness([gupd(1, msg({ message_id: 60, chat: PAIR, text: `@${BOT} I love pizza` }))], {
    extract: async () => ({ ...goodExtraction(""), question: "", resolvability: "unresolvable", appropriate: true } as Extraction),
  });
  await runTelegramSweep(deps);
  check("a guest tag on something that is not a claim says so in the same reply",
    g.answers.length === 1 && g.edits.length === 1 && g.edits[0].c.text === TG_COPY.unmarketable);
}
{
  /* ONE REPLY, SO NO RETRY. A passing outage after the reply went out would
     otherwise be tried again, and the second answer is refused by Telegram. */
  _resetBotState();
  let mints = 0;
  const { deps, g } = guestHarness([gupd(1, msg({ message_id: 70, chat: PAIR, text: `@${BOT} BTC 200k before 2027` }))], {
    openMarket: async () => { mints++; return { ok: false, status: 503, error: "down" } as MintResult; },
  });
  const r1 = await runTelegramSweep(deps);
  await runTelegramSweep(deps);
  check("a guest mint outage is not retried", mints === 1 && r1.retried === 0, `mints=${mints}`);
  check("...and the reply says what to do instead of 'Reading' forever",
    g.answers.length === 1 && g.edits[g.edits.length - 1]?.c.text === TG_COPY.later);
}
{
  _resetBotState();
  const { deps, spy, g } = guestHarness([gupd(1, msg({ message_id: 80, chat: PAIR, text: `@${BOT} BTC 200k before 2027` }))], {
    guestTriesToday: async () => 31, guestDailyTries: 30,
  });
  await runTelegramSweep(deps);
  check("past the day's guest tags, the answer is free: no model call",
    spy.extracted.length === 0 && g.answers[0]?.c.text === TG_COPY.guestCap);
}
{
  // Tagging a claim that already has a market: the pointer is the one reply.
  _resetBotState();
  const { deps, g } = guestHarness([gupd(1, msg({ message_id: 90, chat: PAIR, text: `@${BOT} BTC 200k before 2027` }))], {
    existingMarket: async () => ({ slug: "already", question: "Will BTC hit 200k before 2027?" }),
  });
  await runTelegramSweep(deps);
  check("a known claim is answered with its market, in one reply and no edit",
    g.answers.length === 1 && g.edits.length === 0 && g.answers[0].c.previewUrl === "https://app.oddie.fun/m/already");
}
{
  _resetBotState();
  const { deps, g } = guestHarness([gupd(1, msg({ message_id: 95, chat: PAIR, text: `@${BOT} BTC 200k` }))], { dryRun: true });
  await runTelegramSweep(deps);
  check("a dry run answers no guest either", g.answers.length === 0 && g.edits.length === 0);
}
{
  // A public group the bot was never added to still has real message links.
  _resetBotState();
  const { deps, spy } = guestHarness([gupd(1, msg({ message_id: 97, chat: PUBLIC, text: `@${BOT} BTC 200k before 2027` }))]);
  await runTelegramSweep(deps);
  check("a guest tag in a public group keeps its real t.me link", spy.minted[0]?.sourceUrl === "https://t.me/cryptoroom/97");
}

{
  _resetBotState();
  const { deps, spy, g } = guestHarness([gupd(1, msg({ message_id: 180, chat: PAIR, from: alice, text: `@${BOT} BTC 200k before 2027` }))], {
    guestTriesToday: async () => 99, guestDailyTries: 30, uncapped: async () => true,
  });
  await runTelegramSweep(deps);
  check("an uncapped person is past the guest tries too", spy.minted.length === 1 && g.answers[0]?.c.text !== TG_COPY.guestCap);
}

/* ------------------------------------------------------ the model is out -- */
/* Found live: the Anthropic balance ran dry, and three tags in a row were told
   "tag me again in a minute", and again. A tag that meets an outage of the
   MODEL waits, and opens by itself when the model is back. */
const CREDIT = new Error('extract 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}');
{
  check("no credit is a billing outage", modelOutage(CREDIT) === "billing");
  check("a refused key is an auth outage", modelOutage(new Error("extract 401 invalid x-api-key")) === "auth");
  check("overloaded is busy", modelOutage(new Error("extract 529 overloaded")) === "busy"
    && modelOutage(new Error("extract 429 rate_limit")) === "busy" && modelOutage(new Error("extract 500")) === "busy");
  check("a dropped connection is the network", modelOutage(new Error("fetch failed")) === "network"
    && modelOutage(new Error("The operation was aborted due to timeout")) === "network");
  check("no key at all is config", modelOutage(new Error("extraction unavailable — set ANTHROPIC_API_KEY")) === "config");
  check("a request we got wrong is NOT an outage: waiting would not fix it",
    modelOutage(new Error('extract 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: bad"}}')) === null);
}
{
  _resetBotState(); _resetParked();
  let clock = 1_800_000_000_000;
  let down = true;
  const alerts: string[] = [];
  const claim = msg({ message_id: 140, chat: PAIR, from: noname, text: "BTC is going to 200k before 2027, bet?" });
  const tag = msg({ message_id: 141, chat: PAIR, from: alice, text: `@${BOT}`, reply_to_message: claim });
  const { deps, spy, g } = guestHarness([gupd(1, tag)], {
    now: () => clock,
    extract: async (t) => { spy.extracted.push(t); if (down) throw CREDIT; return goodExtraction("Will Bitcoin hit $200k before 2027?"); },
    alertOps: async (t) => { alerts.push(t); },
  });
  const r1 = await runTelegramSweep(deps);
  check("a guest tag during an outage is parked, not bounced", r1.parked === 1 && r1.failed === 0 && spy.minted.length === 0);
  check("...its one reply says it will open shortly", g.answers.length === 1 && g.edits[g.edits.length - 1]?.c.text === TG_COPY.parked);
  check("...the ledger says why", (_memMentionReason(`tgg:${PAIR.id}:141`) ?? "").startsWith("parked:billing"));
  check("...and the operator hears about it once, with where to fix it",
    alerts.length === 1 && /credit balance/.test(alerts[0]) && /console\.anthropic\.com\/settings\/billing/.test(alerts[0]));
  check("...never storing the private words while it waits", _memMentionClaimText(`tgg:${PAIR.id}:141`) === null);

  clock += 30_000;
  await runTelegramSweep(deps);
  check("it waits its turn: no call before the first minute", spy.extracted.length === 1);
  clock += 60_000;
  await runTelegramSweep(deps);
  check("then tries again", spy.extracted.length === 2);
  check("...still out: the operator is not told twice", alerts.length === 1);

  down = false;
  clock += 3 * 60_000;
  const r4 = await runTelegramSweep(deps);
  const last = g.edits[g.edits.length - 1]?.c;
  check("once the model is back, the market opens by itself", r4.replied === 1 && spy.minted.length === 1);
  check("...in the same reply, edited into the market",
    g.answers.length === 1 && Boolean(last && /Opened by @alice/.test(last.text)) && last?.button?.url === "https://app.oddie.fun/m/slug-1");
  check("...from the friend's message, still", spy.extracted[spy.extracted.length - 1] === claim.text);
  check("...and the ledger says replied", _memMentionOutcome(`tgg:${PAIR.id}:141`) === "replied");
  check("...and the queue is empty", parkedCount() === 0);
}
{
  // A group tag: a short note under the tag, then the card, and the note goes.
  _resetBotState(); _resetParked();
  let clock = 1_800_000_000_000;
  let down = true;
  const notes: Array<{ chatId: number; replyTo: number; text: string }> = [];
  const deleted: number[] = [];
  const { deps, spy } = harness([upd(300, msg({ message_id: 150, chat: PUBLIC, text: `@${BOT} BTC 200k before 2027` }))], {
    now: () => clock,
    extract: async (t) => { spy.extracted.push(t); if (down) throw new Error("extract 529 overloaded"); return goodExtraction("Will Bitcoin hit $200k before 2027?"); },
    replyText: async (chatId, replyTo, text) => { notes.push({ chatId, replyTo, text }); return 7001; },
    deleteMessage: async (_c, m) => { deleted.push(m); },
  });
  const r1 = await runTelegramSweep(deps);
  check("a group tag during an outage gets a note under it", r1.parked === 1 && notes.length === 1
    && notes[0].replyTo === 150 && notes[0].text === TG_COPY.parked && spy.replies.length === 0);
  check("...and does not hold the offset: the queue owns it now", r1.newOffset === 301 && r1.retried === 0);
  down = false;
  clock += 61_000;
  const r2 = await runTelegramSweep(deps);
  check("back: the card goes under the tag", r2.replied === 1 && spy.replies.length === 1
    && spy.replies[0].replyTo === 150 && spy.replies[0].photoUrl === "https://oddie.fun/card/slug-1.png");
  check("...and the note that promised it is removed", deleted.join() === "7001");
}
{
  // Twelve hours is long enough to wait.
  _resetBotState(); _resetParked();
  let clock = 1_800_000_000_000;
  const { deps, spy, g } = guestHarness([gupd(1, msg({ message_id: 160, chat: PAIR, text: `@${BOT} BTC 200k before 2027` }))], {
    now: () => clock,
    extract: async (t) => { spy.extracted.push(t); throw CREDIT; },
  });
  await runTelegramSweep(deps);
  clock += PARK_MAX_MS + 1;
  const r = await runTelegramSweep(deps);
  check("after twelve hours it gives up, and says so where it promised",
    r.failed === 1 && g.edits[g.edits.length - 1]?.c.text === TG_COPY.expired && parkedCount() === 0);
  check("...the ledger says so too", _memMentionReason(`tgg:${PAIR.id}:160`) === "parked-expired");
}
{
  // Anything that is not the model keeps the old answer.
  _resetBotState(); _resetParked();
  const { deps, g } = guestHarness([gupd(1, msg({ message_id: 170, chat: PAIR, text: `@${BOT} BTC 200k before 2027` }))], {
    extract: async () => { throw new Error('extract 400 {"error":{"message":"messages: bad"}}'); },
  });
  const r = await runTelegramSweep(deps);
  check("a failure that is not an outage is not parked", r.parked === 0 && parkedCount() === 0
    && g.edits[g.edits.length - 1]?.c.text === TG_COPY.later);
}
{
  // After a restart the queue is gone; its notes must not say "shortly" forever.
  const edits: string[] = []; const settled: string[] = [];
  const n = await releaseOrphanedParks([
    { key: "tgg:70001:141", replyId: "inline-9" },
    { key: "tg:-1001234567890:150", replyId: "note:-1001234567890:7001" },
    { key: "tg:-1001234567890:151", replyId: null },
  ], {
    guestEdit: async (id, c) => { edits.push(`guest ${id} ${c.text}`); },
    editMessage: async (chat, id, text) => { edits.push(`group ${chat}/${id} ${text}`); },
    settle: async (k) => { settled.push(k); },
  });
  check("a restart takes back every note the lost queue left",
    n === 3 && edits.join("|") === `guest inline-9 ${TG_COPY.expired}|group -1001234567890/7001 ${TG_COPY.expired}` && settled.length === 3);
}

/* -------------------------------------------------------------- dry run -- */
{
  _resetBotState();
  const { deps, spy } = harness([upd(90, msg({ message_id: 1, chat: PUBLIC, text: `@${BOT} BTC 200k` }))], { dryRun: true });
  await runTelegramSweep(deps);
  check("a dry run posts nothing", spy.replies.length === 0);
}

/* ------------------------------------------------ never printed as a link -- */
{
  const { readFileSync } = await import("node:fs");
  const server = readFileSync("src/server.ts", "utf8");
  check("the market page gets a source URL only when it is a real link",
    /url: isWebSourceUrl\(src\.sourceUrl\) \? src\.sourceUrl : null/.test(server));
  check("...and so does the public market list",
    /sourceUrl: isWebSourceUrl\(openers\[m\.slug\]\?\.sourceUrl\)/.test(server));
  const allowed = /allowed_updates: \[([^\]]*)\]/.exec(readFileSync("src/telegram/client.ts", "utf8"))?.[1] ?? "";
  check("guest updates are asked for", allowed.includes('"guest_message"'), allowed);
  const boot = server.slice(server.indexOf("async function startTelegram"), server.indexOf("if (TG.tgToken()) void startTelegram();"));
  check("a parked group tag can leave a note and remove it", /replyText: async \(chatId, replyTo, text\) => \(await TG\.sendMessage\(chatId, text, replyTo\)\)\.message_id/.test(boot)
    && /deleteMessage: \(chatId, messageId\) => TG\.deleteMessage\(chatId, messageId\)/.test(boot));
  check("the operator alert is wired", /alertOps: \(text\) => tgOpsAlert\(text\)/.test(boot)
    && /process\.env\.TG_OPS_CHAT_ID/.test(server) && /process\.env\.TG_OPS_HANDLE/.test(server));
  check("a restart takes back the notes of the queue it lost, and only those",
    /parkedMentionRows\(TG_BOOT_AT\)/.test(boot) && /releaseOrphanedParks\(orphans,/.test(boot));
  const store = readFileSync("src/store/markets.ts", "utf8");
  const rowsFn = store.slice(store.indexOf("export async function parkedMentionRows"), store.indexOf("export async function tgIdForHandle"));
  check("...read from the ledger by their parked reason, before this start", /reason LIKE 'parked:%'/.test(rowsFn) && /at < \$1/.test(rowsFn));
  check("...and taps on the bot's buttons", allowed.includes('"callback_query"'), allowed);
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall telegram checks passed.\n");
process.exit(failures ? 1 : 0);
