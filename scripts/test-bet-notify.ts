// When a stake lands: who hears what, how often, and what is never said.
// Notices go through the REAL store (in memory), because "the same stake
// relayed twice is one notice" is the store's unique key, and a fake that
// deduped differently would prove nothing about it.
if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database: unset DATABASE_URL");
  process.exit(1);
}
import { readFileSync } from "node:fs";
import {
  groupText, shouldBroadcast, counterText, openerText, onBetLanded, BROADCAST_GAP_MS,
  type BetLanded, type BetNotifyDeps, type Pacing,
} from "../src/social/bets.js";
import { recordBetNotices, betNoticesFor, _resetBetNotices } from "../src/store/markets.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

const SOL = 1e9;
const YES_W = "YesWa11etYesWa11etYesWa11etYesWa11etYesW111";
const NO_W = "NoWa11etNoWa11etNoWa11etNoWa11etNoWa11etN11";
const OPENER_W = "OpenerWa11etOpenerWa11etOpenerWa11etOpen111";
const URL_M = "https://app.oddie.fun/m/btc-100k";
const bet = (wallet: string, side: "yes" | "no", sol: number, yes: number, no: number): BetLanded =>
  ({ slug: "btc-100k", wallet, side, lamports: sol * SOL, before: { yes: yes * SOL, no: no * SOL } });

console.log("what the group reads");
{
  const first = groupText(bet(YES_W, "yes", 0.5, 0, 0));
  check("the first stake names the side still open", first === "Someone just took YES with 0.5 SOL. NO is wide open.", first);
  const other = groupText(bet(NO_W, "no", 0.2, 0.5, 0));
  check("the other side arriving says both are in",
    other === "Someone just took NO with 0.2 SOL. Both sides are in: 0.5 SOL on YES, 0.2 SOL on NO.", other);
  const more = groupText(bet(YES_W, "yes", 1, 0.5, 0.2));
  check("later stakes give the pool", more === "Someone just added 1 SOL to YES. The pool: 1.5 SOL on YES, 0.2 SOL on NO.", more);
  const lonely = groupText(bet(YES_W, "yes", 1, 0.5, 0));
  check("...and keep saying the empty side is open", lonely === "Someone just added 1 SOL to YES. 1.5 SOL on YES, and NO is wide open.", lonely);
  const all = [first, other, more, lonely, counterText(bet(NO_W, "no", 0.2, 0.5, 0), "BTC to $100k?", URL_M),
    openerText(bet(NO_W, "no", 0.2, 0.5, 0), "BTC to $100k?", URL_M, 200)];
  check("never a wallet, never a name", !all.some((t) => t.includes(YES_W) || t.includes(NO_W) || /@\w/.test(t)));
  check("no em or en dashes", !all.some((t) => /[–—]/.test(t)));
  check("the opener hears their cut", /The pool is 0\.7 SOL, and you earn 2% of it when it settles\./.test(all[5]), all[5]);
}

console.log("\nhow often the phone buzzes");
{
  const t0 = 1_800_000_000_000;
  check("the first stake of a market always", shouldBroadcast(bet(YES_W, "yes", 0.5, 0, 0), null, t0));
  check("the first stake on the other side always, however soon",
    shouldBroadcast(bet(NO_W, "no", 0.1, 0.5, 0), { at: t0, pool: 0.5 * SOL }, t0 + 60_000));
  const last: Pacing = { at: t0, pool: 1 * SOL };
  check("not again within half an hour", !shouldBroadcast(bet(YES_W, "yes", 5, 0.5, 0.5), last, t0 + BROADCAST_GAP_MS - 1));
  check("not after it either, unless the pool grew by half",
    !shouldBroadcast(bet(YES_W, "yes", 0.2, 0.5, 0.5), last, t0 + BROADCAST_GAP_MS));
  check("...and yes when it did", shouldBroadcast(bet(YES_W, "yes", 0.5, 0.5, 0.5), last, t0 + BROADCAST_GAP_MS));
}

console.log("\nwho hears what, against a faithful Telegram");
type Sent = { kind: "group" | "dm"; to: number; text: string; replyTo?: number; url?: string };
function world(over: Partial<BetNotifyDeps> = {}, sides: Record<string, "yes" | "no"> = {}, tgOf: Record<string, number> = {}) {
  _resetBetNotices();
  const sent: Sent[] = [];
  const pushes: Array<{ wallets: string[]; body: string }> = [];
  const pacing = new Map<string, Pacing>();
  let clock = 1_800_000_000_000;
  const deps: BetNotifyDeps = {
    now: () => clock,
    market: async () => ({ headline: "BTC to $100k?", url: URL_M, feeBps: 200 }),
    opener: async () => ({ wallet: null, tgUserId: 1775258225 }),
    walletsOnSide: async (_s, side) => Object.entries(sides).filter(([, v]) => v === side).map(([w]) => w),
    record: (l) => recordBetNotices(l),
    tgUserForWallet: async (w) => tgOf[w] ?? null,
    groupThreads: async () => [{ chatId: -1004413284410, messageId: 2 }],
    pacing: { get: async (s) => pacing.get(s) ?? null, set: async (s, p) => { pacing.set(s, p); } },
    sendGroup: async (o) => { sent.push({ kind: "group", to: o.chatId, text: o.text, replyTo: o.replyTo, url: o.url }); },
    // Faithful: Telegram refuses a first message to somebody who never started the bot.
    dm: async (to, text) => { if (to === 404) throw new Error("403 bot can't initiate conversation with a user"); sent.push({ kind: "dm", to, text }); },
    push: async (wallets, p) => { pushes.push({ wallets, body: p.body }); },
    log: () => {},
    ...over,
  };
  return { deps, sent, pushes, sides, tick: (ms: number) => { clock += ms; } };
}
{
  // The first stake of a Telegram market whose opener has not chosen a wallet.
  const w = world({}, { [YES_W]: "yes" });
  const r = await onBetLanded(bet(YES_W, "yes", 0.5, 0, 0), w.deps);
  const g = w.sent.find((s) => s.kind === "group");
  check("the group hears it, under the tag that opened the market", Boolean(g && g.replyTo === 2 && g.url === URL_M), JSON.stringify(g));
  check("...with no one on the other side to tell yet", r.notices === 0);
  check("the opener is told on Telegram, wallet or not",
    w.sent.some((s) => s.kind === "dm" && s.to === 1775258225 && /you earn 2%/.test(s.text)));
}
{
  // Then the other side arrives: the moment the whole feature exists for.
  // FAITHFUL TO THE LEDGER: the real path writes chain_entry for a stake just
  // before announcing it, so a wallet is "on a side" from its own stake on,
  // never before. The first version of this fixture had NO_W on NO from the
  // start and told it about a YES it had not yet bet against.
  const w = world({ opener: async () => ({ wallet: OPENER_W, tgUserId: null }) },
    { [YES_W]: "yes" }, { [YES_W]: 555 });
  await onBetLanded(bet(YES_W, "yes", 0.5, 0, 0), w.deps);
  w.sides[NO_W] = "no";
  w.sent.length = 0; w.pushes.length = 0;
  w.tick(10 * 60_000);
  const r = await onBetLanded(bet(NO_W, "no", 0.2, 0.5, 0), w.deps);
  check("the first stake on the other side is broadcast, ten minutes in", r.broadcast && w.sent.some((s) => s.kind === "group" && /Both sides are in/.test(s.text)));
  check("the YES bettor is told somebody took the other side", w.sent.some((s) => s.kind === "dm" && s.to === 555 && /other side of your bet/.test(s.text)));
  check("...and so is their browser", w.pushes.some((p) => p.wallets.includes(YES_W) && /other side/.test(p.body)));
  const inbox = await betNoticesFor([YES_W]);
  check("...and it waits in their Activity", inbox.length === 1 && inbox[0].kind === "counter" && inbox[0].side === "no");
  const openerInbox = await betNoticesFor([OPENER_W]);
  check("the opener's Activity has both stakes", openerInbox.length === 2 && openerInbox.every((n) => n.kind === "opened_bet"));
  check("the bettor is never told about their own stake", (await betNoticesFor([NO_W])).length === 0);

  w.sent.length = 0;
  w.tick(5 * 60_000);
  const quiet = await onBetLanded(bet(YES_W, "yes", 0.1, 0.5, 0.2), w.deps);
  check("five minutes later a small top-up is written down, not broadcast", !quiet.broadcast && w.sent.length === 0);
  check("...though the NO bettor's Activity has it", (await betNoticesFor([NO_W])).some((n) => n.kind === "counter"));

  w.tick(60 * 60_000);
  const replay = await onBetLanded(bet(NO_W, "no", 0.2, 0.5, 0), w.deps);
  check("the same stake relayed twice is one notice", replay.notices === 0 && (await betNoticesFor([YES_W])).length === 1);
}
{
  // The opener staking in their own market.
  const w = world({ opener: async () => ({ wallet: YES_W, tgUserId: 1775258225 }) }, { [YES_W]: "yes" });
  await onBetLanded(bet(YES_W, "yes", 0.5, 0, 0), w.deps);
  check("an opener's own stake does not tell them about it",
    !w.sent.some((s) => s.kind === "dm") && (await betNoticesFor([YES_W])).length === 0);
}
{
  // Somebody who never started the bot cannot be messaged; nobody else loses out.
  const w = world({}, { [YES_W]: "yes", [NO_W]: "no" }, { [YES_W]: 404 });
  await onBetLanded(bet(NO_W, "no", 0.2, 0.5, 0), w.deps);
  check("a refused private message does not stop the group ping", w.sent.some((s) => s.kind === "group"));
}
{
  const w = world({ dryRun: true }, { [YES_W]: "yes" });
  await onBetLanded(bet(YES_W, "yes", 0.5, 0, 0), w.deps);
  check("a dry run sends nothing to Telegram", w.sent.length === 0);
}

console.log("\nwired into the money path");
{
  const server = readFileSync("src/server.ts", "utf8");
  const submit = server.slice(server.indexOf('app.post("/api/chain/submit"'));
  const confirmed = submit.slice(submit.indexOf("out.confirmed === true"), submit.indexOf("res.json({ ok: true, signature"));
  check("a confirmed stake, and only a confirmed one, is announced", /await onBetLanded\(\{/.test(confirmed));
  const api = server.slice(server.indexOf('app.get("/api/notices"'), server.indexOf('app.post("/api/notices/seen"'));
  check("the Activity API never sends the wallet that staked", !/actor:/.test(api));
  const store = readFileSync("src/store/markets.ts", "utf8");
  check("notices live in their own table, not the play-money era's `notice`",
    /CREATE TABLE IF NOT EXISTS bet_notice \(/.test(store) && /INSERT INTO bet_notice/.test(store));
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall bet notification checks passed.\n");
process.exit(failures ? 1 : 0);
