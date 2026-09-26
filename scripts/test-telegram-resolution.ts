// The settlement notice in Telegram: where it goes, what it says, and what it
// must never say. The fake send enforces Telegram's own contract (a real chat
// id, a positive message id, a caption within 1024 characters, a photo URL it
// can fetch), because a fake that accepts anything is how the first live
// Telegram tag failed silently.
import { readFileSync } from "node:fs";
import {
  parseTgKey, threadsFrom, solText, tgResolutionText, postTelegramResolution, type TgResolutionDeps,
} from "../src/telegram/resolution.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

const APP = "https://app.oddie.fun";
const URL_M = `${APP}/m/will-bitcoin-btc-reach-a-price-f34a9c`;

console.log("ledger keys and threads");
{
  check("a supergroup key parses, negative id and all",
    JSON.stringify(parseTgKey("tg:-1004413284410:2")) === JSON.stringify({ chatId: -1004413284410, messageId: 2 }));
  check("an X key is not a Telegram thread", parseTgKey("2103403084542312820") === null && parseTgKey("x:123") === null);
  check("message id zero and junk are refused", parseTgKey("tg:-100:0") === null && parseTgKey("tg:abc:1") === null);

  const t = threadsFrom([
    { key: "tg:-1001:2", reason: "opened" },
    { key: "tg:-1002:5", reason: "existing" },
    { key: "tg:-1002:9", reason: "existing" },
    { key: "tg:-1001:7", reason: "existing" },
    { key: "not-a-key", reason: "opened" },
  ]);
  const a = t.find((x) => x.chatId === -1001), b = t.find((x) => x.chatId === -1002);
  check("one thread per group", t.length === 2);
  check("the group it was opened in answers the opener's own message", a?.messageId === 2 && a.opened === true);
  check("a group that only got a pointer answers its latest tag", b?.messageId === 9 && b.opened === false);
}

console.log("\nthe amount, in words");
{
  check("0.04 SOL", solText(40_000_000) === "0.04", solText(40_000_000));
  check("1.5 SOL", solText(1_500_000_000) === "1.5", solText(1_500_000_000));
  check("2 SOL", solText(2_000_000_000) === "2", solText(2_000_000_000));
  check("a tiny cut is not rounded to zero", solText(20_000) === "0.00002", solText(20_000));
  check("four places below one SOL", solText(1_234_567) === "0.0012", solText(1_234_567));
}

console.log("\nwhat it says");
{
  const base = { outcome: "yes" as const, marketUrl: URL_M };
  const empty = tgResolutionText({ ...base, pool: 0, won: 0 });
  check("a market nobody staked still gets its result", empty.startsWith("Settled: YES.") && empty.endsWith(URL_M));
  check("...and no sentence about money that does not exist", !/stake|paid|fee/i.test(empty), empty);
  check("nobody on the winning side: everyone refunded, no fee",
    /every stake goes back in full\. We took no fee\./.test(tgResolutionText({ ...base, pool: 5e8, won: 0 })));
  check("winners exist: paid from the pool",
    /Everyone who called it is paid from the pool, on chain\./.test(tgResolutionText({ ...base, pool: 5e8, won: 1e8 })));
  check("an unreadable vault says nothing about money",
    !/stake|paid|fee/i.test(tgResolutionText({ ...base, pool: null, won: null })));

  const linked = tgResolutionText({ ...base, pool: 2e9, won: 1e9,
    opener: { handle: "levvercetti", feeLamports: 40_000_000, linked: true, collectUrl: `${APP}/profile` } });
  check("a linked opener is named, told the amount, and sent to the profile",
    linked.includes(`@levvercetti, you opened this market and earned 0.04 SOL. Collect it on your profile: ${APP}/profile`), linked);
  const unlinked = tgResolutionText({ ...base, pool: 2e9, won: 1e9,
    opener: { handle: null, feeLamports: 40_000_000, linked: false, collectUrl: "https://t.me/oddiefunbot?start=earn" } });
  check("an opener with no @name is addressed as you, since the message replies to them",
    unlinked.includes("You opened this market and earned 0.04 SOL. Choose the wallet it goes to: https://t.me/oddiefunbot?start=earn"), unlinked);
  check("no cut owed, no opener line",
    !/opened this market/.test(tgResolutionText({ ...base, pool: 2e9, won: 0,
      opener: { handle: "x", feeLamports: 0, linked: true, collectUrl: `${APP}/profile` } })));
  check("no em or en dashes anywhere", ![empty, linked, unlinked].some((t) => /[–—]/.test(t)));
}

console.log("\nwhere it goes, against a faithful Telegram");
{
  type Sent = { chatId: number; replyTo: number; text: string; photoUrl: string | null };
  const make = (over: Partial<TgResolutionDeps> = {}, fail: number[] = []) => {
    const sent: Sent[] = [];
    let vaultReads = 0;
    const deps: TgResolutionDeps = {
      dryRun: false,
      appBaseUrl: APP,
      botUsername: "oddiefunbot",
      threads: async () => [
        { key: "tg:-1004413284410:2", reason: "opened" },
        { key: "tg:-1009999:14", reason: "existing" },
      ],
      opener: async () => ({ handle: "levvercetti", linked: false }),
      vault: async () => { vaultReads++; return { pool: 2e9, won: 1e9, creatorFee: 40_000_000 }; },
      cardUrl: (s, o) => `https://oddie.fun/card/${s}.png?v=${o}`,
      send: async (m) => {
        if (!Number.isSafeInteger(m.chatId) || m.chatId === 0) throw new Error("400 chat not found");
        if (!Number.isSafeInteger(m.replyTo) || m.replyTo <= 0) throw new Error("400 bad reply_parameters");
        if (m.photoUrl && !/^https:\/\//.test(m.photoUrl)) throw new Error("400 wrong file identifier/HTTP URL");
        if (m.photoUrl && m.text.length > 1024) throw new Error("400 caption is too long");
        if (fail.includes(m.chatId)) throw new Error("403 bot was kicked from the group");
        sent.push(m);
      },
      log: () => {},
      ...over,
    };
    return { deps, sent, reads: () => vaultReads };
  };

  const slug = "will-bitcoin-btc-reach-a-price-f34a9c";
  {
    const { deps, sent } = make();
    const r = await postTelegramResolution(slug, "yes", deps);
    const opened = sent.find((m) => m.chatId === -1004413284410);
    const pointer = sent.find((m) => m.chatId === -1009999);
    check("one message per group", r.posted === 2 && sent.length === 2);
    check("the opener's group answers the opener's own message", opened?.replyTo === 2);
    check("...with the card showing the verdict", Boolean(opened?.photoUrl?.includes(`/card/${slug}.png?v=yes`)));
    check("...and names the cut there", Boolean(opened?.text.includes("@levvercetti, you opened this market and earned 0.04 SOL")));
    check("a group that only got a pointer hears the result, not the opener's cut",
      pointer?.replyTo === 14 && !/opened this market/.test(pointer.text));
    check("an opener with no wallet yet is sent to a private chat, never a token URL",
      Boolean(opened?.text.includes("https://t.me/oddiefunbot?start=earn")) && !sent.some((m) => /tg\/earn\?t=/.test(m.text)));
  }
  {
    const { deps, sent } = make({ opener: async () => ({ handle: "levvercetti", linked: true }) });
    await postTelegramResolution(slug, "no", deps);
    check("a linked opener is sent to the profile", sent[0]?.text.includes(`Collect it on your profile: ${APP}/profile`));
  }
  {
    const { deps, sent } = make({ dryRun: true });
    const r = await postTelegramResolution(slug, "yes", deps);
    check("dry run sends nothing and still writes the words", sent.length === 0 && r.skipped === "dry-run" && r.texts.length === 2);
  }
  {
    const { deps, sent, reads } = make({ threads: async () => [] });
    const r = await postTelegramResolution(slug, "yes", deps);
    check("a market that never came from Telegram posts nothing and reads nothing",
      sent.length === 0 && r.skipped === "no-thread" && reads() === 0);
  }
  {
    const { deps, sent } = make({}, [-1004413284410]);
    const r = await postTelegramResolution(slug, "yes", deps);
    check("a group that refuses does not stop the next one", r.failed === 1 && r.posted === 1 && sent[0]?.chatId === -1009999);
  }
  {
    const { deps, sent } = make({ vault: async () => null });
    await postTelegramResolution(slug, "yes", deps);
    check("an unreadable vault still announces the result, with no money and no cut",
      sent.length === 2 && sent.every((m) => m.text.startsWith("Settled: YES.") && !/paid|stake|earned/.test(m.text)));
  }
}

console.log("\nwired into settlement");
{
  const server = readFileSync("src/server.ts", "utf8");
  check("the notice waits for the chain to have the verdict", /chainDone\.then\(\(\) => postTelegramResolution\(/.test(server));
  check("the chain resolve is what chainDone waits on", /return resolvedOnChain;/.test(server));
  check("the card route draws the verdict", /settled: verdict,/.test(server));
  check("...and settlement drops the cached open card", /pngCache\.delete\(slug\);/.test(server));
  const store = readFileSync("src/store/markets.ts", "utf8");
  check("X never replies to a Telegram message id", /AND tweet_id NOT LIKE 'tg:%'\s*\n\s*ORDER BY at DESC LIMIT 1/.test(store));
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall telegram resolution checks passed.\n");
process.exit(failures ? 1 : 0);
