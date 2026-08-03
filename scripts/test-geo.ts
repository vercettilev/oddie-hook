// The real-money geofence: isRestrictedLocation's pure logic, and
// resolveClientCountry's two-path resolution (CDN header first, geoip-lite
// fallback) against a minimal fake Express request — no network, no real IP
// lookups beyond geoip-lite's own bundled offline database.
//
// Run with: npm run test-geo

import { isRestrictedLocation, RESTRICTED_COUNTRIES, RESTRICTED_UA_REGIONS } from "../src/geo/restrictedRegions.js";
import { resolveClientCountry } from "../src/geo/resolveClientCountry.js";
import type { Request } from "express";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
}

const fakeReq = (headers: Record<string, string>, ip: string | null): Request =>
  ({ headers, ip: ip ?? undefined }) as unknown as Request;

console.log("\nisRestrictedLocation: the OFAC-comprehensive baseline, nothing more");
{
  check("Cuba is restricted", isRestrictedLocation("CU", null));
  check("Iran is restricted", isRestrictedLocation("IR", null));
  check("North Korea is restricted", isRestrictedLocation("KP", null));
  check("lowercase input still matches (case-insensitive)", isRestrictedLocation("cu", null));
  check("an ordinary country is not restricted", !isRestrictedLocation("US", null));
  check("isRestrictedLocation(null,...) is pure set-membership, not policy — a null country simply isn't IN the set; resolveClientCountry (below) is what decides fail-open vs fail-closed for an unresolved IP",
    !isRestrictedLocation(null, null));
  // The line this whole file exists to get right: comprehensively-embargoed
  // vs. merely-sanctioned. Confirmed via a live OFAC fetch the same day this
  // shipped — Syria dropped off the comprehensive list on 2025-07-01; Russia
  // and Belarus have extensive sectoral sanctions but were NEVER comprehensive.
  check("Syria is NOT on the list (embargo ended 2025-07-01 — do not regress this)",
    !isRestrictedLocation("SY", null));
  check("Russia is NOT on the list (sectoral, not comprehensive)", !isRestrictedLocation("RU", null));
  check("Belarus is NOT on the list (sectoral, not comprehensive)", !isRestrictedLocation("BY", null));
  check("exactly 3 comprehensively-embargoed countries", RESTRICTED_COUNTRIES.size === 3, String(RESTRICTED_COUNTRIES.size));
}

console.log("\nisRestrictedLocation: the Ukraine sub-national carve-out");
{
  check("Crimea (region 43) is restricted", isRestrictedLocation("UA", "43"));
  check("Sevastopol (region 40) is restricted", isRestrictedLocation("UA", "40"));
  check("Donetsk (region 14) is restricted", isRestrictedLocation("UA", "14"));
  check("Luhansk (region 09) is restricted", isRestrictedLocation("UA", "09"));
  check("the rest of Ukraine is NOT restricted (e.g. Kyiv, region 30)", !isRestrictedLocation("UA", "30"));
  check("Ukraine with no region resolved is NOT restricted — the carve-out needs the region to fire",
    !isRestrictedLocation("UA", null));
  check("these region codes only apply under UA — the same code under a different country is not restricted",
    !isRestrictedLocation("US", "43"));
  check("exactly 4 restricted UA regions", RESTRICTED_UA_REGIONS.size === 4, String(RESTRICTED_UA_REGIONS.size));
}

console.log("\nresolveClientCountry: CDN header path (Cloudflare cf-ipcountry)");
{
  const cu = resolveClientCountry(fakeReq({ "cf-ipcountry": "CU" }, "203.0.113.1"));
  check("a restricted CDN header is trusted directly, no geoip-lite lookup needed",
    cu.source === "cdn-header" && cu.restricted === true, JSON.stringify(cu));

  const us = resolveClientCountry(fakeReq({ "cf-ipcountry": "US" }, "203.0.113.1"));
  check("an allowed CDN header passes through as not restricted",
    us.source === "cdn-header" && us.restricted === false, JSON.stringify(us));

  const unknown = resolveClientCountry(fakeReq({ "cf-ipcountry": "XX" }, "8.8.8.8"));
  check("Cloudflare's own 'unknown' marker (XX) is never treated as a real country — falls through to geoip-lite",
    unknown.source !== "cdn-header", JSON.stringify(unknown));

  const tor = resolveClientCountry(fakeReq({ "cf-ipcountry": "T1" }, "8.8.8.8"));
  check("Cloudflare's Tor marker (T1) also falls through, not treated as a country",
    tor.source !== "cdn-header", JSON.stringify(tor));
}

console.log("\nresolveClientCountry: geoip-lite fallback (no CDN header present)");
{
  // 8.8.8.8 (Google Public DNS) is a stable, well-known US-geolocated IP —
  // safe to assert on across environments and geoip-lite database updates.
  const us = resolveClientCountry(fakeReq({}, "8.8.8.8"));
  check("a real public IP resolves via geoip-lite when no CDN header is present",
    us.source === "geoip-lite" && us.country === "US" && us.restricted === false, JSON.stringify(us));

  const noIp = resolveClientCountry(fakeReq({}, null));
  check("no resolvable IP at all -> unresolved, fails CLOSED (restricted — legal-verified real-money policy)",
    noIp.source === "unresolved" && noIp.restricted === true, JSON.stringify(noIp));

  const loopback = resolveClientCountry(fakeReq({}, "127.0.0.1"));
  check("a loopback address (local dev) resolves as unresolved, and is now RESTRICTED by the fail-closed policy — dev needs an explicit cf-ipcountry header to test the allowed path",
    loopback.source === "unresolved" && loopback.restricted === true, JSON.stringify(loopback));
}

console.log("\nREGIME 2 · the venue list (Jupiter ToU §1), and the contractual gate over it");
{
  const {
    VENUE_RESTRICTED_COUNTRIES, VENUE_RESTRICTED_UA_REGIONS,
    isVenueRestrictedLocation, venueRealMoneyAllowed, VENUE_TERMS_CLEARED,
  } = await import("../src/geo/restrictedRegions.js");

  // Every jurisdiction named in §1, transcribed. If this drifts from the
  // quoted clause in restrictedRegions.ts, one of the two is wrong.
  const named: Array<[string, string]> = [
    ["US", "United States"], ["TW", "Republic of China (read literally)"], ["CN", "China (read as most terms mean it)"],
    ["SG", "Singapore"], ["MM", "Myanmar"], ["CI", "Cote d'Ivoire"], ["CU", "Cuba"],
    ["CD", "DR Congo"], ["IR", "Iran"], ["IQ", "Iraq"], ["LY", "Libya"], ["ML", "Mali"],
    ["NI", "Nicaragua"], ["KP", "North Korea"], ["SO", "Somalia"], ["SD", "Sudan"],
    ["SY", "Syria"], ["YE", "Yemen"], ["ZW", "Zimbabwe"],
  ];
  for (const [cc, label] of named) {
    check(`${label} (${cc}) is venue-restricted`, isVenueRestrictedLocation(cc, null));
  }
  check("exactly the 19 countries in §1 (incl. both readings of 'Republic of China')",
    VENUE_RESTRICTED_COUNTRIES.size === 19, String(VENUE_RESTRICTED_COUNTRIES.size));
  check("Crimea/Sevastopol/Donetsk/Luhansk carried over", VENUE_RESTRICTED_UA_REGIONS.size === 4);
  check("the rest of Ukraine is not venue-restricted", !isVenueRestrictedLocation("UA", "30"));

  // The US block is what makes Polymarket's state list moot — and it is the
  // ONLY reason this regime is implementable, since our IP data resolves a US
  // state for barely 30% of US addresses.
  check("the US is blocked WHOLESALE, which subsumes Polymarket's 8 state blocks",
    ["AZ", "IL", "MA", "MD", "MI", "MT", "NV", "OH", "CA", "NY"].every((s) => isVenueRestrictedLocation("US", s)));

  // The two lists answer different questions and must NOT be synced.
  check("Syria is venue-restricted (source is stricter than the law)…", isVenueRestrictedLocation("SY", null));
  check("…while staying OFF the OFAC baseline, which is about the law", !isRestrictedLocation("SY", null));
  check("the US is venue-restricted but NOT on the OFAC baseline",
    isVenueRestrictedLocation("US", null) && !isRestrictedLocation("US", null));

  // The contractual gate sits ABOVE geography and is currently shut.
  check("VENUE_TERMS_CLEARED is false — §3.2(d)/§7.3/§7.5 unanswered", VENUE_TERMS_CLEARED === false);
  check("a perfectly allowed location is STILL refused while the terms are open",
    venueRealMoneyAllowed({ country: "GB", region: null, restricted: false }) === false);
  check("an unresolved location is refused too (fail-closed, inherited)",
    venueRealMoneyAllowed({ country: null, region: null, restricted: true }) === false);
  check("a restricted location is refused",
    venueRealMoneyAllowed({ country: "US", region: "CA", restricted: false }) === false);
}

console.log("\nGEOBLOCK_LIST_VERIFIED: the legal sign-off gate");
{
  check("the list is marked verified (set only after counsel reviewed the exact CU/IR/KP + UA-region contents)",
    RESTRICTED_COUNTRIES.size === 3 && RESTRICTED_UA_REGIONS.size === 4);
  const { GEOBLOCK_LIST_VERIFIED } = await import("../src/geo/restrictedRegions.js");
  check("GEOBLOCK_LIST_VERIFIED is true", GEOBLOCK_LIST_VERIFIED === true);
  check("the US is not in the restricted set", !isRestrictedLocation("US", null));
}

console.log(failures === 0 ? "\nall geo checks passed.\n" : `\n${failures} geo check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
