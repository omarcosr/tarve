#!/usr/bin/env node
// Frame-accurate offline render of the Tarve launch film.
//
//   node render.mjs                         -> tarve-launch.mp4 (1920x1080, 60 fps, motion blur)
//   node render.mjs --stills 0.9,4.5,13.9   -> PNG stills in ./stills
//   node render.mjs --samples 1 --out draft.mp4
//
// Requires Playwright (Chromium) and ffmpeg with libx264 (set FFMPEG=/path/to/ffmpeg if not on PATH).
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const fps = Number(args.fps || 60);
const samples = Number(args.samples || 4);
const outFile = path.resolve(here, args.out || 'tarve-launch.mp4');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';

async function loadPlaywright() {
  try { return await import('playwright'); } catch {}
  const root = execSync('npm root -g').toString().trim();
  return createRequire(path.join(root, 'noop.js'))('playwright');
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  try {
    const p = path.join(here, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(here)) throw new Error('forbidden');
    const body = await readFile(p.endsWith('/') ? path.join(p, 'index.html') : p);
    res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/index.html?render`;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', e => { console.error('page error:', e); process.exit(1); });
await page.goto(url);
await page.evaluate(() => window.TARVE.ready);
const duration = await page.evaluate(() => window.TARVE.DURATION);

const grab = t => page.evaluate(([t, s]) => {
  window.TARVE.renderFrame(t, s);
  return document.getElementById('out').toDataURL('image/png').slice(22);
}, [t, samples]);

if (args.stills) {
  const dir = path.join(here, 'stills');
  await mkdir(dir, { recursive: true });
  for (const s of String(args.stills).split(',')) {
    const t = Number(s);
    await writeFile(path.join(dir, `t${t.toFixed(2)}.png`), Buffer.from(await grab(t), 'base64'));
    console.log('still', t);
  }
} else {
  const from = Number(args.from || 0), to = Number(args.to || duration);
  const first = Math.round(from * fps), last = Math.round(to * fps);
  const enc = spawn(ffmpeg, [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', args.preset || 'slow', '-crf', String(args.crf || 20),
    '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-movflags', '+faststart', outFile,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const started = Date.now();
  for (let f = first; f < last; f++) {
    const png = Buffer.from(await grab(f / fps), 'base64');
    if (!enc.stdin.write(png)) await new Promise(r => enc.stdin.once('drain', r));
    if (f % 30 === 0) {
      const done = f - first + 1, rate = done / ((Date.now() - started) / 1000);
      process.stdout.write(`\rframe ${f}/${last}  ${rate.toFixed(1)} fps  eta ${Math.round((last - f) / rate)}s   `);
    }
  }
  enc.stdin.end();
  await new Promise((r, j) => enc.on('close', c => (c === 0 ? r() : j(new Error(`ffmpeg exited ${c}`)))));
  console.log(`\nwrote ${outFile}`);
}
await browser.close();
server.close();
