/**
 * "A MARKET YOU WERE IN HAS SETTLED", which is a sentence nobody was ever told.
 *
 * Winning on chain reached the winner through no channel at all: not X, not the
 * app, not mail. The money sat in the vault and the only way to find out was to
 * wander back to the profile unprompted. The play-money era had settle_win
 * notices, but they hang off market_call and nothing has written that table
 * since the product stopped using play money.
 *
 * What is pinned here is the shape that makes the notice reach everybody:
 * keyed on the WALLET rather than on an X handle, because a bettor is
 * guaranteed to have one and is not guaranteed to have connected X.
 *
 * Run with: npm run test-payout-notice
 */
if (process.env.DATABASE_URL) { console.error("refusing to run against a database"); process.exit(1); }

import {
  recordPayoutNotices, unseenPayouts, markPayoutsSeen, _resetPayoutNotices,
} from "../src/store/markets.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.error(`  ✗ ${n}`); if (d) console.error(`      ${d}`); }
};

const A = "WalletAAAA1111", B = "WalletBBBB2222", C = "WalletCCCC3333";

async function main() {
  console.log("\npayout notices\n");

  {
    _resetPayoutNotices();
    const n = await recordPayoutNotices("slug-1", [A, B]);
    check("everybody who staked is told", n === 2, String(n));
    check("...and each of them counts it as their own",
      (await unseenPayouts([A])) === 1 && (await unseenPayouts([B])) === 1);
    check("...and nobody else's", (await unseenPayouts([C])) === 0);
  }

  {
    /* A re-resolve, a retried sweep, a reconcile run by hand: all of them come
       back through here, and a notice somebody has already dismissed must not
       be resurrected by one. */
    _resetPayoutNotices();
    await recordPayoutNotices("slug-1", [A]);
    await markPayoutsSeen([A]);
    const again = await recordPayoutNotices("slug-1", [A]);
    check("re-recording the same settlement raises nothing", again === 0 && (await unseenPayouts([A])) === 0,
      String(again));
  }

  {
    // Two markets, one wallet: the badge is a count of settlements, not of
    // markets that happen to exist.
    _resetPayoutNotices();
    await recordPayoutNotices("slug-1", [A]);
    await recordPayoutNotices("slug-2", [A]);
    check("two settlements count as two", (await unseenPayouts([A])) === 2);
    await markPayoutsSeen([A]);
    check("being shown clears both at once", (await unseenPayouts([A])) === 0);
  }

  {
    /* A canonical device can carry more than one linked wallet, and money in
       either of them belongs to whoever is reading the page. */
    _resetPayoutNotices();
    await recordPayoutNotices("slug-1", [A]);
    await recordPayoutNotices("slug-2", [B]);
    check("one browser sees every wallet it is signed in to",
      (await unseenPayouts([A, B])) === 2, String(await unseenPayouts([A, B])));
    await markPayoutsSeen([A, B]);
    check("...and clearing clears them together", (await unseenPayouts([A, B])) === 0);
  }

  {
    // The settlement path is money-critical: nothing here is allowed to throw
    // its way into holding up a resolution.
    _resetPayoutNotices();
    check("a market nobody staked writes nothing", (await recordPayoutNotices("slug-9", [])) === 0);
    check("a settlement with no slug writes nothing", (await recordPayoutNotices("", [A])) === 0);
    check("a duplicate wallet in one settlement is one notice",
      (await recordPayoutNotices("slug-9", [A, A])) === 1);
    check("asking about no wallets is zero, not an error", (await unseenPayouts([])) === 0);
    await markPayoutsSeen([]);
    check("...and clearing none is a no-op", true);
  }

  console.log(failures === 0 ? "\nall payout notice checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FAILED:", (e as Error).message); process.exit(1); });
