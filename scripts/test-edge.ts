// Who is on the other end of a request (src/net/edge.ts): Cloudflare's own
// headers count only on a connection from Cloudflare, per-visitor limits key
// on the visitor rather than on Cloudflare's machine, and the Cloudflare-only
// switch refuses what went around Cloudflare while leaving internal callers be.
//
// Run with: npm run test-edge

import type { Request } from "express";
import { clientIp, cloudflareCountry, edgeLockedOut, viaCloudflare } from "../src/net/edge.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
}

const req = (ip: string | undefined, headers: Record<string, string> = {}): Request =>
  ({ ip, headers, socket: { remoteAddress: ip } }) as unknown as Request;

const CF_V4 = "104.16.0.1";        // 104.16.0.0/13
const CF_V6 = "2606:4700::6810:1"; // 2606:4700::/32
const VISITOR = "8.8.8.8";

console.log("\nviaCloudflare: the connecting address, not anything the caller wrote");
{
  check("an address in Cloudflare's IPv4 ranges is Cloudflare", viaCloudflare(req(CF_V4)));
  check("an address in Cloudflare's IPv6 ranges is Cloudflare", viaCloudflare(req(CF_V6)));
  check("an IPv4-mapped IPv6 form of a Cloudflare address is still Cloudflare", viaCloudflare(req(`::ffff:${CF_V4}`)));
  check("an ordinary address is not Cloudflare", !viaCloudflare(req(VISITOR)));
  check("the edge of a range: 104.23.255.255 is inside 104.16.0.0/13", viaCloudflare(req("104.23.255.255")));
  check("…and 104.24.0.0 is the next range's first address, also Cloudflare", viaCloudflare(req("104.24.0.0")));
  check("104.28.0.0 is outside every Cloudflare range", !viaCloudflare(req("104.28.0.0")));
  check("a request with no address at all is not Cloudflare", !viaCloudflare(req(undefined)));
}

console.log("\nclientIp: the visitor, whichever way the request came");
{
  check("through Cloudflare, the visitor is CF-Connecting-IP",
    clientIp(req(CF_V4, { "cf-connecting-ip": VISITOR })) === VISITOR);
  check("through Cloudflare over IPv6, same", clientIp(req(CF_V6, { "cf-connecting-ip": "2001:db8::7" })) === "2001:db8::7");
  check("direct, a forged CF-Connecting-IP is ignored and the connecting address is the key",
    clientIp(req("203.0.113.9", { "cf-connecting-ip": VISITOR })) === "203.0.113.9");
  check("through Cloudflare with a header that is not an address, fall back to the connecting address",
    clientIp(req(CF_V4, { "cf-connecting-ip": "not-an-ip" })) === CF_V4);
  check("a mapped IPv4 peer is reported plainly", clientIp(req("::ffff:203.0.113.9")) === "203.0.113.9");
  check("no address at all reads as 'unknown', the key the old code used", clientIp(req(undefined)) === "unknown");
}

console.log("\ncloudflareCountry: Cloudflare's word, only from Cloudflare");
{
  check("through Cloudflare the header is read and upper-cased", cloudflareCountry(req(CF_V4, { "cf-ipcountry": "tr" })) === "TR");
  check("direct, the same header is nobody's word", cloudflareCountry(req(VISITOR, { "cf-ipcountry": "TR" })) === null);
  check("through Cloudflare with no header, nothing", cloudflareCountry(req(CF_V4)) === null);
}

console.log("\nedgeLockedOut: the Cloudflare-only switch");
{
  check("off (the default), nobody is refused", !edgeLockedOut(req(VISITOR), false));
  check("on, a request from Cloudflare goes through", !edgeLockedOut(req(CF_V4), true));
  check("on, a direct request from the internet is refused", edgeLockedOut(req(VISITOR), true));
  check("on, a forged CF header does not get a direct request in",
    edgeLockedOut(req(VISITOR, { "cf-connecting-ip": "1.1.1.1", "cf-ipcountry": "US" }), true));
  for (const internal of ["127.0.0.1", "10.4.0.12", "172.20.1.5", "192.168.1.10", "100.64.0.7", "::1", "fd12:3456::1"]) {
    check(`on, an internal caller (${internal}) is left alone`, !edgeLockedOut(req(internal), true));
  }
  check("on, a request with no address is refused rather than waved through", edgeLockedOut(req(undefined), true));
}

console.log(failures === 0 ? "\nall edge checks passed.\n" : `\n${failures} edge check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
