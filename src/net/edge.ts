/**
 * WHO IS ACTUALLY ON THE OTHER END OF A REQUEST.
 *
 * Measured on 2026-10-31, against Railway's own request log: req.ip (trust
 * proxy 1, see server.ts) is NOT the visitor. It is one of Railway's edge
 * servers (AS60068, Amsterdam, 152.233.x.x), whichever way the request came,
 * while Railway's log shows the visitor's real address for the same request.
 * So every per-visitor limit keyed on req.ip (meteredRoute, the v1 create
 * quota) was quietly one limit shared by everybody behind the same edge
 * server, and the geoip fallback placed every visitor in the Netherlands.
 *
 * The same measurement also means addresses cannot tell whether a request came
 * through Cloudflare at all, and Railway's edge answers anybody who connects
 * to it directly with our Host header, which walks around everything the
 * Cloudflare zone does (its DDoS protection, its rate limiting rule).
 *
 * So the zone stamps its own requests. A Request Header Transform Rule in the
 * Cloudflare dashboard sets x-oddie-edge on every request to a value only the
 * zone and this service know (ORIGIN_SECRET in Railway). A request carrying it
 * came through Cloudflare, and on such a request Cloudflare's own
 * CF-Connecting-IP and CF-IPCountry are the visitor's (Cloudflare refuses a
 * request that arrives already carrying CF-Connecting-IP). A request without
 * the stamp went around Cloudflare, and its CF headers are whatever the caller
 * wrote.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type { Request } from "express";

export const EDGE_HEADER = "x-oddie-edge";

/* Addresses that never come in from the internet: loopback, the private
   ranges, carrier-grade NAT (Railway's own network) and IPv6 unique-local.
   A request from one of these did not cross Railway's public edge, so the
   Cloudflare-only switch leaves it alone (health checks, the service calling
   itself). */
const INTERNAL_V4 = ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16"];
const INTERNAL_V6 = ["::1/128", "fc00::/7", "fe80::/10"];
const internal = new BlockList();
for (const cidr of INTERNAL_V4) { const [net, bits] = cidr.split("/"); internal.addSubnet(net, Number(bits), "ipv4"); }
for (const cidr of INTERNAL_V6) { const [net, bits] = cidr.split("/"); internal.addSubnet(net, Number(bits), "ipv6"); }

/** A clean address or null. Node reports IPv4 peers on a dual-stack socket as
 *  "::ffff:1.2.3.4"; the ranges above are written as plain IPv4. */
function bare(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().replace(/^::ffff:/i, "");
  return isIP(v) ? v : null;
}

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Read per call rather than at boot, so a rotated secret needs no code path
 *  of its own and the tests can set one. */
const originSecret = (): string => (process.env.ORIGIN_SECRET ?? "").trim();
const digest = (v: string): Buffer => createHash("sha256").update(v).digest();

function stampMatches(req: Request): boolean {
  const secret = originSecret();
  const got = header(req, EDGE_HEADER);
  if (!secret || !got) return false;
  return timingSafeEqual(digest(got), digest(secret));
}

/* The stamp is checked once, by the first middleware, and then taken off the
   request so no handler, error page or log line downstream ever holds the
   value. What is remembered is only that it matched. */
const stamped = new WeakSet<object>();

/** First thing on every request: remember whether the zone stamped it, then
 *  drop the header. */
export function takeStamp(req: Request): void {
  if (stampMatches(req)) stamped.add(req);
  delete req.headers[EDGE_HEADER];
}

/** True when the request came through the Cloudflare zone. */
export function viaCloudflare(req: Request): boolean {
  return stamped.has(req) || stampMatches(req);
}

/** The address this service sees: Railway's edge server for anything from the
 *  internet, the caller itself for anything internal (see the top of the file). */
export function peerIp(req: Request): string | null {
  return bare(req.ip) ?? bare(req.socket?.remoteAddress);
}

/** The visitor's address, the key every per-visitor limit uses: Cloudflare's
 *  word for it on a stamped request, the address we see otherwise. */
export function clientIp(req: Request): string {
  if (viaCloudflare(req)) {
    const told = bare(header(req, "cf-connecting-ip"));
    if (told) return told;
  }
  return peerIp(req) ?? "unknown";
}

/** Cloudflare's country for the visitor, only on a request the zone stamped:
 *  on any other request cf-ipcountry is a header the caller wrote. */
export function cloudflareCountry(req: Request): string | null {
  if (!viaCloudflare(req)) return null;
  const v = header(req, "cf-ipcountry")?.trim().toUpperCase();
  return v || null;
}

/**
 * THE CLOUDFLARE-ONLY SWITCH, BEHIND A FLAG.
 *
 * With CLOUDFLARE_ONLY=true every request from the internet that does not carry
 * the zone's stamp gets a short 403 before any route runs, so going around
 * Cloudflare buys a caller nothing heavier than that. Off by default and an
 * env change rather than a deploy, so it goes on only once GET /api/edge
 * answers "cloudflare" through the real domain, and comes off just as fast.
 * With no ORIGIN_SECRET set there is nothing to check a stamp against, and the
 * switch refuses nobody rather than everybody.
 */
export const CLOUDFLARE_ONLY = (process.env.CLOUDFLARE_ONLY ?? "").toLowerCase() === "true";

export function edgeLockedOut(req: Request, on: boolean = CLOUDFLARE_ONLY): boolean {
  if (!on || !originSecret()) return false;
  if (viaCloudflare(req)) return false;
  const ip = peerIp(req);
  return !(ip && internal.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4"));
}

/** Said once at boot when the switch is on but has no secret to check. */
export function edgeMisconfigured(): string | null {
  return CLOUDFLARE_ONLY && !originSecret()
    ? "CLOUDFLARE_ONLY is on but ORIGIN_SECRET is empty, so nothing is locked"
    : null;
}
