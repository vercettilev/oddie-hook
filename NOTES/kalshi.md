# Kalshi: how it's queried, and the three traps

**Status: ON.** `ENABLE_KALSHI=1`, set on the `poppin-hook` service. Read-only
odds source: nobody signs in, nobody deposits, nothing executes, and no card
ever names the venue. It is here because it prices the Fed, CPI, GDP and
unemployment questions Polymarket does not.

Contributes **169 markets, 87 of them bettable** (4–96%): 54 Politics,
29 economics (which the categorizer calls Other, so they live in the matcher's
universe and never reach the feed), 4 Crypto.

Turning it off again is a one-line change here **and** an edit to the "both
venues are enabled" precondition in `scripts/smoke.ts`, which is deliberate:
switching a venue off should not be something a green suite can hide.

Measured 2026-07-09, re-measured 2026-07-10, against
`https://external-api.kalshi.com/trade-api/v2`.

## Trap 1: the parlay endpoint (what kept it off for a week)

The fetcher asks for `/markets?status=open&limit=200`. That endpoint serves
**multivariate event (MVE) markets first** — auto-generated parlays whose
`title` is a comma-joined list of legs:

```
"yes 8+ corners,yes Lionel Messi: 1+,yes Erling Haaland: 1+,yes Argentina: 5"
```

Kalshi generates these continuously, so they dominate the default ordering:

| measurement | result |
|---|---|
| markets scanned via `/markets?status=open` pagination | 12,000 |
| of those, MVE/parlay | 12,000 (100%) |
| of those, real single-question markets | 0 |
| first non-MVE market appears at | ~13,000 markets in (page 12 of 1000) |

So a `limit=200` page has **never** contained a real market. Every Kalshi
market poppin ever ingested was a parlay.

Two consequences, both bad:

1. A parlay title is not a question. It renders as comma soup on the card.
2. It still *matches*. It shares leg names with tweets, so `"messi is scoring
   tonight for sure"` hits one at **0.250** and `"haaland is unstoppable,
   argentina too"` at **0.500** — both well over `MIN_OVERLAP` (0.19). The
   matcher isn't going quiet here; it's confidently matching an unreadable
   market, and the card ships publicly. That's worse than a miss.

`isMultiLeg()` in `src/venues/kalshi.ts` drops them at the fetch boundary, on
structured fields (`mve_collection_ticker`, `mve_selected_legs`, `KXMVE` event
prefix) rather than by guessing from the text. It removes 200/200 of a live
page and 0/26 of known-real markets. Keep it when re-enabling.

## What works

Real Kalshi markets exist and have clean, single-question titles. Two queries
reach them:

### 1. `/events?status=open&limit=200`

200 events, **0 MVE**. Clean titles straight out:

```
KXELONMARS-99         "Will Elon Musk visit Mars in his lifetime?"
KXNEWPOPE-70          "Who will the next Pope be?"
KXNEXTNATOSECGEN-99   "Who will be the next Secretary General of NATO?"
KXWARMING-50          "Will the world pass 2 degrees Celsius over pre-industrial levels...?"
```

Fetch nested markets per event, or use the event tickers to drive query 2.

### 2. `/markets?status=open&series_ticker=<SERIES>`

Verified to return real markets:

| series_ticker | sample title |
|---|---|
| `KXFEDDECISION` | "Will the Federal Reserve Hike rates by 25bps at their January 2028 meeting?" |
| `KXBTCD` | "Bitcoin price on Jul 9, 2026?" |
| `KXBTC` | "Bitcoin price range on Jul 9, 2026?" |
| `KXELONMARS` | "Will Elon Musk visit Mars before Aug 1, 2099?" |
| `KXNEWPOPE` | "Who will the next Pope be?" |
| `KXWARMING` | "Will the world pass 2 degrees Celsius...?" |

(`KXNBASERIES` returned 0 open markets — series tickers are not guessable, get
them from `/events` or `/series`.)

Do **not** "fix" this by paginating `/markets` until real markets appear. It
costs 13 pages of 1000 to find two of them.

## Trap 2: fetching the series in parallel silently loses 98% of them

Fourteen series fired with `Promise.all` returns **429 on six of them the first
call and thirteen of fourteen on the next.** Nothing throws: `allSettled` treats
a rejected series as one hole in one topic, so the venue quietly contributes
**2 markets instead of 169** and every log line still reads healthy.

Sequential with a 120 ms gap: 14/14, ~4.7 s, stable across three runs. That cost
is paid once per 60 s cache window, which is why the fetcher is a `for` loop and
not a `map`. **Do not "optimize" it back into a parallel fetch.**

## Trap 3: `volume_fp` is CONTRACTS, for the market's whole life

Polymarket's `volume24hr` is **dollars in a day**. Kalshi's `volume_fp` is
**contracts since listing**. Putting one in the other's field is a unit error
with two visible consequences:

- a card reading `$38.3M in play` for a market that traded 38.3M contracts;
- **"For you" turning all-Kalshi**, because that feed ranks on volume alone and
  a lifetime count beats a daily one on every comparison.

A contract settles at $1, so `volume_24h_fp × price` is the dollars that changed
hands, to within the spread. Measured: $900k of 24h notional across the series
below, busiest market $224k. Polymarket's busiest is $5.9M. Comparable units,
comparable rankings.

## Trap 4: one title, thirty outcomes

Multi-outcome events reuse a single `title` for every contract — thirty markets
all called "Who will win the next presidential election?", told apart only by
`yes_sub_title` ("Ro Khanna", "Rahm Emanuel", …). Ingested raw they are literal
twins: the matcher cannot separate them and the volume tie-break picks one at
random. Measured: 107 colliding titles across 698 of 4,278 bettable markets.

`disambiguate()` folds the subtitle in, but **only where the title actually
collides** — "Will CPI rise more than -0.3% in July 2026?" already carries its
own number and reads worse as "…? — Above -0.3%".

## What shipped

A hand-picked series list (`KALSHI_SERIES` in `src/venues/kalshi.ts`), not a
crawl. `/events?status=open&limit=200&with_nested_markets=true` paginates
cleanly and carries zero parlays — but eight pages yield 10,514 markets, 4,278
bettable, against Polymarket's ~950, and one series alone (`KXMIDTERMMOV`,
"margin of victory for Republicans in \<district\>") is 1,429 near-identical
markets. Ingesting that would bury the feed and hand the matcher a thousand
fresh ways to be confidently wrong.

So: the questions Polymarket does not price. Economics
(`KXFEDDECISION`, `KXCPI`, `KXU3`, `KXGDP`, `KXRECSSNBER`), crypto by strike
(`KXBTCD`), US politics (`KXPRESPERSON`, `KXPRESNOMD/R`, `KXPRESPARTY`,
`KXHOUSEPOPVOTEMARGIN`, `KXTRUMPREMOVE`, `KXGREENLAND`, `KXINSURRECTION`).

Series tickers are **not derivable**. Get new ones from `/events` or `/series`,
never by guessing — `KXNBASERIES` looked obvious and returns 0 open markets.

## Watch out

Whatever you measure in Week 1, `matched:false` reflects **venue coverage** as
much as matcher quality. With Kalshi off, a miss on a sports or politics take
says nothing about whether embeddings would help — embeddings cannot match a
market that isn't in the set. The per-`/hook` log line records venue counts
(`{"evt":"hook","venues":{"kalshi":0,"polymarket":75},...}`) so the rate can be
segmented after the fact. Use it.
