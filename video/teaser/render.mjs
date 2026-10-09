// Renders teaser.html frame by frame in parallel and muxes it with the score.
//
//   node video/teaser/render.mjs                    -> video/teaser/oddie-teaser.mp4 (30 fps)
//   node video/teaser/render.mjs --fps 60
//   node video/teaser/render.mjs --stills 16.1,20.3 --out /tmp/stills   (PNG stills, no video)
//
// Needs Playwright (the project's, or a global install), ffmpeg, and python3 with numpy + scipy.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = await import('playwright').catch(() =>
  import(pathToFileURL(execFileSync('npm', ['root', '-g']).toString().trim() + '/playwright/index.mjs').href));

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const fps = Number(arg('fps', 30));
const workers = Number(arg('workers', Math.max(1, Math.min(6, cpus().length))));
const stills = arg('stills', null);

// teaser.html keys the ghost out of the logo with getImageData, so it must be served over http
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.ttf': 'font/ttf', '.wav': 'audio/wav', '.js': 'text/javascript' };
const server = createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root)) { res.writeHead(403).end(); return; }
  try { statSync(p); res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' }).end(readFileSync(p)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/video/teaser/teaser.html?render`;

const browser = await chromium.launch();
async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => { console.error('page error:', e.message); process.exitCode = 1; });
  await page.goto(url);
  await page.waitForFunction(() => window.ready);
  return page;
}
const shoot = (page, t, f, file) => page.evaluate(([t, f]) => window.render(t, f), [t, f])
  .then(() => page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1920, height: 1080 } }));

if (stills) {
  const out = arg('out', path.join(here, 'stills'));
  mkdirSync(out, { recursive: true });
  const page = await openPage();
  for (const t of stills.split(',').map(Number)) await shoot(page, t, Math.round(t * 30), path.join(out, `s_${t.toFixed(2)}.png`));
  await browser.close(); server.close();
  console.log('stills in', out);
  process.exit();
}

const frames = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'oddie-frames-'));
const pages = await Promise.all(Array.from({ length: workers }, openPage));
const dur = await pages[0].evaluate(() => window.DUR);
const total = Math.round(dur * fps);
let next = 0, done = 0;
const t0 = Date.now();
await Promise.all(pages.map(async page => {
  for (let f = next++; f < total; f = next++) {
    await shoot(page, f / fps, f, path.join(frames, `f${String(f).padStart(5, '0')}.png`));
    if (++done % fps === 0) process.stdout.write(`\r${done}/${total} frames, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}));
await browser.close(); server.close();
console.log(`\n${total} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

const wav = path.join(here, 'score.wav');
execFileSync('python3', [path.join(here, 'build_audio.py'), wav], { stdio: 'inherit' });
const out = path.join(here, 'oddie-teaser.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(frames, 'f%05d.png'), '-i', wav,
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  '-c:a', 'aac', '-b:a', '256k', '-shortest', out], { stdio: 'inherit' });
rmSync(frames, { recursive: true, force: true });
console.log('wrote', out);
