// Who is on the other end of a request (src/net/edge.ts): the Cloudflare zone's
// stamp is the only thing that marks a request as having come through it, the
// stamp never outlives the first middleware, Cloudflare's country header counts
// only on a stamped request, and the Cloudflare-only switch refuses what went
// around Cloudflare while leaving internal callers be.
//
// Run with: npm run test-edge

import type { Request } from "express";

const STAMP = "test-zone-stamp";
process.env.ORIGIN_SECRET = STAMP;
const { EDGE_HEADER, clientIp, cloudflareCountry, edgeLockedOut, takeStamp, viaCloudflare } = await import("../src/net/edge.js");

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
}

const req = (ip: string | undefined, headers: Record<string, string> = {}): Request =>
  ({ ip, headers: { ...headers }, socket: { remoteAddress: ip } }) as unknown as Request;
const VISITOR = "8.8.8.8";

console.log("\nviaCloudflare: the zone's stamp, nothing else");
{
  check("a request carrying the stamp came through Cloudflare", viaCloudflare(req(VISITOR, { [EDGE_HEADER]: STAMP })));
  check("a request without it did not", !viaCloudflare(req(VISITOR)));
  check("a wrong stamp is no stamp", !viaCloudflare(req(VISITOR, { [EDGE_HEADER]: "a-guess" })));
  check("a stamp that only starts right is no stamp", !viaCloudflare(req(VISITOR, { [EDGE_HEADER]: STAMP.slice(0, 6) })));
  check("Cloudflare's own headers prove nothing on their own",
    !viaCloudflare(req(VISITOR, { "cf-ray": "8d1c", "cf-connecting-ip": VISITOR, "cf-ipcountry": "US" })));
  const prev = process.env.ORIGIN_SECRET;
  process.env.ORIGIN_SECRET = "";
  check("with no secret configured, not even an empty stamp counts", !viaCloudflare(req(VISITOR, { [EDGE_HEADER]: "" })));
  process.env.ORIGIN_SECRET = prev;
}

console.log("\ntakeStamp: checked once, then gone from the request");
{
  const r = req(VISITOR, { [EDGE_HEADER]: STAMP });
  takeStamp(r);
  check("the header is removed, so nothing downstream can log or echo it", !(EDGE_HEADER in r.headers));
  check("…and the request is still known to have come through Cloudflare", viaCloudflare(r));
  const forged = req(VISITOR, { [EDGE_HEADER]: "a-guess" });
  takeStamp(forged);
  check("a wrong stamp is removed too, and the request stays direct", !(EDGE_HEADER in forged.headers) && !viaCloudflare(forged));
}

console.log("\nclientIp: the visitor, from Cloudflare on a stamped request");
{
  const RAILWAY_EDGE = "152.233.12.245"; // what req.ip actually is from the internet
  check("stamped, the visitor is CF-Connecting-IP, not Railway's edge server",
    clientIp(req(RAILWAY_EDGE, { [EDGE_HEADER]: STAMP, "cf-connecting-ip": VISITOR })) === VISITOR);
  const taken = req(RAILWAY_EDGE, { [EDGE_HEADER]: STAMP, "cf-connecting-ip": VISITOR });
  takeStamp(taken);
  check("…and still after the first middleware has taken the stamp off", clientIp(taken) === VISITOR);
  check("stamped over IPv6, same", clientIp(req(RAILWAY_EDGE, { [EDGE_HEADER]: STAMP, "cf-connecting-ip": "2001:db8::7" })) === "2001:db8::7");
  check("stamped with a header that is not an address, fall back to the address we see",
    clientIp(req(RAILWAY_EDGE, { [EDGE_HEADER]: STAMP, "cf-connecting-ip": "not-an-ip" })) === RAILWAY_EDGE);
  check("unstamped, a forged CF-Connecting-IP changes nothing",
    clientIp(req(RAILWAY_EDGE, { "cf-connecting-ip": "1.2.3.4" })) === RAILWAY_EDGE);
  check("unstamped, the address we see is the key", clientIp(req(VISITOR)) === VISITOR);
  check("a mapped IPv4 peer is reported plainly", clientIp(req("::ffff:203.0.113.9")) === "203.0.113.9");
  check("no address at all reads as 'unknown', the key the old code used", clientIp(req(undefined)) === "unknown");
}

console.log("\ncloudflareCountry: Cloudflare's word, only on a stamped request");
{
  check("stamped, the header is read and upper-cased", cloudflareCountry(req(VISITOR, { [EDGE_HEADER]: STAMP, "cf-ipcountry": "tr" })) === "TR");
  check("unstamped, the same header is nobody's word", cloudflareCountry(req(VISITOR, { "cf-ipcountry": "TR" })) === null);
  check("stamped with no country header, nothing", cloudflareCountry(req(VISITOR, { [EDGE_HEADER]: STAMP })) === null);
}

console.log("\nedgeLockedOut: the Cloudflare-only switch");
{
  check("off (the default), nobody is refused", !edgeLockedOut(req(VISITOR), false));
  check("on, a stamped request goes through", !edgeLockedOut(req(VISITOR, { [EDGE_HEADER]: STAMP }), true));
  check("on, an unstamped request from the internet is refused", edgeLockedOut(req(VISITOR), true));
  check("on, Cloudflare's headers without the stamp do not get a direct request in",
    edgeLockedOut(req(VISITOR, { "cf-ray": "8d1c", "cf-connecting-ip": "1.1.1.1" }), true));
  for (const internal of ["127.0.0.1", "10.4.0.12", "172.20.1.5", "192.168.1.10", "100.64.0.7", "::1", "fd12:3456::1"]) {
    check(`on, an internal caller (${internal}) is left alone`, !edgeLockedOut(req(internal), true));
  }
  check("on, a request with no address is refused rather than waved through", edgeLockedOut(req(undefined), true));
  const prev = process.env.ORIGIN_SECRET;
  process.env.ORIGIN_SECRET = "";
  check("on but with no secret configured, nobody is refused (a missing secret must not lock out everybody)",
    !edgeLockedOut(req(VISITOR), true));
  process.env.ORIGIN_SECRET = prev;
}

console.log(failures === 0 ? "\nall edge checks passed.\n" : `\n${failures} edge check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
