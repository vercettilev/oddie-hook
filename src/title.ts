// Display-time title normalization for grouped/outcome markets.
//
// Venue adapters (and some venue payloads themselves) title an outcome market
// "{event} — {outcome}": "F1 Drivers' Champion — Lewis Hamilton", "Will the
// U.S. invade Iran before 2027? — Yes". On a card that already has YES/NO
// buttons, "— Yes" is pure redundancy, and "event — name" isn't a question at
// all — and the card's title IS the tweet when it gets screenshotted.
//
// DISPLAY ONLY. The raw question stays canonical everywhere that matters
// mechanically — the matcher, slugs, tweet-copy trust rules — so normalizing
// here can never change what a market IS, only how it reads.
//
// The rules, deliberately small:
//   "{title}? — Yes"  -> "{title}?"        (the YES button already says it)
//   "{title} — No"    -> unchanged         (yesPct prices the NO outcome as
//                                           this market's YES side; stripping
//                                           the suffix would flip the meaning)
//   "{title} — {out}" -> "{title}: {out}?" (a question without needing a verb:
//                                           "F1 Drivers' Champion: Hamilton?")
export function displayTitle(q: string): string {
  const i = q.lastIndexOf(" — ");
  if (i < 0) return q;
  const title = q.slice(0, i).trim();
  const outcome = q.slice(i + 3).trim();
  if (!title || !outcome) return q;
  const low = outcome.toLowerCase();
  if (low === "yes") return title;
  if (low === "no") return q;
  const base = title.endsWith("?") ? title.slice(0, -1).trimEnd() : title;
  return `${base}: ${outcome}?`;
}
