/**
 * The Genesis season's rules, against the in-memory backend.
 *
 * These are money-adjacent rules (tickets gate whether a market is minted at
 * all, and the board is the campaign's only number), so they get asserted
 * rather than eyeballed. Everything here runs with no DATABASE_URL: the pg
 * branch mirrors the same logic and is exercised against a real database by
 * the deploy, but the RULES are what these cases pin down.
 */
import {
  GENESIS_TICKETS, ticketsLeft, spendTicketForTag, creditFundedBettor,
  genesisStanding, genesisBoard, _resetSeason,
} from "../src/genesis/season.js";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
}

async function main(): Promise<void> {
  // --- the balance ---------------------------------------------------------
  _resetSeason();
  check("a handle nobody has seen starts with the full five",
    (await ticketsLeft("stranger")) === GENESIS_TICKETS);
  check("the @ is optional and case does not matter",
    (await ticketsLeft("@STRANGER")) === GENESIS_TICKETS);
  check("a handle X could never issue has nothing",
    (await ticketsLeft("this-is-not-a-handle")) === 0);

  // --- spending ------------------------------------------------------------
  _resetSeason();
  check("opening a market spends exactly one", await spendTicketForTag("m1", "alice", "bob")
    && (await ticketsLeft("alice")) === GENESIS_TICKETS - 1);
  check("the claim's author is not charged", (await ticketsLeft("bob")) === GENESIS_TICKETS);

  await spendTicketForTag("m1", "alice", "bob");
  check("a retried sweep charges once for the same market",
    (await ticketsLeft("alice")) === GENESIS_TICKETS - 1);

  for (const slug of ["m2", "m3", "m4", "m5"]) await spendTicketForTag(slug, "alice", "bob");
  check("five tags empty the book", (await ticketsLeft("alice")) === 0);
  check("the sixth tag is refused", (await spendTicketForTag("m6", "alice", "bob")) === false);
  check("a refused tag leaves no debt", (await ticketsLeft("alice")) === 0);
  check("and opens no market row", (await genesisStanding("alice")).marketsOpened === 5);

  // --- the board and the regen --------------------------------------------
  _resetSeason();
  await spendTicketForTag("m1", "alice", "bob");
  await creditFundedBettor("m1", "wallet-A");
  check("a new funded wallet counts for whoever tagged the market",
    (await genesisStanding("alice")).takers === 1);
  check("and hands the ticket back", (await ticketsLeft("alice")) === GENESIS_TICKETS);

  await creditFundedBettor("m1", "wallet-A");
  check("the same wallet betting again is still one person",
    (await genesisStanding("alice")).takers === 1);

  await spendTicketForTag("m2", "alice", "carol");
  await creditFundedBettor("m2", "wallet-A");
  check("a wallet's credit never moves to a second market (first touch)",
    (await genesisStanding("alice")).takers === 1);

  // The cap. Alice is at 4 (spent m2), one new wallet refills her to 5, and a
  // second one must NOT mint a sixth.
  await creditFundedBettor("m2", "wallet-B");
  check("bringing people back refills what was spent", (await ticketsLeft("alice")) === GENESIS_TICKETS);
  await creditFundedBettor("m2", "wallet-C");
  check("but never mints a sixth ticket", (await ticketsLeft("alice")) === GENESIS_TICKETS);
  check("while the board still counts every person",
    (await genesisStanding("alice")).takers === 3);

  // --- your own wallet never counts (the rule the page prints) -------------
  _resetSeason();
  await spendTicketForTag("m1", "alice", "bob");
  await creditFundedBettor("m1", "wallet-alice", "alice");
  check("funding your own market scores nothing",
    (await genesisStanding("alice")).takers === 0);
  check("and hands no ticket back", (await ticketsLeft("alice")) === GENESIS_TICKETS - 1);
  await creditFundedBettor("m1", "wallet-alice2", "ALICE");
  check("upper case is the same person", (await genesisStanding("alice")).takers === 0);
  // The wallet is NOT burned: it must still be able to count for somebody else.
  await spendTicketForTag("m2", "bob", null);
  await creditFundedBettor("m2", "wallet-alice", "alice");
  check("that same wallet still counts for somebody else",
    (await genesisStanding("bob")).takers === 1);
  await creditFundedBettor("m1", "wallet-stranger", "carol");
  check("somebody else's wallet counts normally",
    (await genesisStanding("alice")).takers === 1);
  await creditFundedBettor("m1", "wallet-anon", null);
  check("an unlinked wallet counts (we cannot prove it is yours)",
    (await genesisStanding("alice")).takers === 2);

  // --- an untagged market credits nobody -----------------------------------
  _resetSeason();
  await creditFundedBettor("orphan", "wallet-Z");
  check("a market nobody tagged credits nobody", (await genesisBoard()).length === 0);

  // --- ranking -------------------------------------------------------------
  _resetSeason();
  await spendTicketForTag("a1", "alice", null);
  await spendTicketForTag("b1", "bob", null);
  await spendTicketForTag("c1", "carol", null);
  for (const w of ["w1", "w2", "w3"]) await creditFundedBettor("a1", w);
  for (const w of ["w4", "w5", "w6"]) await creditFundedBettor("b1", w);
  await creditFundedBettor("c1", "w7");

  const board = await genesisBoard();
  check("the board is ordered by people", board.map((r) => r.takers).join(",") === "3,3,1", board);
  check("a tie shares a rank", board[0].rank === 1 && board[1].rank === 1);
  check("and the next number is 2, not 3 (dense)", board[2].rank === 2, board);
  check("standing agrees with the board", (await genesisStanding("carol")).rank === 2);
  check("somebody who brought nobody has no rank", (await genesisStanding("dave")).rank === null);
  check("the board only holds people who brought somebody",
    board.every((r) => r.takers > 0) && board.length === 3);

  const one = await genesisStanding("alice");
  check("standing reports markets opened", one.marketsOpened === 1);
  check("standing reports people brought", one.takers === 3);

  console.log(failed === 0 ? "\nall genesis season checks passed." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
