// The front door after 1 Oct: every argument, not every tweet.
//
// The landing and the app list used to describe a product that lived on X: an
// X composer in the hero and at the close, "Tagged markets", an empty state
// that said "Tag @oddiefun on X". Kick and Telegram were live and appeared
// nowhere. These pin the parts that are easy to undo by accident: the three
// doors, the streamer door, the list that hides dead cards, the dollar figure
// that never invents a price, and the opener's share said without arithmetic.
import { readFileSync, statSync } from "node:fs";
import { solUsd, _setSolUsd } from "../src/price/solUsd.js";
import { _setPriceFeed, type PriceFeed } from "../src/price/feed.js";
import { filesUnder } from "./inline-blocks.js";
import { MARKET_COPY } from "../src/live/claims.js";
import { buildTweetReply } from "../src/matching/tweetReply.js";
import { TG_COPY } from "../src/telegram/loop.js";
import { resolutionText, authorCreditText } from "../src/x/resolutionReply.js";
import { tgResolutionText } from "../src/telegram/resolution.js";
import { slugFor } from "../src/store/markets.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

const landing = readFileSync("public/landing.html", "utf8");
const list = readFileSync("public/app/markets.html", "utf8");
const page = readFileSync("public/app/market.html", "utf8");
const server = readFileSync("src/server.ts", "utf8");

console.log("the landing leads with livestreams and names every door (7 Oct)");
{
  check("the headline is the one-liner", /<h1 class="h1"><span>Prediction markets<\/span><span class="lo">for livestreams\.<\/span><\/h1>/.test(landing));
  check("...and the old headline closes the page as the vision",
    /<h2 class="h2 vision reveal"><span>Every argument<\/span><span class="lo">is a market\.<\/span><\/h2>/.test(landing)
    && landing.indexOf('class="h2 vision') > landing.indexOf('id="creators"'));
  check("no line says the product is X-only", !/about anything on X/.test(landing));
  for (const [door, href] of [
    ["Kick", "https://app.oddie.fun/live/kick/connect"],
    ["Twitch", "https://app.oddie.fun/live/twitch/connect"],
  ]) {
    const n = landing.split(`<a class="door" href="${href}">`).length - 1;
    // Once, in the hero: the closing ask that repeated them went (Lev, 2 Oct).
    check(`${door} is a door in the hero, straight to its sign-in`, n === 1, `${n} found`);
  }
  check("...and X and Telegram are one quiet line under them",
    /<p class="also">Also on[\s\S]{0,200}href="https:\/\/x\.com\/intent\/post\?text=%40oddiefun%20"[\s\S]{0,300}href="https:\/\/t\.me\/oddiefunbot"/.test(landing));
  check("the creators field has a card per door",
    /id="creators"[\s\S]*?<h3>Streamers<\/h3>[\s\S]*?<h3>Creators on X<\/h3>[\s\S]*?<h3>Communities<\/h3>/.test(landing));
  check("...and the streamer card adds it to Kick and to Twitch",
    /<h3>Streamers<\/h3>[\s\S]{0,300}href="https:\/\/app\.oddie\.fun\/live\/kick\/connect"[\s\S]{0,200}href="https:\/\/app\.oddie\.fun\/live\/twitch\/connect"/.test(landing));
  check("...and the nav can reach it", /href="#creators">For creators</.test(landing));
  check("the hero chat is in English, the page speaks to everyone", !/cumaya|görmez/.test(landing));
  check("no card says KOL", !/\bKOLs?\b/.test(landing));
  check("the description names Kick, Twitch and Telegram", /<meta name="description" content="[^"]*Kick[^"]*Twitch[^"]*Telegram/.test(landing));
  check("no share tag says real money (brand rules)", !/content="[^"]*real-money/.test(landing));
  check("no X composer is left to wire", !/data-ask/.test(landing) && !/EXAMPLES/.test(landing));
  /* Step three used to state the deadline and never a side, because it told
     the live BTC market. It now settles a made-up twin of it (another slug,
     no date in the question), so it can say how the twin settled, in the
     bots' words; that market and those words are pinned in the tale's
     section below (Lev approved, 2 Oct). */
  check("step three settles the twin and says nothing about the live market",
    !landing.includes("Friday 23:59 UTC. The result is in.") && !/by Friday, October/.test(landing)
    && !landing.includes("will-bitcoin-btc-reach-88000-by-426b52"));
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
  check("the money sheet's button carries the dollars when a price is known",
    chain.includes('stakeBtn.textContent = `${side.toUpperCase()} · ${sol} SOL${usd.charAt(0) === "$" ? ` (${usd})` : ""}`;')
    && /if \(!\(r > 0\) \|\| !\(sol > 0\)\) return "";/.test(chain));
  check("...from the price the page already read", /window\.ODDIE_SOL_USD = SOL_USD;/.test(list) && /window\.ODDIE_SOL_USD = SOL_USD;/.test(page));
  // The leaderboard is the stream votes now (Lev, 8 Oct): a name, and where it was called.
  check("the leaderboard says where each name was called, one tap from that channel", board.includes('<a class="ch" href="/live/'));
  check("...and an empty board points at adding oddie to a stream", board.includes('<a href="/live">Add oddie to your stream</a>'));
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

console.log("\nthe first bet is told what happens if nobody comes");
{
  const chain = readFileSync("public/chain.js", "utf8");
  const lib = readFileSync("onchain/programs/oddie_chain/src/lib.rs", "utf8");
  // The promise rests on both of these: no fee when one side holds the whole
  // pool, and a full refund when the winning side holds nothing.
  check("the program takes no fee from a pool with one side (lib.rs)",
    /if winning_total == 0 \{\s*return Ok\(0\);/.test(lib) && /if pool == winning_total \{\s*return Ok\(0\);/.test(lib));
  // From fmtSol, because the line formats its figure with it.
  const start = chain.indexOf("  function fmtSol(");
  const end = chain.indexOf("  /* THE SHEET, AS A SHEET");
  check("payoutHint is where this test looks for it",
    start > 0 && end > start && chain.indexOf("  function payoutHint(") > start && chain.indexOf("  function payoutLamports(") < end);
  const { payoutHint, payoutLamports } = new Function(chain.slice(start, end) + "\nreturn { payoutHint, payoutLamports };")();
  check("the sheet says the floor as a tag, not in the payout line",
    payoutHint("yes", 0.1, 0, 0, 200, 200) === "" && payoutHint("no", 0.5, 0, 1e8, 200, 200) === ""
    && chain.includes('<span class="chain-tag chain-tag--floor" id="chainfloor" hidden>No taker? Full refund.</span>'));
  check("...shown while the chosen side's other side is empty, including joining the only side there is",
    chain.includes('if (floorTag) floorTag.hidden = !(side && (side === "yes" ? noLamports : yesLamports) === 0);'));
  check("taking the empty side is a payout estimate, after both fees",
    payoutHint("no", 0.1, 1e8, 0, 200, 200) === "Wins about 0.192 SOL as the pool stands. Moves as others bet.",
    payoutHint("no", 0.1, 1e8, 0, 200, 200));
  // Bee, 8 Oct: 0.04 SOL on NO against 0.1 on YES, settled NO, collected 0.1344.
  check("the estimate is what the program paid, to the lamport",
    payoutLamports("no", 0.04, 1e8, 0, 200, 200) === 134_400_000, payoutLamports("no", 0.04, 1e8, 0, 200, 200));
  // 1 SOL onto a YES of 0.1 against a NO of 0.04: 4% of 1.14 is 0.0456, more
  // than the 0.04 the other side holds. Capped, being right returns the 1 SOL.
  check("...and on a thin other side, being right pays the stake back (the cap)",
    payoutLamports("yes", 1, 1e8, 4e7, 200, 200) === 1_000_000_000, payoutLamports("yes", 1, 1e8, 4e7, 200, 200));
  check("...nothing to win where the other side is empty",
    payoutLamports("yes", 0.5, 1e8, 0, 200, 200) === null && payoutLamports("no", 0.5, 0, 0, 200, 200) === null);
  // 149 lamports: each 2% floors to 2, while 4% at once would floor to 5.
  check("...each fee floors on its own, the way resolve_market fixes them",
    payoutLamports("yes", 1e-7, 0, 49, 200, 200) === 145, payoutLamports("yes", 1e-7, 0, 49, 200, 200));
  check("...and the market page quotes the same function, under each side",
    chain.includes("payout: payoutLamports,")
    && page.includes("window.OddieChain && window.OddieChain.payout")
    && page.includes('<p class="side-win side-win--y" data-win="yes"></p><p class="side-win side-win--n" data-win="no"></p>'));
  check("the market page says it under the first-in line, while bets are open",
    page.includes("if (!closed && !resolved) {\n        html += '<p class=\"first-floor\">No taker? Full refund.</p>';"));
  check("...and on a phone it stays beside that line",
    page.includes("#view > .pool,#view > .first,#view > .first-floor{order:5}"));
}

console.log("\nthe choice survives the trip into Phantom");
{
  const chain = readFileSync("public/chain.js", "utf8");
  // The link, built against a fake page.
  const ls = chain.indexOf("  function phantomDeepLink(");
  const le = chain.indexOf("  /**\n   * WHAT A CONNECT CONTROL SHOULD SAY");
  check("phantomDeepLink is where this test looks for it", ls > 0 && le > ls);
  const win = { location: { href: "https://app.oddie.fun/m/btc-88k", origin: "https://app.oddie.fun" } };
  const deepLink = new Function("window", chain.slice(ls, le) + "\nreturn phantomDeepLink;")(win);
  const inner = (link: string) => decodeURIComponent(link.slice("https://phantom.app/ul/browse/".length).split("?ref=")[0]);
  check("the link carries the side and the amount",
    inner(deepLink({ side: "yes", sol: 0.1 })) === "https://app.oddie.fun/m/btc-88k?side=yes&sol=0.1", inner(deepLink({ side: "yes", sol: 0.1 })));
  check("...and without a choice it is the page, as before",
    inner(deepLink()) === "https://app.oddie.fun/m/btc-88k");
  check("the stake button hands its choice to the link", chain.includes("if (connectHere({ side, sol })) return;"));
  check("a sheet opened by a link waits for a tap, whatever the wallet",
    chain.includes("if (presetSol > 0 && side && sol > 0 && wallet && !(opts && opts.confirm)) {"));

  // The arrival, read against a fake location.
  const as = page.indexOf("  var ARRIVAL = (function () {");
  const ae = page.indexOf("  })();", as);
  check("the arrival is read once, before the first render", as > 0 && as < page.indexOf("  function render(m) {"));
  const arrive = (search: string) => {
    const replaced: string[] = [];
    const href = "https://app.oddie.fun/m/btc-88k" + search;
    const got = new Function("location", "history", "URL",
      page.slice(as, ae + "  })();".length).replace("var ARRIVAL =", "return"))(
      { search, href }, { replaceState: (_s: unknown, _t: string, u: string) => replaced.push(u) }, URL);
    return { got, replaced };
  };
  const a1 = arrive("?side=no&sol=0.1&sheet=v2");
  check("?side=no&sol=0.1 arrives as NO for 0.1",
    a1.got?.side === "no" && a1.got?.sol === 0.1, JSON.stringify(a1.got));
  check("...and leaves the URL, keeping every other param", a1.replaced[0] === "/m/btc-88k?sheet=v2", a1.replaced[0]);
  check("an amount the server would refuse is dropped, not obeyed", arrive("?side=yes&sol=9").got?.sol === null);
  check("no side, no arrival, and the URL is left alone",
    arrive("?sheet=v2").got === null && arrive("?sheet=v2").replaced.length === 0);
  check("the old read inside render, which ran before chain.js existed, is gone",
    !page.includes('history.replaceState(null, "", location.pathname);'));
  check("render tries the arrival until it lands, and opens it to wait for a tap",
    page.includes("openArrival();\n  }") && page.includes('window.addEventListener("load", openArrival, { once: true });')
    && page.includes("window.OddieChain.openStake(SLUG, ARRIVAL.side, stake || undefined, { confirm: true });"));
}

console.log("\nthe money screens fit a glance (the hypercasual cut)");
{
  const chain = readFileSync("public/chain.js", "utf8");
  const money = readFileSync("public/app/money.css", "utf8");
  // The market page: the first screen is the claim, the price and YES/NO.
  check("the full question left the header for Rules, as the same element chain.js reads",
    page.includes(`fullQ = '<p class="terms__q" data-oddie-question data-oddie-hook="' + esc(hook)`)
    && !page.includes('class="qfull"'));
  check("\"Winners split the pool.\" is a rule now, not a line above the chips",
    !page.includes('<p class="how">') && page.includes(`'<p class="terms__m">Winners split the pool'`));
  check("Rules is drawn on every market, with the fee, both refunds and the vault",
    page.includes(`html += '<details class="terms"><summary><span class="terms__k">Rules' + lockNote`)
    && page.includes("Nobody took the other side? Every stake comes back in full, no fee.")
    && page.includes("No result 30 days after close? Everyone can take their stake back.")
    && page.includes("See the money on Solana</a></p>"));
  check("Share keeps its own line, and the fee and the vault are off it",
    page.includes(`html += '<div class="rail"><span><button class="share" id="share" type="button">Share</button></span></div>';`));
  check("the amount on the pinned buttons stays, without the dollar restatement",
    page.includes(`(stake === null ? "any amount" : "<b>" + esc(String(stake)) + " SOL</b>")`)
    && !page.includes(`" SOL</b>" + usdOf(Number(stake))`));
  check("...and shows only while the chips are out of sight, without moving the page",
    page.includes(`amtEl.classList.toggle("sides__amt--near", es[es.length - 1].isIntersecting);`)
    && page.includes(".sides__amt--near{visibility:hidden}"));
  // The sheet.
  check("the sheet prices a pool only once both sides hold money",
    chain.includes("const twoSided = yesLamports > 0 && noLamports > 0;") && !chain.includes("chain-pool-empty"));
  check("its small print is tags: the floor, the date, the fee",
    chain.includes("<span class=\"chain-tag\">Settles ${settles}</span>")
    && chain.includes("<span class=\"chain-tag\">${totalPct}% fee</span>")
    && money.includes(".chain-tag[hidden]{display:none}"));
  check("the chips name the amount once, with no dollar line under each",
    !chain.includes("chain-chip__usd") && !money.includes("chain-chip__usd"));
  check("a title whose question is its hook is written once",
    chain.includes("const titleHTML = hook && question && question !== hook"));
  // The list.
  check("a list card is the hook, the numbers and YES/NO, with no full question line",
    !list.includes("card__full")
    && list.includes(`'<h2 class="card__q" data-oddie-question data-oddie-hook="' + esc(hook)`));
}

console.log("\nthe secondary pages say less (the hypercasual cut, round two)");
{
  const board = readFileSync("public/app/leaderboard.html", "utf8");
  const who = readFileSync("public/app/who.html", "utf8");
  const following = readFileSync("public/app/following.html", "utf8");
  const you = readFileSync("public/app/you.html", "utf8");
  const live = readFileSync("public/app/live.html", "utf8");
  const standings = readFileSync("src/store/standings.ts", "utf8");
  const store = readFileSync("src/store/markets.ts", "utf8");
  check("settled calls carry the market's hook from the database to both pages",
    store.includes("SELECT ce.wallet, ce.slug, s.question, cm.hook,") && standings.includes("hook: c.hook ?? null")
    && server.includes("hook: r.hook ?? null, side: r.side") && server.includes("hook: first.hook ?? null"));
  check("the record and a channel's markets lead each row with the hook",
    who.includes("esc(r.hook || r.question)") && live.includes("esc(m.hook || m.question)"));
  check("the record says the side and its price as one fact, and zero as a refund",
    who.includes(`"<span>" + side + " at " + r.entryPct + "%</span>"`) && who.includes(`r.pnlSol === 0 ? "<span>refunded</span>"`)
    && !who.includes(`"<span>crowd said "`));
  check("the board's rule is one line", board.includes(`<p class="rule">Points from votes in stream chats.</p>`));
  check("Following signs in with a five-word note, not a 21-word sentence",
    following.includes(`"<p>Alerts on Telegram or here.</p></div>"`) && !following.includes("Sign in once, follow anybody"));
  check("the profile keeps the iPhone home-screen route, in one line",
    you.includes("Results on your phone: tap <b>Share</b>, then <b>Add to Home Screen</b>.")
    && !you.includes("The wallet comes later."));
  check("the streamer page is three one-line steps, with no lede restating them",
    !live.includes('<p class="lede">Anyone in your chat turns a claim') && live.includes("<li><span><b>Add oddie to your Kick or Twitch channel.</b></span></li>"));
  check("...with one door per platform", live.includes('href="/live/kick/connect">Add oddie to Kick</a>')
    && live.includes('href="/live/twitch/connect">Add oddie to Twitch</a>'));
}

console.log("\nthe landing tells it once, as one chat (the hypercasual cut, round two)");
{
  const tale = landing.slice(landing.indexOf('<div class="tale reveal" id="tale">'));
  const script = landing.slice(landing.indexOf("HOW IT WORKS, AS ONE CHAT"));
  check("how it works is one chat window, not three cards", landing.includes('<div class="tale reveal" id="tale">')
    && !landing.includes('<div class="steps reveal">') && !landing.includes('class="step__cap"'));
  check("...that plays on every door, streams first",
    script.indexOf('where: "Kick chat"') < script.indexOf('where: "Twitch chat"')
    && script.indexOf('where: "Twitch chat"') < script.indexOf('where: "Replies on X"')
    && script.includes('where: "Replies on X"') && script.includes('where: "Telegram group"')
    && script.includes('var TAG = "!oddie BTC hits 88k by Friday?"') && script.includes('"<i>@oddiefun</i> BTC hits 88k by Friday?"')
    && script.includes('"<i>@oddiefunbot</i> BTC hits 88k by Friday?"'));
  check("...each door drawn as its own app (Lev, 2 Oct: X and Telegram did not look like X and Telegram)",
    script.includes('p: "kick"') && script.includes('p: "tw"') && script.includes('p: "x"') && script.includes('p: "tg"')
    && /\.tale__screen\[data-app="tw"\]\{background:#18181b;/.test(landing)
    && /\.tale__screen\[data-app="x"\]\{background:#000;/.test(landing) && /\.tale__screen\[data-app="tg"\]\{background:#0e1621;/.test(landing)
    && landing.includes(".xp--chain::before") && landing.includes(".tg__bub::before"));
  check("...and the window keeps one height on every door, so a switch never moves the page",
    /\.tale--js \.tale__feed\{height:\d+px;/.test(landing)
    && !/\.tale__screen\[data-app="(?:x|tg|tw)"\]\{[^}]*(?:padding:|padding-(?:top|bottom)|height)/.test(landing));
  check("the card in the X reply and the Telegram photo is the real card, not a drawing of one",
    script.includes('var CARD_SRC = "/brand/tale-card.webp";') && script.includes('card("xp__m")') && script.includes('card("tg__ph")')
    && !landing.includes('class="mcard__s"') && statSync("public/brand/tale-card.webp").size < 40_000);
  {
    /* EVERY LINE A BOT SAYS ON SCREEN IS WHAT ITS CODE SAYS, built here from
       that code for the market on screen. The market is a made-up twin of the
       live BTC one: its slug comes from its own id, and the X reply picks its
       CTA from the link, so the twin's id was chosen to land on "pick a side". */
    const HOOK = "BTC to $88k by Friday?";
    const twin = { venue: "community" as const, venueId: "demo-btc-88k-4", question: "Will Bitcoin (BTC) reach $88,000 by Friday?",
      yesPct: 50, closesAt: null, volumeUsd: 0, venueUrl: "", tags: [] };
    const LINK = `https://app.oddie.fun/m/${slugFor(twin)}`;
    const js = (s: string) => s.replace(/\n/g, "\\n");
    const [kickA, kickB] = MARKET_COPY.opened(HOOK, "\u0000", "this channel").split("\u0000");
    check("the market on screen is the twin, never a live one", LINK === "https://app.oddie.fun/m/will-bitcoin-btc-reach-88000-by-215eb7"
      && script.includes(`var LINK = "${LINK}";`) && !/will-bitcoin-btc-reach-88000-by-(?!215eb7)[0-9a-f]{6}/.test(landing));
    check("Kick says what the chat bot says, opening and settling",
      tale.includes(`${kickA}<span class="ln">${LINK}</span>${kickB}`)
      && server.includes('`It\'s ${outcome.toUpperCase()}: "${headline}" Winners collect at ${APP_BASE_URL}/m/${slug}`')
      && tale.includes(`It's NO: "${HOOK}" Winners collect at <span class="ln">${LINK}</span>`));
    // Twitch runs the same engine, so its lines are Kick's, on its own market.
    const TW_HOOK = "SOL above $150 by Sunday?";
    const [twA, twB] = MARKET_COPY.opened(TW_HOOK, "\u0000", "this channel").split("\u0000");
    check("Twitch says what the chat bot says, opening and settling",
      script.includes(`var HK = "${TW_HOOK}";`)
      && script.includes(`'${twA.replace(TW_HOOK, "' + HK + '")}' + link + "${twB}"`)
      && script.includes(`"It's YES: \\"" + HK + "\\" Winners collect at " + link`));
    const reply = buildTweetReply({ question: twin.question, permalink: LINK, hook: HOOK }).primary;
    check("X and Telegram open with the reply the bot builds for that link",
      reply.endsWith(`\n\nPick a side, real SOL on it ↓\n${LINK}`)
      && script.includes('"Pick a side, real SOL on it ↓\\n" + SHORT') && script.includes('"Pick a side, real SOL on it ↓\\n" + link + "\\n\\n'));
    check("...Telegram names the opener the way TG_COPY does",
      script.includes(js(`\n\n${TG_COPY.opener("Jules", "oddiefunbot").split("\n")[0]}`)));
    const settled = resolutionText(twin.question, "no", LINK, 1);
    check("step three settles in the bots' own words, on X and in Telegram",
      settled === tgResolutionText({ outcome: "no", pool: 2, won: 1, marketUrl: LINK })
      && script.includes(js(settled.slice(0, settled.lastIndexOf("\n\n") + 2)))
      && script.includes(`"<i>@0xjules</i>${authorCreditText("0xjules", LINK).split("\n")[0].slice("@0xjules".length)}"`));
  }
  check("without script it is the whole Kick conversation",
    tale.includes('<div class="tale__screen" data-app="kick"><div class="tale__feed" aria-live="off">')
    && tale.includes('<p class="msg kc"><b class="k2">0xjules</b>: !oddie BTC hits 88k by Friday?</p>'));
  check("it moves only on screen, and never on its own with reduced motion",
    script.includes("if (reduced) { upTo(1); return; }") && script.includes("}, { threshold: 0.35 }).observe(tale);"));
  check("the hero says the pitch once, to the streamer; the doors say where",
    landing.includes("<span>Your chat calls the market. You earn 2%.</span>") && !landing.includes("It opens in seconds and pays out on its own."));
  check("the creators are a row per door, each still saying who earns",
    landing.includes("<p>Your channel earns <b>2%</b>.</p>") && landing.includes("<p>You earn <b>2%</b>, either side.</p>")
    && landing.includes("<p>The opener earns <b>2%</b>.</p>"));
  check("the offer heads the creators field, in the words Lev approved (folded in by his call, 2 Oct)",
    landing.indexOf('<h2 class="offer__hd">Open a market,<br>earn <span class="lo">2%</span> of the pool.</h2>') > landing.indexOf('id="creators"')
    && landing.includes('<p class="offer__sub">Whichever side wins, the 2% is yours.</p>') && !landing.includes('class="Bw sec"'));
  check("the closing ask is gone and the crowd stays",
    !landing.includes('<div class="close col col--mid reveal">') && landing.includes('<img src="/brand/crowd-strip.webp?v=2"'));
  check("the crowd wears the real mark, from the retouched source (Lev, 2 Oct)",
    statSync("brand/v3/oddiepng3-realmark.png").size > 0 && readFileSync("brand/README.md", "utf8").includes("oddiepng3-realmark.png"));
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall green\n");
process.exit(failures ? 1 : 0);
