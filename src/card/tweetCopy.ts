// Ready-to-copy tweet lines, generated from the market's own numbers and
// nothing else. Deliberately NOT an LLM: templates selected by the SHAPE of
// the market (split, favorite, longshot, big money, closing soon) so the copy
// is specific without ever inventing a fact. Zero latency, zero cost, and the
// same market always produces the same lines.
//
// The trust rules, enforced by scripts/test-copy.ts:
//   - only facts already on the card: percentage, payout, volume, time left
//   - one line, one emoji max, no hype words, no side advice
//   - never "free tokens" / "sign up" / app-speak — the copy provokes, the
//     link carries everything else

import { Market } from "../venues/types.js";
import { TAGLINE } from "../brand.js";

const mult = (pct: number): string => {
  const m = 100 / pct;
  return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}×`;
};

const money = (n: number): string =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`;

/** "2 days" / "14h" / null when unknown or already closed. */
function timeLeft(closesAt: string | null): { text: string; days: number } | null {
  if (!closesAt) return null;
  const ms = new Date(closesAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const days = ms / 86_400_000;
  if (days >= 1) return { text: `${Math.floor(days)} day${Math.floor(days) === 1 ? "" : "s"}`, days };
  return { text: `${Math.max(1, Math.floor(ms / 3_600_000))}h`, days };
}

/**
 * The trust rules, as a function — applied to every LLM-written reply line
 * before it is shown to anyone. A line that fails ANY rule is dropped:
 * one line, at most one emoji (and only 👇/👀), no hype, no CTA, no side
 * advice, and no number that isn't already true — i.e. present in the tweet,
 * in the market question, or derivable from the market (pct, payout, volume,
 * time left). The LLM writes the voice; this decides what's allowed to ship.
 */
const BANNED_RE = /insane|don'?t miss|check (it |this )?out|claim|sign ?up|try (our|the) app|our app|download|moon|guarantee|can'?t lose|easy money|trust me|link in bio|🚀|🔥|💎|‼️/i;
const ADVICE_RE = /\b(take (the )?(yes|no)\b|bet (on )?(yes|no)\b|you should|i'?d (go|take)|smart money|hammer (the )?(yes|no))/i;
// Editorializing on the PRICE is implicit betting advice ("undervalued" means
// "buy this"). The odds are stated as fact; whether the market is wrong is
// exactly the question the reader is being invited to answer, not told.
// Deliberately phrase-level: bare "cheap" stays legal ("talk is cheap").
const EDITORIAL_RE = /\b(undervalued|overvalued|underpriced|overpriced|mispriced|(good|great|real) value|value (bet|play)|free money|a steal|steal at|too (cheap|expensive|low|high)|market('?s| is| looks| seems)? (wrong|off|sleeping|missing|lagging)|better (bet|side)|worth a (bet|shot|punt|flier)|price is (cheap|expensive|low|high)|odds (are|look|seem) (cheap|expensive|generous|off))\b/i;

function allowedNumbers(m: Market, tweetText: string): Set<string> {
  const yes = Math.max(1, Math.min(99, Math.round(m.yesPct)));
  const no = 100 - yes;
  const out = new Set<string>([String(yes), String(no), "100"]);
  for (const p of [yes, no]) {
    const r = 100 / p;
    out.add(String(r >= 10 ? Math.round(r) : Math.round(r * 10) / 10));
  }
  out.add(m.volumeUsd >= 1e6 ? (m.volumeUsd / 1e6).toFixed(1) : String(Math.round(m.volumeUsd / 1e3)));
  if (m.closesAt) {
    const ms = new Date(m.closesAt).getTime() - Date.now();
    if (ms > 0) {
      out.add(String(Math.floor(ms / 86_400_000)));
      out.add(String(Math.max(1, Math.floor(ms / 3_600_000))));
    }
  }
  for (const src of [tweetText, m.question]) {
    for (const n of src.match(/\d+(?:[.,]\d+)?/g) ?? []) out.add(n.replace(",", ""));
  }
  return out;
}

export function validReplyLine(line: string, m: Market, tweetText: string): boolean {
  if (!line || line.includes("\n") || line.length > 220) return false;
  const emojis = [...line.matchAll(/\p{Extended_Pictographic}/gu)].map((x) => x[0]);
  if (emojis.length > 1) return false;
  if (emojis.length === 1 && emojis[0] !== "👇" && emojis[0] !== "👀") return false;
  if (BANNED_RE.test(line) || ADVICE_RE.test(line) || EDITORIAL_RE.test(line)) return false;
  const allowed = allowedNumbers(m, tweetText);
  for (const n of line.match(/\d+(?:\.\d+)?/g) ?? []) {
    if (!allowed.has(n)) return false; // an invented number kills the line
  }
  return true;
}

export function tweetCopy(m: Market): string[] {
  const yes = Math.max(1, Math.min(99, Math.round(m.yesPct)));
  const no = 100 - yes;
  const vol = money(m.volumeUsd);
  const bigMoney = m.volumeUsd > 1_000_000;
  const left = timeLeft(m.closesAt);
  const closingSoon = left !== null && left.days < 3;

  const out: string[] = [];

  // Shape first: the strongest angle the numbers themselves offer.
  if (yes >= 40 && yes <= 60) {
    // Balanced: the dilemma is the story.
    out.push(`${yes}% yes. genuinely split 👇`);
    out.push(`the market can't decide. can you?`);
    if (bigMoney) out.push(`${vol} in play and it's ${yes}/${no}. someone's wrong 👇`);
  } else if (yes >= 70) {
    // Favorite (incl. heavy): dare the fade.
    out.push(`market says ${yes}%. brave enough to take the other side?`);
    out.push(`${yes}% sure. being right on no pays ${mult(no)} 👀`);
    if (bigMoney) out.push(`${vol} riding on ${yes}%. fade it or ride it 👇`);
  } else if (yes <= 30) {
    // Longshot: the payout is the story.
    out.push(`${yes}% — pays ${mult(yes)}. feeling lucky? 👇`);
    out.push(`the market says no (${yes}% yes). being right pays ${mult(yes)} 👀`);
    if (bigMoney) out.push(`${vol} in play at ${yes}%. long odds, real money 👇`);
  } else {
    // A lean (31–39 / 61–69): no strong shape, let the numbers speak plainly.
    out.push(`${yes}% yes · right pays ${mult(yes)}. call it 👇`);
    out.push(`market leans ${yes > 50 ? "yes" : "no"} at ${yes}%. agree?`);
  }

  // Modifiers: credibility and urgency, whichever the market has earned.
  if (bigMoney) out.push(`${vol} in play. market says ${yes}% 👇`);
  if (closingSoon && left) out.push(`${yes}% yes · ${left.text} left 👇`);
  if (closingSoon && left) out.push(`last call — ${left.text} left, sitting at ${yes}%`);

  // Always-valid fallbacks so every market gets at least three lines.
  out.push(`market says ${yes}%. what do you say? 👇`);
  out.push(`${TAGLINE} — ${yes}% yes 👀`);

  return out.slice(0, 5);
}
