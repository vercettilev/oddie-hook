# Lessons paid for in production

Bugs that shipped, or nearly shipped, because the code looked obviously correct.
Each one is here because the class can recur somewhere else, and because no test
we had would have caught it.

---

## 1. Never compare a Postgres `timestamptz` to a JS `Date` for equality

**Postgres keeps microseconds. JavaScript `Date` truncates to milliseconds.** So
an equality predicate against a `Date` parameter silently matches **zero rows**.

Measured on the live database, 2026-07-10:

```
Postgres : 2026-07-09 12:58:52.178902
JS Date  : 2026-07-09T12:58:52.178Z
SELECT count(*) FROM device_balance WHERE device_id = $1 AND topped_up_at = $2   -- $2 = the Date we just read
-> 0
```

### Where it bit us

`getWallet()` granted the daily top-up with what read like an optimistic lock:

```ts
// BROKEN. Looks like a lock. Is a lock that never opens.
await db().query(
  `UPDATE device_balance SET tokens = $1, topped_up_at = to_timestamp($2 / 1000.0)
    WHERE device_id = $3 AND topped_up_at = $4`,   // $4 is a JS Date
  [next.tokens, next.toppedUpAt, deviceId, cur.topped_up_at],
);
```

The grant was computed correctly. The `UPDATE` touched nothing. The function then
re-read the row, found the old balance, and reported `granted: 0`. **No device
would ever have been topped up** — silently, for everyone, forever. There was no
error, no log line, and nothing for a user to report except "the counter says
`+200 in 0h` and nothing happens".

### Why nothing caught it

- The unit tests for `applyTopUp()` inject a clock and compare **numbers**. They
  were right, and they stayed green.
- The in-memory store backend also compares numbers. Green.
- `pg-mem` and friends do not reproduce microsecond storage, so a fake database
  would have agreed with the fake clock.
- The one assertion that *looked* like it covered the write — "a second read in
  the same window grants nothing" — **passes under the broken code too**, because
  nothing ever grants. An assertion that a thing did not happen is satisfied by a
  world in which the thing can never happen.

Only `scripts/test-wallet-db.ts`, running against a real Postgres and asserting
that **the row itself** reads 240, fails on the broken version. It was written
after the fact and confirmed to fail against it.

### The rule

Guard a timestamped write on the **window**, never on the timestamp's value, and
let the database supply `now()`:

```ts
// Correct: a predicate about time, not about a timestamp's exact bits.
`UPDATE device_balance SET tokens = $1, topped_up_at = now()
  WHERE device_id = $2
    AND tokens = $3                                         -- nothing moved under us
    AND topped_up_at <= now() - make_interval(secs => $4)   -- a window really elapsed
 RETURNING tokens, topped_up_at`
```

This is still race-safe: the first writer stamps `now()`, so the second writer's
window predicate fails. If a stake was deducted in between, the `tokens = $prev`
predicate fails instead and the grant waits one page-load. A late top-up is not a
bug; a top-up that overwrites a stake is.

### Where this can come back

**Settlement.** It writes `closed_at`, `exit_pct` and `proceeds` on
`market_call` and credits a balance — the same shape as the top-up. If it guarded
on "this row still has the `closed_at` I read", it would have the same bug with
the same silence. It ships (2026-07-10) guarded on `closed_at IS NULL` — a fact
about the row's state rather than about a clock's precision — and
`scripts/test-settle-db.ts` holds the line against real Postgres: it grep-asserts
the source has no timestamp-equality predicate, proves a double-settle touches
zero rows and credits zero tokens, and runs the guard-less mutant to show it
WOULD have re-paid, so the test is known to be able to fail.

Anywhere else that reads a `timestamptz`, does arithmetic in JavaScript, and
writes back conditionally, is the same trap. Read the state, not the instant.

### If you must compare instants

`date_trunc('milliseconds', ts) = $jsDate` works, and is worse: it tells the
reader that an exact-instant comparison was intended, which it almost never is.
Compare the state.

---

## 2. `display` in a class beats `[hidden]`

`.picker{display:flex}` outranks the user agent's `[hidden]{display:none}` on
specificity, so an element with the `hidden` attribute rendered anyway — 200px of
form on every card, before a side was ever tapped. It overflowed the card's fixed
height upward and slid the question under the sticky chips bar.

Five separate "bugs" reported from a screenshot were one line. The regression
test lives in `scripts/audit-feed.mjs` (`npm run audit-feed`), which asserts the
picker is not painted while closed, at five viewport sizes. It was invisible at
390×844 — the size a headless screenshot defaults to — and visible on every real
phone, where the browser chrome eats ~180px of height.

Any rule that sets `display` on a class must pair with `.thing[hidden]{display:none}`.

---

## 3. A contrast check must resolve the *real* backdrop, not `body`

The dark theme shipped a token split — surfaces (white cards) keep their ink,
the ground (feed background, rail, chips) goes dark. `audit-feed.mjs` grew a
WCAG contrast pass to prove no text went invisible, and it reported **0 ihlal in
both themes**. It was measuring the wrong background.

Two ways it lied, both the same root cause — it did not walk to the element's
actual painted parent:

- It compared `.card .take` against `getComputedStyle(document.body)`. But on
  desktop the card sits inside `.frame`, which **hardcoded `background:#fff`**.
  In dark mode the question text was `--on-ground` (near-white) on that white
  frame — `1.14:1`, invisible — and the check, looking at `body`, saw a dark
  ground and passed. The mobile half of the same bug (`body{color:var(--on-ground)}`
  poisoning every undeclared white surface) had already been found by eye; the
  desktop `.frame` half survived because the audit's backdrop was a guess.
- Its fallback `if (!bg) continue` treated "I could not find a background" as a
  pass. A skip that reads as green is worse than no check: the very surfaces the
  bug affected paint no background of their own, so they were the ones skipped.

`scripts/contrast.mjs` replaces it: no selector list (every text node on every
screen), nothing skipped (an unresolved backdrop is a failure), and the backdrop
is found by **walking the ancestor chain and compositing every translucent
layer, gradient stops included** — so `.orow`'s outlined `39%` is scored against
the blue *and* white halves of its own fill, and text with a `-webkit-text-stroke`
is read from the stroke. It is a **regression** gate, not an absolute one:
anything under 3:1 fails in any theme (that is the invisible-text class), and
anything that passes bright but fails dark fails as a theme regression;
pre-existing brand-grey misses (e.g. `#6B7A88` on white is 4.41:1, and always
was) are reported loudly but do not fail, so the gate can actually stay green and
therefore stay on.

The rule: to check contrast, composite the stack the pixel is actually painted
on. Measuring against `body` measures a page that does not exist.
