// Every visible piece of text on every screen, in both themes, measured against
// the background it is actually painted on.
//
// This exists because the selector-list version did not catch the bug it was
// written for. `body{color:var(--on-ground)}` handed near-white text to every
// white surface that had not declared its own colour, and the audit stayed
// green: the surfaces it named paint no background of their own, so the probe's
// `if (!bg) continue` skipped them. A skip that reads as a pass is worse than no
// check. It then missed the desktop half of the same bug — `.frame` hardcoded
// `#fff` — because it compared card text against `body` rather than the real
// parent.
//
// So: no selector list, nothing skipped, and the backdrop is resolved by walking
// the ancestor chain and compositing every translucent layer, gradient stops
// included. Two things the naive version got wrong, both now handled:
//   - a gradient stop of `rgba(0,0,0,0)` is not black, it is whatever is behind it
//   - text with a 3px stroke (the outlined percentage) is read from its stroke
//
// The gate is a REGRESSION gate, not an absolute one. Several brand greys have
// always sat a hair under AA in the bright theme (#6B7A88 on white is 4.41:1).
// Failing on those would mean this script can never be green, so it would be
// turned off. Instead: anything under 3:1 is a hard failure in any theme (that
// is invisible text, the class that shipped), and anything that passes bright
// but fails dark is a regression this theme introduced. Pre-existing bright
// misses are reported, loudly, and do not fail the run.
//
//   node scripts/contrast.mjs [baseUrl] [payload.json]

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3999/feed";
const PAYLOAD = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], "utf8")) : null;
const PORT = 9401;
const SCREENS = ["", "#/positions", "#/leaderboard", "#/profile"];
const VIEWPORTS = [[390, 844], [1280, 900]];
const INVISIBLE = 3;

// One board, frozen, so both themes measure the same DOM. A feed that fetched
// live markets would score a different set of cards per theme, and a screen that
// failed to load would quietly measure eight strings and call itself clean.
const board = await (await fetch(BASE.replace(/\/feed.*$/, "") + "/api/feed")).json();

const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${PORT}`,
   `--user-data-dir=/tmp/cdpC-${process.pid}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function page() {
  for (let i = 0; i < 60; i++) {
    try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = j.find((t) => t.type === "page"); if (p) return p; } catch {}
    await sleep(250);
  }
  throw new Error("chrome never came up");
}
const ws = new WebSocket((await page()).webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Fetch.requestPaused") {
    const u = m.params.request.url, rid = m.params.requestId;
    let b = null;
    if (u.includes("/api/feed")) b = board;
    else if (PAYLOAD && u.includes("/api/positions")) b = PAYLOAD.positions;
    else if (PAYLOAD && u.includes("/api/leaderboard")) b = PAYLOAD.leaderboard;
    else if (u.includes("/api/auth/me")) b = { accounts: [], providers: [{ provider: "twitter", available: true }, { provider: "google", available: true }] };
    else if (u.includes("/api/ev")) b = { ok: true };   // never write an analytics row
    if (b) send("Fetch.fulfillRequest", { requestId: rid, responseCode: 200,
      responseHeaders: [{ name: "content-type", value: "application/json" }], body: b64(b) });
    else send("Fetch.continueRequest", { requestId: rid });
    return;
  }
  if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
};
const send = (m, p = {}) => new Promise((resolve, reject) => {
  const n = ++id; pend.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result.value;

await send("Page.enable"); await send("Runtime.enable");
await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/*" }] });

const PROBE = `(()=>{
  const px=(c)=>{const m=(c||"").match(/[\\d.]+/g); if(!m||m.length<3)return null;
    return [ +m[0], +m[1], +m[2], m.length>3? +m[3] : 1 ];};
  const lin=(v)=>{v/=255; return v<=.03928? v/12.92 : Math.pow((v+.055)/1.055,2.4);};
  const lum=([r,g,b])=>.2126*lin(r)+.7152*lin(g)+.0722*lin(b);
  const over=(fg,bg)=>{const a=fg[3]; return [0,1,2].map(i=>fg[i]*a+bg[i]*(1-a)).concat(1);};
  const ratio=(f,b)=>{const [x,y]=[lum(f),lum(b)].sort((m,n)=>n-m); return (x+.05)/(y+.05);};
  const stops=(img)=>{const out=[]; const re=/rgba?\\([^)]+\\)/g; let m;
    while((m=re.exec(img))){const c=px(m[0]); if(c)out.push(c);} return out;};

  // Every opaque colour that could sit under this text. A gradient from blue to
  // white can put either under a label, so both are candidates and the worst
  // one is what we score. A translucent stop resolves against its own parent.
  const resolve=(node,depth)=>{
    if(!node || node===document.documentElement.parentNode || depth>24) return [[255,255,255,1]];
    const cs=getComputedStyle(node);
    let cands=[];
    const img=cs.backgroundImage;
    if(img && img!=="none") cands=stops(img);
    const bgc=px(cs.backgroundColor);
    if(bgc && bgc[3]>0) cands.push(bgc);
    cands=cands.filter(c=>c[3]>0);              // fully transparent paints nothing
    if(!cands.length) return resolve(node.parentElement,depth+1);
    if(cands.every(c=>c[3]>=.999)) return cands;
    const behind=resolve(node.parentElement,depth+1);
    const out=[];
    for(const c of cands){ if(c[3]>=.999){out.push(c);continue;}
      for(const b of behind) out.push(over(c,b)); }
    return out.slice(0,8);
  };

  const visible=(el)=>{const cs=getComputedStyle(el); const r=el.getBoundingClientRect();
    return r.width>0 && r.height>0 && cs.visibility!=="hidden" && cs.display!=="none" && +cs.opacity>0.05;};
  const owns=(el)=>[...el.childNodes].some(n=>n.nodeType===3 && n.textContent.trim().length>0);

  const rows=[];
  for(const el of document.querySelectorAll("body *")){
    if(!owns(el) || !visible(el) || el.closest("[hidden]")) continue;
    const cs=getComputedStyle(el);
    const fill=px(cs.color); if(!fill || fill[3]===0) continue;
    const bgs=resolve(el,0);
    // A 3px black stroke is what makes the outlined percentage legible; its
    // white fill against a white row would otherwise read as 1:1.
    const sw=parseFloat(cs.webkitTextStrokeWidth)||0;
    const sc=px(cs.webkitTextStrokeColor);
    const inks = (sw>=1.5 && sc && sc[3]>0) ? [fill,sc] : [fill];
    const worst=Math.min(...bgs.map(b=>Math.max(...inks.map(k=>ratio(over(k,b),b)))));
    const size=parseFloat(cs.fontSize), w=parseInt(cs.fontWeight,10)||400;
    const large = size>=24 || (size>=18.66 && w>=700);
    rows.push({
      label: el.tagName.toLowerCase()+(el.className&&typeof el.className==="string"?"."+el.className.trim().split(/\\s+/).join("."):""),
      text: el.textContent.trim().replace(/\\s+/g," ").slice(0,24),
      ratio:+worst.toFixed(2), need: large?3:4.5});
  }
  return {theme:document.documentElement.dataset.theme, rows};})()`;

const seen = new Map();   // key -> {bright, dark, need, label, text, where}
for (const theme of ["bright", "dark"]) {
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try{localStorage.setItem("poppin_theme",${JSON.stringify(theme)});}catch(e){}` });
  for (const [w, h] of VIEWPORTS) {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
    for (const screen of SCREENS) {
      await send("Page.navigate", { url: BASE + screen });
      for (let i = 0; i < 30; i++) {
        if (await ev(`document.querySelectorAll(".card,.tile,.lb,.acct,.stat,.rep").length>0`).catch(() => false)) break;
        await sleep(300);
      }
      await sleep(700);
      const where = `${screen || "#/feed"} @${w}`;
      const { rows } = await ev(PROBE);
      const applied = await ev(`document.documentElement.dataset.theme`);
      if (applied !== theme) throw new Error(`theme did not apply: wanted ${theme}, got ${applied}`);
      if (rows.length < 5) throw new Error(`${where} rendered almost no text (${rows.length}) — screen did not load`);
      for (const r of rows) {
        const key = `${where}|${r.label}|${r.text}`;
        const rec = seen.get(key) ?? { need: r.need, label: r.label, text: r.text, where };
        rec[theme] = r.ratio;
        seen.set(key, rec);
      }
    }
  }
}
ws.close(); chrome.kill();

const invisible = [], regressed = [], preexisting = [];
for (const r of seen.values()) {
  const b = r.bright, d = r.dark;
  if ((b !== undefined && b < INVISIBLE) || (d !== undefined && d < INVISIBLE)) { invisible.push(r); continue; }
  if (d !== undefined && d < r.need && (b === undefined || b >= r.need)) { regressed.push(r); continue; }
  if ((b !== undefined && b < r.need) || (d !== undefined && d < r.need)) preexisting.push(r);
}
const show = (r) => `      ${r.where.padEnd(20)} bright ${String(r.bright ?? "-").padStart(5)}  dark ${String(r.dark ?? "-").padStart(5)}  (>=${r.need})  ${r.label} "${r.text}"`;

console.log(`\n${seen.size} benzersiz metin, iki temada da olculdu.\n`);
if (invisible.length) { console.log(`✗ ${invisible.length} GORUNMEZ (<${INVISIBLE}:1) — her temada hata:`); invisible.forEach((r) => console.log(show(r))); }
if (regressed.length) { console.log(`✗ ${regressed.length} DARK REGRESYONU (bright geciyor, dark kaliyor):`); regressed.forEach((r) => console.log(show(r))); }
if (preexisting.length) {
  console.log(`⚠ ${preexisting.length} onceden var olan AA sapmasi (iki temada da, marka grisi) — hata degil:`);
  [...new Map(preexisting.map((r) => [r.label + r.text, r])).values()].slice(0, 8).forEach((r) => console.log(show(r)));
}
const fails = invisible.length + regressed.length;
console.log(fails === 0 ? `\n0 gorunmez metin, 0 dark regresyonu.\n` : `\n${fails} HATA.\n`);
process.exit(fails === 0 ? 0 : 1);
