# oddie

**Tag any claim on X and it becomes a real market on Solana.**

Someone tags [@oddiefun](https://x.com/oddiefun) under a post. An agent reads the
argument, decides whether it can actually be settled, writes the resolution
criteria and a deadline, and opens a pari-mutuel market. The bot answers the
original tweet with a card anyone can tap. People take YES or NO with real SOL.
At the deadline the market settles itself and the bot posts the result back
under the tweet that started it.

No listing desk. On a price claim, no model decides who won: the answer is
arithmetic over published candles. Settlement is the distribution.

- Live: [oddie.fun](https://oddie.fun) · app at [app.oddie.fun](https://app.oddie.fun)
- Program: [`3SYG7hzQBYGc853BGTxcBtTLefESaP9DqP5aHbvgnYsu`](https://explorer.solana.com/address/3SYG7hzQBYGc853BGTxcBtTLefESaP9DqP5aHbvgnYsu) on Solana mainnet

## It has run end to end, unattended

On 15 September 2026 a tag landed at `13:17:08.818Z` and the market was live and
answering at `13:17:33.026Z`. Both are tweet ids, so the twenty-four seconds is
arithmetic anyone can redo. On 18 September it closed itself at the deadline,
read the token's published price history, answered NO, and posted the result
under the original tweet.

**The honest caveat:** that tag and that stake were ours. It proves the machine
runs unattended. It does not prove demand.

## The loop

```
mention on X
  → extractClaim()     is there a claim here, can it be settled, by when
  → market opens       minted on chain at the first stake, not before
  → the bot replies    a rendered card under the original tweet
  → people stake       their own wallet signs; we never hold or sign for funds
  → the deadline       oracle decides, or abstains out loud
  → the bot replies    the result, under the tweet that started it
```

## The oracle has two paths, and the cheap one is the common one

A **price claim** resolves from published candles and nothing else: DexScreener
for token identity, GeckoTerminal for hourly OHLCV, then arithmetic. No model is
consulted and no tokens are spent. Coverage is checked as *bracketed*, not as a
candle count, so a sparse history cannot be mistaken for a confident NO.

**Anything else** goes through propose → citation audit → blind second read,
with the gates ANDed. If any gate fails it settles nothing, writes down which
gate stopped it, and waits for a person. It abstains far more often than it
decides, and that is the design.

## What we can and cannot do

The honest version, because the code is here and anyone can check it.

**We cannot take a stake.** Every lamport leaves a vault through one of five
paths, and four of them are bounded by the caller's own position and signed by
its owner. The authority is not even an account on `claim_winnings`.

**We do sign the outcome.** `resolve_market` takes a raw outcome byte from one
key. There is no oracle account, no evidence on chain, no challenge period. The
oracle that produces the answer is deterministic for price claims and abstains
rather than guess for everything else, but what the chain sees is a signature.

**So the real exposure is not a drain, it is a decision.** The same key could
stake the thin side of a market and then resolve that side as the winner.
Nothing in the program stops it today.

**And the program is upgradeable.** Upgrade authority
`52YvH8wXqfxgdmXpPuJkwewyw4Pwzj67PSsY3GrXL77z`, which is deliberately not the
key the server signs with. New code could do anything to money already in
vaults, so every line above is conditional on that one key.

**Written, not deployed.** The program in this repo now forbids the authority
from holding a side of a market it resolves, through `take_position` and through
`take_listing`, which is the other way into a seat. It also makes
`refund_after_deadline` decrement the market totals, without which a resolve
after a refund prices payouts against money that has already left the vault and
strands the last winner. Neither is live: the deployed bytes are still the ones
at the slot above, and an upgrade is a separate, deliberate act.

Still to do: put the resolution criteria on chain so the rule cannot change
after people stake (this changes the account layout from 162 bytes and needs a
migration, so it comes last); move the upgrade authority behind a multisig and a
timelock; publish a verifiable build so the deployed bytes can be matched to
this source.

Deliberately NOT on that list: a close-time guard on `resolve_market`. It was
there and was removed on purpose, because it locked real money for two months to
protect against nothing the outcome changes. An authority that settles early is
a key-custody problem and the multisig is its answer, not a `require!`.

None of the deployed guarantees have changed yet. Saying so is the only one
worth anything before they do.

## The money

4% when a market is over and nothing before: 2% to whoever opened it, for as
long as the market exists, and 2% to the protocol. Both rates are frozen into
the market at creation, so changing the rate can never reprice an open pool.

A pool with no winners is refunded in full and charged nothing, because taking a
cut of a refund would be charging people for our own inability to price the
question.

## Layout

```
onchain/programs/oddie_chain/   the Anchor program: markets, vaults, positions,
                                a peer-to-peer listing book (1188 lines)
src/chain/                      client: reads, transaction assembly, resolve
src/matching/                   tweet → claim, criteria, deadline; duplicate check
src/oracle/                     the decision, its gates, and what it refuses
src/price/                      DexScreener + GeckoTerminal, the deterministic path
src/card/                       every card the bot posts, drawn as SVG server-side
src/x/                          mentions, replies, the resolution post
src/auth/                       Sign In With Solana
src/store/                      Postgres, and the schema comments explaining it
public/                         the app: hand-written HTML, no framework
scripts/                        49 test suites, probes, and the deck generator
```

## Run it

```bash
npm install
npm test          # 49 suites, all offline
npm run dev       # :3000
```

`npm test` runs against fixtures and needs no network, no database and no keys.
Everything that touches production is a separate `peek-*` script.

## Notes

The comments in this repo explain **why**, not what. Where a decision looks
strange, the comment next to it is usually the story of the bug that caused it.
`src/store/markets.ts` and `src/oracle/oracle.ts` are the two worth reading.

Development is AI-assisted with Claude Code. The Anthropic API is used in
production for claim extraction and the citation oracle, and for nothing on the
price path.
