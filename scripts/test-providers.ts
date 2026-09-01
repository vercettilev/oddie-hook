// Every surface that offers a sign-in offers ALL of them.
//
// This exists because the same bug shipped three times. A provider was added,
// and a screen that listed providers in literal markup kept listing the old
// set: the connect sheet, then the profile, then the in-feed gate card each
// went on offering X and Google after Phantom existed. Nothing failed, nothing
// logged — the wallet was simply unreachable from that screen, and it took
// somebody looking at it to notice.
//
// It is a static check on purpose. The drift is in the SOURCE — a literal
// provider name written into markup instead of read from the one list — so
// that is what to look for, and it costs nothing to run.
//
// Run with: npm run test-providers

import { readFileSync } from "node:fs";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

const accounts = readFileSync("src/store/accounts.ts", "utf8");
const feed = readFileSync("public/feed.html", "utf8");
const landing = readFileSync("public/landing.html", "utf8");

// --- the one list everything else is measured against ----------------------
const union = accounts.match(/export type Provider\s*=\s*([^;]+);/);
const PROVIDERS = union ? [...union[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]) : [];

console.log("\nthe account layer's provider list is the source of truth");
{
  check("src/store/accounts.ts declares a Provider union", PROVIDERS.length > 0, union?.[1] ?? "not found");
  check("...and it has more than one member (a single-provider union makes this test vacuous)",
    PROVIDERS.length > 1, PROVIDERS.join(", "));
  console.log(`      providers: ${PROVIDERS.join(", ")}`);
}

console.log("\nthe app knows a mark and a label for every one of them");
{
  // PROV is the client's provider table. A provider missing from it renders as
  // `undefined` in a button, or is skipped entirely by the p&&... guards.
  // Bounded to the PROV literal itself. An earlier version let the match run to
  // the next "};" in the file and swept up `headers:{...}` from a fetch call
  // further down — a test that reports keys the source never declared is worse
  // than no test, because the noise is what gets ignored.
  const start = feed.indexOf("const PROV={");
  const end = feed.indexOf("\n", feed.indexOf("phantom:", start));
  const body = start >= 0 ? feed.slice(start, end) : "";
  const keys = [...body.matchAll(/(?:\{|\s)([a-z]+)\s*:\s*\{/g)].map((m) => m[1]);
  check("feed.html defines PROV", keys.length > 0, keys.join(", "));
  for (const p of PROVIDERS) {
    check(`PROV has an entry for "${p}"`, keys.includes(p), `PROV keys: ${keys.join(", ")}`);
  }
  check("PROV has no entry the account layer does not know",
    keys.every((k) => PROVIDERS.includes(k)), `extra: ${keys.filter((k) => !PROVIDERS.includes(k)).join(", ")}`);
}

console.log("\nno screen writes a provider name into its markup by hand");
{
  // The exact shape of all three regressions: a literal provider in a data
  // attribute, next to a hand-typed glyph, instead of a value produced by
  // mapping over the list. Template placeholders (${provider}) are the correct
  // form and are not literals, so they do not match.
  const literals = [...feed.matchAll(/data-(?:connect|p)="([a-z]+)"/g)].map((m) => m[1]);
  check("feed.html has no hardcoded data-connect / data-p provider",
    literals.length === 0,
    literals.length ? `hardcoded: ${[...new Set(literals)].join(", ")} — build these from PROV instead` : "");

  // The same drift, one level up. The landing names its providers literally
  // (it is static HTML with no PROV to read), so instead of banning literals
  // there, require the full set.
  //
  // Two forms are accepted because the landing changed shape once already: it
  // used to LINK to /feed?connect=<p> and now it has data-connect buttons that
  // start the sign-in in place. The invariant being guarded is "the landing
  // offers every provider", not "offers them as links" — this check failing
  // when only the mechanism changed would be the test measuring the wrong
  // thing, and a test people have to placate is a test people delete.
  const linked = [
    ...[...landing.matchAll(/\/feed\?connect=([a-z]+)/g)].map((m) => m[1]),
    ...[...landing.matchAll(/data-connect="([a-z]+)"/g)].map((m) => m[1]),
  ];
  // Third shape, added when the landing stopped offering sign-in at all: the
  // buttons moved into the app, which is where a device id and a session
  // already live. With no sign-in surface there is no set to drift out of, so
  // the parity check has nothing to measure — asserting it anyway would be a
  // test people have to placate, and this file's whole point is that those get
  // deleted. Offering SOME but not all is still the bug, and still fails.
  if (linked.length === 0) {
    check("the landing offers no sign-in at all, so provider parity does not apply to it", true);
  } else {
    for (const p of PROVIDERS) {
      check(`the landing offers "${p}"`, linked.includes(p),
        `landing offers: ${[...new Set(linked)].join(", ")}`);
    }
  }
}

console.log("\nthe server advertises the same set");
{
  const server = readFileSync("src/server.ts", "utf8");
  // /api/auth/me is what the client builds its buttons from. Anything it omits
  // is invisible to every screen at once.
  const me = server.slice(server.indexOf('app.get("/api/auth/me"'), server.indexOf('app.get("/api/auth/me"') + 1200);
  const oauth = readFileSync("src/auth/oauth.ts", "utf8");
  const oauthList = oauth.match(/export const PROVIDERS:[^=]+=\s*\[([^\]]+)\]/);
  const oauthNames = oauthList ? [...oauthList[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]) : [];
  const nonOauth = PROVIDERS.filter((p) => !oauthNames.includes(p));

  check("every OAuth provider is in the account union",
    oauthNames.every((p) => PROVIDERS.includes(p)), oauthNames.join(", "));
  for (const p of nonOauth) {
    // A non-OAuth provider (a wallet) cannot come from PROVIDERS, so the route
    // has to append it explicitly — that append is what this checks.
    check(`/api/auth/me appends the non-OAuth provider "${p}"`,
      me.includes(`"${p}"`), "it is in the union but the route never advertises it");
  }
}

console.log(failures === 0 ? "\nall provider checks passed.\n" : `\n${failures} provider check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
