/**
 * THE CRYPTO, CHECKED, BECAUSE A WRONG PUSH LOOKS EXACTLY LIKE NO PUSH.
 *
 * Web push fails silently by design. If the HKDF info strings are wrong, or the
 * two public points are concatenated the other way round, or the signature is
 * DER instead of raw, nothing on our side errors: the request is accepted, the
 * browser cannot decrypt the record, and no notification appears. A winner
 * misses a payout and the logs say the push was sent.
 *
 * So this plays the browser's part. It generates a subscription keypair the way
 * a real browser does, encrypts a record to it, and decrypts it back — which
 * exercises the ECDH, the whole HKDF chain, the nonce and the cipher against
 * each other rather than against themselves.
 *
 * Run with: npm run test-push
 */
import { createECDH, createPublicKey, verify } from "node:crypto";
import {
  encryptPayload, decryptPayload, vapidHeader, generateVapidKeys, sendPush,
  _vapidPublicFromPrivate, type PushSubscription,
} from "../src/push/webpush.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.error(`  ✗ ${n}`); if (d) console.error(`      ${d}`); }
};
/** The value, or what it threw, so a refused key reads as a failed check
 *  rather than as a stack trace that stops every check after it. */
const attempt = (f: () => string): string => {
  try { return f(); } catch (e) { return `threw: ${(e as Error).message}`; }
};

/** A subscription exactly as a browser produces one: a P-256 keypair whose
 *  public point is p256dh, and 16 random bytes of auth secret. */
function fakeSubscription(endpoint: string) {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = Buffer.from("0123456789abcdef", "utf8"); // 16 bytes, fixed so a failure is reproducible
  const sub: PushSubscription = {
    endpoint,
    keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
  };
  return { sub, uaPrivate: ua.getPrivateKey(), uaPublic: ua.getPublicKey(), auth };
}

console.log("\nweb push\n");

/* --------------------------------------------------------------- VAPID -- */
{
  const { publicKey, privateKey } = generateVapidKeys();
  check("a generated public key is an uncompressed P-256 point",
    Buffer.from(publicKey, "base64url").length === 65 && Buffer.from(publicKey, "base64url")[0] === 0x04);
  check("...and the private key is the bare 32-byte scalar",
    Buffer.from(privateKey, "base64url").length === 32);

  /* The DER wrapper is the part most likely to be plausible and wrong: node
     accepts a malformed-but-parseable key and then signs with the wrong point,
     which every push service rejects with a 401 nobody reads. */
  check("the hand-rolled DER imports to the SAME public point",
    _vapidPublicFromPrivate(privateKey, publicKey) === publicKey,
    `${_vapidPublicFromPrivate(privateKey, publicKey)} vs ${publicKey}`);

  const keys = { publicKey, privateKey, subject: "https://oddie.fun" };
  const h = vapidHeader("https://fcm.googleapis.com/fcm/send/abc123?x=1", keys, 1_700_000_000);
  check("the header is vapid t=<jwt>, k=<key>", /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(h), h);
  check("...and k is the public key", h.endsWith(`k=${publicKey}`));

  const payload = JSON.parse(Buffer.from(h.split("t=")[1].split(".")[1], "base64url").toString());
  /* THE AUDIENCE IS THE ORIGIN AND NOTHING ELSE. With the path on it every
     push is rejected at once, which at least fails loudly; the subtler bug is
     that the path is per-subscription, so a cached token would be wrong for
     everybody but the person it was minted for. */
  check("aud is the endpoint's ORIGIN, with no path",
    payload.aud === "https://fcm.googleapis.com", payload.aud);
  check("...it expires within a day", payload.exp > 1_700_000_000 && payload.exp <= 1_700_000_000 + 86_400);
  check("...and says who is sending", payload.sub === "https://oddie.fun");

  const sig = Buffer.from(h.split(".")[2].split(",")[0], "base64url");
  // 64 bytes is r||s. A DER signature would be 70-72 and silently rejected.
  check("the signature is raw r||s, not DER", sig.length === 64, `${sig.length} bytes`);
}
{
  /* ONE KEY IN 256 BEGINS WITH A ZERO BYTE, and node's getPrivateKey() hands
     it back without that byte: 31 bytes, not 32. The random pair above lands
     on it one run in 256, which is how the length check failed once on
     2 Oct 2026 and passed on every rerun. This scalar starts with 0x00, so the
     case runs every time: through the generator's padding, through the DER
     import, and as the 31-byte value an older pair may still be stored as. */
  const d = Buffer.from("00" + "5c".repeat(31), "hex");
  const ec = createECDH("prime256v1");
  ec.setPrivateKey(d);
  const point = ec.getPublicKey();
  check("the fixture is the case node shortens: getPrivateKey() gives 31 bytes",
    ec.getPrivateKey().length === 31, `${ec.getPrivateKey().length} bytes`);

  const { publicKey, privateKey } = generateVapidKeys(ec);
  const generated = Buffer.from(privateKey, "base64url");
  check("a scalar that starts with 0x00 is generated at all 32 bytes, zero kept",
    generated.equals(d), generated.toString("hex"));
  const imported = attempt(() => _vapidPublicFromPrivate(privateKey, publicKey));
  check("...and the hand-rolled DER imports it to the SAME public point", imported === publicKey, imported);

  /* THAT IMPORT CANNOT TELL A RIGHT SCALAR FROM A WRONG ONE. The DER carries
     the public point verbatim and node never checks the scalar against it, so
     a zero padded onto the wrong end would import just as cleanly. A signature
     can tell: one made with the key has to verify against the point this
     scalar really has, read here from the bare coordinates rather than from
     the wrapper under test. */
  const truePoint = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") },
    format: "jwk",
  });
  const signs = (priv: string) => attempt(() => {
    const h = vapidHeader("https://fcm.googleapis.com/fcm/send/abc123", { publicKey, privateKey: priv, subject: "https://oddie.fun" }, 1_700_000_000);
    const [head, body, sig] = h.slice("vapid t=".length, h.indexOf(", k=")).split(".");
    const ok = verify("sha256", Buffer.from(`${head}.${body}`), { key: truePoint, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
    return ok ? "verifies" : "does not verify";
  });
  const signed = signs(privateKey);
  check("a header signed with it verifies against the scalar's own point", signed === "verifies", signed);

  /* A PAIR GENERATED BEFORE THE FIX MAY ALREADY SIT IN RAILWAY AT 31 BYTES.
     It is the same number, so it is padded back and never refused: refusing
     it would turn off every push for everybody who has allowed notifications. */
  const stored = d.subarray(1).toString("base64url");
  const storedImported = attempt(() => _vapidPublicFromPrivate(stored, publicKey));
  check("a stored 31-byte key imports to the same point, padded rather than refused",
    storedImported === publicKey, storedImported);
  const storedSigned = signs(stored);
  check("...and signs headers that verify", storedSigned === "verifies", storedSigned);

  // Two leading zeros, one key in 65,536: padded to 32, not padded by one.
  const d2 = Buffer.from("0000" + "5c".repeat(30), "hex");
  const ec2 = createECDH("prime256v1");
  ec2.setPrivateKey(d2);
  const generated2 = Buffer.from(generateVapidKeys(ec2).privateKey, "base64url");
  check("two leading zeros come back as two", generated2.equals(d2), generated2.toString("hex"));
}

/* ---------------------------------------------------------- encryption -- */
{
  const { sub, uaPrivate, uaPublic, auth } = fakeSubscription("https://example.push/x");
  const msg = Buffer.from(JSON.stringify({ title: "oddie", body: "Your market settled." }), "utf8");
  const body = encryptPayload(sub, msg);

  check("the record is framed salt || rs || idlen || key || ciphertext",
    body.length > 21 + 65 && body[20] === 65, `idlen=${body[20]}`);
  check("...with the record size the spec wants", body.readUInt32BE(16) === 4096, String(body.readUInt32BE(16)));

  const back = decryptPayload(body, uaPrivate, uaPublic, auth);
  check("a browser holding the subscription key can read it back",
    back.toString("utf8") === msg.toString("utf8"), back.toString("utf8").slice(0, 60));
}
{
  /* NONCE REUSE IS THE ONE WAY TO BREAK AES-GCM WITHOUT BREAKING AES. Two
     records to the same subscription must not share a salt or an ephemeral
     key, and the default arguments are what guarantee it. */
  const { sub } = fakeSubscription("https://example.push/y");
  const a = encryptPayload(sub, Buffer.from("one"));
  const b = encryptPayload(sub, Buffer.from("one"));
  check("two sends of the same text produce different records",
    !a.equals(b) && !a.subarray(0, 16).equals(b.subarray(0, 16)));
  check("...and different ephemeral keys",
    !a.subarray(21, 86).equals(b.subarray(21, 86)));
}
{
  // The wrong subscription must not be able to read it, which is the whole
  // point of binding the record to both public points.
  const mine = fakeSubscription("https://example.push/a");
  const theirs = fakeSubscription("https://example.push/b");
  const body = encryptPayload(mine.sub, Buffer.from("private"));
  let refused = false;
  try { decryptPayload(body, theirs.uaPrivate, theirs.uaPublic, theirs.auth); } catch { refused = true; }
  check("somebody else's key cannot read it", refused);
}

/* ------------------------------------------------- the whole send, for real */
{
  /* THE PUSH SERVICE'S PART, PLAYED LOCALLY.
     Everything above proves the pieces against each other. This proves the
     thing that actually goes out: a real POST, over real HTTP, with the headers
     a push service checks and a body only the subscription's key can open.
     It is a better test than clicking Allow in a browser, because a browser
     that shows nothing tells you nothing about which of six steps was wrong. */
  const http = await import("node:http");
  const got: { headers: Record<string, string | string[] | undefined>; body: Buffer }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      got.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const { sub, uaPrivate, uaPublic, auth } = fakeSubscription(`http://127.0.0.1:${port}/push/abc`);
  const { publicKey, privateKey } = generateVapidKeys();
  const keys = { publicKey, privateKey, subject: "https://oddie.fun" };
  const payload = { title: "oddie", body: "A market you were in settled YES.", url: "/profile", tag: "payout:x" };

  const r = await sendPush(sub, payload, keys);
  check("the push is accepted by the service", r.ok && r.status === 201, JSON.stringify(r));
  check("...exactly one request went out", got.length === 1);

  const h = got[0].headers;
  check("it declares the encoding a push service demands",
    h["content-encoding"] === "aes128gcm" && h["content-type"] === "application/octet-stream",
    `${h["content-encoding"]} / ${h["content-type"]}`);
  check("...carries a TTL, so the service knows how long to hold it", h["ttl"] === "86400", String(h["ttl"]));
  check("...and a VAPID authorization", String(h["authorization"] || "").startsWith("vapid t="));

  /* THE ONE THAT MATTERS: the bytes that travelled open with the subscription's
     own key and say what we meant to say. */
  const back = JSON.parse(decryptPayload(got[0].body, uaPrivate, uaPublic, auth).toString("utf8"));
  check("the browser could read exactly what we sent",
    back.body === payload.body && back.url === payload.url && back.tag === payload.tag,
    JSON.stringify(back));

  await new Promise<void>((r2) => server.close(() => r2()));
}
{
  /* A DEAD SUBSCRIPTION HAS TO BE RECOGNISABLE, because it is the only failure
     worth acting on: kept, it is retried forever for a browser that will never
     answer again. */
  const http = await import("node:http");
  const server = http.createServer((_req, res) => res.writeHead(410).end("gone"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const { sub } = fakeSubscription(`http://127.0.0.1:${port}/push/dead`);
  const { publicKey, privateKey } = generateVapidKeys();
  const r = await sendPush(sub, { title: "x" }, { publicKey, privateKey, subject: "https://oddie.fun" });
  check("a 410 is reported as gone, not as weather", !r.ok && r.gone === true, JSON.stringify(r));
  await new Promise<void>((r2) => server.close(() => r2()));
}
{
  // And an unreachable endpoint must not throw its way up into a settlement.
  const { sub } = fakeSubscription("http://127.0.0.1:1/push/nowhere");
  const { publicKey, privateKey } = generateVapidKeys();
  const r = await sendPush(sub, { title: "x" }, { publicKey, privateKey, subject: "https://oddie.fun" });
  check("an unreachable push service returns rather than throws", !r.ok && r.gone === false);
}

console.log(failures === 0 ? "\nall push checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
