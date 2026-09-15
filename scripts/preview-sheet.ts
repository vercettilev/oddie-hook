/**
 * THE MONEY SHEET CANNOT BE LOOKED AT WITHOUT A WALLET, AND THAT IS WHY IT DRIFTS.
 *
 * Every screen in this product can be opened in a browser except the ones that
 * matter most: the stake sheet and the receipt only exist after a real signature
 * on a real cluster, behind a wallet, behind the app gate. So they get changed
 * by reading CSS and hoping, and the two worst visual bugs this repo has had
 * both lived there.
 *
 * This writes a standalone HTML file that carries the app shell's own tokens and
 * fonts, money.css as it is on disk, and the sheet markup with the stickers
 * inlined, so the thing can simply be opened and looked at. It is generated
 * rather than committed because it is ~200KB of duplicated base64, and a copy
 * of a stylesheet in the repo is a copy that goes stale.
 *
 * Run with: npx tsx scripts/preview-sheet.ts [outDir]
 */
import { readFileSync, writeFileSync } from "node:fs";

const OUT = (process.argv[2] ?? ".").replace(/\/+$/, "");

const shellStyle = readFileSync("public/app/market.html", "utf8").match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
const money = readFileSync("public/app/money.css", "utf8");
const sticker = (name: string) =>
  `data:image/webp;base64,${readFileSync(`public/brand/${name}`).toString("base64")}`;

/** One receipt, exactly as public/chain.js builds it. Kept in this shape on
 *  purpose: if the markup there changes, this stops matching and the preview
 *  stops being evidence. */
function receipt(side: "yes" | "no", amount: string, st: string, line: string): string {
  return `<div class="cdim" style="position:relative;inset:auto;padding:24px">
  <div class="csheet">
    <div class="rcpt rcpt--${side}">
      <p class="rin">
        <b class="rin__s rin__s--${side}">${side.toUpperCase()}</b>
        <span class="rin__a">${amount} <i>SOL</i></span>
        <img class="rin__st" src="${sticker(st)}" alt="">
      </p>
      <p class="rin__l">${line}</p>
    </div>
    <a class="cbtn cbtn--share" href="#">Post your call</a>
    <p class="chain-sig">On Solana: <a href="#">4YMR&hellip;4Cg5 &#8599;</a></p>
    <p class="chain-home"><a href="#">Back to your profile &rarr;</a></p>
    <button class="cclose">Done</button>
  </div>
</div>`;
}

const html = `<!doctype html><meta charset="utf-8"><title>oddie money sheet preview</title>
<style>
${shellStyle}
${money}
body{background:#0C0D0B;margin:0}
</style>
${receipt("no", "0.1", "st-called.webp", "Your call is on chain now.")}
${receipt("yes", "2.5", "st-rocket.webp", "You set the odds. Whoever comes next has to take your price.")}
`;

const path = `${OUT}/sheet-preview.html`;
writeFileSync(path, html);
console.log(`wrote ${path} (${Math.round(html.length / 1024)}KB) — open it in a browser`);
