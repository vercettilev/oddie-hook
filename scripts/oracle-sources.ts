// Which sources can actually be CITED?
//
// The audit only passes a citation when we can fetch the page ourselves and
// find the quoted words in it. That makes the set of citable domains a real,
// measurable property of the internet rather than an assumption — and it feeds
// straight back into extractClaim, which tells the model to "name a source a
// stranger could go verify". A source that renders in JavaScript or refuses our
// fetch is not that source, however respectable it looks in the criteria.
//
// This hits live third-party sites, so it is not part of `npm run test`.
//
//   npx tsx scripts/oracle-sources.ts [url ...]
//
// Each page is asked to verify a sentence taken out of its OWN text. A page
// that fails that cannot support any honest citation at all.

import { htmlToText, auditCitation } from "../src/oracle/audit.js";

const DEFAULTS = [
  "https://en.wikipedia.org/wiki/Premier_League",
  "https://www.bbc.com/news",
  "https://www.reuters.com/",
  "https://www.coingecko.com/en/coins/bitcoin",
  "https://www.premierleague.com/results",
  "https://www.anthropic.com/news",
  "https://apnews.com/",
  "https://www.espn.com/soccer/",
];
const urls = process.argv.slice(2).filter((a) => a.startsWith("http"));
const targets = urls.length ? urls : DEFAULTS;

console.log(`\n  ${targets.length} source(s). "verified" means the page contains its own words when we fetch it.\n`);
let citable = 0;
for (const url of targets) {
  let html = "";
  let status = 0;
  try {
    const r = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "oddie-oracle/1.0 (+https://oddie.fun)" },
      signal: AbortSignal.timeout(12_000),
    });
    status = r.status;
    if (r.ok) html = await r.text();
  } catch {
    status = 0;
  }
  if (!html) {
    console.log(`  DEAD      ${String(status || "timeout").padStart(7)}  ${url}`);
    continue;
  }
  // A CONTIGUOUS run out of the page's own middle. An earlier version of this
  // dropped numeric tokens first, which stitched "Jul" to "Investigating" across
  // a stripped year and asked every page to verify a sentence that had never
  // been on it. Three sources looked unciteable that were not.
  const words = htmlToText(html).replace(/\s+/g, " ").trim().split(" ");
  const mid = Math.floor(words.length / 2);
  const span = words.slice(mid, mid + 14).join(" ");
  const a = await auditCitation({ url, quote: span }, null);
  if (a.status === "verified") citable++;
  console.log(
    `  ${a.status.padEnd(9)} ${String(Math.round(html.length / 1024)).padStart(5)}K  ` +
    `date=${(a.datedAt ?? "none").slice(0, 10).padEnd(10)}  ${url}`,
  );
  if (a.status !== "verified") console.log(`            span: "${span.slice(0, 80)}"`);
}
console.log(`\n  ${citable} of ${targets.length} can carry a citation.\n`);
