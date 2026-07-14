# Known gaps in the matcher

> Bugs that already shipped and were paid for — the Postgres timestamp trap, the
> `[hidden]` override — live in [lessons.md](lessons.md). This file is about
> things the matcher still gets wrong.

Things we measured, understood, and chose not to fix yet. Each one is a
deliberate deferral with a trigger for when it stops being acceptable.

---

## 1. Identical-token markets ("near twins")

**Status:** open. Acceptable through Week 1 (manual seeding). **Must be fixed
before bot automation.**

**Measured 2026-07-09**, live Polymarket board, 989 bettable markets:

```
groups of markets with identical token sets : 97
markets falling into such a group           : 312 / 989   (31.5%)
```

**Re-measured 2026-07-10**, after Kalshi was re-enabled and the Polymarket fetch
widened to all tags. Both boards below are the *same snapshot*, so the growth is
the widening and not the day:

```
                          groups   markets in a group   biggest group
old universe (979 mkts)      72      238 / 979 (24.3%)        13
new universe (2293 mkts)    190      876 / 2293 (38.2%)       23
```

The gap got **worse, as expected**: more markets means more twins, and a wider
board draws in whole families that never had a chip. This does not change the
Week-1 decision — a human still reads every card before it is posted — but it
raises the stakes for Week 6, and it means the `/tool` near-twin warning now
fires on roughly two cards in five rather than one in four. That is the warning
working, not the warning breaking. It stays useful only as long as someone
actually reads it.

### What it is

`tokenize()` drops every token shorter than three characters. Dates and scores
live in exactly those tokens, so the matcher cannot see them:

| question | what the matcher sees |
| --- | --- |
| `Will Donald Trump publicly insult someone on July 7, 2026?` | `donald trump publicly insult someone july 2026` |
| `…on July 10, 2026?` | `donald trump publicly insult someone july 2026` |
| `Exact Score: Spain 0 - 1 Belgium?` | `exact score spain belgium` |
| `Exact Score: Spain 3 - 2 Belgium?` | `exact score spain belgium` |

Identical token sets score identically, so the **volume tie-break** picks the
winner. A take about July 11 gets a July 7 card, confidently.

### Why it matters more than it looks

Like the template-family bug that `resolveFamilies()` fixes, this class is
**invisible to the `matched:false` rate**. It reports as a confident match. Any
miss-rate number collected while it is open is measuring something narrower than
"how often were we right".

It is *not* caused by the family rule. `resolveFamilies()` cannot help: its whole
mechanism is finding a word that tells two siblings apart, and here there is no
such word to find. Behaviour is identical to the pre-family-rule baseline.

### Why it is deferred

1. Pre-existing. The family rule neither introduced nor worsened it.
2. Fixing it means another tokenizer round — keeping short numeric tokens
   changes what every question tokenizes to, which moves `MIN_OVERLAP` off its
   calibration (0.167 false < 0.19 ≤ 0.200 true). That is a full re-measurement,
   not a patch.
3. **Week 1 has a human in the loop.** Every card is reviewed in `/tool` before
   it is posted by hand, so a wrong-date card gets skipped by eye.

### The trigger

Reason 3 evaporates the moment the bot posts without a human reading the card.
**This must be closed before automation.** Until then `/tool` warns on it: when
the matched market shares its token set with another live market, the tool shows
"near-twin markets exist — check the date/details before posting" and lists them.

### Sketch of a fix

Keep short tokens when they are numeric and adjacent to a month name or a
score-like pattern, then re-run `scripts/test-matcher.ts` (the calibration
margin) and `scripts/smoke.ts`. Expect `MIN_OVERLAP` to need re-derivation:
lengthening every market's token set lowers every overlap score.

---

## 2. Fed meeting disambiguation

**Status:** open, accepted for Week 1.

`parseDirection()` says WHICH WAY, never WHICH MEETING. "the fed is hiking again"
agrees with the July hike market and the September one equally, and volume picks.
Both cards are honest about the event, possibly wrong about the date.

Note this is the same failure shape as gap 1, arriving by a different road: the
family rule would have caught it (July/September *are* distinguishing words), but
the structural-anchor exemption in `resolveFamilies()` deliberately stands the
rule down when direction agrees — because demanding lexical distinctness from
threshold families cost 74 of 400 live self-matches when measured.

Closing it means parsing the meeting out of the tweet, which the tweet usually
does not state. See the comment above `corroborates()` in `matcher.ts`.
