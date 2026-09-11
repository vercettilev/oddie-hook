/**
 * WEB PUSH, BY HAND, BECAUSE THIS REPO HOLDS A MAINNET KEY.
 *
 * The obvious move is `npm i web-push`. It is the standard, it is maintained,
 * and it would be about forty lines instead of this file. It is also another
 * package with install scripts and a dependency tree inside a process that
 * signs Solana transactions with an admin key that mints every market we own.
 * Seven dependencies is not an accident here; it is the thing standing between
 * that key and somebody else's postinstall.
 *
 * So this is RFC 8291 (aes128gcm payload encryption) and RFC 8292 (VAPID) on
 * node:crypto, which has every primitive both of them need.
 *
 * HOW IT IS VERIFIED, because cryptographic code that silently produces
 * undecryptable garbage is the worst kind: the browser is the test. A push
 * whose encryption is wrong shows nothing at all, so `npm run test-push` does
 * the key agreement against a subscription keypair it generates itself and
 * decrypts its own record back — which proves the ECDH, the HKDF chain, the
 * nonce and the cipher — and the end-to-end proof is a real notification
 * arriving on a real device.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is retry, queue or batch. A push is an
 * announcement about money that has already moved; the money is safe whether
 * or not it arrives, and the profile says the same thing forever. A failed
 * push is logged and dropped. A 404 or 410 means the subscription is dead and
 * the caller is told to delete it, which is the only failure worth acting on.
 */
import {
  createECDH, createCipheriv, createDecipheriv, hkdfSync,
  randomBytes, createPublicKey, createPrivateKey, sign as signRaw,
} from "node:crypto";

const b64url = (b: Buffer): string => b.toString("base64url");
const unb64url = (s: string): Buffer => Buffer.from(s, "base64url");

/** What the browser handed us. `keys.p256dh` is its public point, `keys.auth`
 *  the shared secret that salts the first extraction. */
export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidKeys {
  /** Uncompressed P-256 point, 65 bytes, base64url. Public by design: it is
   *  handed to every browser that subscribes. */
  publicKey: string;
  /** The 32-byte scalar, base64url. A secret, and the only one here. */
  privateKey: string;
  /** RFC 8292 wants a way to reach whoever is sending. */
  subject: string;
}

/* ------------------------------------------------------------- VAPID ---- */

/** A P-256 private key object from the raw 32-byte scalar the VAPID format
 *  stores. Node will not import a bare scalar, so it is wrapped in the minimal
 *  DER a SEC1 EC private key needs, with the public point alongside it. */
function vapidPrivateKey(privateKeyB64: string, publicKeyB64: string) {
  const d = unb64url(privateKeyB64);
  const q = unb64url(publicKeyB64);
  if (d.length !== 32) throw new Error(`VAPID private key must be 32 bytes, got ${d.length}`);
  if (q.length !== 65 || q[0] !== 0x04) throw new Error("VAPID public key must be a 65-byte uncompressed point");
  // SEC1: SEQUENCE { INTEGER 1, OCTET STRING d, [0] OID prime256v1, [1] BIT STRING q }
  const der = Buffer.concat([
    Buffer.from("308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420", "hex"),
    d,
    Buffer.from("a14403420004", "hex"),
    q.subarray(1),
  ]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/**
 * The Authorization header.
 *
 * `aud` is the ORIGIN of the endpoint and nothing else: push services reject a
 * token whose audience carries the path, and the path is per-subscription, so
 * getting this wrong fails for everybody at once rather than visibly.
 */
export function vapidHeader(endpoint: string, keys: VapidKeys, nowSec = Math.floor(Date.now() / 1000)): string {
  const aud = new URL(endpoint).origin;
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  // Twelve hours. The spec caps it at 24 and a shorter window is one fewer
  // stolen-token problem; it is minted per send, so there is nothing to cache.
  const body = b64url(Buffer.from(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: keys.subject })));
  const signing = Buffer.from(`${header}.${body}`);
  // ieee-p1363, not DER. An ES256 JWT signature is the raw r||s pair, and
  // node's default for EC is DER, which every push service rejects.
  const sig = signRaw("sha256", signing, {
    key: vapidPrivateKey(keys.privateKey, keys.publicKey),
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${header}.${body}.${b64url(sig)}, k=${keys.publicKey}`;
}

/* -------------------------------------------------- payload encryption ---- */

const KEY_INFO = Buffer.from("WebPush: info\0", "utf8");
const CEK_INFO = Buffer.from("Content-Encoding: aes128gcm\0", "utf8");
const NONCE_INFO = Buffer.from("Content-Encoding: nonce\0", "utf8");
/** One record, and the payload is a short sentence, so the size is a constant
 *  rather than a decision. */
const RECORD_SIZE = 4096;

/**
 * RFC 8291. The body is salt || rs || idlen || as_public || ciphertext, and
 * the plaintext carries a 0x02 delimiter marking it as the last record.
 *
 * `salt` and `ephemeral` are parameters ONLY so the test can pin them; every
 * real call generates both fresh, and reusing either with the same key would
 * be the classic nonce-reuse break of AES-GCM.
 */
export function encryptPayload(
  sub: PushSubscription, plaintext: Buffer,
  salt = randomBytes(16), ephemeral?: ReturnType<typeof createECDH>,
): Buffer {
  // Generated HERE rather than in a default argument: an ECDH object throws on
  // getPublicKey() until generateKeys() has run, so a default that looked
  // harmless made every real call fail while the test that passed its own key
  // stayed green.
  let ec = ephemeral;
  if (!ec) { ec = createECDH("prime256v1"); ec.generateKeys(); }
  const uaPublic = unb64url(sub.keys.p256dh);
  const authSecret = unb64url(sub.keys.auth);
  const asPublic = ec.getPublicKey();

  const shared = ec.computeSecret(uaPublic);
  // Extract with the auth secret, expand over both public points: this is what
  // binds the record to THIS subscription and nobody else's.
  const keyInfo = Buffer.concat([KEY_INFO, uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, CEK_INFO, 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, NONCE_INFO, 12));

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 is "this is the last record". 0x01 would promise another.
  const body = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const ct = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE, 0);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

/**
 * The inverse, and it exists for exactly one reason: to be the test.
 *
 * A push whose encryption is subtly wrong does not error anywhere on our side.
 * It arrives, the browser fails to decrypt it, and nothing appears — so the
 * only way to catch a wrong HKDF info string or a swapped public point before
 * a real user misses a real payout is to play the browser's part here.
 */
export function decryptPayload(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);

  const ua = createECDH("prime256v1");
  ua.setPrivateKey(uaPrivate);
  const shared = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([KEY_INFO, uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, CEK_INFO, 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, NONCE_INFO, 12));

  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  const out = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
  // Strip the trailing delimiter and any padding behind it.
  let end = out.length - 1;
  while (end >= 0 && out[end] === 0x00) end--;
  return out.subarray(0, end);
}

/* ------------------------------------------------------------- sending ---- */

export type PushResult =
  | { ok: true; status: number }
  | { ok: false; status: number; gone: boolean; error: string };

/**
 * One push, to one subscription.
 *
 * `gone` is the only failure a caller should act on: 404 and 410 are the push
 * service saying this subscription no longer exists, which means the row is
 * dead and keeping it means trying forever. Everything else is weather.
 */
export async function sendPush(
  sub: PushSubscription, payload: unknown, keys: VapidKeys, ttlSec = 86_400,
): Promise<PushResult> {
  try {
    const body = encryptPayload(sub, Buffer.from(JSON.stringify(payload), "utf8"));
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidHeader(sub.endpoint, keys),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(ttlSec),
        // A payout is worth waking a screen for; anything less would be
        // batched by the push service and arrive whenever.
        Urgency: "normal",
      },
      // A Buffer is not a BodyInit as far as the DOM types go; the bytes are
      // the same either way and the copy is one short record.
      body: new Uint8Array(body),
    });
    if (res.ok) return { ok: true, status: res.status };
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, gone: res.status === 404 || res.status === 410, error: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: (e as Error).message };
  }
}

/** Read the keys from the environment, or null when push is simply not set up.
 *  Null is a normal state: every caller degrades to sending nothing. */
export function vapidFromEnv(): VapidKeys | null {
  const publicKey = (process.env.VAPID_PUBLIC_KEY ?? "").trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY ?? "").trim();
  const subject = (process.env.VAPID_SUBJECT ?? "https://oddie.fun").trim();
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

/** Generate a pair. Printed by scripts/push-keys.ts, never called at runtime. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ec = createECDH("prime256v1");
  ec.generateKeys();
  return { publicKey: b64url(ec.getPublicKey()), privateKey: b64url(ec.getPrivateKey()) };
}

/** Test seam: the public key as node sees it, for asserting the DER wrapper
 *  above produced an importable key rather than a plausible-looking one. */
export function _vapidPublicFromPrivate(privateKeyB64: string, publicKeyB64: string): string {
  const key = vapidPrivateKey(privateKeyB64, publicKeyB64);
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  return b64url(Buffer.from(spki.subarray(spki.length - 65)));
}
