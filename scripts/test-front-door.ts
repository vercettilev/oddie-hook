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
import { filesUnder } from "./inline-blocks.js";

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

console.log("\nsmall things a stranger reads wrong");
{
  const chain = readFileSync("public/chain.js", "utf8");
  const board = readFileSync("public/app/leaderboard.html", "utf8");
  const you = readFileSync("public/app/you.html", "utf8");
  check("the money sheet's amounts carry dollars when a price is known",
    /chain-chip__usd/.test(chain) && /if \(!\(r > 0\) \|\| !\(sol > 0\)\) return "";/.test(chain));
  check("...from the price the page already read", /window\.ODDIE_SOL_USD = SOL_USD;/.test(list) && /window\.ODDIE_SOL_USD = SOL_USD;/.test(page));
  check("a settled line at zero says refunded, not '0 SOL'", /Number\(p\.pnlSol\) === 0 \? "refunded"/.test(board));
  check("...and a wallet with no name is 'a caller', not half an address", /: "a caller";/.test(board));
  check("signed out, the profile does not offer the same two doors twice", /if \(!x && !tg\) return;/.test(you));
}

console.log("\nlive strip, the other side, two columns");
{
  const chain = readFileSync("public/chain.js", "utf8");
  check("the hero has a live strip slot, filled by the server", /<!--LIVESTRIP-->/.test(landing)
    && /\.replace\("<!--LIVESTRIP-->", liveStrip\)/.test(server));
  check("...from the same closing-soon market as the card, with the same clock",
    /liveStrip = '<a class="live" href="' \+ href\(soon\.m\)/.test(server) && /class="live__t clock" data-at="/.test(server));
  check("the receipt asks for the other side, in words that stay true",
    /pays when somebody <em>takes \$\{otherSide\.toUpperCase\(\)\}<\/em>/.test(chain)
    && /is <em>more for your \$\{side\.toUpperCase\(\)\}<\/em>/.test(chain));
  check("...with X, Telegram and a copied link", /id="chainshare"/.test(chain) && /t\.me\/share\/url\?url=/.test(chain) && /id="chaincopy"/.test(chain));
  check("a wide screen lays markets in two columns, and nothing else is squeezed",
    /@media \(min-width:1000px\)\{[\s\S]*?#view\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/.test(list)
    && /#view > :not\(\.card\),#view > \.card--invite\{grid-column:1\/-1\}/.test(list));
}

console.log("\nthe opener's share, without arithmetic");
{
  check("an even split reads as half of it", /\? "<b>half<\/b> of it to "/.test(page));
  check("...and an uneven one names the pool, not 'it'", /%<\/b> of the pool to "\)/.test(page));
}

console.log("\na press answers on the press, on every page");
{
  /* A tap on a phone fires :hover and it stays until the next tap somewhere
     else, so an unguarded hover rule leaves a button lit after the finger has
     gone. Every hover rule waits for a pointer that can really hover. */
  const unguarded = (css: string): string[] => {
    const out: string[] = [];
    const stack: boolean[] = [];
    let prelude = "";
    for (let i = 0; i < css.length; i++) {
      if (css.startsWith("/*", i)) { const j = css.indexOf("*/", i + 2); i = j < 0 ? css.length : j + 1; continue; }
      const ch = css[i];
      if (ch === "{") {
        const p = prelude.trim();
        const guarded = stack.includes(true) || /^@media[^{]*\(\s*hover\s*:\s*hover\s*\)/.test(p);
        if (!guarded && !p.startsWith("@") && p.includes(":hover")) out.push(p);
        stack.push(guarded);
        prelude = "";
      } else if (ch === "}") { stack.pop(); prelude = ""; }
      else if (ch === ";") prelude = "";
      else prelude += ch;
    }
    return out;
  };
  const pages = filesUnder("public", ".html").filter((f) => !/(^|\/)zz-/.test(f));
  check("there are pages to check", pages.length >= 15, `${pages.length}`);
  for (const f of pages) {
    const html = readFileSync(f, "utf8");
    const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
    const bad = unguarded(css);
    check(`${f}: every hover waits for a real pointer`, bad.length === 0, bad.slice(0, 3).join(" | "));
    check(`${f}: no grey box flashes on a tap`, /html\{-webkit-tap-highlight-color:transparent\}/.test(html));
  }
  const money = readFileSync("public/app/money.css", "utf8");
  check("money.css: every hover waits for a real pointer", unguarded(money).length === 0, unguarded(money).slice(0, 3).join(" | "));
  const me = readFileSync("public/app/me.js", "utf8");
  const hovers = (me.match(/:hover\{/g) ?? []).length;
  const guarded = (me.match(/@media \(hover:hover\)\{[^{}]*:hover\{/g) ?? []).length;
  check("me.js: the chips it draws wait for a real pointer too", hovers > 0 && hovers === guarded, `${guarded}/${hovers}`);

  // iOS only applies :active once the page listens for touches.
  const touch = /document\.addEventListener\("touchstart", function \(\) \{\}, \{ passive: true \}\);/;
  check("every app page gets :active on iOS through id.js", touch.test(readFileSync("public/app/id.js", "utf8")));
  check("...and the landing, which does not load id.js, listens itself", touch.test(landing));
  for (const p of ["markets", "market", "you", "live", "leaderboard", "following", "person", "who"]) {
    const html = readFileSync(`public/app/${p}.html`, "utf8");
    check(`${p}.html loads id.js`, html.includes('<script src="/app/id.js"></script>'));
    check(`${p}.html: the masthead chip gives under the finger`, html.includes(".top .mechip:active{scale:.96}"));
    check(`${p}.html: moving between pages cross-fades, and not for reduced motion`,
      html.includes("@view-transition{navigation:auto}")
      && /@media \(prefers-reduced-motion:reduce\)\{\s*::view-transition-group\(\*\),::view-transition-old\(\*\),::view-transition-new\(\*\)\{animation:none!important\}/.test(html));
  }
  check("the landing keeps clear of the notch", /viewport-fit=cover/.test(landing) && /env\(safe-area-inset-left\)/.test(landing));
}

console.log("\nthe question travels from the list into the market");
{
  check("the market's headline and the tapped card share one name",
    page.includes("#view h1.q{view-transition-name:mq}") && list.includes('head.style.viewTransitionName = "mq";'));
  check("...given to one card at a time and taken back on return",
    /function clearTravel\(\)/.test(list) && list.includes('window.addEventListener("pageshow", clearTravel);'));
  check("an in-app visit holds its first frame until the market is drawn",
    page.includes('hold.rel = "expect"; hold.href = "#painted"; hold.setAttribute("blocking", "render");'));
  check("...decided in the head, the only place a hold can still be added",
    page.indexOf('hold.rel = "expect"') > 0 && page.indexOf('hold.rel = "expect"') < page.indexOf("<header"));
  check("...and released right after the script that draws the market",
    page.lastIndexOf("load(true);") < page.indexOf('<i id="painted" hidden></i>')
    && /<i id="painted" hidden><\/i>\s*$/.test(page));
}

console.log("\nthe money sheet moves like a sheet");
{
  const chain = readFileSync("public/chain.js", "utf8");
  const money = readFileSync("public/app/money.css", "utf8");
  check("every sheet closes through one door", /function closeSheet\(el, velocity\)/.test(chain)
    && !/closest\("\.cdim"\)\.remove\(\)/.test(chain));
  check("the spring sheet waits behind ?sheet=v2 until it is approved",
    chain.includes('if (q === "v2") localStorage.setItem("oddie:sheet", "v2");')
    && chain.includes('if (q === "v1") localStorage.removeItem("oddie:sheet");')
    && chain.includes("if (SHEET_V2) mountSheetMotion(dim, sheet);"));
  check("...and reduced motion gets a short fade, not travel", /if \(reduced\) \{ halt\(\); dim\.classList\.add\("cdim--out"\)/.test(chain)
    && /\.cdim--v2\.cdim--fade\{animation:cdim-in \.15s ease-out\}/.test(money));
  check("the sheet fits the screen you can see, and keeps its scroll to itself",
    money.includes("max-height:88dvh") && money.includes("overscroll-behavior:contain"));
  check("a confirmed stake taps the hand once",
    chain.includes("if (confirmed) { try { if (navigator.vibrate) navigator.vibrate(12); }"));

  // The spring itself, on a fake clock: what a refactor could quietly break
  // is no overshoot at damping 1, overshoot below it, a carried velocity, and
  // the projection that decides whether a flick closes the sheet.
  const start = chain.indexOf("  function spring(");
  const end = chain.indexOf("  /** Close the sheet");
  check("the spring is where this test looks for it", start > 0 && end > start);
  let frames: ((t: number) => void)[] = [];
  const make = new Function("requestAnimationFrame", "cancelAnimationFrame",
    chain.slice(start, end) + "\nreturn { spring, project, rubber };");
  const { spring, project, rubber } = make((cb: (t: number) => void) => frames.push(cb), () => {});
  const run = (st: { x: number; v: number }, to: number, opts: { response: number; damping: number }) => {
    frames = [];
    let t = 0, n = 0, lo = Infinity, hi = -Infinity, done = false;
    spring(st, to, opts, () => { lo = Math.min(lo, st.x); hi = Math.max(hi, st.x); }, () => { done = true; });
    while (!done && n++ < 600) { const f = frames; frames = []; t += 1000 / 60; f.forEach((cb) => cb(t)); }
    return { done, ms: Math.round(t), lo, hi };
  };
  const open = run({ x: 0, v: 0 }, 100, { response: 0.38, damping: 1 });
  check("damping 1 arrives without passing the target", open.done && open.hi <= 100.0001, JSON.stringify(open));
  check("...in about its response time, not a slow crawl", open.ms < 900, `${open.ms}ms`);
  const back = run({ x: 0, v: 0 }, 100, { response: 0.3, damping: 0.8 });
  check("damping .8 overshoots a little, as a released sheet should", back.hi > 100 && back.hi < 110, `${back.hi.toFixed(2)}`);
  const caught = run({ x: 50, v: -3000 }, 100, { response: 0.3, damping: 1 });
  check("a spring started mid-flight keeps the speed it was given", caught.done && caught.lo < 50, `low ${caught.lo.toFixed(1)}`);
  check("a flick at 1000px/s projects 499px ahead (Apple's normal deceleration)",
    Math.abs(project(1000) - 499) < 1e-6, `${project(1000)}`);
  check("past the edge the sheet follows less, and less again",
    rubber(100, 400) < 100 && rubber(200, 400) < 2 * rubber(100, 400) && rubber(0, 400) === 0);
  // A stake sheet on a 390x844 phone, plus the 24px a close travels past it.
  const H = 453;
  const closes = (x: number, v: number) => x + project(v) > H * 0.5;
  check("a medium swipe from a third of the way down closes it", closes(134, 600));
  check("...so does a quick flick from near the top", closes(40, 1500));
  check("...and a slow nudge springs back", !closes(100, 50) && !closes(60, 0));
  check("...by the rule the sheet actually runs", chain.includes("if (st.x + project(v) > H() * 0.5) close(Math.max(v, 0));"));
  check("a finger that stopped before it lifted hands over no speed",
    chain.includes("hist.filter((p) => now - p.t < 100).concat({ y: last.y, t: now })[0]"));
  check("the sheet grows with its content instead of jumping", /ro = new ResizeObserver\(/.test(chain)
    && chain.includes("if (ro) ro.disconnect();") && chain.includes("if (d <= 0 || drag || closing) return;"));
}

console.log("\na pool nobody backed is a refund, not a loss");
{
  const chain = readFileSync("public/chain.js", "utf8");
  const you = readFileSync("public/app/you.html", "utf8");
  const lib = readFileSync("onchain/programs/oddie_chain/src/lib.rs", "utf8");
  const claim = chain.slice(chain.indexOf("async function renderClaim("), chain.indexOf("async function openRefundSheet("));
  check("the program refunds every stake in full when nobody won (lib.rs)",
    /if winning_total == 0 \{\s*staked \/\/ nobody won/.test(lib));
  check("the claim sheet reads the pool when it was not handed one",
    claim.includes("fetch(`/api/chain/market/${encodeURIComponent(slug)}`)"));
  check("...and a winning side holding nothing means a refund, as claim_winnings decides it",
    claim.includes('Number(won === "YES" ? totals.totalYesLamports : totals.totalNoLamports) === 0'));
  check("...which it says as a refund, with the whole stake on the button",
    claim.includes("so nobody wins your stake. All <b>${back} SOL</b> comes back, no fee.")
    && claim.includes("Take back ${back} SOL"));
  check("the profile row says nobody was on that side, not that you lost",
    you.includes('o.refund ? "nobody was on " + String(o.outcome || "").toUpperCase() : "you lost it"'));
  check("...and its button takes the stake back, checked before the win branch it used to hide in",
    /o\.refund && o\.payoutLamports != null\s*\?\s*"Take back " \+ sol4/.test(you));
  check("the market page offers the stake back when nobody won",
    page.includes('(nobodyWon ? "Take your stake back" : "Collect winnings")'));
  check("the server's returns field agrees with its own payout figure",
    server.includes('returns: refund ? "stake-and-rent" : won ? "winnings-and-rent" : "rent-only"'));
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall green\n");
process.exit(failures ? 1 : 0);
