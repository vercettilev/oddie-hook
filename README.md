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

**The rule is on chain now.** A market's resolution criteria are an argument to
`create_market`, so the text is in that transaction's instruction data forever,
and `criteria_hash` in account state is sha256 of it. Anyone can check that the
rule oddie shows for a market is the rule the market was opened under, and the
ledger keeps the text readable if oddie is gone. Deployed
[`2RfwMf4s…uju6ywQf`](https://explorer.solana.com/tx/2RfwMf4sUq7FjFwaemipsPETAHXaf9QRt7aHFhXfXss5z1zsBdTi2Eisds8YgMojsp4aSuZYZTsu1wy2uju6ywQf),
with the deployed bytes verified identical to this source.

**A zero hash means the market was never committed to a rule**, and three
markets carry one: they were opened before the field existed and were migrated
into the new 194-byte layout with their pools intact. Hashing whatever criteria
the database holds for them today would manufacture exactly the proof this
field exists to make real, so they keep the zero.

**Still to do:** move the upgrade authority behind a multisig and a timelock,
and publish a verifiable build so the deployed bytes can be matched to this
source by somebody who is not us.

Deliberately NOT on that list: a close-time guard on `resolve_market`. It was
there and was removed on purpose, because it locked real money for two months to
protect against nothing the outcome changes. An authority that settles early is
a key-custody problem and the multisig is its answer, not a `require!`.

One of these is now a deployed guarantee rather than a sentence: the rule a
market settles by is pinned in the transaction that opened it. The rest are
still sentences, and saying which is which is the only part of this worth
anything.

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

## The one piece of configuration that is not optional

`SOLANA_RPC_URL` must point at a keyed endpoint. Solana's public one
(`api.mainnet-beta.solana.com`) is documented as not for production and it does
not degrade politely: on 2026-09-22 it answered 429 to this server with ONE
market and ONE visitor, every card rendered "can't read this pool" with both
sides disabled, and the feed took 8.3 seconds to say so.

The read layer is cached per market and shared across visitors, so audience
size is not what exhausts the budget -- a thousand people on the feed cost the
same as one. What costs is markets under simultaneous view, and stakes, which
cannot be cached because a bet must price against a fresh pool. So the failure
at scale is not a dark feed, it is bets failing quietly.

The server warns at boot if this is pointed at the public endpoint.

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
