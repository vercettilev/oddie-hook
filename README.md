# oddie-hook

The wedge, end to end: **tag Oddie into a take → we find the most relevant
live market (Kalshi or Polymarket) → reply with a branded odds card → tap
lands on `oddie.fun/market/[slug]` → make the call.**

Phase 1 = virtual tokens only. No wallet, no custody, no real-money execution
in this skeleton — and none of it touches the Chrome Web Store, so the Google
extension policy doesn't apply to any of this.

## Pieces

```
src/venues/     kalshi.ts + polymarket.ts read clients → one normalized Market
src/matching/   matchTweet(): tweet text → best live market (or null)
src/card/       renderCard(): the manila betting-slip SVG (the "ad")
src/store/      in-memory slug store + virtual-token calls
src/server.ts   POST /hook, /api/feed, /api/market/:slug, /card/:slug.svg, calls
public/feed.html   THE page: oddie.fun/market/[slug] serves the feed,
                   tagged market pinned as the top card (slug = door into feed)
CADENCE.md      the experiment cadence doc for the Blas jam
scripts/smoke.ts   runs the whole thing against LIVE data, no server
```

## Run it

Both venues' read endpoints are **public, no API key**:
- Kalshi: `https://external-api.kalshi.com/trade-api/v2/markets` (all markets)
- Polymarket Gamma: `https://gamma-api.polymarket.com/markets`

```bash
npm install
npm run smoke      # live fetch + match sample tweets + write card-sample.svg
npm run dev        # start the API on :3000
```

Try the hook:
```bash
curl -s localhost:3000/hook -H 'content-type: application/json' \
  -d '{"tweetText":"no way bitcoin closes above 150k this year"}' | jq
# → { matched, slug, landingUrl, cardUrl, market }
# open the cardUrl in a browser to see the slip.
```

## What's verified vs. what you must check in your env

Endpoints and response shapes were taken from current (2026) Kalshi and
Polymarket docs. **I couldn't run live calls from where this was built (no
network), so before trusting it:** run `npm run smoke` once and confirm
(a) both venues return markets, (b) the Polymarket `outcomePrices`/`outcomes`
fields still arrive as stringified JSON arrays, (c) Kalshi markets still carry
`title`. If a field moved, the fix is isolated to the one `normalize()` fn.

## Deliberate design choices

- **Matcher returns `null` below threshold.** Replying with an irrelevant
  market is worse than staying silent, and the misses tell you which
  categories to seed. Tune `minScore` in `matcher.ts` during the wedge test.
- **Lexical matching, not embeddings — yet.** It's explainable so you can see
  *why* a tweet matched while eyeballing results. Swap `scoreMarket()` for an
  embedding cosine when you want quality; keep this as a cheap prefilter.
- **In-memory store.** Virtual tokens, nothing to lose on restart. Replace with
  Drizzle/Postgres (you already run it) when calls need to persist — only
  `store/markets.ts` changes.
- **Card is SVG, in Oddie brand** (blue #68C6FF, black outline, ghost eyes, no
  venue named — shows normalized volume as the trust signal). To post as an
  image on X, rasterize to PNG at post time (`@resvg/resvg-js`, or `satori` if
  you'd rather build it as JSX). Embed the Fredoka + Nunito fonts when you
  rasterize, or text falls back to a system sans.

## Next steps (not built here, on purpose)

1. **X bot glue.** Wire `POST /hook` to your mention webhook: read the parent
   tweet, call the hook, post `cardUrl` (rasterized) + `landingUrl` as the reply.
   Respect the guardrail from your brief — only reply when *tagged*.
2. **Real-money execution (Phase 3).** The DFlow→Kalshi / Polymarket-CLOB order
   path is intentionally absent. That's financial infra (custody, settlement,
   KYC) and should be built piece by piece, not scaffolded in a hook skeleton.
3. **CLOB fresh prices.** Gamma odds can lag a few seconds; read the CLOB order
   book by token id when you want tick-fresh numbers on high-volume markets.
