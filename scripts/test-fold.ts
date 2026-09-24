// Folding a mint is DISPLAY ONLY. The question is hashed on chain at creation,
// so folding the canonical copy breaks every verification of that hash, and the
// resolution criteria are where an address belongs whole because that string IS
// the rule. These pin the boundary, not the regex.
import { readFileSync } from "node:fs";
import { foldIds, displayTitle } from "../src/title.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

const MINT = "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp";
const Q = `Will the Solana token at mint address ${MINT} reach 90 by the end of this week?`;

{
  const out = foldIds(Q);
  check("a 44-character mint is folded", !out.includes(MINT), out.slice(0, 70));
  check("...keeping both ends, which is how a person checks one",
    out.includes("oreoU2") && out.includes("ybcp"), out);
  check("...and the rest of the sentence is untouched",
    out.startsWith("Will the Solana token at mint address ") && out.endsWith("end of this week?"), out);
  check("folding is shorter than not folding", out.length < Q.length - 25, `${out.length} vs ${Q.length}`);
}
{
  // Ordinary words are not addresses, however long. The class excludes 0, O, I
  // and l, so base58 is what matches and English is not.
  const plain = "Will Bitcoin close above one hundred thousand dollars on Friday?";
  check("plain English is never folded", foldIds(plain) === plain, foldIds(plain));
  check("a short ticker survives", foldIds("Will $ORE reach $80 today?") === "Will $ORE reach $80 today?");
}
{
  check("folding composes with the title rule", foldIds(displayTitle(`${Q} — Yes`)) === foldIds(Q));
}

/* THE BOUNDARY, CHECKED IN THE SOURCE. A fold applied to the canonical field is
   not a rendering bug, it is a market whose published question no longer hashes
   to what the chain stored. */
{
  const server = readFileSync("src/server.ts", "utf8");
  const bad = server.match(/^\s*question: foldIds\(/m);
  check("the canonical question is never folded on the way out", !bad, bad?.[0] ?? "");
  check("the readable copy is published beside it, not instead of it",
    /questionDisplay: foldIds\(/.test(server) && /^\s*question: (m|detail)\.question,$/m.test(server));
  const criteria = server.match(/(resolutionCriteria|criteria): foldIds\(/);
  check("the resolution criteria keep their address whole", !criteria, criteria?.[0] ?? "");
}

/* AND THE CLIENTS ACTUALLY READ IT. Publishing questionDisplay and then not
   printing it is the same bug wearing a new field name. */
for (const f of ["public/app/market.html", "public/app/markets.html"]) {
  const html = readFileSync(f, "utf8");
  const raw = [...html.matchAll(/esc\(m\.question\)/g)].length;
  check(`${f.split("/").pop()} prints no raw question`, raw === 0, `${raw} left`);
  check(`...and does read questionDisplay`, /m\.questionDisplay \|\| m\.question/.test(html));
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall green\n");
process.exit(failures ? 1 : 0);
