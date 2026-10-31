/**
 * WHO IS ACTUALLY ON THE OTHER END OF A REQUEST.
 *
 * Railway's edge is the one proxy this service trusts (server.ts sets trust
 * proxy to 1), so req.ip is whatever connected to that edge. Without a CDN
 * that is the visitor. With app.oddie.fun proxied through Cloudflare it is one
 * of Cloudflare's own machines, and every per-visitor limit keyed on it
 * (meteredRoute, the v1 create quota) would collapse onto a handful of
 * Cloudflare addresses: a crowd watching one stream would share one hourly
 * quota and the first few people would spend it for everybody.
 *
 * Cloudflare writes the visitor's address into CF-Connecting-IP and the
 * visitor's country into CF-IPCountry. Those are ordinary request headers,
 * though, and anybody who reaches Railway without going through Cloudflare
 * can send them too. So they count only when the connection itself came from
 * one of Cloudflare's published ranges, and are ignored everywhere else.
 *
 * Bumping trust proxy to 2 instead would read the right address through
 * Cloudflare and a caller-written one around it, which is the hole the trust
 * proxy comment in server.ts describes.
 */
import { BlockList, isIP } from "node:net";
import type { Request } from "express";

/* cloudflare.com/ips-v4 and /ips-v6, read 2026-10-31. Cloudflare changes these
   rarely and announces it; an address missing from here only makes a visitor
   look like a direct caller (keyed on the Cloudflare machine, and refused
   while CLOUDFLARE_ONLY is on), it never lets a forged header through. */
const CLOUDFLARE_V4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
];
const CLOUDFLARE_V6 = [
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
  "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
];

/* Addresses that never come in from the internet: loopback, the private
   ranges, carrier-grade NAT (Railway's own network) and IPv6 unique-local.
   A request from one of these did not cross Railway's public edge, so the
   Cloudflare-only switch leaves it alone (health checks, the service calling
   itself). */
const INTERNAL_V4 = ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16"];
const INTERNAL_V6 = ["::1/128", "fc00::/7", "fe80::/10"];

function listOf(v4: string[], v6: string[]): BlockList {
  const list = new BlockList();
  for (const cidr of v4) { const [net, bits] = cidr.split("/"); list.addSubnet(net, Number(bits), "ipv4"); }
  for (const cidr of v6) { const [net, bits] = cidr.split("/"); list.addSubnet(net, Number(bits), "ipv6"); }
  return list;
}
const cloudflare = listOf(CLOUDFLARE_V4, CLOUDFLARE_V6);
const internal = listOf(INTERNAL_V4, INTERNAL_V6);

/** A clean address or null. Node reports IPv4 peers on a dual-stack socket as
 *  "::ffff:1.2.3.4"; the ranges above are written as plain IPv4. */
function bare(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().replace(/^::ffff:/i, "");
  return isIP(v) ? v : null;
}

function inList(list: BlockList, ip: string | null): boolean {
  if (!ip) return false;
  return list.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
}

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** The address that connected to Railway's edge: the visitor, or Cloudflare. */
export function peerIp(req: Request): string | null {
  return bare(req.ip) ?? bare(req.socket?.remoteAddress);
}

/** True when the request reached Railway from one of Cloudflare's machines. */
export function viaCloudflare(req: Request): boolean {
  return inList(cloudflare, peerIp(req));
}

/** The visitor's own address: Cloudflare's word for it when Cloudflare is the
 *  one asking, the connecting address otherwise. */
export function clientIp(req: Request): string {
  if (viaCloudflare(req)) {
    const told = bare(header(req, "cf-connecting-ip"));
    if (told) return told;
  }
  return peerIp(req) ?? "unknown";
}

/** Cloudflare's country for the visitor, only when Cloudflare sent it. */
export function cloudflareCountry(req: Request): string | null {
  if (!viaCloudflare(req)) return null;
  const v = header(req, "cf-ipcountry")?.trim().toUpperCase();
  return v || null;
}

/**
 * THE CLOUDFLARE-ONLY SWITCH, BEHIND A FLAG.
 *
 * Proxying the DNS names through Cloudflare protects nothing on its own while
 * Railway still answers anybody who connects to it directly, by its
 * *.up.railway.app name or by its edge address with our Host header. With
 * CLOUDFLARE_ONLY=true every request from the internet that did not come
 * through Cloudflare gets a short 403 before any route runs. Off by default
 * and an env change rather than a deploy, so it goes on only after the proxy
 * is confirmed working (GET /api/edge answers "cloudflare") and comes off
 * just as fast.
 */
export const CLOUDFLARE_ONLY = (process.env.CLOUDFLARE_ONLY ?? "").toLowerCase() === "true";

export function edgeLockedOut(req: Request, on: boolean = CLOUDFLARE_ONLY): boolean {
  if (!on) return false;
  if (viaCloudflare(req)) return false;
  return !inList(internal, peerIp(req));
}
