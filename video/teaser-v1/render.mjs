// Renders teaser.html frame by frame, then muxes with the synthesized score.
//   node video/teaser-v1/render.mjs [fps]   ->  video/teaser-v1/oddie-teaser-v1.mp4
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// playwright from the project if present, else the global install
const { chromium } = await import('playwright').catch(() =>
  import(pathToFileURL(execFileSync('npm', ['root', '-g']).toString().trim() + '/playwright/index.mjs').href));

const here = path.dirname(fileURLToPath(import.meta.url));
const fps = Number(process.argv[2] || 30);
const frames = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'oddie-frames-'));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(pathToFileURL(path.join(here, 'teaser.html')).href);
await page.evaluate(() => window.ready);
const dur = await page.evaluate(() => window.DUR);
const total = Math.round(dur * fps);
for (let f = 0; f < total; f++) {
  await page.evaluate(([t, f]) => window.render(t, f), [f / fps, f]);
  await page.screenshot({ path: path.join(frames, `f${String(f).padStart(5, '0')}.png`) });
  if (f % fps === 0) process.stdout.write(`\r${f}/${total}`);
}
await browser.close();
console.log('\nframes done');

const wav = path.join(frames, 'score.wav');
execFileSync('python3', ['-I', path.join(here, 'build_audio.py'), wav, String(dur)], { stdio: 'inherit' });
const out = path.join(here, 'oddie-teaser-v1.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(frames, 'f%05d.png'), '-i', wav,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  '-c:a', 'aac', '-b:a', '192k', '-shortest', out], { stdio: 'inherit' });
rmSync(frames, { recursive: true, force: true });
console.log('wrote', out);
