// The front door after 1 Oct: every argument, not every tweet.
//
// The landing and the app list used to describe a product that lived on X: an
// X composer in the hero and at the close, "Tagged markets", an empty state
// that said "Tag @oddiefun on X". Kick and Telegram were live and appeared
// nowhere. These pin the parts that are easy to undo by accident: the three
// doors, the streamer door, the list that hides dead cards, the dollar figure
// that never invents a price, and the opener's share said without arithmetic.
import { readFileSync } from "node:fs";
import { solUsd, _setSolUsd } from "../src/price/solUsd.js";
import { _setPriceFeed, type PriceFeed } from "../src/price/feed.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

const landing = readFileSync("public/landing.html", "utf8");
const list = readFileSync("public/app/markets.html", "utf8");
const page = readFileSync("public/app/market.html", "utf8");
const server = readFileSync("src/server.ts", "utf8");

console.log("the landing names all three doors");
{
  check("the headline is the one-liner", /<h1 class="h1"><span>Every argument<\/span><span class="lo">is a market\.<\/span><\/h1>/.test(landing));
  check("no line says the product is X-only", !/about anything on X/.test(landing));
  for (const [door, href] of [
    ["!oddie", "https://app.oddie.fun/live"],
    ["@oddiefun", "https://x.com/intent/post?text=%40oddiefun%20"],
    ["@oddiefunbot", "https://t.me/oddiefunbot"],
  ]) {
    const n = landing.split(`<a class="door" href="${href}">`).length - 1;
    check(`${door} is a door in the hero and at the close`, n === 2, `${n} found`);
  }
  check("the creators field has a card per door",
    /id="creators"[\s\S]*?<h3>Streamers<\/h3>[\s\S]*?<h3>Creators on X<\/h3>[\s\S]*?<h3>Communities<\/h3>/.test(landing));
  check("...and the streamer card still links to /live", /<h3>Streamers<\/h3>[\s\S]{0,300}href="https:\/\/app\.oddie\.fun\/live"/.test(landing));
  check("...and the nav can reach it", /href="#creators">For creators</.test(landing));
  check("the hero chat is in English, the page speaks to everyone", !/cumaya|görmez/.test(landing));
  check("no card says KOL", !/\bKOLs?\b/.test(landing));
  check("the description names Kick and Telegram", /<meta name="description" content="[^"]*Kick[^"]*Telegram/.test(landing));
  check("no X composer is left to wire", !/data-ask/.test(landing) && !/EXAMPLES/.test(landing));
  check("step three never states a side for a market still open",
    !/<div class="step">[\s\S]*?3\. It pays[\s\S]*?(Settled|Result): (YES|NO)/i.test(landing));
  check("the board slot is back, behind a threshold", /<!--BOARD-->/.test(landing)
    && /const BOARD_MIN = 5;/.test(server) && /boardRows\.length < BOARD_MIN \? ""/.test(server));
  check("the live cards are a biggest pool and a closing-soon clock",
    /Biggest pool/.test(server) && /Closing soon/.test(server) && /class="clock" data-at="/.test(server));
  check("an unminted open market can close soon (it is minted on its first stake)",
    /if \(!m\.onchainPubkey\) return \[\{ m, lamports: 0 \}\];/.test(server));
  check("...but a minted one whose read failed is left out, not shown as empty",
    /if \(!r\?\.ok\) return \[\];/.test(server));
  check("...and the page ticks the clock", /querySelectorAll\("\.clock\[data-at\]"\)/.test(landing));
}

console.log("\nthe list shows what you can still bet on");
{
  check("the heading is Markets, not Tagged markets", /<h1>Markets /.test(list) && !/Tagged markets/.test(list));
  check("open cards are drawn from the open set", /view\.innerHTML = open\.map\(/.test(list));
  check("a closed market with money waits underneath",
    /isShut\(m\) && \(poolSol\(m\) > 0 \|\| m\.oddsSource === "unreadable"/.test(list));
  check("...as a row that goes to the market page", /class="wrow"><a href="\/m\//.test(list));
  check("the empty state names all three doors", /!oddie<\/b> on Kick[\s\S]{0,80}@oddiefun<\/b> on X[\s\S]{0,80}@oddiefunbot<\/b> on Telegram/.test(list));
  check("a Kick or Telegram origin wins over the X handle", /var origin = originChip\(m\.openedBy\);\s*if \(origin\)/.test(list));
  check("the API publishes where it was opened", /openedBy: openedBy\[m\.slug\] \?\? null/.test(server));
  check("...from the one helper the market page uses too",
    (server.match(/openedByFor\(/g) ?? []).length >= 3);
}

console.log("\ndollars beside SOL, never invented");
{
  for (const [name, html] of [["markets.html", list], ["market.html", page]] as const) {
    check(`${name}: no dollar figure without a price`, /if \(!\(SOL_USD > 0\) \|\| !\(sol > 0\)\) return "";/.test(html));
  }
  check("both APIs send the cached price", (server.match(/solUsd: (usd|await solUsd\(\))/g) ?? []).length === 2);

  const failing: PriceFeed = {
    searchPairs: async () => [], searchPools: async () => [], ohlcv: async () => [],
    tokenInfo: async () => { throw new Error("rate limited"); },
  };
  _setPriceFeed(failing);
  const now = Date.now();
  _setSolUsd({ usd: 117.5, at: now - 10 * 60_000 });
  check("a failed read keeps a price under an hour old", (await solUsd(now)) === 117.5);
  _setSolUsd({ usd: 117.5, at: now - 2 * 60 * 60_000 });
  check("...and gives up on one older than that", (await solUsd(now)) === null);
  _setSolUsd(null);
  check("...and with no price ever read, says nothing", (await solUsd(now)) === null);
  _setPriceFeed({ ...failing, tokenInfo: async () => ({ mint: "", symbol: "SOL", name: "", decimals: 9, totalSupply: null, priceUsd: 120, topPools: [] }) });
  check("a good read is the price", (await solUsd(Date.now())) === 120);
  _setPriceFeed({ ...failing, tokenInfo: async () => ({ mint: "", symbol: "SOL", name: "", decimals: 9, totalSupply: null, priceUsd: 0, topPools: [] }) });
  _setSolUsd(null);
  check("a zero price is not a price", (await solUsd(Date.now())) === null);
  _setPriceFeed(null);
}

console.log("\nthe opener's share, without arithmetic");
{
  check("an even split reads as half of it", /\? "<b>half<\/b> of it to "/.test(page));
  check("...and an uneven one names the pool, not 'it'", /%<\/b> of the pool to "\)/.test(page));
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall green\n");
process.exit(failures ? 1 : 0);
