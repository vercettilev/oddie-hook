// The entry stamp and the receipt: the system that pays reputation for being
// early, because the pool mechanics never will.
//
// Pari-mutuel pays every winner pro-rata whenever they entered, so the money
// cannot tell a 30% contrarian from a 90% bandwagoner, and a caller who gets
// followed is DILUTED by their own audience. Everything here exists to make
// the entry moment matter: the decoder that reads a signed stake, the stamp
// that writes the crowd's number down while it is still true, and the card
// that turns it into something a winner posts.
//
// Run with: npm run test-receipts
if (process.env.DATABASE_URL) { console.error("refusing to run against a database"); process.exit(1); }

import { anchorDiscriminator, decodeTakePositionIx, entryShareOf } from "../src/chain/oddieChain.js";
import {
  recordChainEntry, chainEntryFor, walletReceipts, walletLeaderboard, slugForOnchainPubkey,
  createCommunityMarket, markCommunityResolved, _resetChainEntries,
  receiptWeight, FULL_CREDIT_LAMPORTS, emailsForWallets, walletsInMarket, openEntriesFor,
  retireMarket, isRetired, openCommunityMarkets, openMarketForSourcePost, recordSurfacer,
} from "../src/store/markets.js";
import { linkAccount, _memAccounts } from "../src/store/accounts.js";
import { renderReceiptCard, VOICE_RECEIPT, textWidth } from "../src/card/renderCard.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.error(`  ✗ ${n}`); if (d) console.error(`      ${d}`); }
};

const W_A = "A".repeat(43), W_B = "B".repeat(43), W_C = "C".repeat(43);

console.log("\nthe decoder reads a signed stake and nothing else");
{
  const ix = (side: number, lamports: bigint, disc = anchorDiscriminator("take_position")) => {
    const b = Buffer.alloc(17);
    disc.copy(b, 0); b.writeUInt8(side, 8); b.writeBigUInt64LE(lamports, 9);
    return b;
  };
  const keys = ["USERKEY", "MARKETKEY", "VAULT", "POSITION", "SYSTEM"];

  const yes = decodeTakePositionIx(ix(0, 5_000_000n), keys);
  check("a YES stake decodes", yes?.side === "yes" && yes.lamports === 5_000_000, JSON.stringify(yes));
  check("...with the user and market from the account order", yes?.user === "USERKEY" && yes?.market === "MARKETKEY");
  check("a NO stake decodes", decodeTakePositionIx(ix(1, 1n), keys)?.side === "no");

  // Everything else through the same relay: claims, fee pulls, garbage. None
  // of it has an entry to stamp, and none of it may decode as one.
  check("another instruction's discriminator is refused", decodeTakePositionIx(ix(0, 5n, anchorDiscriminator("claim_winnings")), keys) === null);
  check("an invalid side is refused", decodeTakePositionIx(ix(7, 5n), keys) === null);
  check("a zero amount is refused", decodeTakePositionIx(ix(0, 0n), keys) === null);
  check("a wrong-length payload is refused", decodeTakePositionIx(Buffer.alloc(16), keys) === null);
  check("too few accounts is refused", decodeTakePositionIx(ix(0, 5n), ["ONLYONE"]) === null);
}

console.log("\nthe crowd number means the crowd, not the crowd plus you");
{
  check("an empty pool answers 50: no crowd, no credit", entryShareOf({ totalYesLamports: 0, totalNoLamports: 0 }, "yes") === 50);
  const pool = { totalYesLamports: 300, totalNoLamports: 100 };
  check("yes side of a 300/100 pool is 75", entryShareOf(pool, "yes") === 75);
  check("no side of the same pool is 25", entryShareOf(pool, "no") === 25);
  check("a one-sided pool reads 100 and 0", entryShareOf({ totalYesLamports: 10, totalNoLamports: 0 }, "yes") === 100 && entryShareOf({ totalYesLamports: 10, totalNoLamports: 0 }, "no") === 0);
}

console.log("\nfirst entry wins, and later size cannot rewrite it");
{
  _resetChainEntries();
  const { slug } = await createCommunityMarket({ question: "Will Arsenal win the league?", closeTime: Math.floor(Date.now() / 1000) + 3600 });
  await recordChainEntry({ slug, wallet: W_A, side: "yes", entryPct: 30, lamports: 1_000_000 });
  // The cheat this exists to kill: enter tiny and early, pile in late, look
  // early with size. The top-up must change nothing.
  await recordChainEntry({ slug, wallet: W_A, side: "yes", entryPct: 90, lamports: 900_000_000 });
  const e = await chainEntryFor(slug, W_A);
  check("the stamp is the first stake", e?.entryPct === 30, String(e?.entryPct));
  check("...and the first size", e?.lamports === 1_000_000);
  check("an unknown wallet has no stamp", (await chainEntryFor(slug, W_B)) === null);
  check("an out-of-range pct is clamped, not stored", await recordChainEntry({ slug, wallet: W_B, side: "no", entryPct: 250, lamports: 1 }).then(() => chainEntryFor(slug, W_B)).then((x) => x?.entryPct === 100));
}

console.log("\na receipt is proof, so an open market cannot mint one");
{
  _resetChainEntries();
  const { slug: open } = await createCommunityMarket({ question: "Still open?", closeTime: Math.floor(Date.now() / 1000) + 3600 });
  const { slug: done } = await createCommunityMarket({ question: "Did BTC close above 100k?", closeTime: Math.floor(Date.now() / 1000) + 3600 });
  await recordChainEntry({ slug: open, wallet: W_A, side: "yes", entryPct: 20, lamports: FULL_CREDIT_LAMPORTS });
  await recordChainEntry({ slug: done, wallet: W_A, side: "yes", entryPct: 30, lamports: FULL_CREDIT_LAMPORTS });
  await recordChainEntry({ slug: done, wallet: W_B, side: "no", entryPct: 70, lamports: FULL_CREDIT_LAMPORTS });
  await markCommunityResolved(done, "yes");

  const a = await walletReceipts(W_A);
  check("only the settled market is a receipt", a.length === 1 && a[0].slug === done, JSON.stringify(a.map((r) => r.slug)));
  check("a win at 30 weighs 70", a[0].won && a[0].weight === 70, JSON.stringify(a[0]));
  check("the receipt carries the question", a[0].question.includes("BTC"));

  const b = await walletReceipts(W_B);
  check("a loss is a receipt too, at weight zero", b.length === 1 && !b[0].won && b[0].weight === 0, JSON.stringify(b[0]));
}

console.log("\nTHE BOARD IS ORDERED BY EARLINESS, NOT BY WIN COUNT");
{
  // The whole reason this board exists: pari-mutuel pays the pile-on the same
  // as the early call, so if the board also crowned the pile-on, nothing
  // anywhere would reward having been right when it was hard to be.
  _resetChainEntries();
  const mk = async (q: string, out: "yes" | "no") => {
    const { slug } = await createCommunityMarket({ question: q, closeTime: Math.floor(Date.now() / 1000) + 3600 });
    return { slug, out };
  };
  const m1 = await mk("m1?", "yes"), m2 = await mk("m2?", "yes"), m3 = await mk("m3?", "yes"), m4 = await mk("m4?", "yes");

  // C: one brave call at 25 that won -> 75 points.
  await recordChainEntry({ slug: m1.slug, wallet: W_C, side: "yes", entryPct: 25, lamports: FULL_CREDIT_LAMPORTS });
  // A: three bandwagon wins at 90 -> 30 points, more wins, fewer points.
  for (const m of [m2, m3, m4]) await recordChainEntry({ slug: m.slug, wallet: W_A, side: "yes", entryPct: 90, lamports: FULL_CREDIT_LAMPORTS });
  // B: a loss, worth nothing but counted.
  await recordChainEntry({ slug: m1.slug, wallet: W_B, side: "no", entryPct: 75, lamports: FULL_CREDIT_LAMPORTS });
  for (const m of [m1, m2, m3, m4]) await markCommunityResolved(m.slug, m.out);

  const board = await walletLeaderboard();
  check("one contrarian win outranks three bandwagon wins", board[0]?.wallet === W_C && board[1]?.wallet === W_A,
    JSON.stringify(board.map((w) => [w.wallet.slice(0, 3), w.points])));
  check("the points say why", board[0]?.points === 75 && board[1]?.points === 30);
  check("losses are counted, never scored", board.find((w) => w.wallet === W_B)?.losses === 1 && board.find((w) => w.wallet === W_B)?.points === 0);
}

console.log("\nthe card is a flex, not a disclosure");
{
  const svg = renderReceiptCard("Will Arsenal win the league?", { side: "yes", entryPct: 30 });
  check("it says what was called and when", svg.includes("called YES at 30%"));
  check("it carries the question", svg.includes("Arsenal"));
  check("it is marked as settled on chain", svg.includes("settled on chain"));
  // No amounts anywhere: size dressing up as conviction is the exact cheat the
  // first-entry stamp exists to kill, and the card must not reopen it. The
  // embedded logo's base64 is stripped first: random base64 contains every
  // three-letter string eventually, and this check is about the words on the
  // card, not the bytes under it.
  const visible = svg.replace(/data:image[^"]+/g, "");
  check("no SOL amount appears", !/SOL|lamport/i.test(visible), visible.match(/.{0,30}(SOL|lamport).{0,30}/i)?.[0] ?? "");

  const esc = renderReceiptCard('Will "A&B" <win>?', { side: "no", entryPct: 88 });
  check("the question is escaped", esc.includes("&amp;") && !esc.includes("<win>"));

  for (const v of VOICE_RECEIPT) {
    check(`voice line fits at 32: "${v}"`, textWidth(v, 32) < 860, String(textWidth(v, 32)));
  }
}


console.log("\nDEPTH IS WHAT MAKES EARLINESS EXPENSIVE TO FAKE");
{
  // The formula, purely. Full credit needs a real pool behind it.
  const full = FULL_CREDIT_LAMPORTS;
  check("a 30% call in a full pool is worth 70", receiptWeight({ entryPct: 30, won: true, poolLamports: full }) === 70);
  check("a loss is worth nothing however deep", receiptWeight({ entryPct: 0, won: false, poolLamports: full * 10 }) === 0);
  check("deeper than the reference does not pay more", receiptWeight({ entryPct: 30, won: true, poolLamports: full * 100 }) === 70);
  check("half the depth is half the credit", receiptWeight({ entryPct: 0, won: true, poolLamports: full / 2 }) === 50);

  // THE ATTACK, priced. Two wallets you control: one puts the minimum stake on
  // NO in an empty market, the other then calls YES at a 0% share. You need not
  // predict anything, because one of your wallets always wins. Before depth
  // scaling that receipt was worth the maximum and cost about a cent.
  const dustPool = 2_000_000; // two minimum stakes, 0.002 SOL
  check("the manufactured perfect call is worth ~nothing", receiptWeight({ entryPct: 0, won: true, poolLamports: dustPool }) === 0,
    String(receiptWeight({ entryPct: 0, won: true, poolLamports: dustPool })));
  // ...and an honest call in a real market is untouched.
  check("an honest call in a real pool keeps its credit", receiptWeight({ entryPct: 20, won: true, poolLamports: full }) === 80);
}

console.log("\nthe board and the receipts cannot disagree");
{
  _resetChainEntries();
  const deep = await createCommunityMarket({ question: "Deep market?", closeTime: Math.floor(Date.now() / 1000) + 3600 });
  const dust = await createCommunityMarket({ question: "Dust market?", closeTime: Math.floor(Date.now() / 1000) + 3600 });
  // Same perfect entry (0%) in both. Only the depth differs.
  await recordChainEntry({ slug: deep.slug, wallet: W_A, side: "yes", entryPct: 0, lamports: FULL_CREDIT_LAMPORTS });
  await recordChainEntry({ slug: dust.slug, wallet: W_B, side: "yes", entryPct: 0, lamports: 1_000_000 });
  await markCommunityResolved(deep.slug, "yes");
  await markCommunityResolved(dust.slug, "yes");

  const ra = await walletReceipts(W_A), rb = await walletReceipts(W_B);
  check("the deep call scores full", ra[0]?.weight === 100, JSON.stringify(ra[0]));
  check("the dust call scores ~nothing", (rb[0]?.weight ?? -1) === 0, JSON.stringify(rb[0]));
  check("the receipt reports the depth it was scored on", ra[0]?.poolLamports === FULL_CREDIT_LAMPORTS);

  // The board must agree with the receipts, exactly. Two formulas is one
  // formula too many.
  const board = await walletLeaderboard();
  const pa = board.find((w) => w.wallet === W_A)?.points;
  const pb = board.find((w) => w.wallet === W_B)?.points;
  check("the board matches the receipt for the deep call", pa === ra[0]?.weight, `${pa} vs ${ra[0]?.weight}`);
  check("...and for the dust call", pb === rb[0]?.weight, `${pb} vs ${rb[0]?.weight}`);
  check("a dust farmer still shows the win, worth zero", board.find((w) => w.wallet === W_B)?.wins === 1);
  _resetChainEntries();
}


console.log("\nREACHING A WALLET IS OPT-IN, AND NOTHING HERE CREATES A LINK");
{
  _resetChainEntries();
  _memAccounts.length = 0;
  const m = await createCommunityMarket({ question: "Reachable?", closeTime: Math.floor(Date.now() / 1000) + 3600 });
  await recordChainEntry({ slug: m.slug, wallet: W_A, side: "yes", entryPct: 20, lamports: FULL_CREDIT_LAMPORTS });
  await recordChainEntry({ slug: m.slug, wallet: W_B, side: "no", entryPct: 80, lamports: FULL_CREDIT_LAMPORTS });

  // A staker who never linked anything is unreachable, and that is correct: a
  // stake must never by itself tell us who somebody is.
  check("a bare wallet is not reachable", Object.keys(await emailsForWallets([W_A, W_B])).length === 0);

  // Half a link is not a link. Wallet signed, but no email on the device.
  await linkAccount("dev-1", { provider: "phantom", uid: W_A });
  check("a linked wallet with no email is still unreachable", Object.keys(await emailsForWallets([W_A])).length === 0);

  // Both halves, deliberately given by the same person on the same device.
  await linkAccount("dev-1", { provider: "google", uid: "g-1", email: "a@example.com" });
  const reach = await emailsForWallets([W_A, W_B]);
  check("both halves make a wallet reachable", reach[W_A] === "a@example.com", JSON.stringify(reach));
  check("...and only that wallet", reach[W_B] === undefined);

  // A different person's email must never leak across devices.
  await linkAccount("dev-2", { provider: "google", uid: "g-2", email: "b@example.com" });
  await linkAccount("dev-2", { provider: "phantom", uid: W_C });
  const both = await emailsForWallets([W_A, W_C]);
  check("each wallet gets its own device's address", both[W_A] === "a@example.com" && both[W_C] === "b@example.com", JSON.stringify(both));

  check("the market's stakers are listed for the notice", (await walletsInMarket(m.slug)).length === 2);
  _memAccounts.length = 0;
  _resetChainEntries();
}

console.log("\nopen stakes are the OPEN ones, and a stamp is only a candidate");
{
  _resetChainEntries();
  const open = await createCommunityMarket({ question: "Still running?", closeTime: Math.floor(Date.now() / 1000) + 3600 });
  const done = await createCommunityMarket({ question: "Finished?", closeTime: Math.floor(Date.now() / 1000) + 3600 });
  await recordChainEntry({ slug: open.slug, wallet: W_A, side: "yes", entryPct: 30, lamports: 5_000_000 });
  await recordChainEntry({ slug: done.slug, wallet: W_A, side: "no", entryPct: 40, lamports: 5_000_000 });
  await markCommunityResolved(done.slug, "no");

  const list = await openEntriesFor(W_A);
  check("a settled market is not an open stake", list.length === 1 && list[0].slug === open.slug, JSON.stringify(list.map((x) => x.slug)));
  check("it carries what the panel needs", list[0].question.includes("Still running") && list[0].side === "yes" && list[0].entryPct === 30);
  check("another wallet sees none of it", (await openEntriesFor(W_B)).length === 0);
  _resetChainEntries();
}


console.log("\nRETIRING HIDES A MARKET FROM DISCOVERY, NEVER FROM ITS OWNER");
{
  _resetChainEntries();
  const m = await createCommunityMarket({ question: "Off the board?", closeTime: Math.floor(Date.now() / 1000) + 3600 });
  await recordSurfacer(m.slug, { sourceUrl: "https://x.com/someone/status/77771111" });

  const before = (await openCommunityMarkets()).length;
  check("it starts on the board", before > 0);
  check("and its source post is taken", (await openMarketForSourcePost("https://x.com/someone/status/77771111")) !== null);

  // THE GUARD NOTHING OVERRIDES. Hiding a market somebody has money in is
  // hiding their money, so a funded vault is refused...
  const funded = await retireMarket(m.slug, 5_000_000);
  check("a market holding SOL is refused", !funded.ok && Boolean(funded.reason?.includes("SOL")), JSON.stringify(funded));
  // ...and so is one we could not check, because "we could not check" must
  // never resolve to "go ahead".
  const unknown = await retireMarket(m.slug, null);
  check("an unreadable vault is refused too", !unknown.ok && Boolean(unknown.reason?.includes("could not be read")), JSON.stringify(unknown));
  check("neither refusal changed anything", !(await isRetired(m.slug)));

  const out = await retireMarket(m.slug, 0);
  check("an empty market retires", out.ok && (await isRetired(m.slug)));
  check("it leaves the board", (await openCommunityMarkets()).length === before - 1);
  // The whole point: a fresh tag on the same post opens a FRESH market rather
  // than pointing somebody at a dead one.
  check("its source post is free again", (await openMarketForSourcePost("https://x.com/someone/status/77771111")) === null);

  // Latches, so a second run reports honestly instead of moving the timestamp.
  check("retiring twice is not a second retirement", !(await retireMarket(m.slug, 0)).ok);
  _resetChainEntries();
}

console.log("\nthe pubkey-to-slug lookup answers only what it knows");
{
  check("an unknown pubkey is null, not an error", (await slugForOnchainPubkey("nope")) === null);
}

console.log(failures === 0 ? "\nall receipt checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
