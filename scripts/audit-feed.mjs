// Layout + picker-state assertions for the feed, across the viewports phones
// actually present. Run against a live server:
//
//   npm start &                 # or point it at production
//   npm run audit-feed          # defaults to http://localhost:3999/feed
//
// This exists because of one line. `.picker{display:flex}` outranks the UA's
// `[hidden]{display:none}`, so the amount picker rendered on every card, always:
// 200px of form nobody had asked for, sitting in a fixed-height flex column
// anchored to its bottom edge. The overflow went off the TOP of the card, slid
// the question under the sticky chips bar, and made the first thing a visitor
// read "…World Cup?" — with a blank payout line, no side highlighted and no
// amount chosen, because none of that state exists until a side is tapped.
//
// It was invisible at 390x844, the one viewport a headless screenshot defaults
// to, and visible on every real phone, where the browser chrome eats ~180px.
// So the matrix below is not decoration: the bug lives in the rows this file
// added, not the one it started with.
//
// Assertions, not eyeballs. Exits non-zero on any violation.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9380, RAW_URL = process.argv[2] ?? "http://localhost:3999/feed", OUT = process.argv[3];
// The feed is now the gated TikTok-web landing: a fresh browser sees the taste
// flow (2 cards, then the category picker), so card index 27 wouldn't exist to
// measure. ?full=1 renders the whole feed for layout auditing — the call-rope
// still holds, so this changes what is drawn, never who may play.
const URL = RAW_URL.includes("?") ? `${RAW_URL}&full=1` : `${RAW_URL}?full=1`;
// `npm run audit-feed -- <url> <out> dark` runs the whole matrix in dark.
const THEME = process.argv[4] === "dark" ? "dark" : "bright";
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/cdpA-${Date.now()}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pg() { for (let i = 0; i < 40; i++) { try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = j.find((t) => t.type === "page"); if (p) return p; } catch {} await sleep(250); } throw new Error("no chrome"); }
const ws = new WebSocket((await pg()).webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
const send = (m, p = {}) => new Promise((resolve, reject) => { const n = ++id; pend.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result.value;
const shot = async (n) => { if (!OUT) return; const { data } = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${n}.png`, Buffer.from(data, "base64")); };
await send("Page.enable"); await send("Runtime.enable");
// Planted before any document script runs, so the theme is chosen at boot and
// the page never paints the other one first.
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `try{localStorage.setItem("poppin_theme", ${JSON.stringify(THEME)});}catch(e){}`,
});
console.log(`  tema: ${THEME}`);

const SNAP = (i) => `(()=>{const sc=document.getElementById("scroller"),c=document.querySelectorAll(".card")[${i}];
  if(!c)return "nocard"; sc.scrollTop=c.offsetTop; return Math.round(c.getBoundingClientRect().top);})()`;

const PROBE = (i) => `(()=>{const c=document.querySelectorAll(".card")[${i}];
 const R=el=>el.getBoundingClientRect();
 const take=c.querySelector(".take"),cat=c.querySelector(".cat"),chips=document.querySelector(".chips");
 const p=c.querySelector(".picker"),line=c.querySelector(".pline");
 const tabs=document.querySelector(".tabs")||document.querySelector("nav");
 const [y,n]=c.querySelectorAll(".orow");
 const picking=c.classList.contains("picking");
 return {cardTop:Math.round(R(c).top),
  qTop:Math.round(R(take).top), chipsBottom:Math.round(R(chips).bottom),
  qUnderChips: R(take).top < R(chips).bottom-0.5,
  qClipped: take.scrollHeight>take.clientHeight+1,
  topOverflow: R(cat).top < R(c).top-0.5,
  hScroll: document.documentElement.scrollWidth>innerWidth+0.5,
  pickerPainted: getComputedStyle(p).display!=="none",
  theme: document.documentElement.dataset.theme,
  groundBg: getComputedStyle(document.body).backgroundColor,
  rowBg: getComputedStyle(y).backgroundImage.includes("rgb(255, 255, 255)"),
  rowBorder: getComputedStyle(y).borderTopColor,
  // The brand signature, as tokens. Every surface in the app is drawn from
  // these two, so pinning them here catches an inversion anywhere — a literal
  // check on one element only catches an inversion of that element.
  surfaceWhite: getComputedStyle(document.documentElement).getPropertyValue("--white").trim(),
  surfaceInk: getComputedStyle(document.documentElement).getPropertyValue("--ink").trim(),
  // And a surface that actually consumes them.
  pickerBg: (()=>{const q=c.querySelector(".picker");const cs=getComputedStyle(q);return cs.backgroundColor+" / "+cs.borderTopColor;})(),
  // Text must be readable on whatever it actually sits on. This exists because
  // giving <body> a ground colour silently handed near-white text to every white
  // tile that had not declared its own, and the questions disappeared.
  //
  // Only elements that paint their own background are measured: .orow fills
  // itself with a gradient, so its computed backgroundColor is transparent and
  // walking up would compare its black label against the dark ground — a false
  // alarm about the one thing that is definitely fine.
  contrast: (()=>{
    const lum=(c)=>{const m=(c||"").match(/[\d.]+/g); if(!m||m.length<3)return null;
      const [r,g,b]=m.slice(0,3).map(Number).map(v=>{v/=255;
        return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4);});
      return .2126*r+.7152*g+.0722*b;};
    const ratio=(fg,bg)=>{const a=lum(fg),b=lum(bg); if(a===null||b===null)return null;
      const [x,y]=[a,b].sort((m,n)=>n-m); return (x+.05)/(y+.05);};
    const painted=(el)=>{const bg=getComputedStyle(el).backgroundColor;
      return /rgba\(0, 0, 0, 0\)|transparent/.test(bg)?null:bg;};
    const out={};
    // surfaces that paint themselves
    for(const sel of [".bal",".amt",".confirm",".picker"]){
      const el=document.querySelector(sel); if(!el)continue;
      const bg=painted(el); if(!bg)continue;
      const r=ratio(getComputedStyle(el).color,bg); if(r!==null)out[sel]=+r.toFixed(2);
    }
    // and the two texts that live directly on the ground
    const groundBg=getComputedStyle(document.body).backgroundColor;
    for(const sel of [".card .take",".card .meta"]){
      const el=document.querySelector(sel); if(!el)continue;
      const r=ratio(getComputedStyle(el).color,groundBg); if(r!==null)out[sel]=+r.toFixed(2);
    }
    return out;})(),
  picking, amtsOn:[...c.querySelectorAll(".amt.on")].map(b=>b.textContent),
  pline: line.textContent,
  sideMarked: y.classList.contains("pick")!==n.classList.contains("pick"),
  sideDimmed: y.classList.contains("dim")!==n.classList.contains("dim"),
  confirmDisabled: c.querySelector(".confirm").disabled,
  confirmBelowTabs: picking && tabs ? R(c.querySelector(".confirm")).bottom > R(tabs).top+0.5 : false};})()`;

let fails = 0;
const bad = (c, m) => { if (c) { fails++; console.log(`      x ${m}`); } };

for (const [w, h, name] of [[320, 640, "SE1"], [375, 667, "SE2/8"], [390, 664, "14+bars"], [414, 736, "8Plus"], [390, 844, "14 full"]]) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await send("Page.navigate", { url: URL });
  for (let i = 0; i < 40; i++) { const n = await ev('document.querySelectorAll(".card").length').catch(() => 0); if (n > 1) break; await sleep(400); }
  console.log(`\n  ${w}x${h} ${name}`);
  for (const [idx, label] of [[27, "uzun soru"], [0, "kisa soru"]]) {
    const t = await ev(SNAP(idx));
    if (t === "nocard") { console.log(`    ${label}: kart yok`); continue; }
    await sleep(150);
    let p = await ev(PROBE(idx));
    console.log(`    ${label} / picker kapali   (soru ust=${p.qTop}, cip alti=${p.chipsBottom})`);
    bad(p.cardTop !== 0, `kart oturmadi (top=${p.cardTop})`);
    bad(p.pickerPainted, `picker taraf secilmeden goruntuleniyor`);
    bad(p.theme !== THEME, `tema uygulanmadi (${p.theme})`);
    // The brand signature, pinned at the token level. Every surface in the app —
    // tiles, picker, sheets, buttons — is drawn from --white and --ink, so an
    // inversion anywhere shows up here. A literal check on one element would
    // only catch an inversion of that element, which is how the first version of
    // this assertion sat green through a deliberate Path-B mutant.
    bad(p.surfaceWhite.toLowerCase() !== "#fff", `--white tema ile degisti: ${p.surfaceWhite}`);
    bad(p.surfaceInk.toLowerCase() !== "#000", `--ink tema ile degisti: ${p.surfaceInk}`);
    bad(!p.rowBg, `YES satiri beyaz degil`);
    bad(p.rowBorder !== "rgb(0, 0, 0)", `YES satirinin konturu siyah degil: ${p.rowBorder}`);
    if (THEME === "dark") bad(p.groundBg === "rgb(255, 255, 255)", `zemin koyulasmamis: ${p.groundBg}`);
    if (THEME === "bright") bad(p.groundBg !== "rgb(255, 255, 255)", `zemin beyaz degil: ${p.groundBg}`);
    for (const [sel, r] of Object.entries(p.contrast)) bad(r < 4.5, `dusuk kontrast ${sel}: ${r}:1`);
    bad(p.qUnderChips, `soru cip barinin altinda`);
    bad(p.qClipped, `soru kirpik`);
    bad(p.topOverflow, `icerik kartin ustunden tasiyor`);
    bad(p.hScroll, `yatay kaydirma`);

    // One tap now PLACES the call (5s undo window); the picker is opt-in behind
    // "change amount". The audit walks exactly that path: tap a side, assert the
    // pending state, then open the picker through the affordance — which also
    // cancels the pending call, so the audit never actually stakes anything.
    // The audit measures LAYOUT for a gated-in player; the gate itself has its
    // own tests. Force the pass before tapping, as a signed-in user would have.
    await ev(`GATE.allowed=true; 1`);
    await ev(`document.querySelectorAll(".card")[${idx}].querySelector(".orow").click(); 1`);
    await sleep(250);
    const pend = await ev(`(()=>{const s=document.querySelectorAll(".card")[${idx}].querySelector(".social");
      return {text:s.textContent.slice(0,44), undo:!!s.querySelector(".undo"), chg:!!s.querySelector(".chgamt")};})()`);
    bad(!pend.undo, `[tek-tap] undo butonu yok`);
    bad(!pend.chg, `[tek-tap] change-amount affordance yok`);
    bad(!/Locked — \d+ on (YES|NO), pays \d+/.test(pend.text), `[tek-tap] kilit satiri bozuk: "${pend.text}"`);
    await ev(`document.querySelectorAll(".card")[${idx}].querySelector(".chgamt").click(); 1`);
    await sleep(200);
    p = await ev(PROBE(idx));
    console.log(`    ${label} / picker acik     (soru ust=${p.qTop})  secili=${JSON.stringify(p.amtsOn)}  "${p.pline.slice(0, 42)}"`);
    bad(p.qUnderChips, `[acik] soru cip barinin altinda`);
    bad(p.qClipped, `[acik] soru kirpik`);
    bad(p.topOverflow, `[acik] icerik ustten tasiyor`);
    bad(p.amtsOn.length !== 1, `[acik] secili miktar sayisi ${p.amtsOn.length}`);
    bad(!p.pline, `[acik] canli kazanc satiri bos`);
    bad(!p.sideMarked, `[acik] secili taraf vurgulanmamis`);
    bad(!p.sideDimmed, `[acik] diger taraf soluk degil`);
    bad(p.confirmDisabled, `[acik] Confirm pasif`);
    bad(p.confirmBelowTabs, `[acik] Confirm tab bar altinda`);
    if (idx === 27) await shot(`fixed-${w}x${h}`);
  }
}
console.log(`\n  ${fails} ihlal`);
ws.close(); chrome.kill(); process.exit(fails ? 1 : 0);
