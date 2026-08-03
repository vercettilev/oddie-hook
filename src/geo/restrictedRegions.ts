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

/** True if this country/region combination falls under the embargo above.
 *  Pure set-membership only — a null/unknown country is correctly "not a
 *  member of this set," which is NOT the same question as "should an
 *  unresolvable IP be allowed to stake real money." That policy call (now:
 *  fail CLOSED) lives in resolveClientCountry, one layer up. */
export function isRestrictedLocation(country: string | null, region: string | null): boolean {
  if (!country) return false;
  const c = country.toUpperCase();
  if (RESTRICTED_COUNTRIES.has(c)) return true;
  if (c === "UA" && region && RESTRICTED_UA_REGIONS.has(region)) return true;
  return false;
}

/**
 * Legal sign-off gate for the whole real-money layer. The two sets above are
 * DATA; whether counsel has actually reviewed and approved the CURRENT
 * contents of both is a separate fact, and the real-money layer must not be
 * enableable in production until that fact is true — see server.ts, where
 * both /api/chain/status and the real-stakes route-registration gate require
 * this to be true, on top of (not instead of) ONCHAIN_ENABLED.
 *
 * Verified by Lev's lawyer, confirmed 2026-08-02, against exactly this list:
 * RESTRICTED_COUNTRIES = {CU, IR, KP} and RESTRICTED_UA_REGIONS = {43, 40,
 * 14, 09} (Crimea, Sevastopol, Donetsk, Luhansk) — the US is NOT in either
 * set. If EITHER set above changes, this MUST be reset to false until
 * re-verified: a stale approval on a changed list is worse than no approval
 * at all, because it looks like clearance that was never actually given for
 * the new contents.
 */
export const GEOBLOCK_LIST_VERIFIED = true;

/* ------------------------------------------------- REGIME 2 · venue markets --
 * A SECOND, STRICTER list, for real-money on Polymarket-sourced markets only.
 * Our own parimutuel (REGIME 1) blocks nobody; this list exists because
 * sourcing venue markets means accepting the source API's own terms, and
 * those are not ours to negotiate.
 *
 * Transcribed from Jupiter's Terms of Use §1 "Prohibited Localities"
 * (developers.jup.ag/docs/legal/terms-of-use), read on 2026-08-03:
 *
 *   "Jupiter does not interact with digital wallets located in, established
 *    in, or a resident of the United States, the Republic of China,
 *    Singapore, Myanmar (Burma), Cote D'Ivoire (Ivory Coast), Cuba, Crimea
 *    and Sevastopol, Democratic Republic of Congo, Iran, Iraq, Libya, Mali,
 *    Nicaragua, Democratic People's Republic of Korea (North Korea),
 *    Somalia, Sudan, Syria, Yemen, Zimbabwe or any other state, country or
 *    region that is subject to sanctions enforced by the United States, the
 *    United Kingdom or the European Union."
 *
 * Three things worth knowing before anyone edits this:
 *
 *  1. The UNITED STATES is on it, in full. That is what makes Polymarket's
 *     eight state-level blocks (AZ, IL, MA, MD, MI, MT, NV, OH) moot for
 *     this regime — they are subsumed by a total US block, which is the only
 *     reason this list is implementable at all. Our IP data resolves a US
 *     state for barely 30% of US addresses (measured, not estimated), so a
 *     state-level rule was never going to be a real control. A country-level
 *     rule is.
 *
 *  2. "the Republic of China" is genuinely ambiguous. Read literally it is
 *     TAIWAN (TW); most consumer terms using that phrasing mean mainland
 *     CHINA (CN). We block BOTH, because the cost of over-blocking here is a
 *     lost user and the cost of under-blocking is a terms breach. If counsel
 *     gets a definitive reading, narrow it — do not widen it silently.
 *
 *  3. SYRIA is on this list even though it is deliberately NOT on the OFAC
 *     baseline above (we verified the comprehensive embargo ended
 *     2025-07-01). The two lists answer different questions: the baseline is
 *     "who does the law forbid", this one is "who does our data source
 *     forbid". A source can be stricter than the law, and we still have to
 *     honour it. Do not "fix" the discrepancy by syncing them.
 */
export const VENUE_RESTRICTED_COUNTRIES: ReadonlySet<string> = new Set([
  "US", // United States — in full; subsumes Polymarket's 8 state blocks
  "TW", // "Republic of China", read literally
  "CN", // ...and read as most consumer terms mean it. Both, deliberately — see note 2
  "SG", // Singapore
  "MM", // Myanmar (Burma)
  "CI", // Cote D'Ivoire
  "CU", // Cuba
  "CD", // Democratic Republic of Congo
  "IR", // Iran
  "IQ", // Iraq
  "LY", // Libya
  "ML", // Mali
  "NI", // Nicaragua
  "KP", // North Korea
  "SO", // Somalia
  "SD", // Sudan
  "SY", // Syria — see note 3
  "YE", // Yemen
  "ZW", // Zimbabwe
]);

/** Crimea and Sevastopol are named in §1 directly; Donetsk and Luhansk come in
 *  via its "any other region subject to US/UK/EU sanctions" catch-all. */
export const VENUE_RESTRICTED_UA_REGIONS: ReadonlySet<string> = new Set(["43", "40", "14", "09"]);

/** Venue-regime membership. Pure set logic, like isRestrictedLocation — the
 *  fail-closed policy for an unresolved country still lives one layer up in
 *  resolveClientCountry, and applies here identically. */
export function isVenueRestrictedLocation(country: string | null, region: string | null): boolean {
  if (!country) return false;
  const c = country.toUpperCase();
  if (VENUE_RESTRICTED_COUNTRIES.has(c)) return true;
  if (c === "UA" && region && VENUE_RESTRICTED_UA_REGIONS.has(region)) return true;
  return false;
}

/**
 * The CONTRACTUAL gate, which is separate from and additional to the
 * geographic one — and is currently CLOSED.
 *
 * Geofencing answers "may this user be here". It does not answer any of:
 *   §3.2(d) — may we surface API-obtained content to our own users at all
 *             ("sell, lease, share, transfer or sublicense … to any third
 *             party"); our users are third parties to that agreement.
 *   §7.3    — we must perform wallet screening and AML/KYC due diligence. We
 *             are deliberately non-custodial with no KYC and do no screening.
 *   §7.5    — we must be able to block a specific wallet on written request.
 *             We have no such mechanism.
 *
 * None of the three is fixable with an IP lookup, so no amount of geoblocking
 * flips this. It stays false until counsel answers all three IN WRITING.
 */
export const VENUE_TERMS_CLEARED = false;

/** The only sanctioned way to ask "can this request use a venue real-money
 *  surface". Both gates, contractual first — so that even a perfectly
 *  geolocated user in an allowed country is refused while the terms are
 *  unresolved, which is the current and intended state. */
export function venueRealMoneyAllowed(loc: { country: string | null; region: string | null; restricted: boolean }): boolean {
  if (!VENUE_TERMS_CLEARED) return false;
  if (loc.restricted) return false;                  // fail-closed on unresolved, inherited
  return !isVenueRestrictedLocation(loc.country, loc.region);
}
