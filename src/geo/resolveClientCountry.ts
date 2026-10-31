/**
 * IP -> country/region, for the real-money geofence only (see
 * restrictedRegions.ts). Two paths, tried in order, because this app's actual
 * network topology (is it behind Cloudflare or hitting Railway directly?)
 * wasn't known at the time this shipped:
 *
 *   1. A CDN-provided country header (Cloudflare's cf-ipcountry), counted
 *      only when the connection itself came from Cloudflare (see
 *      src/net/edge.ts): anybody reaching Railway directly can send the same
 *      header, so on any other connection it is ignored and this path falls
 *      through cleanly. Free, exact, no local computation.
 *   2. geoip-lite — a self-hosted, offline, MaxMind-GeoLite2-derived
 *      database bundled in node_modules. No external API call per request:
 *      no per-request latency, no rate limit, no cost at scale, and no
 *      third party ever sees a user's IP address. This is the path that
 *      actually runs today, since (1) was unconfirmed.
 *
 * Fails CLOSED on an unresolved IP (private/loopback ranges in local dev, or
 * any address the database has no entry for) — an unresolvable location is
 * treated as RESTRICTED, not "assume it's fine". This was a deliberate
 * reversal: the layer originally shipped fail-open (unresolvable = allowed),
 * flagged explicitly as "a real tradeoff a compliance review should bless" —
 * that review happened, and the call for real money is fail-closed. The
 * practical cost is the same trade in the other direction: local dev now
 * needs a cf-ipcountry header on a request from a Cloudflare address (or a
 * real, resolvable public IP) to exercise the "allowed" path — see
 * scripts/test-geo.ts's fakeReq usage —
 * and a small number of real users with unresolvable IPs will be blocked
 * even though they may not actually be in a restricted location. That's the
 * intended shape for money: default to no, not default to yes.
 */
import type { Request } from "express";
import geoip from "geoip-lite";
import { isRestrictedLocation } from "./restrictedRegions.js";
import { clientIp, cloudflareCountry } from "../net/edge.js";

export interface ClientLocation {
  country: string | null;
  region: string | null;
  source: "cdn-header" | "geoip-lite" | "unresolved";
  restricted: boolean;
}

// Cloudflare's own markers for "no country determined" — never treat these as
// a real country code (in particular, never look them up in the blocklist).
const CF_UNKNOWN = new Set(["XX", "T1"]);

/**
 * The visitor's own IP (src/net/edge.ts): Cloudflare's CF-Connecting-IP when
 * the connection came from Cloudflare, otherwise the address Railway's edge
 * saw, which server.ts's trust proxy setting of 1 makes req.ip.
 */
function visitorIp(req: Request): string | null {
  const ip = clientIp(req);
  return ip === "unknown" ? null : ip;
}

export function resolveClientCountry(req: Request): ClientLocation {
  const cf = cloudflareCountry(req);
  if (cf && !CF_UNKNOWN.has(cf)) {
    return { country: cf, region: null, source: "cdn-header", restricted: isRestrictedLocation(cf, null) };
  }

  const ip = visitorIp(req);
  const hit = ip ? geoip.lookup(ip) : null;
  // Fail CLOSED: no country, no benefit of the doubt — see the file-level
  // comment above. This is a deliberate policy overlay, not a call to
  // isRestrictedLocation(null, ...) — that function answers a different,
  // narrower question (pure set membership) than "is it safe to allow".
  if (!hit) return { country: null, region: null, source: "unresolved", restricted: true };

  const region = hit.region || null;
  return { country: hit.country, region, source: "geoip-lite", restricted: isRestrictedLocation(hit.country, region) };
}
