/**
 * Real-money geofencing — governs ONLY the opt-in on-chain real-stakes layer
 * (see src/chain/oddieChain.ts, and the ONCHAIN_ENABLED-gated routes in
 * server.ts). The free play-token flow is never gated by anything in this
 * file, for anyone, anywhere.
 *
 * Scope is deliberately narrow and current status is deliberately spelled
 * out, because a stale or approximate sanctions list is worse than an
 * honestly incomplete one:
 *
 *   - RESTRICTED_COUNTRIES is the set of jurisdictions under a COMPREHENSIVE
 *     US OFAC embargo (not the much longer list of countries with ANY OFAC
 *     program — e.g. Russia and Belarus have extensive targeted/sectoral
 *     sanctions but are NOT comprehensively embargoed, and are deliberately
 *     excluded here). Verified by live-fetching treasury.gov/ofac directly
 *     on 2026-08-02 — NOT carried over from training data. That fetch is
 *     exactly what caught that Syria dropped off this list on 2025-07-01
 *     (Executive Order terminating the embargo; OFAC formally removed the
 *     Syrian Sanctions Regulations from the CFR on 2025-08-26) — a change
 *     over a year old that a memorized "Cuba/Iran/NKorea/Syria" list would
 *     have silently gotten wrong. Re-verify this list periodically; OFAC
 *     does not publish a single machine-readable "comprehensive" flag, so
 *     there is no feed to subscribe to instead.
 *
 *   - This is NOT yet Polymarket's full restricted-jurisdictions list. That
 *     research hit a hard wall (polymarket.com was unreachable from the
 *     research environment; secondary sources disagreed with each other on
 *     specifics). Shipping the verifiable OFAC baseline now, broadening
 *     later once a primary-sourced Polymarket list is available, was the
 *     explicit, deliberate call — see the commit this file shipped in.
 *
 *   - Crimea, Donetsk, and Luhansk carry a comprehensive embargo (E.O. 13685
 *     and related determinations) even though the rest of Ukraine does not.
 *     RESTRICTED_UA_REGIONS is a BEST-EFFORT sub-national check on top of the
 *     country check — and it has a real, structural limitation: consumer
 *     IP-geolocation data has no reliable way to resolve occupied/contested
 *     territory, and Crimean traffic increasingly routes through Russian
 *     infrastructure and geolocates as country=RU — which is correctly NOT
 *     in RESTRICTED_COUNTRIES (Russia isn't comprehensively embargoed), so
 *     that traffic would slip through this check entirely. This is an
 *     inherent gap in IP-based geolocation for this specific territory, not
 *     a bug in this code; flagged explicitly rather than papered over.
 */
export const RESTRICTED_COUNTRIES: ReadonlySet<string> = new Set([
  "CU", // Cuba
  "IR", // Iran
  "KP", // North Korea
]);

/**
 * ISO 3166-2:UA subdivision codes, without the "UA-" prefix — the format
 * geoip-lite's `region` field uses (confirmed from its own README: "ISO
 * 3166-2 code", example `region: 'TX'` for a US state). Coverage for these
 * specific oblasts in the free bundled dataset is unverified in this
 * environment; the format is standard, the DATA for this territory is the
 * uncertain part (see the file-level doc comment above).
 */
export const RESTRICTED_UA_REGIONS: ReadonlySet<string> = new Set([
  "43", // Autonomous Republic of Crimea
  "40", // Sevastopol (separate special-status city)
  "14", // Donetsk Oblast
  "09", // Luhansk Oblast
]);

/** True if this country/region combination falls under the embargo above. */
export function isRestrictedLocation(country: string | null, region: string | null): boolean {
  if (!country) return false; // unresolved IP — see resolveClientCountry's fail-open note
  const c = country.toUpperCase();
  if (RESTRICTED_COUNTRIES.has(c)) return true;
  if (c === "UA" && region && RESTRICTED_UA_REGIONS.has(region)) return true;
  return false;
}
