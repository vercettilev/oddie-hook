// The sign-in surfaces offer exactly the providers the product offers.
//
// This file exists because the same bug shipped three times: a provider was
// added, and a screen that listed providers in literal markup kept listing
// the old set. Nothing failed, nothing logged, the new one was simply
// unreachable from that screen. So it is a static check on the SOURCE.
//
// The invariant changed shape on 2026-09-05 and the file says so rather than
// pretending: Google sign-in was dropped (the identity is X; settlement is an
// X reply, not an email), and the surfaces were deliberately split. Genesis
// offers X and nothing else, because it is the campaign. The app offers X at
// its door and the wallet at the bet, because that is where each one pays.
// So "every surface offers ALL providers" is no longer the rule. The rules
// that survive are these three, and each one is a regression somebody could
// actually ship:
//   1. no surface offers a provider the product no longer offers (a Google
//      button quietly coming back);
//   2. the app really does offer both of the two that remain;
//   3. nobody hand-types a provider name into markup instead of reading it
//      from the one list.
//
// Run with: npm run test-providers

import { readFileSync } from "node:fs";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** What the product OFFERS. Not the same set as what the account layer KNOWS:
 *  the union in accounts.ts must keep "google" because production rows exist
 *  with it, and a type that cannot describe stored data is a lie. */
const OFFERED = ["twitter", "phantom"] as const;

const accounts = read("src/store/accounts.ts");
const union = accounts.match(/export type Provider\s*=\s*([^;]+);/);
const KNOWN = union ? [...union[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]) : [];

console.log("\nthe account layer knows every provider the product offers");
{
  check("src/store/accounts.ts declares a Provider union", KNOWN.length > 0, union?.[1] ?? "not found");
  for (const p of OFFERED) check(`the union contains "${p}"`, KNOWN.includes(p), `known: ${KNOWN.join(", ")}`);
  console.log(`      known: ${KNOWN.join(", ")}   offered: ${OFFERED.join(", ")}`);
}

const SURFACES: Record<string, string> = {
  "public/landing.html": read("public/landing.html"),
  "public/genesis.html": read("public/genesis.html"),
  "public/app/markets.html": read("public/app/markets.html"),
  "public/app/market.html": read("public/app/market.html"),
  "public/app/you.html": read("public/app/you.html"),
  "public/app/leaderboard.html": read("public/app/leaderboard.html"),
  "public/app/who.html": read("public/app/who.html"),
  "public/chain.js": read("public/chain.js"),
};

console.log("\nno surface offers a provider the product dropped");
{
  const dropped = KNOWN.filter((p) => !(OFFERED as readonly string[]).includes(p));
  check("something was in fact dropped, so this check is not vacuous", dropped.length > 0, KNOWN.join(", "));
  for (const [file, src] of Object.entries(SURFACES)) {
    for (const p of dropped) {
      // A sign-in for a dropped provider has exactly two shapes: its OAuth
      // start route, or a data-connect/data-p literal. Font hosts and comments
      // are not offers.
      const offers = new RegExp(`auth/${p}/start|data-(?:connect|p)="${p}"`).test(src);
      check(`${file} does not offer "${p}"`, !offers);
    }
  }
}

console.log("\nthe app offers both providers that remain, where each one pays");
{
  const app = SURFACES["public/app/markets.html"] + SURFACES["public/app/you.html"];
  check("the app's door offers X (the gate on the list and on /you)", /auth\/twitter\/start/.test(app));
  check("genesis offers X (the campaign's connect)", /auth\/twitter\/start/.test(SURFACES["public/genesis.html"]));
  // The wallet is offered by chain.js, which the money shells load. It is the
  // only place a wallet can be connected, so both facts are checked: the
  // offer exists, and the shells that take money reach it.
  check("chain.js offers the wallet (Phantom detection + connect)",
    /isPhantom/.test(SURFACES["public/chain.js"]) && /provider\.connect\(\)/.test(SURFACES["public/chain.js"]));
  for (const f of ["public/app/market.html", "public/app/you.html"]) {
    check(`${f} loads chain.js, so the wallet is reachable from it`, /src="\/chain\.js"/.test(SURFACES[f]));
  }
}

console.log("\nno screen writes a provider name into its markup by hand");
{
  // The exact shape of all three regressions: a literal provider in a data
  // attribute instead of a value produced from the list. Template
  // placeholders (${provider}) are the correct form and do not match.
  for (const [file, src] of Object.entries(SURFACES)) {
    if (!file.endsWith(".html")) continue;
    const literals = [...src.matchAll(/data-(?:connect|p)="([a-z]+)"/g)].map((m) => m[1]);
    check(`${file} has no hardcoded data-connect / data-p provider`, literals.length === 0,
      literals.length ? `hardcoded: ${[...new Set(literals)].join(", ")}` : "");
  }
}

console.log("\nthe server advertises the same set");
{
  const server = read("src/server.ts");
  const at = server.indexOf('app.get("/api/auth/me"');
  const me = server.slice(at, at + 1200);
  const oauth = read("src/auth/oauth.ts");
  const oauthList = oauth.match(/export const PROVIDERS:[^=]+=\s*\[([^\]]+)\]/);
  const oauthNames = oauthList ? [...oauthList[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]) : [];
  check("every OAuth provider is in the account union", oauthNames.every((p) => KNOWN.includes(p)), oauthNames.join(", "));
  // A wallet is not an OAuth provider, so the route has to append it by hand;
  // that append is the only way any screen ever learns it exists.
  check('/api/auth/me appends the non-OAuth provider "phantom"', me.includes('"phantom"'),
    "it is offered but the route never advertises it");
}

console.log(failures === 0 ? "\nall provider checks passed.\n" : `\n${failures} provider check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
