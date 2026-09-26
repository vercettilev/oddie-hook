// Wallet sign-in. A third way to be somebody, alongside X and Google.
//
// This is NOT the real-money layer. Nothing here touches a transaction: the
// wallet proves an identity by signing a sentence, and that is the entire
// interaction. `signMessage` cannot move funds, and the message we ask for says
// so in its own text so a person reading Phantom's prompt can see it too.
//
// The proof is an ed25519 signature over a server-issued challenge:
//
//   1. The browser asks for a challenge, naming the device it is on.
//   2. We mint a one-shot nonce, remember which device asked, and hand back the
//      exact string to sign.
//   3. The wallet signs it. The browser returns pubkey + signature + nonce.
//   4. We consume the nonce (it can never be used twice), rebuild the message
//      OURSELVES from what we stored, and verify the signature against it.
//
// Step 4 is the load-bearing one. We never verify the client's copy of the
// message — only the copy we issued — so a caller cannot get a signature over
// text of their choosing accepted by sending different text than they signed.
//
// Verification uses node:crypto, not a library. A Solana address is a raw
// 32-byte ed25519 public key; wrapping it in the fixed SPKI DER prefix below
// turns it into something createPublicKey accepts, and that is the whole trick.

import { createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";

/** How long a challenge is good for. Long enough to read Phantom's prompt,
 *  short enough that a leaked one is worthless. */
export const WALLET_NONCE_TTL_MS = 5 * 60_000;

/** Refuse to hold more than this many pending challenges. An unauthenticated
 *  endpoint mints these, so it needs a ceiling that is not "the heap". */
const MAX_PENDING = 5_000;

/** A base58 Solana address. Deliberately strict: 32 bytes encodes to 43-44
 *  chars, and anything else is not an address we should be decoding. */
export const WALLET_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface Challenge {
  nonce: string;
  deviceId: string;
  message: string;
  expiresAt: number;
}

const pending = new Map<string, Challenge>();

function sweep(now: number): void {
  for (const [k, c] of pending) if (c.expiresAt <= now) pending.delete(k);
}

/**
 * SIWS needs a chain and Phantom's vocabulary is not Solana's: it says
 * "mainnet", never "mainnet-beta". Read from the same env var the chain layer
 * reads so the two cannot disagree, without importing it.
 */
const CHAIN_ID = /^devnet/.test(process.env.SOLANA_CLUSTER ?? "")
  ? "devnet"
  : /^testnet/.test(process.env.SOLANA_CLUSTER ?? "")
    ? "testnet"
    : "mainnet";

/**
 * The text the wallet is asked to sign.
 *
 * Written to be read by a human in a wallet popup, because that popup is the
 * only place this string is ever seen. It names the site (so a signature
 * harvested by another origin reads as obviously foreign), states plainly that
 * it authorises nothing, and carries the nonce that makes it single-use.
 *
 * AND IT IS SIGN IN WITH SOLANA, ALL OF IT OR NONE OF IT. The first line is
 * the magic one: a wallet that sees "<domain> wants you to sign in with your
 * Solana account:" stops treating the text as text and parses it against the
 * SIWS grammar, which requires URI, Version, Chain ID, Nonce and Issued At, in
 * that order, after the statement. This message had the opening line and then
 * jumped straight to Nonce, so Phantom switched into the structured renderer,
 * failed to parse, and refused to show the request at all: "The app's
 * signature request cannot be shown due to invalid formatting." The button
 * looked dead and there was nothing on our side to see, because nothing had
 * reached us yet.
 *
 * Emitting the missing three is the fix and it is also the better outcome: the
 * wallet now renders its own sign-in panel with the domain it verified, which
 * is a stronger anti-phishing surface than any sentence we could write.
 */
function messageFor(domain: string, address: string, nonce: string, issuedAt: string): string {
  return [
    `${domain} wants you to sign in with your Solana account:`,
    address,
    "",
    "Signing proves you own this wallet. It does not approve a transaction and cannot move any funds.",
    "",
    `URI: https://${domain}`,
    "Version: 1",
    `Chain ID: ${CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

/**
 * The site a wallet is told it is signing in to.
 *
 * TWO RULES PULL AGAINST EACH OTHER. The wallet compares this name with the
 * origin of the page that asked and flags any difference, so it has to be the
 * host the page is really on: after the app moved to app.oddie.fun every
 * message still said oddie.fun. And it must never be a name the caller picks,
 * or a phishing page could have our name printed on its own request. So: the
 * host the request came in on when that host is one of ours, otherwise the
 * primary one.
 */
export function signInDomain(requestHost: string, primary: string, others: readonly string[] = []): string {
  const asked = requestHost.trim().toLowerCase();
  const ours = [primary, ...others].map((h) => h.trim().toLowerCase()).filter(Boolean);
  return ours.find((h) => h === asked) ?? primary.trim().toLowerCase();
}

/** Mint a one-shot challenge for this device+address. */
export function issueChallenge(deviceId: string, address: string, domain: string, now = Date.now()): Challenge {
  sweep(now);
  // Full rather than partial eviction: a flood should not be able to push out
  // one honest pending challenge at a time and keep the map permanently full.
  if (pending.size >= MAX_PENDING) pending.clear();

  // HEX, NOT BASE64URL. SIWS allows only letters and digits in the nonce
  // (`8*( ALPHA / DIGIT )`). base64url put a '-' or '_' in about two nonces out
  // of three, and Phantom refuses a message it cannot parse without opening a
  // popup, so most attempts died in the wallet and never reached us.
  const nonce = randomBytes(16).toString("hex");
  const c: Challenge = {
    nonce,
    deviceId,
    message: messageFor(domain, address, nonce, new Date(now).toISOString()),
    expiresAt: now + WALLET_NONCE_TTL_MS,
  };
  pending.set(nonce, c);
  return c;
}

/**
 * Take the challenge back. One shot: a nonce that has been consumed is gone
 * whether or not the signature that came with it turns out to be valid, so a
 * captured (nonce, signature) pair can never be replayed.
 *
 * Returns null for unknown, expired, or wrong-device nonces. The device check
 * stops a challenge minted for one browser being redeemed by another.
 */
export function consumeChallenge(nonce: string, deviceId: string, now = Date.now()): Challenge | null {
  const c = pending.get(nonce);
  if (!c) return null;
  pending.delete(nonce);
  if (c.expiresAt <= now) return null;
  if (c.deviceId !== deviceId) return null;
  return c;
}

// The DER header for an Ed25519 SubjectPublicKeyInfo. Fixed, 12 bytes, and the
// only thing standing between a raw Solana address and node:crypto.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Does `signature` prove that the holder of `address` signed `message`?
 *
 * Returns false rather than throwing on every malformed input — a bad address,
 * a truncated signature and a genuine mismatch are all just "no" to the caller,
 * and none of them should be able to 500 the route.
 */
export function verifyWalletSignature(address: string, message: string, signature: Buffer): boolean {
  if (!WALLET_ADDRESS.test(address)) return false;
  if (signature.length !== 64) return false;
  try {
    const raw = decodeBase58(address);
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(null, Buffer.from(message, "utf8"), key, signature);
  } catch {
    return false;
  }
}

/** Base58 (Bitcoin alphabet) decode. Small enough to own rather than depend on,
 *  and this is the only place the server decodes an address. */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function decodeBase58(s: string): Buffer {
  const bytes: number[] = [0];
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error("bad base58");
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  // Leading '1's are leading zero bytes by definition of the encoding.
  for (const ch of s) { if (ch !== "1") break; bytes.push(0); }
  return Buffer.from(bytes.reverse());
}

/** The public label for a wallet account: 4 and 4, the way every Solana UI
 *  writes it. Never the bare 44-char address — it is unreadable as a name. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** Exposed for the tests only. */
export const _decodeBase58 = decodeBase58;
export const _pendingSize = (): number => pending.size;
