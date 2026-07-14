// Handle generation and validation. Pure — no I/O, no store; uniqueness is the
// database's job (a unique index), this file's job is shape and taste.
//
// One identity system, two sources: an anonymous device gets a random handle it
// can edit; connecting X replaces it with the real @handle for display. The
// random ones are deliberately playful and deliberately obviously-generated
// ("popper_4821"), so nobody mistakes an anonymous scalper for a person who
// chose their name.

const ADJ = [
  "big", "bold", "sharp", "lucky", "sneaky", "loud", "cold", "wild",
  "quick", "shiny", "spicy", "cosmic", "turbo", "mellow", "feisty", "slick",
];
const NOUN = [
  "call", "popper", "oracle", "edge", "streak", "hunch", "signal", "gut",
  "whale", "degen", "scout", "fox", "hawk", "shark", "wolf", "badger",
];

/** A fresh random handle, e.g. "bold_call_4821". Collisions are the caller's
 *  problem (retry against the unique index); at 16*16*9000 combinations they
 *  are rare enough that a retry loop terminates immediately in practice. */
export function randomHandle(rng: () => number = Math.random): string {
  const pick = (arr: string[]) => arr[Math.floor(rng() * arr.length)];
  const n = 1000 + Math.floor(rng() * 9000);
  return `${pick(ADJ)}_${pick(NOUN)}_${n}`;
}

export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

// Words a handle may not contain (impersonation) or be (confusion). Substring
// match on the slur-adjacent entries, exact match on the reserved ones — "class"
// contains "ass" and should pass.
const RESERVED = new Set([
  "admin", "administrator", "mod", "moderator", "staff", "official", "support",
  "oddie", "system", "root", "api", "bot", "help", "you", "anonymous", "null",
  "undefined", "deleted", "me",
]);
const BLOCKED_SUBSTRINGS = [
  "nigger", "nigga", "faggot", "kike", "spic", "chink", "wetback", "retard",
  "rape", "hitler", "nazi", "kys",
];

export type HandleVerdict = { ok: true; handle: string } | { ok: false; reason: string };

/** Normalise and judge a proposed handle. Lowercases before anything else so
 *  validation and the case-insensitive unique index agree on what a name is. */
export function validateHandle(raw: string): HandleVerdict {
  const handle = String(raw ?? "").trim().toLowerCase();
  if (handle.length < 3) return { ok: false, reason: "at least 3 characters" };
  if (handle.length > 20) return { ok: false, reason: "at most 20 characters" };
  if (!HANDLE_RE.test(handle)) return { ok: false, reason: "letters, numbers and _ only" };
  if (RESERVED.has(handle)) return { ok: false, reason: "that name is reserved" };
  for (const bad of BLOCKED_SUBSTRINGS) {
    if (handle.includes(bad)) return { ok: false, reason: "that name isn't available" };
  }
  return { ok: true, handle };
}
