// Wallet sign-in: the signature check and the challenge lifecycle.
//
// This is the only auth path where WE verify the proof rather than handing a
// code to Google or X and trusting the answer, so it is the one that has to be
// tested adversarially: a signature over different text, a signature from a
// different key, a replayed nonce, a nonce redeemed by another browser.
//
// Run with: npm run test-wallet

import { generateKeyPairSync, sign as edSign } from "node:crypto";
import {
  issueChallenge, consumeChallenge, verifyWalletSignature, shortAddress,
  WALLET_ADDRESS, WALLET_NONCE_TTL_MS, _decodeBase58, signInDomain,
} from "../src/auth/wallet.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

// --- helpers: a throwaway Solana-shaped keypair --------------------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encodeBase58(buf: Buffer): string {
  const digits = [0];
  for (const byte of buf) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "";
  for (const b of buf) { if (b !== 0) break; out += "1"; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12); // strip SPKI header
  return {
    address: encodeBase58(Buffer.from(raw)),
    sign: (msg: string) => edSign(null, Buffer.from(msg, "utf8"), privateKey),
  };
}

const DOMAIN = "oddie.fun";
const DEV = "device-aaaaaaaaaaaaaaaa";

console.log("\nbase58: the address decode the signature check depends on");
{
  // Round-trip is the property that matters; a wrong decode means every
  // signature fails closed, which is safe but silently breaks the feature.
  const w = wallet();
  check("a generated address round-trips to 32 bytes", _decodeBase58(w.address).length === 32);
  check("...and matches its own encoding", encodeBase58(_decodeBase58(w.address)) === w.address);
  check("leading zero bytes survive as leading '1'", encodeBase58(Buffer.from([0, 0, 1])) === "112");
  check("...and decode back", [..._decodeBase58("112")].join(",") === "0,0,1");
  check("the address regex accepts a real address", WALLET_ADDRESS.test(w.address), w.address);
  check("...and rejects one with a look-alike character", !WALLET_ADDRESS.test(w.address.slice(0, -1) + "0"));
}

console.log("\nverifyWalletSignature: only the holder of the key passes");
{
  const w = wallet();
  const msg = "oddie.fun wants you to sign in\nNonce: abc";
  const sig = w.sign(msg);

  check("a real signature over the real message verifies", verifyWalletSignature(w.address, msg, sig));

  // The whole point of the endpoint.
  check("the SAME signature does not verify a different message",
    !verifyWalletSignature(w.address, msg + " ", sig));
  check("a one-character change in the nonce is rejected",
    !verifyWalletSignature(w.address, msg.replace("abc", "abd"), sig));

  const other = wallet();
  check("someone else's key does not verify this signature",
    !verifyWalletSignature(other.address, msg, sig));
  check("...and their own valid signature does not pass as ours",
    !verifyWalletSignature(w.address, msg, other.sign(msg)));

  // Malformed inputs are answers, not exceptions.
  check("a truncated signature is false, not a throw", !verifyWalletSignature(w.address, msg, sig.subarray(0, 63)));
  check("an over-long signature is false", !verifyWalletSignature(w.address, msg, Buffer.concat([sig, Buffer.from([0])])));
  check("a non-base58 address is false", !verifyWalletSignature("not*an*address", msg, sig));
  check("an empty address is false", !verifyWalletSignature("", msg, sig));
  check("a well-formed address of the wrong LENGTH is false",
    !verifyWalletSignature("1111111111111111111111111111111", msg, sig));
}

console.log("\nthe challenge: single use, time limited, bound to one browser");
{
  const w = wallet();
  const c = issueChallenge(DEV, w.address, DOMAIN);

  check("the message names the site", c.message.startsWith(`${DOMAIN} wants you to sign in`), c.message.split("\n")[0]);
  check("...carries the address being proved", c.message.includes(w.address));
  check("...carries the nonce", c.message.includes(c.nonce));
  // THE POPUP IS THE WHOLE PRODUCT SURFACE HERE. The opening line puts every
  // wallet into SIWS mode, and a SIWS message missing any required field is not
  // rendered as plain text, it is refused: Phantom showed "the app's signature
  // request cannot be shown due to invalid formatting" and the Link button
  // looked broken. Nothing reaches the server in that state, so only this test
  // can catch it.
  const lines = c.message.split("\n");
  const tail = lines.slice(-5);
  check("...is a parseable SIWS message: URI, Version, Chain ID, Nonce, Issued At, in order",
    tail[0].startsWith("URI: https://") && tail[1] === "Version: 1"
    && tail[2].startsWith("Chain ID: ") && tail[3].startsWith("Nonce: ")
    && tail[4].startsWith("Issued At: "), tail.join(" | "));
  check("...names the same host in the URI as in the first line",
    tail[0] === `URI: https://${DOMAIN}`, tail[0]);
  check("...and says in its own text that it authorises nothing",
    c.message.includes("does not approve a transaction"), c.message);

  const second = issueChallenge(DEV, w.address, DOMAIN);
  check("two challenges never share a nonce", second.nonce !== c.nonce);

  check("a challenge can be consumed once", consumeChallenge(c.nonce, DEV) !== null);
  check("...and never twice — a captured signature cannot be replayed",
    consumeChallenge(c.nonce, DEV) === null);

  const other = issueChallenge(DEV, w.address, DOMAIN);
  check("a different browser cannot redeem it", consumeChallenge(other.nonce, "device-bbbbbbbbbbbbbbbb") === null);
  check("...and the attempt burns it, so the thief cannot retry as the victim",
    consumeChallenge(other.nonce, DEV) === null);

  const stale = issueChallenge(DEV, w.address, DOMAIN, Date.now() - WALLET_NONCE_TTL_MS - 1);
  check("an expired challenge is refused", consumeChallenge(stale.nonce, DEV) === null);

  check("an unknown nonce is refused", consumeChallenge("never-issued", DEV) === null);
}

console.log("\nthe message obeys the SIWS grammar, field by field");
{
  // THE SHAPE CHECK ABOVE PASSED WHILE PHANTOM REFUSED MOST OF THESE. The
  // grammar allows only letters and digits in the nonce (`8*( ALPHA / DIGIT )`)
  // and we issued base64url, which carries a '-' or '_' in about two nonces out
  // of three. A message that fails to parse gets no popup at all ("cannot be
  // shown due to invalid formatting"), so the Connect button looks dead and
  // nothing reaches the server. The nonce is random, so one sample proves
  // little: this reads four hundred.
  const SIWS = new RegExp([
    "^[^\\s/?#]+ wants you to sign in with your Solana account:",
    "[1-9A-HJ-NP-Za-km-z]{32,44}",
    "",
    "[A-Za-z0-9 \\-._~:/?#\\[\\]@!$&'()*+,;=]+",
    "",
    "URI: https://\\S+",
    "Version: 1",
    "Chain ID: (?:mainnet|testnet|devnet|localnet|solana:mainnet|solana:testnet|solana:devnet)",
    "Nonce: [A-Za-z0-9]{8,}",
    "Issued At: \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$",
  ].join("\\n"));
  const w = wallet();
  let bad = "";
  let n = 0;
  for (; n < 400 && !bad; n++) {
    const m = issueChallenge(DEV, w.address, DOMAIN).message;
    if (!SIWS.test(m)) bad = m;
  }
  check("every one of 400 messages parses (the nonce is letters and digits only)",
    !bad, `message ${n} does not parse: ${bad.replace(/\n/g, " | ")}`);
}

console.log("\nthe site the message names: the page's own, and only ever ours");
{
  // The wallet compares the named site with the page that asked. After the app
  // moved to app.oddie.fun every message still said oddie.fun.
  const APP = "app.oddie.fun", APEX = "oddie.fun";
  check("a page on the app host names the app host", signInDomain("app.oddie.fun", APP, [APEX]) === APP);
  check("a page on the apex names the apex", signInDomain("oddie.fun", APP, [APEX]) === APEX);
  check("...whatever the case of the Host header", signInDomain("App.Oddie.FUN", APP, [APEX]) === APP);
  check("a host that is not ours is never printed: it gets our primary",
    signInDomain("oddie.fun.evil.example", APP, [APEX]) === APP);
  check("...nor is an empty one", signInDomain("", APP, [APEX]) === APP);
  check("with no app host configured, the apex is the primary", signInDomain("elsewhere.example", APEX) === APEX);
}

console.log("\nend to end: the exact flow the route runs");
{
  const w = wallet();
  const c = issueChallenge(DEV, w.address, DOMAIN);
  const sig = w.sign(c.message);
  const taken = consumeChallenge(c.nonce, DEV);
  check("the server verifies against the message IT issued, not the client's",
    taken !== null && verifyWalletSignature(w.address, taken.message, sig));

  // The attack this shape exists to stop: sign whatever you like, then post a
  // different string alongside it. The route never reads the client's message,
  // so the only thing that can verify is the issued one.
  const c2 = issueChallenge(DEV, w.address, DOMAIN);
  const attackerText = "transfer everything to me";
  const sigOverOtherText = w.sign(attackerText);
  const taken2 = consumeChallenge(c2.nonce, DEV);
  check("a signature over attacker-chosen text fails against the issued message",
    taken2 !== null && !verifyWalletSignature(w.address, taken2.message, sigOverOtherText));
}

console.log("\nshortAddress: a name a person can read");
{
  const w = wallet();
  const s = shortAddress(w.address);
  check("is four and four", /^....….{4}$/.test(s), s);
  check("...and is not the raw address", s !== w.address);
}

console.log(failures === 0 ? "\nall wallet checks passed.\n" : `\n${failures} wallet check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
