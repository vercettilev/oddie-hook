# Oddie — Experiment Cadence
*Draft for the jam with Blas · July 2026*

## The locked flow (what we're testing)

Someone tags @poppin under a take on X → we match the most relevant **live**
market (existing venues supply the liquidity; we never name them — the card
shows Oddie brand + volume) → we reply with a branded odds card +
`oddie.fun/market/[slug]` → the link opens **the feed with that market as the
top card** → one-tap YES/NO with a payout multiplier (virtual tokens) → keep
swiping: same category first, then trending; category chips on top.

The slug is the door into the feed. Twitter is the top of funnel; the feed is
the product. Liquidity stays the venues' problem; experience is ours.

**Platform choice:** mobile-first web (not native). The link from X opens in
the in-app browser, so web is where the user already lands; app stores are
gatekeepers with hostile prediction-market rules (see: Chrome extension ban);
and web is the lightest thing we can iterate on. PWA later if retention wants
push notifications.

---

## Cadence: one experiment per week, each answers ONE question

### Week 1 — Manual wedge test (no bot yet)
**Question:** does "tag → card → tap" happen at all?
**Do:** run the hook locally; manually drop the branded card + slug link into
15–20 live arguments/takes (from the @poppin account, only where it fits).
**Measure:** card impressions → link taps → first call on the top card.
**Kill/scale:** if taps/impressions is dismal across 20 good threads, the
wedge framing needs work before any automation is worth it.
**Cost:** ~0 build (already built). 1 week of manual posting.

### Week 2 — Feed depth
**Question:** after the first call, do people swipe?
**Do:** same manual seeding, feed live behind every slug.
**Measure:** cards viewed per session (depth), % of sessions with 2+ calls,
category-chip usage.
**Signal:** depth ≥3 cards median = the feed is real; depth 1 = we have a
link-preview product, not a feed — rethink before building more.

### Week 3 — Reply-to-bet vs. tap-to-bet
**Question:** where does the call want to live — in the X thread or in the feed?
**Do:** on half the seeded threads, also parse replies like "10 yes"
(virtual); compare against link-tap cohort.
**Measure:** calls per thread, new-user conversion per path.
**Why it matters:** decides how much to invest in the bot vs. the feed.

### Week 4 — Resolution as content
**Question:** does settling markets drive the loop?
**Do:** when seeded markets resolve, auto-post outcome + who called it
(opt-in tagging).
**Measure:** quote-tweets/shares per resolution post, new tags of @poppin in
the following 48h, return visits from resolution posts.
**This is the viral engine hypothesis — it deserves its own week.**

### Week 5 — Multiplier framing A/B
**Question:** does payout language ("win 3.7×") convert better than
probability language alone — and does it change *who* it attracts?
**Do:** 50/50 the feed buttons: multiplier vs. plain %.
**Measure:** call rate, depth, and (soft) reply sentiment.
**Brand gate:** if multiplier wins big but pulls the tone sportsbook-ward,
that's a deliberate brand/regulatory decision, not a growth default.

### Week 6 — Automate the bot
Only now, with wedge + depth + path data, wire the mention webhook to
`POST /hook` and let it run within X's rate limits. Guardrail stays: reply
only when tagged.

---

## Standing metrics (every week, same dashboard)
- Tags of @poppin (leading, easy to juice — never optimize alone)
- Link taps / card impressions
- **Weekly active poppers** (made ≥1 call) — the north star
- Feed depth (median cards/session)
- Week-over-week return rate

## Standing risks we're tracking (not blocking)
- **X dependency** (API limits, bot policy) — mitigation queued: same backend,
  Telegram bot as second surface, Q3.
- **Chrome extension** — dead as a distribution base; companion-extension
  question parked with Google support + a test listing. Bonus if it survives,
  never the plan.
- **Real money (Phase 3)** — US = KYC venues (Kalshi / Polymarket US), non-US =
  wallet path; geoblocks respected. Decision deferred until Phase 1 retention
  data says which market we're actually in.
