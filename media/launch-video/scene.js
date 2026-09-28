/*
 * Tarve — 15 second launch film.
 *
 * Every frame is a pure function of time: `drawFrame(ctx, t)` paints the
 * scene at `t` seconds, so the film renders identically in the live preview
 * and in the offline frame-accurate capture (see render.mjs).
 *
 * Timeline
 *   0.00  terminal — cursor in the dark, `bun add @tarve/core`
 *   2.00  detonation — native UI system assembles from primitives
 *   6.08  match cut — TypeScript / Bun / Rust / Taffy / Vello / Parley
 *   7.88  architecture stack
 *   8.30  performance — 10k element tunnel, 120 fps profiler
 *   9.45  100k-row VirtualList at speed, native resize + reflow
 *  11.80  collapse into the wordmark
 *  12.80  hero — TARVE / Native UI. TypeScript velocity. / bun add @tarve/core
 */
(() => {
'use strict';

const W = 1920, H = 1080, FPS = 60, DURATION = 15, F = 1600;
const SANS = '"Geist", system-ui, sans-serif';
const MONO = '"Geist Mono", ui-monospace, monospace';

const C = {
  ink: '#F5F5F7', ink2: 'rgba(245,245,247,0.74)', ink3: 'rgba(245,245,247,0.50)', ink4: 'rgba(245,245,247,0.28)',
  line: 'rgba(255,255,255,0.08)', line2: 'rgba(255,255,255,0.15)',
  accent: '#3E7BFF', accentHi: '#8FB4FF', cyan: '#7DE3F4',
  kw: '#7AA2FF', str: '#7DE3F4', num: '#C3B1FF', tag: '#F2F2F4', attr: '#9A9AA8', punc: '#7C7C88', fn: '#E6E6EA',
  green: '#4ADE9A', red: '#FF6B7A',
};
const wht = a => `rgba(255,255,255,${a})`;
const acc = a => `rgba(62,123,255,${a})`;
const accHi = a => `rgba(143,180,255,${a})`;
const blk = a => `rgba(0,0,0,${a})`;

// ---------------------------------------------------------------- math
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const inv = (a, b, x) => clamp((x - a) / (b - a));
const E = {
  outExpo: t => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inExpo: t => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  outCubic: t => 1 - Math.pow(1 - t, 3),
  inCubic: t => t * t * t,
  inOutCubic: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inOutQuint: t => (t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2),
  outQuint: t => 1 - Math.pow(1 - t, 5),
  outBack: t => { const c1 = 1.4, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
};
const grow = (u, d, dur = 0.45, fn = E.outExpo) => fn(inv(d, d + dur, u));
const bump = (t, a, b) => (t <= a || t >= b ? 0 : Math.sin(Math.PI * (t - a) / (b - a)));
const hash = n => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123; return s - Math.floor(s); };
const hashInt = (n, m) => Math.floor(hash(n) * 1e6) % m;
const mod = (a, n) => ((a % n) + n) % n;
const fmt = n => Math.round(n).toLocaleString('en-US');

// ---------------------------------------------------------------- 2d helpers
function rr(g, x, y, w, h, r) {
  g.beginPath();
  w = Math.max(0, w); h = Math.max(0, h);
  g.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}
function font(g, s, w = 400, mono = false, ls = 0) {
  g.font = `${w} ${s}px ${mono ? MONO : SANS}`;
  g.letterSpacing = `${ls}px`;
}
function txt(g, s, x, y, o = {}) {
  font(g, o.s || 14, o.w || 400, o.mono, o.ls || 0);
  g.textAlign = o.a || 'left';
  g.textBaseline = o.b || 'middle';
  g.fillStyle = o.c || C.ink;
  g.fillText(s, x, y);
}
function tw(g, s, size, w = 400, mono = false, ls = 0) { font(g, size, w, mono, ls); return g.measureText(s).width; }
// skeleton bar -> resolved text
function rtxt(g, s, x, y, u, d, o = {}) {
  const p1 = E.outExpo(inv(d, d + 0.3, u));
  if (p1 <= 0) return;
  const p2 = E.outCubic(inv(d + 0.12, d + 0.42, u));
  const size = o.s || 14;
  const wd = tw(g, s, size, o.w || 400, o.mono, o.ls || 0);
  const bx = o.a === 'right' ? x - wd : o.a === 'center' ? x - wd / 2 : x;
  if (p2 < 1) { g.fillStyle = wht(0.11 * (1 - p2)); rr(g, bx, y - size * 0.36, wd * p1, size * 0.72, 3); g.fill(); }
  if (p2 > 0) { const pa = g.globalAlpha; g.globalAlpha = pa * p2; txt(g, s, x + (1 - p2) * 6, y, o); g.globalAlpha = pa; }
}
function line(g, x1, y1, x2, y2) { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }

// ---------------------------------------------------------------- shared chrome
function chrome(g, w, h, u, radius = 12) {
  const pf = E.outCubic(inv(0.1, 0.45, u));
  g.save();
  rr(g, 0, 0, w, h, radius); g.clip();
  g.globalAlpha = pf;
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, 'rgba(23,23,27,0.97)'); gr.addColorStop(1, 'rgba(10,10,12,0.975)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  g.globalAlpha = 1;
  return pf;
}
function chromeEnd(g, w, h, u, t, radius = 12, sheen = 0) {
  // glass reflection
  g.globalCompositeOperation = 'lighter';
  const sx = w * (0.15 + 0.1 * Math.sin(t * 0.4 + sheen));
  const gr = g.createLinearGradient(sx, 0, sx + h * 0.7, h);
  gr.addColorStop(0, wht(0)); gr.addColorStop(0.45, wht(0.028)); gr.addColorStop(0.5, wht(0.05)); gr.addColorStop(0.56, wht(0.02)); gr.addColorStop(1, wht(0));
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'source-over';
  g.restore();
  const po = E.outCubic(inv(0, 0.5, u));
  const L = 2 * (w + h);
  g.lineWidth = 1;
  const wire = 1 - E.inOutCubic(inv(0.35, 1.0, u));
  if (wire > 0) {
    g.setLineDash([L * po, L]);
    g.strokeStyle = accHi(0.95 * wire); rr(g, 0.5, 0.5, w - 1, h - 1, radius); g.stroke();
    g.setLineDash([]);
  }
  g.strokeStyle = wht(0.12 * po); rr(g, 0.5, 0.5, w - 1, h - 1, radius); g.stroke();
  const hl = g.createLinearGradient(0, 0, w, 0);
  hl.addColorStop(0, wht(0)); hl.addColorStop(0.3, wht(0.22 * po)); hl.addColorStop(0.7, wht(0.1 * po)); hl.addColorStop(1, wht(0));
  g.strokeStyle = hl; line(g, radius, 1, w - radius, 1);
}
function caption(g, w, a) {
  g.save(); g.globalAlpha *= a; g.strokeStyle = wht(0.55); g.lineWidth = 1;
  let x = w - 138 + 23; line(g, x - 5, 20.5, x + 5, 20.5);
  x = w - 92 + 23; g.strokeRect(x - 4.5, 15.5, 9, 9);
  x = w - 46 + 23; g.beginPath(); g.moveTo(x - 5, 15.5); g.lineTo(x + 5, 25.5); g.moveTo(x + 5, 15.5); g.lineTo(x - 5, 25.5); g.stroke();
  g.restore();
}
function mark(g, x, y, s, a = 1) {
  g.save(); g.globalAlpha *= a;
  const gr = g.createLinearGradient(x - s / 2, y - s / 2, x + s / 2, y + s / 2);
  gr.addColorStop(0, '#B7D0FF'); gr.addColorStop(1, '#3E7BFF');
  g.fillStyle = gr; rr(g, x - s / 2, y - s / 2, s, s, s * 0.28); g.fill();
  g.fillStyle = '#060608';
  g.fillRect(x - s * 0.28, y - s * 0.25, s * 0.56, s * 0.15);
  g.fillRect(x - s * 0.075, y - s * 0.25, s * 0.15, s * 0.53);
  g.restore();
}
function titlebar(g, w, u, title) {
  const p = grow(u, 0.15, 0.4);
  g.fillStyle = wht(0.028 * p); g.fillRect(0, 0, w, 40);
  g.fillStyle = C.line; g.fillRect(0, 40, w * p, 1);
  mark(g, 20, 20, 13, p);
  rtxt(g, title, 36, 20.5, u, 0.2, { s: 12.5, w: 500, c: C.ink2 });
  caption(g, w, p);
}

// ---------------------------------------------------------------- window object
class Win {
  constructor(o) {
    Object.assign(this, { R: 2, ry: 0, phase: 0, float: 6, mode: 'fly', exit: null, glow: 0 }, o);
    this.cv = document.createElement('canvas');
    this.cv.width = Math.ceil((o.maxW || o.w) * this.R);
    this.cv.height = Math.ceil((o.maxH || o.h) * this.R);
    this.g = this.cv.getContext('2d');
    this.cw = o.w; this.ch = o.h;
  }
  render(t) {
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.cv.width, this.cv.height);
    g.setTransform(this.R, 0, 0, this.R, 0, 0);
    this.paint(g, t - this.enter, t, this);
  }
}

function proj(cam, x, y, z) {
  const d = F + z - cam.z;
  if (d < 40) return null;
  const s = F / d;
  return { x: W / 2 + (x - cam.x) * s, y: H / 2 + (y - cam.y) * s, s, d };
}
function winWorld(win, t) {
  const fl = Math.sin(t * 0.8 + win.phase) * win.float;
  let x = win.x, y = win.y + fl, z = win.z, ry = win.ry, alpha = 1, sc = 1;
  if (win.mode === 'fly') {
    const e = E.outExpo(inv(win.enter, win.enter + 1.05, t));
    x = lerp(win.x * 0.08, win.x, e); y = lerp(0, y, e);
    z = win.z + (1 - e) * 2800;
    ry = win.ry + (1 - e) * (win.x > 0 ? -0.55 : 0.55);
    alpha = E.outCubic(inv(win.enter, win.enter + 0.25, t));
  } else if (win.mode === 'pop') {
    const e = E.outExpo(inv(win.enter, win.enter + 0.45, t));
    z = win.z + (1 - e) * 160; alpha = E.outCubic(inv(win.enter, win.enter + 0.18, t));
  } else if (win.mode === 'drop') {
    alpha = E.outCubic(inv(win.enter, win.enter + 0.08, t));
  }
  if (win.exit != null) {
    const k = E.inCubic(inv(win.exit, win.exit + 0.18, t));
    alpha *= 1 - k; sc *= 1 - 0.05 * k;
  }
  if (win.world) ({ x, y, z, ry } = win.world(t, { x, y, z, ry }));
  return { x, y, z, ry, alpha, sc };
}
function winScreen(win, t, cam) {
  const w = winWorld(win, t);
  const p = proj(cam, w.x, w.y, w.z);
  if (!p) return null;
  return { sx: p.x, sy: p.y, s: p.s * w.sc, kx: Math.cos(w.ry), shear: Math.sin(w.ry) * 0.1, alpha: w.alpha, z: w.z, d: p.d };
}
function localToScreen(win, P, lx, ly) {
  const ox = lx - win.cw / 2, oy = ly - win.ch / 2;
  return { x: P.sx + P.kx * P.s * ox, y: P.sy + P.shear * P.s * ox + P.s * oy };
}
function drawWin(ctx, win, P, t, blur = 0, fade = 1) {
  const a = P.alpha * fade;
  if (a <= 0.004 || P.s <= 0.01) return;
  const w = win.cw, h = win.ch;
  ctx.save();
  ctx.translate(P.sx, P.sy);
  ctx.transform(P.kx, P.shear, 0, 1, 0, 0);
  ctx.scale(P.s, P.s);
  ctx.globalAlpha = a;
  if (win.shadow !== false) {
    ctx.save();
    ctx.shadowColor = win.glow ? acc(0.35 * win.glow) : blk(0.85);
    ctx.shadowBlur = (win.glow ? 60 : 80) * P.s; ctx.shadowOffsetY = (win.glow ? 0 : 30) * P.s;
    ctx.fillStyle = blk(0.9); rr(ctx, -w / 2 + 8, -h / 2 + 8, w - 16, h - 16, 12); ctx.fill();
    ctx.restore();
  }
  if (blur > 0.35) ctx.filter = `blur(${blur.toFixed(2)}px)`;
  ctx.drawImage(win.cv, 0, 0, w * win.R, h * win.R, -w / 2, -h / 2, w, h);
  ctx.filter = 'none';
  // construction overlay: corner brackets, dimension label, layout guides
  const u = t - win.enter;
  if (win.mode === 'fly' && u >= 0 && u < 1.1) {
    const k = E.outCubic(inv(0.05, 0.2, u)) * (1 - E.inCubic(inv(0.45, 1.1, u)));
    if (k > 0) {
      const lw = 1.25 / P.s;
      ctx.lineWidth = lw; ctx.strokeStyle = accHi(0.9 * k);
      const ox = w / 2 + 10, oy = h / 2 + 10, arm = 16;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        ctx.beginPath(); ctx.moveTo(sx * ox, sy * oy + -sy * arm); ctx.lineTo(sx * ox, sy * oy); ctx.lineTo(sx * ox - sx * arm, sy * oy); ctx.stroke();
      }
      ctx.setLineDash([4 / P.s, 6 / P.s]); ctx.strokeStyle = accHi(0.16 * k);
      line(ctx, -w / 2, -4000, -w / 2, 4000); line(ctx, w / 2, -4000, w / 2, 4000);
      line(ctx, -4000, -h / 2, 4000, -h / 2); line(ctx, -4000, h / 2, 4000, h / 2);
      ctx.setLineDash([]);
      txt(ctx, `${Math.round(w)} × ${Math.round(h)}`, -w / 2, -h / 2 - 22, { s: 12, mono: true, c: accHi(0.95 * k), ls: 0.5 });
      txt(ctx, win.tag || '<Window>', w / 2, -h / 2 - 22, { s: 12, mono: true, c: wht(0.5 * k), a: 'right' });
    }
  }
  ctx.restore();
}

// ================================================================ SCENE 1 — terminal
const CMD = 'bun add @tarve/core';
const TYPE_T = (() => { const a = []; let x = 0.42; for (let i = 0; i < CMD.length; i++) { a.push(x); x += 0.05 + hash(i * 3.3) * 0.028 + (CMD[i] === ' ' ? 0.035 : 0); } return a; })();
const ENTER = TYPE_T[TYPE_T.length - 1] + 0.11;
const BURST = 2.0;

function chevron(g, x, y, s, color, lw) {
  g.strokeStyle = color; g.lineWidth = lw; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s * 0.9, y); g.lineTo(x, y + s); g.stroke();
  g.lineCap = 'butt';
}
function sceneTerminal(ctx, t) {
  if (t >= BURST + 0.02) return;
  const n = TYPE_T.filter(x => x <= t).length;
  const z = lerp(1, 1.12, E.inOutCubic(inv(0, 2.0, t)));
  const sqY = E.inExpo(inv(1.7, 1.88, t));
  const sqX = E.inExpo(inv(1.83, 1.99, t));
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(z * (1 - sqX * 0.998), z * (1 - sqY * 0.985));
  const size = 56;
  font(ctx, size, 500, true); const cw = ctx.measureText('M').width;
  const total = 54 + CMD.length * cw;
  const x0 = -total / 2, xt = x0 + 54, yc = -52;
  // ambient glow
  const cx = xt + n * cw;
  const glowA = E.outCubic(inv(0.05, 0.4, t)) * 0.22;
  const rg = ctx.createRadialGradient(cx, yc, 0, cx, yc, 520);
  rg.addColorStop(0, acc(glowA)); rg.addColorStop(1, acc(0));
  ctx.fillStyle = rg; ctx.fillRect(-1200, -700, 2400, 1400);
  // prompt
  const pa = E.outCubic(inv(0.18, 0.4, t));
  ctx.globalAlpha = pa; chevron(ctx, x0 + 6, yc, 13, C.accent, 5); ctx.globalAlpha = 1;
  // command text
  const flash = bump(t, ENTER, ENTER + 0.16);
  let xx = xt;
  for (let i = 0; i < n; i++) {
    const ch = CMD[i];
    const col = i < 3 ? C.ink : i < 8 ? C.ink3 : '#FFFFFF';
    const age = t - TYPE_T[i];
    ctx.globalAlpha = E.outCubic(clamp(age / 0.05));
    txt(ctx, ch, xx, yc + (1 - E.outExpo(clamp(age / 0.08))) * 6, { s: size, w: i >= 8 ? 600 : 500, mono: true, c: col });
    xx += cw;
  }
  ctx.globalAlpha = 1;
  if (flash > 0) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = flash * 0.6; for (let i = 0; i < n; i++) txt(ctx, CMD[i], xt + i * cw, yc, { s: size, w: 600, mono: true, c: C.accentHi }); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; }
  // cursor
  const curOn = t > 0.08 && (t < ENTER || t > ENTER + 0.3);
  if (curOn) {
    const blinkOn = t < 0.42 ? (t < 0.26 || t > 0.33) : true;
    if (blinkOn) {
      const fin = E.outCubic(inv(0.08, 0.2, t));
      const onPrompt = t > ENTER + 0.3;
      const cxp = onPrompt ? xt : cx + 4;
      const cyp = onPrompt ? 170 : yc;
      const ch = onPrompt ? 34 : 62, cwid = onPrompt ? 15 : 28;
      ctx.save(); ctx.shadowColor = C.accentHi; ctx.shadowBlur = 36;
      ctx.fillStyle = wht(0.96 * fin); ctx.fillRect(cxp, cyp - ch / 2, cwid, ch); ctx.restore();
    }
  }
  // output
  const outs = [
    [ENTER + 0.06, [['bun add ', C.ink4], ['v1.4.0', C.ink4]]],
    [ENTER + 0.13, [['installed ', C.ink3], ['@tarve/core@0.1.1', C.ink], ['  native · win32-x64', C.ink4]]],
    [ENTER + 0.2, [['1 package installed ', C.ink3], ['[38.00ms]', C.accentHi]]],
  ];
  outs.forEach(([t0, segs], k) => {
    const a = E.outCubic(inv(t0, t0 + 0.06, t)); if (a <= 0) return;
    ctx.globalAlpha = a; let x = xt; const y = 40 + k * 44;
    for (const [s, c] of segs) { txt(ctx, s, x, y, { s: 27, mono: true, c }); x += tw(ctx, s, 27, 400, true); }
    ctx.globalAlpha = 1;
  });
  if (t > ENTER + 0.3) { ctx.globalAlpha = E.outCubic(inv(ENTER + 0.3, ENTER + 0.36, t)); chevron(ctx, x0 + 12, 170, 8, C.accent, 3.5); ctx.globalAlpha = 1; }
  // compression light line
  if (sqY > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = wht(0.85 * sqY); ctx.fillRect(-total / 2 - 60, -3 / Math.max(0.02, 1 - sqY * 0.985), total + 120, 6 / Math.max(0.02, 1 - sqY * 0.985));
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
  if (sqX > 0) {
    const r = 6 + 30 * sqX;
    const g2 = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, r * 4);
    g2.addColorStop(0, wht(sqX)); g2.addColorStop(0.3, accHi(0.5 * sqX)); g2.addColorStop(1, acc(0));
    ctx.fillStyle = g2; ctx.fillRect(W / 2 - r * 4, H / 2 - r * 4, r * 8, r * 8);
  }
}

function drawBurst(ctx, t) {
  const u = t - BURST;
  if (u < 0 || u > 1.3) return;
  const cx = W / 2, cy = H / 2;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const f = Math.exp(-u * 8);
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 1100);
  g.addColorStop(0, wht(0.95 * f)); g.addColorStop(0.18, accHi(0.45 * f)); g.addColorStop(1, acc(0));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // anamorphic streak
  const sa = Math.exp(-u * 5);
  const sg = ctx.createLinearGradient(0, 0, W, 0);
  sg.addColorStop(0, accHi(0)); sg.addColorStop(0.5, wht(0.9 * sa)); sg.addColorStop(1, accHi(0));
  ctx.fillStyle = sg; ctx.fillRect(0, cy - 1.5, W, 3);
  ctx.fillStyle = sg; ctx.globalAlpha = 0.35; ctx.fillRect(0, cy - 10, W, 20); ctx.globalAlpha = 1;
  // shockwaves
  for (const [delay, max, lw] of [[0, 1500, 1.6], [0.06, 1000, 0.8]]) {
    const k = inv(delay, delay + 0.75, u); if (k <= 0 || k >= 1) continue;
    const r = E.outCubic(k) * max;
    ctx.strokeStyle = accHi(0.7 * (1 - k)); ctx.lineWidth = lw * (1 + 2 * (1 - k));
    ctx.beginPath(); ctx.ellipse(cx, cy, r, r * 0.62, 0, 0, Math.PI * 2); ctx.stroke();
  }
  // shards
  ctx.lineCap = 'round';
  for (let i = 0; i < 520; i++) {
    const ang = hash(i) * Math.PI * 2;
    const sp = 500 + Math.pow(hash(i + 0.37), 2) * 3400;
    const k = 3.0;
    const dist = sp * (1 - Math.exp(-k * u)) / k + 10;
    const v = sp * Math.exp(-k * u);
    const dx = Math.cos(ang), dy = Math.sin(ang) * 0.66;
    const x = cx + dx * dist, y = cy + dy * dist;
    const len = 6 + v * 0.03;
    const a = (1 - inv(0.2, 1.25, u)) * (0.35 + 0.65 * hash(i + 0.71));
    if (a <= 0) continue;
    ctx.strokeStyle = hash(i + 0.9) < 0.3 ? accHi(a) : wht(a * 0.9);
    ctx.lineWidth = 1 + hash(i + 0.5) * 2;
    line(ctx, x - dx * len, y - dy * len, x, y);
  }
  ctx.restore();
}

// ================================================================ SCENE 2 — native UI system
const ROWS = [
  ['Button', 'control'], ['Input', 'input'], ['Select', 'input'], ['DropdownMenu', 'overlay'], ['Dialog', 'overlay'],
  ['Resizable', 'layout'], ['ScrollArea', 'layout'], ['Tabs', 'navigation'], ['Markdown', 'rich'], ['Code', 'rich'],
  ['Diff', 'rich'], ['DataGrid', 'data'], ['VirtualList', 'data'], ['TreeView', 'data'], ['CommandPalette', 'overlay'],
  ['TextArea', 'input'], ['Slider', 'input'], ['Tooltip', 'overlay'],
];
const QUERY = 'VirtualList', Q_T0 = 3.02, Q_DT = 0.028;
const inspW = t => 250 + 84 * E.inOutCubic(inv(5.08, 5.48, t));
const gridRight = (t, w) => w - inspW(t) - 16;

function paintMain(g, u, t, win) {
  const w = win.w, h = win.h;
  chrome(g, w, h, u);
  titlebar(g, w, u, 'Tarve Studio');
  // sidebar
  const sp = grow(u, 0.2, 0.6);
  g.fillStyle = wht(0.018 * sp); g.fillRect(0, 41, 196, h - 41);
  g.fillStyle = C.line; g.fillRect(196, 41, 1, (h - 41) * sp);
  rtxt(g, 'WORKSPACE', 18, 66, u, 0.28, { s: 10, mono: true, c: C.ink4, ls: 1.6 });
  const items = ['Overview', 'Components', 'Layout', 'Renderer', 'Profiler', 'Accessibility', 'Settings'];
  const selA = grow(u, 0.5, 0.4);
  g.fillStyle = wht(0.065 * selA); rr(g, 10, 128 - 14, 176, 28, 7); g.fill();
  g.fillStyle = acc(selA); rr(g, 10, 128 - 8, 2.5, 16, 1.2); g.fill();
  items.forEach((s, i) => {
    const y = 94 + i * 34, d = 0.3 + i * 0.04, p = grow(u, d, 0.4);
    g.save(); g.globalAlpha *= p; g.strokeStyle = i === 1 ? C.accentHi : C.ink3; g.lineWidth = 1.3;
    const ix = 30;
    if (i % 4 === 0) { rr(g, ix - 6, y - 6, 12, 12, 3); g.stroke(); }
    else if (i % 4 === 1) { g.beginPath(); g.arc(ix, y, 6, 0, Math.PI * 2); g.stroke(); }
    else if (i % 4 === 2) { g.beginPath(); g.moveTo(ix, y - 7); g.lineTo(ix + 7, y); g.lineTo(ix, y + 7); g.lineTo(ix - 7, y); g.closePath(); g.stroke(); }
    else { g.beginPath(); g.moveTo(ix, y - 6.5); g.lineTo(ix + 7, y + 5.5); g.lineTo(ix - 7, y + 5.5); g.closePath(); g.stroke(); }
    g.restore();
    rtxt(g, s, 48, y, u, d + 0.05, { s: 13, w: i === 1 ? 500 : 400, c: i === 1 ? C.ink : C.ink2 });
  });
  g.fillStyle = C.green; g.globalAlpha = grow(u, 0.7); g.beginPath(); g.arc(24, h - 28, 3.5, 0, 7); g.fill(); g.globalAlpha = 1;
  rtxt(g, 'd3d11 · 120 Hz', 36, h - 28, u, 0.7, { s: 11, mono: true, c: C.ink3 });

  // toolbar
  const gx = 216, gr = gridRight(t, w), gw = gr - gx;
  const ip = grow(u, 0.3, 0.55);
  const focus = E.outCubic(inv(2.97, 3.08, t)) * (1 - inv(4.1, 4.3, t));
  const iw0 = Math.min(270, gr - 178 - 12 - gx);
  g.fillStyle = wht(0.03); rr(g, gx, 56, iw0 * ip, 34, 8); g.fill();
  g.strokeStyle = focus > 0 ? `rgba(${lerp(255, 62, focus)},${lerp(255, 123, focus)},255,${lerp(0.14, 0.95, focus)})` : C.line2;
  g.lineWidth = 1; rr(g, gx + 0.5, 56.5, iw0 * ip - 1, 33, 8); g.stroke();
  if (focus > 0) { g.strokeStyle = acc(0.3 * focus); g.lineWidth = 3; rr(g, gx - 2.5, 53.5, iw0 + 5, 39, 10.5); g.stroke(); }
  g.save(); g.globalAlpha *= ip; g.strokeStyle = C.ink3; g.lineWidth = 1.4;
  g.beginPath(); g.arc(gx + 17, 72, 5, 0, 7); g.stroke(); line(g, gx + 20.5, 75.5, gx + 24, 79);
  const n = t < Q_T0 ? 0 : Math.min(QUERY.length, Math.floor((t - Q_T0) / Q_DT) + 1);
  if (n === 0) txt(g, 'Search components…', gx + 32, 73, { s: 13, c: C.ink4 });
  else txt(g, QUERY.slice(0, n), gx + 32, 73, { s: 13, c: C.ink });
  if (focus > 0.5 && (t < Q_T0 + QUERY.length * Q_DT + 0.05 || (t * 2.2) % 1 < 0.6)) {
    const cx = gx + 33 + (n ? tw(g, QUERY.slice(0, n), 13) : 0);
    g.fillStyle = C.accentHi; g.fillRect(cx, 64, 1.5, 18);
  }
  g.strokeStyle = C.line2; rr(g, gx + iw0 - 50.5, 64.5, 40, 17, 4); g.stroke();
  txt(g, 'Ctrl K', gx + iw0 - 30.5, 73.5, { s: 9.5, mono: true, c: C.ink4, a: 'center' });
  g.restore();
  // buttons
  const bp = grow(u, 0.4, 0.5);
  const fx = gr - 84 - 10 - 84;
  g.save(); g.globalAlpha *= bp;
  g.fillStyle = wht(0.025); rr(g, fx, 56, 84, 34, 8); g.fill(); g.strokeStyle = C.line2; rr(g, fx + 0.5, 56.5, 83, 33, 8); g.stroke();
  g.strokeStyle = C.ink2; g.lineWidth = 1.3; line(g, fx + 18, 68, fx + 30, 68); line(g, fx + 20, 73, fx + 28, 73); line(g, fx + 22.5, 78, fx + 25.5, 78);
  txt(g, 'Filter', fx + 38, 73, { s: 13, w: 500, c: C.ink });
  const press = bump(t, 3.46, 3.6);
  const nx = gr - 84;
  g.translate(nx + 42, 73); g.scale(1 - 0.05 * press, 1 - 0.05 * press); g.translate(-(nx + 42), -73);
  g.fillStyle = '#F5F5F7'; rr(g, nx, 56, 84, 34, 8); g.fill();
  if (t > 3.48) { const k = inv(3.48, 3.9, t); g.save(); rr(g, nx, 56, 84, 34, 8); g.clip(); g.fillStyle = acc(0.35 * (1 - k)); g.beginPath(); g.arc(nx + 42, 73, 10 + 70 * E.outCubic(k), 0, 7); g.fill(); g.restore(); }
  txt(g, '+  New', nx + 42, 73, { s: 13, w: 600, c: '#0A0A0C', a: 'center' });
  g.restore();

  // data grid
  const gy = 104;
  const hp = grow(u, 0.35, 0.6);
  g.fillStyle = wht(0.028); rr(g, gx, gy, gw * hp, 32, 7); g.fill();
  const cols = [gx + 14, gx + gw * 0.47, gx + gw * 0.66, gx + gw * 0.8];
  ['COMPONENT', 'STATUS', 'LAYOUT', 'TREND'].forEach((s, i) => rtxt(g, s, cols[i], gy + 16.5, u, 0.4 + i * 0.05, { s: 9.5, mono: true, c: C.ink4, ls: 1.3 }));
  g.save();
  g.beginPath(); g.rect(gx, gy + 34, gw, h - gy - 34 - 12); g.clip();
  const scroll = 7.1 * E.inOutCubic(inv(3.4, 4.02, t));
  ROWS.forEach(([name, kind], i) => {
    const y = gy + 36 + i * 38 - scroll * 38;
    if (y < gy - 40 || y > h) return;
    const yc = y + 19, d = 0.42 + Math.min(i, 12) * 0.035;
    const p = grow(u, d, 0.5);
    if (i === 12 && t > 3.9) {
      const a = E.outCubic(inv(3.9, 4.1, t));
      g.fillStyle = acc(0.14 * a); rr(g, gx + 2, y + 2, gw - 4, 34, 6); g.fill();
      g.fillStyle = acc(a); rr(g, gx + 2, y + 10, 2.5, 18, 1); g.fill();
    }
    g.fillStyle = wht(0.05); g.fillRect(gx, y + 37, gw * p, 1);
    rtxt(g, name, cols[0], yc, u, d, { s: 13, w: 500, c: C.ink });
    if (n > 0 && name.startsWith(QUERY.slice(0, n)) && p > 0.5) txt(g, QUERY.slice(0, n), cols[0], yc, { s: 13, w: 500, c: C.accentHi });
    const nw = tw(g, name, 13, 500);
    rtxt(g, kind, cols[0] + nw + 10, yc + 0.5, u, d + 0.04, { s: 10, mono: true, c: C.ink4 });
    const native = kind === 'rich' || kind === 'data';
    const bw = native ? 50 : 50, bp2 = grow(u, d + 0.08, 0.4);
    g.save(); g.globalAlpha *= bp2;
    if (native) { g.fillStyle = acc(0.14); rr(g, cols[1], yc - 10, bw, 20, 10); g.fill(); g.strokeStyle = acc(0.6); rr(g, cols[1] + 0.5, yc - 9.5, bw - 1, 19, 9.5); g.stroke(); }
    else { g.fillStyle = wht(0.06); rr(g, cols[1], yc - 10, bw, 20, 10); g.fill(); }
    txt(g, native ? 'native' : 'stable', cols[1] + bw / 2, yc + 0.5, { s: 9.5, mono: true, c: native ? C.accentHi : C.ink3, a: 'center' });
    g.restore();
    rtxt(g, `${(0.02 + hash(i * 1.7) * 0.26).toFixed(2)} ms`, cols[2], yc, u, d + 0.06, { s: 12, mono: true, c: C.ink2 });
    const spw = gw * 0.2 - 16, sp2 = grow(u, d + 0.1, 0.6, E.outCubic);
    if (sp2 > 0) {
      g.strokeStyle = native ? C.accentHi : C.ink3; g.lineWidth = 1.3; g.beginPath();
      const pts = 14, last = Math.max(1, Math.floor(pts * sp2));
      for (let k = 0; k <= last; k++) { const x = cols[3] + (k / pts) * spw; const yy = yc + 7 - (hash(i * 31 + k + Math.floor(t * 3) * 0) * 14); k ? g.lineTo(x, yy) : g.moveTo(x, yy); }
      g.stroke();
    }
  });
  g.restore();
  // scrollbar
  const sbA = 0.25 + 0.5 * bump(t, 3.35, 4.3);
  g.fillStyle = wht(sbA * grow(u, 0.6)); rr(g, gr - 5, gy + 40 + scroll * 22, 3, 150, 1.5); g.fill();

  // splitter + inspector
  const drag = inv(5.08, 5.12, t) * (1 - inv(5.48, 5.56, t));
  const sx = gr + 8;
  g.fillStyle = drag > 0 ? acc(0.4 + 0.6 * drag) : C.line; g.fillRect(sx - (drag ? 0.5 : 0), 41, drag ? 2 : 1, (h - 41) * grow(u, 0.3, 0.6));
  if (drag > 0) { g.fillStyle = acc(0.12 * drag); g.fillRect(sx - 6, 41, 13, h - 41); }
  g.fillStyle = drag > 0 ? C.accentHi : C.ink3;
  for (let k = -1; k <= 1; k++) { g.beginPath(); g.arc(sx + 0.5, h / 2 + 30 + k * 7, 1.4, 0, 7); g.fill(); }
  const ix = gr + 26, iw = w - ix - 16;
  rtxt(g, 'Inspector', ix, 66, u, 0.45, { s: 12.5, w: 600, c: C.ink });
  const selLabel = t > 3.95 ? 'VirtualList' : 'Studio';
  rtxt(g, `<${selLabel}>`, ix, 86, u, 0.5, { s: 11, mono: true, c: t > 3.95 ? C.accentHi : C.ink3 });
  [['renderer', 'd3d11'], ['layout', 'taffy'], ['text', 'parley'], ['rows', '100,000'], ['frame', '8.33 ms']].forEach(([k, v], i) => {
    const y = 120 + i * 28, d = 0.5 + i * 0.04;
    rtxt(g, k, ix, y, u, d, { s: 12, c: C.ink3 });
    rtxt(g, v, ix + iw, y, u, d + 0.04, { s: 12, mono: true, c: C.ink, a: 'right' });
    g.fillStyle = wht(0.045); g.fillRect(ix, y + 14, iw * grow(u, d), 1);
  });
  // switch
  const swp = grow(u, 0.7, 0.4);
  const on = t < 3.3 ? 0 : t < 4.62 ? 1 : 0;
  const sk = t < 4.62 ? E.outBack(inv(3.3, 3.5, t)) : 1 - E.outBack(inv(4.62, 4.82, t));
  g.save(); g.globalAlpha *= swp;
  txt(g, 'VSync', ix, 272, { s: 12, c: C.ink2 });
  const swx = ix + iw - 36;
  g.fillStyle = `rgba(${lerp(60, 62, sk)},${lerp(60, 123, sk)},${lerp(66, 255, sk)},${lerp(0.5, 1, sk)})`; rr(g, swx, 262, 36, 20, 10); g.fill();
  g.fillStyle = '#fff'; g.beginPath(); g.arc(swx + 10 + 16 * sk, 272, 7.5, 0, 7); g.fill();
  // slider
  txt(g, 'Overscan', ix, 312, { s: 12, c: C.ink2 });
  const sv = 0.35 + 0.28 * Math.sin(t * 1.4 + 0.4);
  txt(g, `${Math.round(sv * 32)} rows`, ix + iw, 312, { s: 11, mono: true, c: C.ink3, a: 'right' });
  g.fillStyle = wht(0.1); rr(g, ix, 332, iw, 4, 2); g.fill();
  g.fillStyle = C.accent; rr(g, ix, 332, iw * sv, 4, 2); g.fill();
  g.fillStyle = '#fff'; g.beginPath(); g.arc(ix + iw * sv, 334, 7, 0, 7); g.fill();
  g.strokeStyle = acc(0.5); g.lineWidth = 3; g.beginPath(); g.arc(ix + iw * sv, 334, 9.5, 0, 7); g.stroke();
  // frame chart
  txt(g, 'FRAME TIME', ix, 372, { s: 9.5, mono: true, c: C.ink4, ls: 1.3 });
  const cy0 = 390, chh = h - cy0 - 24, bars = 26, bw2 = iw / bars;
  for (let k = 0; k < bars; k++) {
    const v = 0.36 + 0.08 * hash(k + Math.floor(t * 20) * 0.37 + 11);
    const bh = chh * v;
    g.fillStyle = k === bars - 1 ? C.accent : wht(0.16);
    g.fillRect(ix + k * bw2 + 1, cy0 + chh - bh * grow(u, 0.6 + k * 0.01, 0.4), bw2 - 2, bh * grow(u, 0.6 + k * 0.01, 0.4));
  }
  g.setLineDash([3, 3]); g.strokeStyle = acc(0.8); line(g, ix, cy0 + chh * 0.5, ix + iw, cy0 + chh * 0.5); g.setLineDash([]);
  g.restore();
  chromeEnd(g, w, h, u, t, 12, win.phase);
}

const CODE = [
  [['import', 'kw'], [' { ', 'punc'], ['Window', 'fn'], [', ', 'punc'], ['Row', 'fn'], [', ', 'punc'], ['DataGrid', 'fn'], [', ', 'punc'], ['Markdown', 'fn'], [' } ', 'punc'], ['from', 'kw'], [' ', 'punc'], ['"@tarve/core"', 'str'], [';', 'punc']],
  [],
  [['export', 'kw'], [' ', 'punc'], ['function', 'kw'], [' ', 'punc'], ['Studio', 'hi'], ['() {', 'punc']],
  [['  return', 'kw'], [' (', 'punc']],
  [['    <', 'punc'], ['Window', 'tag'], [' title', 'attr'], ['=', 'punc'], ['"Tarve Studio"', 'str'], [' width', 'attr'], ['={', 'punc'], ['1280', 'num'], ['}>', 'punc']],
  [['      <', 'punc'], ['Row', 'tag'], [' flex', 'attr'], ['={', 'punc'], ['1', 'num'], ['}', 'punc'], [' gap', 'attr'], ['={', 'punc'], ['12', 'num'], ['}>', 'punc']],
  [['        <', 'punc'], ['Sidebar', 'tag'], [' items', 'attr'], ['={', 'punc'], ['routes', 'fn'], ['} />', 'punc']],
  [['        <', 'punc'], ['DataGrid', 'tag'], [' rows', 'attr'], ['={', 'punc'], ['metrics', 'fn'], ['}', 'punc'], [' virtual', 'attr'], [' />', 'punc']],
  [['        <', 'punc'], ['Markdown', 'tag'], [' source', 'attr'], ['={', 'punc'], ['notes', 'fn'], ['} />', 'punc']],
  [['      </', 'punc'], ['Row', 'tag'], ['>', 'punc']],
  [['    </', 'punc'], ['Window', 'tag'], ['>', 'punc']],
  [['  );', 'punc']],
  [['}', 'punc']],
];
const CODE_COL = { kw: C.kw, punc: C.punc, fn: C.fn, str: C.str, hi: C.accentHi, tag: C.tag, attr: C.attr, num: C.num };
const CODE_T0 = 2.5, CODE_CPS = 420;
let CW13 = 7.8;
const CODE_TARGET = { lx: 0, ly: 0 };

function paintCode(g, u, t, win) {
  const w = win.w, h = win.h;
  chrome(g, w, h, u);
  const p = grow(u, 0.15, 0.4);
  g.fillStyle = wht(0.028 * p); g.fillRect(0, 0, w, 40);
  g.fillStyle = C.line; g.fillRect(0, 40, w * p, 1);
  g.fillStyle = wht(0.05 * p); g.fillRect(8, 6, 118, 35);
  g.fillStyle = C.accent; g.fillRect(8, 39, 118 * p, 2);
  mark(g, 24, 23, 11, p);
  rtxt(g, 'app.tsx', 38, 23.5, u, 0.2, { s: 12.5, w: 500, c: C.ink });
  rtxt(g, 'theme.ts', 146, 23.5, u, 0.25, { s: 12.5, c: C.ink3 });
  caption(g, w, p);
  // gutter
  const x0 = 58, y0 = 66, lh = 21.5;
  let budget = Math.max(0, (t - CODE_T0) * CODE_CPS);
  let caret = null;
  CODE.forEach((toks, i) => {
    const y = y0 + i * lh;
    const la = grow(u, 0.3 + i * 0.02, 0.3);
    txt(g, String(i + 1), 36, y, { s: 11.5, mono: true, c: wht(0.22 * la), a: 'right' });
    const len = toks.reduce((a, [s]) => a + s.length, 0);
    const show = Math.min(len, budget);
    budget -= len + 3;
    if (show <= 0) { if (!caret && budget + len + 3 >= 0) caret = { x: x0, y }; return; }
    let x = x0, left = Math.floor(show);
    for (const [s, k] of toks) {
      if (left <= 0) break;
      const part = s.slice(0, left); left -= part.length;
      txt(g, part, x, y, { s: 13, mono: true, c: CODE_COL[k], w: k === 'hi' || k === 'tag' ? 500 : 400 });
      x += part.length * CW13;
    }
    if (show < len) caret = { x, y };
    else if (budget < 0 && !caret) caret = { x, y };
  });
  const done = budget > 0;
  if (!done && caret) { g.fillStyle = wht(0.035); g.fillRect(44, caret.y - lh / 2, w - 44 - 70, lh); }
  if (caret && ((t * 2) % 1 < 0.6 || !done)) { g.fillStyle = C.accentHi; g.fillRect(caret.x + 1, caret.y - 9, 1.6, 18); }
  if (done) { const y = y0 + 7 * lh; g.fillStyle = acc(0.08 * inv(4.0, 4.2, t)); g.fillRect(44, y - lh / 2, w - 44 - 70, lh); }
  // minimap
  g.fillStyle = wht(0.02); g.fillRect(w - 64, 41, 64, h - 41 - 26);
  CODE.forEach((toks, i) => {
    let x = w - 56;
    for (const [s, k] of toks) { const ln = s.trim().length * 0.9; if (s.trim()) { g.fillStyle = CODE_COL[k]; g.globalAlpha = 0.45 * grow(u, 0.5 + i * 0.02); g.fillRect(x + (s.length - s.trimStart().length) * 0.9, 58 + i * 5, ln, 2.4); } x += s.length * 0.9; }
    g.globalAlpha = 1;
  });
  g.fillStyle = wht(0.06); g.fillRect(w - 64, 50, 64, 44);
  // status bar
  g.fillStyle = wht(0.025); g.fillRect(0, h - 26, w, 26); g.fillStyle = C.line; g.fillRect(0, h - 26, w, 1);
  g.fillStyle = C.green; g.globalAlpha = grow(u, 0.6); g.beginPath(); g.arc(16, h - 13, 3, 0, 7); g.fill(); g.globalAlpha = 1;
  rtxt(g, 'tarve lsp', 26, h - 12.5, u, 0.6, { s: 10.5, mono: true, c: C.ink3 });
  rtxt(g, 'TSX   UTF-8   Ln 8, Col 42', w - 14, h - 12.5, u, 0.65, { s: 10.5, mono: true, c: C.ink3, a: 'right' });
  chromeEnd(g, w, h, u, t, 12, win.phase);
}

function paintMarkdown(g, u, t, win) {
  const w = win.w, h = win.h;
  chrome(g, w, h, u);
  titlebar(g, w, u, 'README.md — Preview');
  const x = 26;
  rtxt(g, 'Tarve', x, 76, u, 0.3, { s: 28, w: 700, c: C.ink, ls: -0.5 });
  rtxt(g, 'Native desktop UI for Bun + TypeScript.', x, 110, u, 0.36, { s: 13.5, c: C.ink2 });
  rtxt(g, 'No browser. No DOM. Just native pixels.', x, 130, u, 0.4, { s: 13.5, c: C.ink2 });
  g.fillStyle = C.line; g.fillRect(x, 152, (w - 52) * grow(u, 0.4), 1);
  rtxt(g, 'Under the hood', x, 176, u, 0.44, { s: 15.5, w: 600, c: C.ink });
  [['Taffy', ' — flexbox & grid layout'], ['Parley', ' — shaping, selection, IME'], ['Vello', ' — GPU vector rendering']].forEach(([a, b], i) => {
    const y = 204 + i * 22, d = 0.5 + i * 0.05, p = grow(u, d);
    g.fillStyle = acc(p); g.beginPath(); g.arc(x + 4, y, 2.5, 0, 7); g.fill();
    rtxt(g, a, x + 16, y, u, d, { s: 13.5, w: 600, c: C.ink });
    rtxt(g, b, x + 16 + tw(g, a, 13.5, 600), y, u, d + 0.03, { s: 13.5, c: C.ink2 });
  });
  const cp = grow(u, 0.65, 0.5);
  g.fillStyle = wht(0.045); rr(g, x, 276, (w - 52) * cp, 38, 7); g.fill();
  g.strokeStyle = C.line; rr(g, x + 0.5, 276.5, (w - 52) * cp - 1, 37, 7); g.stroke();
  if (cp > 0.6) {
    g.globalAlpha = inv(0.6, 1, cp);
    let xx = x + 14;
    for (const [s, c] of [['const ', C.kw], ['app', C.fn], [' = ', C.punc], ['createApp', C.accentHi], ['(App);', C.punc]]) { txt(g, s, xx, 295.5, { s: 12.5, mono: true, c }); xx += s.length * CW13 * (12.5 / 13); }
    g.globalAlpha = 1;
  }
  g.fillStyle = acc(grow(u, 0.75)); g.fillRect(x, 326, 2, 18 * grow(u, 0.75));
  rtxt(g, 'Retained. Incremental. Native.', x + 12, 335.5, u, 0.78, { s: 13, c: C.ink3 });
  chromeEnd(g, w, h, u, t, 12, win.phase);
}

const DIFF = [
  [' ', 41, 41, 'fn present(&mut self, scene: &Scene) -> Result<()> {', null],
  ['-', 42, null, '    self.renderer.render(scene)?;', 'render(scene)'],
  ['+', null, 42, '    let frame = self.swapchain.acquire()?;', 'swapchain.acquire()'],
  ['+', null, 43, '    self.renderer.render_to(scene, &frame)?;', 'render_to(scene, &frame)'],
  ['+', null, 44, '    frame.present(Present::Immediate);', 'Present::Immediate'],
  [' ', 43, 45, '    Ok(())', null],
  [' ', 44, 46, '}', null],
];
function paintDiff(g, u, t, win) {
  const w = win.w, h = win.h;
  chrome(g, w, h, u);
  titlebar(g, w, u, 'render.rs — Diff');
  rtxt(g, 'native/src/render.rs', 16, 60, u, 0.3, { s: 12, mono: true, c: C.ink2 });
  rtxt(g, '+3', w - 46, 60, u, 0.34, { s: 12, mono: true, c: C.green, a: 'right' });
  rtxt(g, '−1', w - 16, 60, u, 0.36, { s: 12, mono: true, c: C.red, a: 'right' });
  const hp = grow(u, 0.35);
  g.fillStyle = acc(0.08 * hp); g.fillRect(0, 76, w, 24);
  rtxt(g, '@@ -41,6 +41,8 @@ impl Surface', 16, 88, u, 0.38, { s: 11.5, mono: true, c: C.accentHi });
  const cw = CW13 * (12 / 13);
  DIFF.forEach(([sign, a, b, code, hl], i) => {
    const y = 102 + i * 24, d = 0.42 + i * 0.05;
    const p = grow(u, d, 0.5);
    const ins = sign === '+', del = sign === '-';
    if (ins || del) {
      g.fillStyle = ins ? `rgba(74,222,154,${0.1 * p})` : `rgba(255,107,122,${0.1 * p})`; g.fillRect(0, y, w * p, 24);
      g.fillStyle = ins ? C.green : C.red; g.globalAlpha = p; g.fillRect(0, y, 2, 24); g.globalAlpha = 1;
      if (hl && p > 0.5) {
        const k = code.indexOf(hl);
        g.fillStyle = ins ? `rgba(74,222,154,${0.22 * inv(0.5, 1, p)})` : `rgba(255,107,122,${0.22 * inv(0.5, 1, p)})`;
        rr(g, 92 + k * cw - 1, y + 4, hl.length * cw + 2, 16, 3); g.fill();
      }
    }
    g.globalAlpha = p;
    txt(g, a == null ? '' : String(a), 34, y + 12.5, { s: 10.5, mono: true, c: C.ink4, a: 'right' });
    txt(g, b == null ? '' : String(b), 62, y + 12.5, { s: 10.5, mono: true, c: C.ink4, a: 'right' });
    txt(g, sign === ' ' ? '' : sign === '-' ? '−' : '+', 76, y + 12.5, { s: 12, mono: true, c: ins ? C.green : C.red });
    txt(g, code, 92 + (1 - p) * 8, y + 12.5, { s: 12, mono: true, c: sign === ' ' ? C.ink3 : C.ink });
    g.globalAlpha = 1;
  });
  chromeEnd(g, w, h, u, t, 12, win.phase);
}

const DD_ITEMS = [['New window', 'Ctrl N'], ['Open file…', 'Ctrl O'], ['Build executable…', 'Ctrl B'], null, ['Toggle theme', 'Ctrl T'], ['Preferences', 'Ctrl ,']];
const ddItemY = i => 10 + DD_ITEMS.slice(0, i).reduce((a, it) => a + (it ? 34 : 11), 0) + 17;
function paintDropdown(g, u, t, win) {
  const w = win.w, h = win.h;
  const open = E.outExpo(inv(0, 0.3, u));
  const close = win.exit != null ? E.inCubic(inv(win.exit, win.exit + 0.16, t)) : 0;
  const vis = h * open * (1 - close * 0.4);
  g.save(); rr(g, 0, 0, w, vis, 10); g.clip();
  g.fillStyle = 'rgba(20,20,24,0.98)'; g.fillRect(0, 0, w, h);
  // hover
  const hov = t < 3.72 ? -1 : t < 3.95 ? 0 : 2;
  if (hov >= 0) {
    const y = lerp(ddItemY(0), ddItemY(2), E.outExpo(inv(3.93, 4.05, t)));
    const click = bump(t, 4.06, 4.16);
    g.fillStyle = wht(0.07 + 0.08 * click); rr(g, 6, y - 15, w - 12, 30, 6); g.fill();
    if (t > 3.95) { g.fillStyle = acc(0.18 * E.outCubic(inv(3.95, 4.05, t)) + 0.2 * click); rr(g, 6, y - 15, w - 12, 30, 6); g.fill(); }
  }
  DD_ITEMS.forEach((it, i) => {
    const y = ddItemY(i), d = 0.05 + i * 0.03, p = grow(u, d, 0.3);
    if (!it) { g.fillStyle = C.line; g.fillRect(8, y - 17 + 5, (w - 16) * p, 1); return; }
    g.globalAlpha = p;
    txt(g, it[0], 18 + (1 - p) * 6, y, { s: 13, c: C.ink });
    txt(g, it[1], w - 16, y, { s: 11, mono: true, c: C.ink4, a: 'right' });
    g.globalAlpha = 1;
  });
  g.restore();
  g.strokeStyle = C.line2; rr(g, 0.5, 0.5, w - 1, vis - 1, 10); g.stroke();
}

function paintDialog(g, u, t, win) {
  const w = win.w, h = win.h;
  chrome(g, w, h, u, 14);
  const x = 26;
  rtxt(g, 'Build native executable?', x, 38, u, 0.08, { s: 18, w: 600, c: C.ink });
  rtxt(g, 'Compile app.tsx into a standalone Windows x64 binary.', x, 66, u, 0.12, { s: 13.5, c: C.ink3 });
  const cp = grow(u, 0.16, 0.4);
  g.fillStyle = wht(0.045); rr(g, x, 88, (w - 52) * cp, 34, 7); g.fill();
  g.globalAlpha = cp;
  let xx = x + 12; const cw = CW13;
  for (const [s, c] of [['$ ', C.ink4], ['tarve build ', C.ink], ['app.tsx ', C.str], ['--outfile ', C.attr], ['App.exe', C.str]]) { txt(g, s, xx, 105.5, { s: 13, mono: true, c }); xx += s.length * cw; }
  g.globalAlpha = 1;
  const by = h - 58, bp = grow(u, 0.2, 0.4);
  g.globalAlpha = bp;
  const cx = w - 26 - 110 - 10 - 92;
  g.strokeStyle = C.line2; rr(g, cx + 0.5, by + 0.5, 91, 35, 8); g.stroke();
  txt(g, 'Cancel', cx + 46, by + 18, { s: 13, w: 500, c: C.ink, a: 'center' });
  const bx = w - 26 - 110;
  const press = bump(t, 4.47, 4.6);
  g.save(); g.translate(bx + 55, by + 18); g.scale(1 - 0.05 * press, 1 - 0.05 * press); g.translate(-(bx + 55), -(by + 18));
  const built = t > 4.8;
  g.fillStyle = built ? '#FFFFFF' : '#F5F5F7'; rr(g, bx, by, 110, 36, 8); g.fill();
  if (t > 4.49) { const k = inv(4.49, 4.95, t); g.save(); rr(g, bx, by, 110, 36, 8); g.clip(); g.fillStyle = acc(0.45 * (1 - k)); g.beginPath(); g.arc(bx + 55, by + 18, 8 + 90 * E.outCubic(k), 0, 7); g.fill(); g.restore(); }
  if (t < 4.52) txt(g, 'Build', bx + 55, by + 18, { s: 13, w: 600, c: '#0A0A0C', a: 'center' });
  else if (!built) {
    g.strokeStyle = '#0A0A0C'; g.lineWidth = 2; g.lineCap = 'round';
    const a0 = t * 14; g.beginPath(); g.arc(bx + 34, by + 18, 6, a0, a0 + 4.2); g.stroke();
    txt(g, 'Building', bx + 46, by + 18.5, { s: 12.5, w: 600, c: '#0A0A0C' });
  } else {
    const k = E.outBack(inv(4.8, 5.0, t));
    g.strokeStyle = '#0A0A0C'; g.lineWidth = 2.2; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(bx + 27, by + 18); g.lineTo(bx + 27 + 4 * k, by + 18 + 4 * k); g.lineTo(bx + 27 + 4 * k + 8 * k, by + 18 + 4 * k - 9 * k); g.stroke();
    txt(g, 'Built · 1.8s', bx + 44, by + 18.5, { s: 12.5, w: 600, c: '#0A0A0C' });
  }
  g.lineCap = 'butt';
  g.restore();
  g.globalAlpha = 1;
  chromeEnd(g, w, h, u, t, 14, 0.7);
}

function paintWidget(kind) {
  return (g, u, t, win) => {
    const w = win.w, h = win.h;
    chrome(g, w, h, u, 12);
    if (kind === 'toggle') {
      rtxt(g, 'Reduce motion', 18, 26, u, 0.2, { s: 13.5, w: 500 });
      rtxt(g, 'prefers-reduced-motion', 18, 46, u, 0.25, { s: 11, mono: true, c: C.ink4 });
      const k = 0.5 + 0.5 * Math.sin(t * 2.4);
      const on = E.inOutCubic(clamp((k - 0.3) / 0.4));
      g.fillStyle = on > 0.5 ? C.accent : wht(0.15); rr(g, w - 58, 26, 40, 22, 11); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(w - 47 + 18 * on, 37, 8, 0, 7); g.fill();
    } else if (kind === 'progress') {
      const v = mod(t * 0.42, 1);
      rtxt(g, 'Compiling shaders', 18, 26, u, 0.2, { s: 13.5, w: 500 });
      rtxt(g, `${Math.round(v * 100)}%`, w - 18, 26, u, 0.2, { s: 12, mono: true, c: C.ink3, a: 'right' });
      g.fillStyle = wht(0.08); rr(g, 18, 46, w - 36, 5, 2.5); g.fill();
      const gr = g.createLinearGradient(18, 0, w - 18, 0); gr.addColorStop(0, C.accent); gr.addColorStop(1, C.cyan);
      g.fillStyle = gr; rr(g, 18, 46, (w - 36) * v * grow(u, 0.3), 5, 2.5); g.fill();
    } else if (kind === 'tabs') {
      const tabs = ['Preview', 'Code', 'Diff'];
      const sel = Math.floor(mod(t * 1.1, 3));
      const selX = lerp(6 + (sel === 0 ? 2 : sel - 1) * ((w - 12) / 3), 6 + sel * ((w - 12) / 3), E.outExpo(mod(t * 1.1, 1) / 0.3 > 1 ? 1 : mod(t * 1.1, 1) / 0.3));
      g.fillStyle = wht(0.1); rr(g, selX, 8, (w - 12) / 3, h - 16, 7); g.fill();
      tabs.forEach((s, i) => txt(g, s, 6 + (i + 0.5) * ((w - 12) / 3), h / 2, { s: 13, w: 500, c: i === sel ? C.ink : C.ink3, a: 'center' }));
    } else if (kind === 'select') {
      rtxt(g, 'Renderer', 18, 22, u, 0.2, { s: 11, mono: true, c: C.ink4 });
      g.strokeStyle = C.line2; rr(g, 16.5, 34.5, w - 33, 32, 7); g.stroke();
      txt(g, 'Direct3D 11', 28, 51, { s: 13, c: C.ink });
      g.strokeStyle = C.ink3; g.lineWidth = 1.4; g.beginPath(); g.moveTo(w - 38, 48); g.lineTo(w - 33, 53); g.lineTo(w - 28, 48); g.stroke();
    }
    chromeEnd(g, w, h, u, t, 12, win.phase);
  };
}

// windows
const mainWin = new Win({ w: 900, h: 560, x: -170, y: 40, z: 0, ry: 0.05, enter: 2.04, phase: 0.2, paint: paintMain, tag: '<Window title="Tarve Studio">', float: 4 });
const codeWin = new Win({ w: 580, h: 372, x: 600, y: -250, z: 260, ry: -0.13, enter: 2.16, phase: 1.3, paint: paintCode, R: 3, tag: '<Code language="tsx">' });
const mdWin = new Win({ w: 440, h: 360, x: -860, y: -300, z: 520, ry: 0.14, enter: 2.28, phase: 2.2, paint: paintMarkdown, tag: '<Markdown>' });
const diffWin = new Win({ w: 530, h: 300, x: 660, y: 300, z: 140, ry: -0.1, enter: 2.36, phase: 3.1, paint: paintDiff, tag: '<Diff wordDiff>' });
const ddWin = new Win({ w: 250, h: 228, x: -118, y: -46, z: -140, enter: 3.54, mode: 'drop', paint: paintDropdown, exit: 4.14, shadow: true, float: 3.4, phase: 0.2 });
const dlgWin = new Win({ w: 440, h: 206, x: 70, y: 70, z: -240, enter: 4.14, mode: 'pop', paint: paintDialog, exit: 5.02, glow: 1, float: 3 });
const widgets = [
  new Win({ w: 250, h: 70, x: -1030, y: 150, z: 900, ry: 0.2, enter: 2.5, paint: paintWidget('toggle'), phase: 4, tag: '<Switch>' }),
  new Win({ w: 280, h: 72, x: 1120, y: -30, z: 820, ry: -0.2, enter: 2.56, paint: paintWidget('progress'), phase: 5, tag: '<Progress>' }),
  new Win({ w: 300, h: 50, x: -380, y: -500, z: 760, ry: 0.05, enter: 2.62, paint: paintWidget('tabs'), phase: 6, tag: '<Tabs>' }),
  new Win({ w: 260, h: 82, x: 330, y: 560, z: 700, ry: -0.05, enter: 2.66, paint: paintWidget('select'), phase: 7, tag: '<Select>' }),
];
const uiWins = [mainWin, codeWin, mdWin, diffWin, ddWin, dlgWin, ...widgets];

function uiCam(t) {
  const a = E.inOutCubic(inv(2.0, 5.5, t));
  const cam = { x: lerp(-60, 60, a), y: lerp(30, -20, a), z: lerp(-560, 110, E.outCubic(inv(1.95, 5.6, t))), roll: lerp(-0.045, 0.018, a) };
  const zp = Math.pow(inv(5.5, 6.08, t), 2.6);
  if (t > 5.4) {
    const cw = winWorld(codeWin, t);
    const tx = cw.x + (CODE_TARGET.lx - codeWin.w / 2), ty = cw.y + (CODE_TARGET.ly - codeWin.h / 2);
    const k = E.inOutCubic(inv(5.4, 6.0, t));
    cam.x = lerp(cam.x, tx, k); cam.y = lerp(cam.y, ty, k);
    cam.z = lerp(cam.z, cw.z + F * 0.86, zp);
    cam.roll = lerp(cam.roll, 0, k);
  }
  return cam;
}
function focusZ(t) {
  let f = 0;
  f = lerp(f, -120, E.inOutCubic(inv(3.5, 3.7, t)));
  f = lerp(f, -240, E.inOutCubic(inv(4.1, 4.3, t)));
  f = lerp(f, 0, E.inOutCubic(inv(4.95, 5.15, t)));
  f = lerp(f, 260, E.inOutCubic(inv(5.4, 5.7, t)));
  return f;
}
codeWin.world = (t, p) => ({ ...p, ry: lerp(p.ry, 0, E.inOutCubic(inv(5.3, 5.9, t))) });

const FRAGS = ['<Row gap={12}>', 'taffy::compute_layout()', '<VirtualList estimate={44} />', 'parley::Layout', 'vello::Scene', 'onClick={() => count++}', 'await app.ready', '<Resizable>', 'theme.colors.primary', 'createApp(App)', '<ScrollArea>', 'AccessKit · UIA', 'swapchain.present()', '<CommandPalette />'];
function drawFragments(ctx, cam, t) {
  FRAGS.forEach((s, i) => {
    const x = (hash(i + 0.1) - 0.5) * 4200 + t * (20 + hash(i) * 30), y = (hash(i + 0.2) - 0.5) * 2600, z = 1200 + hash(i + 0.3) * 2600;
    const p = proj(cam, x, y, z); if (!p) return;
    const a = 0.22 * E.outCubic(inv(2.3 + hash(i) * 0.6, 3.0 + hash(i) * 0.6, t)) * clamp(1.4 - z / 3800);
    ctx.globalAlpha = a;
    txt(ctx, s, p.x, p.y, { s: 22 * p.s, mono: true, c: i % 3 === 0 ? C.accentHi : C.ink3 });
    ctx.globalAlpha = 1;
  });
}
function drawFloor(ctx, cam, t, yPlane = 700, alpha = 1) {
  ctx.lineWidth = 1;
  const zs = [], a0 = 0.06 * alpha;
  for (let z = -400; z <= 7000; z += 300) zs.push(z);
  for (let x = -4200; x <= 4200; x += 300) {
    const p1 = proj(cam, x, yPlane, -400), p2 = proj(cam, x, yPlane, 7000); if (!p1 || !p2) continue;
    const g = ctx.createLinearGradient(p1.x, p1.y, p2.x, p2.y); g.addColorStop(0, wht(a0)); g.addColorStop(1, wht(0));
    ctx.strokeStyle = g; line(ctx, p1.x, p1.y, p2.x, p2.y);
  }
  for (const z of zs) {
    const p1 = proj(cam, -4200, yPlane, z), p2 = proj(cam, 4200, yPlane, z); if (!p1 || !p2) continue;
    ctx.strokeStyle = wht(a0 * clamp(1 - z / 7000)); line(ctx, p1.x, p1.y, p2.x, p2.y);
  }
  const hz = proj(cam, 0, yPlane, 7000);
  if (hz) {
    const g = ctx.createLinearGradient(0, hz.y - 60, 0, hz.y + 60);
    g.addColorStop(0, acc(0)); g.addColorStop(0.5, acc(0.1 * alpha)); g.addColorStop(1, acc(0));
    ctx.fillStyle = g; ctx.fillRect(-500, hz.y - 60, W + 1000, 120);
  }
}
function drawDust(ctx, cam, t, n = 220, alpha = 1) {
  for (let i = 0; i < n; i++) {
    const x = (hash(i * 1.1) - 0.5) * 5000, y = (hash(i * 2.3) - 0.5) * 3200 - t * (8 + hash(i) * 14), z = -300 + hash(i * 3.7) * 4000;
    const p = proj(cam, x, y, z); if (!p) continue;
    const a = alpha * (0.15 + 0.5 * hash(i * 5.1)) * clamp(1 - z / 4000);
    ctx.fillStyle = hash(i * 7.7) < 0.2 ? accHi(a) : wht(a * 0.7);
    const s = Math.max(0.6, 2.2 * p.s);
    ctx.fillRect(p.x, p.y, s, s);
  }
}

// cursor
function drawPointer(ctx, x, y, a, press = 0) {
  if (a <= 0) return;
  ctx.save(); ctx.globalAlpha = a; ctx.translate(x, y); const s = 1.25 * (1 - 0.1 * press); ctx.scale(s, s);
  ctx.shadowColor = blk(0.6); ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 22); ctx.lineTo(5.5, 16.8); ctx.lineTo(9.6, 25.6); ctx.lineTo(13, 24); ctx.lineTo(9, 15.4); ctx.lineTo(16.5, 15.4); ctx.closePath();
  ctx.fillStyle = '#fff'; ctx.fill(); ctx.shadowColor = 'transparent';
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.restore();
}
function clickRing(ctx, x, y, t, tc) {
  const k = inv(tc, tc + 0.35, t); if (k <= 0 || k >= 1) return;
  ctx.strokeStyle = accHi(0.9 * (1 - k)); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, 6 + 28 * E.outCubic(k), 0, 7); ctx.stroke();
}
function uiCursor(ctx, t, cam, screens) {
  const S = (win, lx, ly) => () => { const P = screens.get(win) || winScreen(win, t, cam); return P ? localToScreen(win, P, typeof lx === 'function' ? lx() : lx, ly) : { x: W / 2, y: H / 2 }; };
  const gr = () => gridRight(t, mainWin.w);
  const keys = [
    { t: 2.7, p: S(mainWin, 420, 150) },
    { t: 2.94, p: S(mainWin, 330, 74) },
    { t: 3.3, p: S(mainWin, 330, 74) },
    { t: 3.46, p: S(mainWin, () => gr() - 40, 76) },
    { t: 3.62, p: S(mainWin, () => gr() - 40, 76) },
    { t: 3.8, p: S(ddWin, 120, ddItemY(0) + 4) },
    { t: 3.92, p: S(ddWin, 124, ddItemY(0) + 4) },
    { t: 4.05, p: S(ddWin, 130, ddItemY(2) + 4) },
    { t: 4.18, p: S(ddWin, 130, ddItemY(2) + 4) },
    { t: 4.44, p: S(dlgWin, dlgWin.w - 26 - 55, dlgWin.h - 38) },
    { t: 4.86, p: S(dlgWin, dlgWin.w - 26 - 55, dlgWin.h - 38) },
    { t: 5.06, p: S(mainWin, () => gr() + 8, 330) },
    { t: 5.5, p: S(mainWin, () => gr() + 8, 330) },
  ];
  let pos;
  if (t <= keys[0].t) pos = keys[0].p();
  else if (t >= keys[keys.length - 1].t) pos = keys[keys.length - 1].p();
  else {
    let i = 0; while (keys[i + 1].t < t) i++;
    const a = keys[i], b = keys[i + 1];
    const k = E.inOutCubic(inv(a.t, b.t, t));
    const pa = a.p(), pb = b.p();
    pos = { x: lerp(pa.x, pb.x, k), y: lerp(pa.y, pb.y, k) };
  }
  const alpha = E.outCubic(inv(2.62, 2.75, t)) * (1 - inv(5.5, 5.62, t));
  for (const tc of [2.95, 3.48, 4.08, 4.49, 5.08]) clickRing(ctx, pos.x, pos.y, t, tc);
  const press = Math.max(bump(t, 2.93, 3.03), bump(t, 3.46, 3.56), bump(t, 4.06, 4.14), bump(t, 4.47, 4.56), inv(5.06, 5.1, t) * (1 - inv(5.46, 5.5, t)));
  drawPointer(ctx, pos.x, pos.y, alpha, press);
  // resize arrow badge while dragging splitter
  if (t > 5.08 && t < 5.5) {
    const a = E.outCubic(inv(5.08, 5.14, t)) * (1 - inv(5.44, 5.5, t));
    ctx.globalAlpha = a;
    ctx.fillStyle = C.accent; rr(ctx, pos.x + 22, pos.y + 22, 96, 26, 13); ctx.fill();
    txt(ctx, `${Math.round(inspW(t))} px`, pos.x + 70, pos.y + 35.5, { s: 13, mono: true, w: 500, c: '#fff', a: 'center' });
    ctx.globalAlpha = 1;
  }
}

function sceneUI(ctx, t) {
  if (t < BURST - 0.02 || t >= 6.08) return;
  const cam = uiCam(t);
  ctx.save();
  ctx.translate(W / 2, H / 2); ctx.rotate(cam.roll); ctx.translate(-W / 2, -H / 2);
  const env = E.outCubic(inv(2.0, 2.6, t));
  drawFloor(ctx, cam, t, 700, env);
  drawDust(ctx, cam, t, 220, env);
  drawFragments(ctx, cam, t);
  const fz = focusZ(t);
  const list = [];
  const screens = new Map();
  for (const win of uiWins) {
    if (t < win.enter) continue;
    if (win.exit != null && t > win.exit + 0.2) continue;
    const P = winScreen(win, t, cam);
    if (!P) continue;
    screens.set(win, P);
    list.push([win, P]);
  }
  list.sort((a, b) => b[1].d - a[1].d);
  for (const [win, P] of list) {
    win.render(t);
    const blur = win === codeWin && t > 5.5 ? 0 : Math.min(9, Math.abs(P.z - fz) * 0.0115);
    const fade = win === codeWin ? 1 : 1 - inv(2.6, 6, P.s);
    drawWin(ctx, win, P, t, blur, fade);
  }
  uiCursor(ctx, t, cam, screens);
  // zoom streaks for the match cut
  const zp = inv(5.55, 6.08, t);
  if (zp > 0) {
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 110; i++) {
      const ang = hash(i * 1.3) * Math.PI * 2;
      const r0 = 120 + mod(hash(i * 2.9) + t * (1.2 + hash(i) * 2.2), 1) * 1300;
      const len = 60 + 520 * zp * zp;
      const a = zp * (0.15 + 0.35 * hash(i * 4.1));
      ctx.strokeStyle = i % 4 ? wht(a) : accHi(a); ctx.lineWidth = 1 + hash(i) * 1.5;
      line(ctx, W / 2 + Math.cos(ang) * r0, H / 2 + Math.sin(ang) * r0, W / 2 + Math.cos(ang) * (r0 + len), H / 2 + Math.sin(ang) * (r0 + len));
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
  // light sweeps
  for (const [t0, y0, ang] of [[2.25, 200, -0.25], [3.9, 900, -0.18], [5.2, 300, -0.22]]) {
    const k = inv(t0, t0 + 0.7, t); if (k <= 0 || k >= 1) continue;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.translate(lerp(-400, W + 400, E.inOutCubic(k)), y0); ctx.rotate(ang);
    const g = ctx.createLinearGradient(-500, 0, 500, 0);
    g.addColorStop(0, accHi(0)); g.addColorStop(0.5, accHi(0.28 * bump(k, 0, 1))); g.addColorStop(1, accHi(0));
    ctx.fillStyle = g; ctx.fillRect(-500, -1, 1000, 2);
    ctx.restore();
  }
  drawBurst(ctx, t);
}

// ================================================================ SCENE 3 — the stack
const WORDS = [
  { w: 'TypeScript', cap: 'LANGUAGE', sub: 'Typed TSX components' },
  { w: 'Bun', cap: 'RUNTIME', sub: 'Event-driven native bridge' },
  { w: 'Rust', cap: 'CORE', sub: 'Retained native tree' },
  { w: 'Taffy', cap: 'LAYOUT', sub: 'Flexbox + CSS Grid' },
  { w: 'Vello', cap: 'RENDERING', sub: 'GPU vector graphics' },
  { w: 'Parley', cap: 'TEXT', sub: 'Shaping · selection · IME' },
];
const TECH_T0 = 6.08, SLOT = 0.3, STACK_T0 = TECH_T0 + WORDS.length * SLOT;
const CODE_RAIN = ['interface Props {', '  title: string;', '  onSelect?: (id: Key) => void;', '}', 'export function List<T>() {', 'const [rows] = useStore();', '<VirtualList items={rows} />', 'type Size = "sm" | "md";', 'createApp(App, { renderer: "gpu" })', '<Window theme={darkTheme}>'];

function techBackground(ctx, i, lt, t) {
  const k = lt / SLOT;
  ctx.save();
  if (i === 0) {
    for (let c = 0; c < 13; c++) {
      const x = 70 + c * 150, sp = 700 + hash(c) * 700;
      for (let r = 0; r < 26; r++) {
        const y = mod(r * 48 - lt * sp - hash(c * 2) * 900, 1300) - 100;
        const s = CODE_RAIN[(c * 3 + r) % CODE_RAIN.length];
        const hi = hash(c * 17 + r) < 0.08;
        txt(ctx, s, x, y, { s: 15, mono: true, c: hi ? accHi(0.4) : wht(0.055) });
      }
    }
  } else if (i === 1) {
    ctx.globalCompositeOperation = 'lighter';
    for (let s = 0; s < 70; s++) {
      const y = hash(s * 1.7) * H, len = 200 + hash(s) * 900, sp = 3000 + hash(s * 3) * 4000;
      const x = W - mod(hash(s * 5) * 3000 + lt * sp, W + len * 2) + len;
      const g = ctx.createLinearGradient(x, 0, x + len, 0);
      g.addColorStop(0, wht(0)); g.addColorStop(1, s % 5 ? wht(0.14) : accHi(0.45));
      ctx.fillStyle = g; ctx.fillRect(x, y, len, s % 5 ? 1 : 2);
    }
    for (let r = 0; r < 3; r++) {
      const rad = 180 + mod(k + r / 3, 1) * 900;
      ctx.strokeStyle = acc(0.35 * (1 - mod(k + r / 3, 1))); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(W / 2, H / 2, rad, 0, 7); ctx.stroke();
    }
  } else if (i === 2) {
    const cs = 40;
    for (let y = 0; y < H / cs; y++) for (let x = 0; x < W / cs; x++) {
      const wave = Math.exp(-Math.pow((x + y * 0.6) - k * 80 + 10, 2) / 60);
      const h0 = hash(x * 131 + y * 7.3);
      const a = 0.025 + 0.35 * wave * (h0 < 0.5 ? h0 : 0) + (h0 > 0.985 ? 0.2 : 0);
      ctx.fillStyle = h0 > 0.93 ? acc(a * 2) : wht(a);
      ctx.fillRect(x * cs + 4, y * cs + 4, cs - 8, cs - 8);
    }
  } else if (i === 3) {
    const X = 150, Y = 120, WW = W - 300, HH = H - 240;
    const side = lerp(0.2, 0.26, E.inOutCubic(k));
    const boxes = [];
    const sw = WW * side;
    boxes.push([X, Y, sw - 8, HH, 'column']);
    const mx = X + sw + 8, mw = WW - sw - 8;
    const hh = HH * 0.16;
    boxes.push([mx, Y, mw, hh, 'row · justify: between']);
    const cy = Y + hh + 16, chh = HH - hh - 16;
    const f = [1, lerp(1, 2, E.inOutCubic(k)), 1];
    const tot = f.reduce((a, b) => a + b, 0);
    let cx = mx;
    f.forEach((fl, j) => { const cw = (mw - 32) * fl / tot; boxes.push([cx, cy, cw, chh, `flex: ${fl.toFixed(j === 1 ? 2 : 0)}`]); cx += cw + 16; });
    for (let j = 0; j < 6; j++) boxes.push([X + 16, Y + 60 + j * 56, sw - 40, 42, '']);
    boxes.forEach(([x, y, w, h, label], j) => {
      const p = E.outExpo(inv(j * 0.02, j * 0.02 + 0.18, lt));
      ctx.strokeStyle = accHi(0.45 * p); ctx.lineWidth = 1.2;
      const L = 2 * (w + h); ctx.setLineDash([L * p, L]); ctx.strokeRect(x + 0.5, y + 0.5, w, h); ctx.setLineDash([]);
      ctx.fillStyle = acc(0.035 * p); ctx.fillRect(x, y, w, h);
      if (label) txt(ctx, label, x + 10, y + 16, { s: 13, mono: true, c: accHi(0.7 * p) });
      if (label && j >= 2) txt(ctx, `${Math.round(w)}px`, x + w / 2, y + h - 18, { s: 12, mono: true, c: wht(0.35 * p), a: 'center' });
    });
  } else if (i === 4) {
    const curves = [
      [[120, 820], [520, 180], [980, 1020], [1800, 260]],
      [[100, 300], [700, 60], [1200, 900], [1820, 760]],
      [[300, 1000], [620, 520], [1400, 520], [1700, 60]],
    ];
    ctx.lineCap = 'round';
    curves.forEach((c, j) => {
      const p = E.outCubic(inv(j * 0.03, 0.26, lt));
      ctx.setLineDash([2400 * p, 3000]);
      ctx.strokeStyle = j === 0 ? accHi(0.7) : wht(0.22); ctx.lineWidth = j === 0 ? 3 : 1.5;
      ctx.beginPath(); ctx.moveTo(...c[0]); ctx.bezierCurveTo(...c[1], ...c[2], ...c[3]); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = wht(0.25 * p); ctx.lineWidth = 1;
      line(ctx, ...c[0], ...c[1]); line(ctx, ...c[3], ...c[2]);
      for (const q of c) { ctx.fillStyle = '#000'; ctx.fillRect(q[0] - 5, q[1] - 5, 10, 10); ctx.strokeStyle = accHi(0.8 * p); ctx.strokeRect(q[0] - 5, q[1] - 5, 10, 10); }
    });
    ctx.lineCap = 'butt';
  }
  ctx.restore();
}
function drawWordSlot(ctx, i, lt, t) {
  const Wd = WORDS[i];
  techBackground(ctx, i, lt, t);
  const size = 250, ls = -7;
  const zoom = 1 + 0.055 * (lt / SLOT);
  ctx.save();
  ctx.translate(W / 2, H / 2); ctx.scale(zoom, zoom); ctx.translate(-W / 2, -H / 2);
  font(ctx, size, 700, false, ls);
  const total = ctx.measureText(Wd.w).width - ls;
  const x0 = W / 2 - total / 2, base = H / 2 + 88;
  const xs = [...Wd.w].map((_, k) => ctx.measureText(Wd.w.slice(0, k)).width);
  // Parley: text metrics + selection
  if (i === 5) {
    const lines = [[-0.93, 'ascent'], [-0.7, 'cap height'], [-0.52, 'x-height'], [0, 'baseline'], [0.22, 'descent']];
    lines.forEach(([f, name], j) => {
      const y = base + f * size, p = E.outExpo(inv(j * 0.02, j * 0.02 + 0.2, lt));
      ctx.fillStyle = f === 0 ? accHi(0.8) : wht(0.18); ctx.fillRect(0, y, W * p, 1);
      txt(ctx, name, 60, y - 12, { s: 13, mono: true, c: f === 0 ? accHi(0.9) : wht(0.4) });
    });
    const sel = Math.floor(E.outCubic(inv(0.06, 0.26, lt)) * Wd.w.length + 0.001);
    if (sel > 0) {
      const sx = x0 + xs[0], ex = sel >= Wd.w.length ? x0 + total : x0 + xs[sel];
      ctx.fillStyle = acc(0.38); ctx.fillRect(sx, base - 0.93 * size, ex - sx, 1.15 * size);
      ctx.fillStyle = C.accentHi; ctx.fillRect(ex, base - 0.93 * size, 4, 1.15 * size);
    }
    [...Wd.w].forEach((ch, k) => {
      const x = x0 + xs[k], w = (k + 1 < Wd.w.length ? xs[k + 1] : total) - xs[k];
      ctx.strokeStyle = wht(0.18); ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, base - 0.93 * size, w, 1.15 * size);
    });
  }
  ctx.save();
  ctx.beginPath(); ctx.rect(0, base - size * 1.0, W, size * 1.28); ctx.clip();
  [...Wd.w].forEach((ch, k) => {
    const p = E.outExpo(inv(k * 0.016, k * 0.016 + 0.2, lt));
    ctx.fillStyle = '#FFFFFF';
    font(ctx, size, 700, false, ls);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(ch, x0 + xs[k], base + (1 - p) * 300);
  });
  ctx.restore();
  // caption + sub
  const ca = E.outCubic(inv(0.02, 0.12, lt));
  ctx.globalAlpha = ca;
  txt(ctx, `0${i + 1}`, x0 + 6, base - size * 0.93 - 34, { s: 18, mono: true, w: 500, c: C.accentHi, ls: 2 });
  txt(ctx, `/  ${Wd.cap}`, x0 + 46, base - size * 0.93 - 34, { s: 18, mono: true, c: C.ink3, ls: 4 });
  ctx.fillStyle = wht(0.25); ctx.fillRect(x0 + 6, base - size * 0.93 - 14, total * E.outExpo(inv(0.02, 0.25, lt)), 1);
  txt(ctx, Wd.sub, x0 + 8 + (1 - ca) * 20, base + 76, { s: 30, w: 400, c: C.ink3 });
  ctx.globalAlpha = 1;
  ctx.restore();
}
function drawStack(ctx, t) {
  const lt = t - STACK_T0;
  const out = E.inExpo(inv(0.36, 0.56, lt));
  ctx.save();
  const sc = 1 + out * 2.2;
  ctx.translate(W / 2, H / 2 + 10); ctx.scale(sc, sc);
  ctx.globalAlpha = 1 - E.inCubic(inv(0.44, 0.56, lt));
  const boxes = [
    ['TypeScript', -170, -200, 300, 'app'], ['Bun', 170, -200, 300, 'runtime'],
    ['Rust', 0, 0, 640, 'native core'],
    ['Taffy', -330, 200, 300, 'layout'], ['Parley', 0, 200, 300, 'text'], ['Vello', 330, 200, 300, 'render'],
  ];
  // connectors
  const links = [[0, 2], [1, 2], [2, 3], [2, 4], [2, 5]];
  links.forEach(([a, b], j) => {
    const A = boxes[a], B = boxes[b];
    const p = E.outExpo(inv(0.08 + j * 0.02, 0.26 + j * 0.02, lt));
    const x1 = A[1], y1 = A[2] + 44, x2 = B[1], y2 = B[2] - 44;
    const ym = (y1 + y2) / 2;
    ctx.strokeStyle = wht(0.2); ctx.lineWidth = 1.5;
    ctx.setLineDash([400 * p, 400]);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1, ym); ctx.lineTo(x2, ym); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
    const q = mod(lt * 2.4 + j * 0.2, 1);
    if (p > 0.9) {
      const segs = [[x1, y1, x1, ym], [x1, ym, x2, ym], [x2, ym, x2, y2]];
      const lens = segs.map(s => Math.hypot(s[2] - s[0], s[3] - s[1])); const L = lens.reduce((a, b) => a + b, 0);
      let d = q * L, si = 0; while (si < 2 && d > lens[si]) { d -= lens[si]; si++; }
      const s = segs[si], f = lens[si] ? d / lens[si] : 0;
      ctx.fillStyle = C.accentHi; ctx.shadowColor = C.accent; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.arc(lerp(s[0], s[2], f), lerp(s[1], s[3], f), 4, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
    }
  });
  boxes.forEach(([name, x, y, w, tag], j) => {
    const p = E.outExpo(inv(j * 0.03, j * 0.03 + 0.3, lt));
    const h = 88;
    ctx.save(); ctx.globalAlpha *= p; ctx.translate(x, y); ctx.scale(lerp(0.92, 1, p), lerp(0.92, 1, p));
    ctx.fillStyle = name === 'Rust' ? acc(0.1) : 'rgba(18,18,22,0.95)'; rr(ctx, -w / 2, -h / 2, w, h, 14); ctx.fill();
    ctx.strokeStyle = name === 'Rust' ? acc(0.9) : C.line2; ctx.lineWidth = 1.2; rr(ctx, -w / 2 + 0.5, -h / 2 + 0.5, w - 1, h - 1, 14); ctx.stroke();
    txt(ctx, name, 0, -4, { s: 34, w: 650, c: C.ink, a: 'center', ls: -0.8 });
    txt(ctx, tag.toUpperCase(), 0, 28, { s: 11.5, mono: true, c: name === 'Rust' ? C.accentHi : C.ink3, a: 'center', ls: 2.5 });
    ctx.restore();
  });
  const ta = E.outCubic(inv(0.05, 0.2, lt));
  txt(ctx, 'TSX  →  FFI  →  NATIVE', 0, -330, { s: 14, mono: true, c: wht(0.45 * ta), a: 'center', ls: 5 });
  ctx.restore();
}
function sceneTech(ctx, t) {
  if (t < TECH_T0 || t >= STACK_T0 + 0.58) return;
  if (t < STACK_T0) {
    const i = Math.floor((t - TECH_T0) / SLOT);
    drawWordSlot(ctx, i, t - (TECH_T0 + i * SLOT), t);
  } else drawStack(ctx, t);
}

// ================================================================ SCENE 4 — performance
const TUN = { Wt: 980, Ht: 560, len: 150, N: 56, tiles: [] };
(() => {
  for (let wall = 0; wall < 4; wall++) {
    const across = wall < 2 ? 18 : 10;
    for (let a = 0; a < across; a++) for (let n = 0; n < TUN.N; n++) {
      const id = wall * 10000 + a * 100 + n;
      TUN.tiles.push({ wall, a, across, n, type: hashInt(id * 1.37, 4), act: hash(id * 0.71) < 0.22, h: hash(id * 3.1) });
    }
  }
})();
const PERF_T0 = 8.28;
const tunnelPos = t => { const u = Math.max(0, t - PERF_T0); return 3400 * u + 2200 * (1 - Math.exp(-u * 2.5)); };
function drawTunnel(ctx, t, alpha) {
  if (alpha <= 0.003) return;
  const D = TUN.len * TUN.N, pos = tunnelPos(t);
  const { Wt, Ht } = TUN;
  ctx.save();
  ctx.translate(W / 2, H / 2); ctx.rotate(0.12 * Math.sin((t - PERF_T0) * 0.6) + (t - PERF_T0) * 0.06);
  const pulse1 = mod(t * 5200, D), pulse2 = mod(t * 5200 + D / 2, D);
  const P = (x, y, z) => [x * F / z, y * F / z];
  for (const tl of TUN.tiles) {
    const z0 = mod(tl.n * TUN.len - pos, D) + 30;
    if (z0 < 45) continue;
    const z1 = z0 + TUN.len * 0.8;
    const fog = Math.pow(1 - z0 / D, 1.7), near = inv(45, 320, z0);
    let a = alpha * fog * near; if (a < 0.01) continue;
    const span = tl.wall < 2 ? 2 * Wt : 2 * Ht, cw = span / tl.across;
    const u0 = -span / 2 + tl.a * cw + cw * 0.09, u1 = u0 + cw * 0.82;
    const corner = (u, z) => tl.wall === 0 ? P(u, Ht, z) : tl.wall === 1 ? P(u, -Ht, z) : tl.wall === 2 ? P(-Wt, u, z) : P(Wt, u, z);
    const q = [corner(u0, z0), corner(u1, z0), corner(u1, z1), corner(u0, z1)];
    const wave = tl.act ? Math.max(Math.exp(-Math.pow(z0 - pulse1, 2) / 180000), Math.exp(-Math.pow(z0 - pulse2, 2) / 180000)) : 0;
    ctx.beginPath(); ctx.moveTo(q[0][0], q[0][1]); ctx.lineTo(q[1][0], q[1][1]); ctx.lineTo(q[2][0], q[2][1]); ctx.lineTo(q[3][0], q[3][1]); ctx.closePath();
    ctx.fillStyle = wave > 0.05 ? acc(a * (0.12 + 0.75 * wave)) : wht(a * (0.06 + 0.07 * tl.h));
    ctx.fill();
    if (z0 < 2600) {
      const d = a * (1 - z0 / 2600);
      const L = (uu, zz) => corner(lerp(u0, u1, uu), lerp(z0, z1, zz));
      const quad = (ua, ub, za, zb) => { const r = [L(ua, za), L(ub, za), L(ub, zb), L(ua, zb)]; ctx.beginPath(); ctx.moveTo(r[0][0], r[0][1]); for (let k = 1; k < 4; k++) ctx.lineTo(r[k][0], r[k][1]); ctx.closePath(); ctx.fill(); };
      ctx.fillStyle = wave > 0.1 ? accHi(d * 0.9) : wht(d * 0.28);
      if (tl.type === 0) { quad(0.12, 0.7, 0.2, 0.32); quad(0.12, 0.45, 0.45, 0.55); }
      else if (tl.type === 1) { quad(0.55, 0.88, 0.3, 0.7); }
      else if (tl.type === 2) { quad(0.12, 0.88, 0.62, 0.8); }
      else { quad(0.12, 0.3, 0.2, 0.8); quad(0.38, 0.88, 0.3, 0.42); }
    }
  }
  // edge rails
  ctx.globalCompositeOperation = 'lighter';
  for (const [x, y] of [[-Wt, -Ht], [Wt, -Ht], [Wt, Ht], [-Wt, Ht]]) {
    const a = P(x, y, 60), b = P(x, y, D);
    const g = ctx.createLinearGradient(a[0], a[1], b[0], b[1]); g.addColorStop(0, accHi(0.5 * alpha)); g.addColorStop(1, accHi(0));
    ctx.strokeStyle = g; ctx.lineWidth = 2; line(ctx, a[0], a[1], b[0], b[1]);
  }
  const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, 260);
  cg.addColorStop(0, acc(0.28 * alpha)); cg.addColorStop(1, acc(0));
  ctx.fillStyle = cg; ctx.fillRect(-300, -300, 600, 600);
  ctx.restore();
}

// HUD
function drawHUD(ctx, t) {
  const a = E.outCubic(inv(8.45, 8.7, t)) * (1 - inv(11.62, 11.8, t));
  if (a <= 0) return;
  ctx.save(); ctx.globalAlpha = a;
  // viewfinder
  ctx.strokeStyle = wht(0.35); ctx.lineWidth = 1.5;
  const m = 44, arm = 26;
  for (const [x, y, sx, sy] of [[m, m, 1, 1], [W - m, m, -1, 1], [W - m, H - m, -1, -1], [m, H - m, 1, -1]]) {
    ctx.beginPath(); ctx.moveTo(x, y + sy * arm); ctx.lineTo(x, y); ctx.lineTo(x + sx * arm, y); ctx.stroke();
  }
  const x = 88, y = 96;
  ctx.fillStyle = C.accent; ctx.globalAlpha = a * (0.6 + 0.4 * Math.sin(t * 12)); ctx.beginPath(); ctx.arc(x + 4, y, 4, 0, 7); ctx.fill(); ctx.globalAlpha = a;
  txt(ctx, 'TARVE  PROFILER', x + 18, y + 1, { s: 13, mono: true, c: C.ink3, ls: 3 });
  const fps = 120 + [0, 1, 0, -1, 0, 2, 0, 1][Math.floor(t * 9) % 8];
  txt(ctx, String(fps), x, y + 62, { s: 76, mono: true, w: 500, c: C.ink, ls: -2 });
  txt(ctx, 'FPS', x + 150, y + 76, { s: 16, mono: true, c: C.accentHi, ls: 3 });
  // frame graph
  const gx = x, gy = y + 118, gw = 340, gh = 70;
  ctx.fillStyle = wht(0.04); ctx.fillRect(gx, gy, gw, gh);
  const bars = 56, bw = gw / bars;
  for (let k = 0; k < bars; k++) {
    const v = 0.44 + 0.05 * hash(k + Math.floor(t * 60) - bars + 9001 * 0 + (Math.floor(t * 60) + k) * 0.001) + 0.03 * hash(Math.floor(t * 60) + k);
    ctx.fillStyle = k === bars - 1 ? C.accent : wht(0.28);
    ctx.fillRect(gx + k * bw + 0.5, gy + gh - gh * v, bw - 1.5, gh * v);
  }
  ctx.setLineDash([4, 4]); ctx.strokeStyle = acc(0.9); line(ctx, gx, gy + gh * 0.5, gx + gw, gy + gh * 0.5); ctx.setLineDash([]);
  txt(ctx, '8.33 ms budget · 120 Hz', gx, gy + gh + 20, { s: 12, mono: true, c: C.ink4 });
  // right block
  const rx = W - 88;
  let label, value;
  if (t < 9.55) { label = 'UI ELEMENTS'; value = fmt(10000 * E.outCubic(inv(8.45, 9.2, t))); }
  else if (t < 10.7) { label = 'VIRTUALIZED ROWS'; value = '100,000'; }
  else { label = 'LAYOUT · TAFFY'; value = `${(0.18 + 0.05 * hash(Math.floor(t * 20))).toFixed(2)} ms`; }
  txt(ctx, label, rx, y + 1, { s: 13, mono: true, c: C.ink3, ls: 3, a: 'right' });
  txt(ctx, value, rx, y + 62, { s: 76, mono: true, w: 500, c: C.ink, ls: -2, a: 'right' });
  const sub = t < 9.55 ? 'retained · incremental' : t < 10.7 ? `${fmt(listScroll(t))} / 100,000` : 'native resize · live reflow';
  txt(ctx, sub, rx, y + 118, { s: 14, mono: true, c: C.accentHi, a: 'right' });
  // bottom
  txt(ctx, 'dropped frames  0', x, H - 96, { s: 14, mono: true, c: C.ink3 });
  txt(ctx, 'renderer  d3d11 · vsync off', x, H - 72, { s: 14, mono: true, c: C.ink4 });
  txt(ctx, 'input → pixels  < 1 frame', rx, H - 96, { s: 14, mono: true, c: C.ink3, a: 'right' });
  txt(ctx, 'idle cpu  0%  · no polling', rx, H - 72, { s: 14, mono: true, c: C.ink4, a: 'right' });
  ctx.restore();
}

// VirtualList + resize window
const ADJ = ['Async', 'Native', 'Retained', 'Vector', 'Layout', 'Glyph', 'Frame', 'Signal', 'Shader', 'Buffer', 'Portal', 'Cursor', 'Atlas', 'Scene'];
const NOUN = ['Pipeline', 'Surface', 'Node', 'Batch', 'Viewport', 'Tree', 'Queue', 'Handle', 'Layer', 'Region', 'Stream', 'Cache', 'Commit'];
const LIST_TARGET = 84216;
const listScroll = t => LIST_TARGET * E.inOutQuint(inv(9.72, 10.62, t));
function listSize(t) {
  let w = 660, h = 620;
  w = lerp(w, 1240, E.outExpo(inv(10.74, 11.1, t)));
  w = lerp(w, 820, E.inOutCubic(inv(11.14, 11.4, t)));
  w = lerp(w, 1060, E.outExpo(inv(11.42, 11.66, t)));
  h = 620 + 50 * E.outExpo(inv(10.74, 11.1, t)) - 70 * E.inOutCubic(inv(11.14, 11.4, t)) + 30 * E.outExpo(inv(11.42, 11.66, t));
  return { w, h };
}
const LIST_LEFT = -330;
function cardLayout(ww, i) {
  const avail = ww - 400 - 32, gap = 14, minW = 150;
  const cols = Math.max(1, Math.floor((avail + gap) / (minW + gap)));
  const cw = (avail - (cols - 1) * gap) / cols;
  const c = i % cols, r = Math.floor(i / cols);
  return [400 + 16 + c * (cw + gap), 104 + r * (124 + gap), cw, 124];
}
function cardSmooth(t, i) {
  const acc4 = [0, 0, 0, 0]; let wt = 0;
  for (let k = 0; k < 14; k++) {
    const tk = t - 0.018 * (i % 6) - k * 0.02;
    const L = cardLayout(listSize(tk).w, i), wk = Math.exp(-k * 0.3);
    for (let j = 0; j < 4; j++) acc4[j] += L[j] * wk;
    wt += wk;
  }
  return acc4.map(v => v / wt);
}
function paintList(g, u, t, win) {
  const { w, h } = listSize(t);
  win.cw = w; win.ch = h;
  const wire = E.inOutCubic(inv(11.72, 11.86, t));
  chrome(g, w, h, u);
  g.globalAlpha = 1 - wire * 0.85;
  titlebar(g, w, u, 'Tarve · VirtualList');
  const gm = E.outExpo(inv(10.74, 11.05, t));
  // header
  const segX = 16, segW = 170;
  g.fillStyle = wht(0.05); rr(g, segX, 54, segW, 32, 8); g.fill();
  g.fillStyle = wht(0.12); rr(g, segX + 3 + gm * (segW / 2 - 3), 57, segW / 2 - 3, 26, 6); g.fill();
  txt(g, 'List', segX + segW / 4 + 1, 70.5, { s: 12.5, w: 500, c: gm < 0.5 ? C.ink : C.ink3, a: 'center' });
  txt(g, 'Grid', segX + segW * 0.75 - 1, 70.5, { s: 12.5, w: 500, c: gm >= 0.5 ? C.ink : C.ink3, a: 'center' });
  const rendered = 14;
  txt(g, `measured · ${rendered} of 100,000 rendered`, w - 18, 70.5, { s: 11.5, mono: true, c: C.ink3, a: 'right' });
  g.fillStyle = C.line; g.fillRect(0, 96, w, 1);
  // rows
  const listW = lerp(w, 400, gm);
  const top = 97, rh = 48, viewH = h - top - 30;
  const pos = listScroll(t);
  const first = Math.floor(pos), off = (pos - first) * rh;
  g.save(); g.beginPath(); g.rect(0, top, listW, viewH); g.clip();
  for (let k = 0; k <= Math.ceil(viewH / rh) + 1; k++) {
    const i = first + k, y = top + k * rh - off;
    const yc = y + rh / 2;
    if (i === LIST_TARGET + 2 && t > 10.55) {
      const a = E.outCubic(inv(10.55, 10.7, t));
      g.fillStyle = acc(0.16 * a); g.fillRect(0, y, listW, rh);
      g.fillStyle = acc(a); g.fillRect(0, y + 10, 2.5, rh - 20);
    }
    txt(g, `#${String(i).padStart(6, '0')}`, 18, yc, { s: 11.5, mono: true, c: C.ink4 });
    const hue = hashInt(i * 3.1, 5);
    g.fillStyle = hue === 0 ? acc(0.9) : wht(0.1 + hue * 0.03); g.beginPath(); g.arc(106, yc, 14, 0, 7); g.fill();
    txt(g, ADJ[hashInt(i, ADJ.length)][0] + NOUN[hashInt(i * 7 + 3, NOUN.length)][0], 106, yc + 0.5, { s: 10.5, w: 600, c: hue === 0 ? '#fff' : C.ink2, a: 'center' });
    txt(g, `${ADJ[hashInt(i, ADJ.length)]} ${NOUN[hashInt(i * 7 + 3, NOUN.length)]}`, 132, yc - 8, { s: 13.5, w: 500, c: C.ink });
    txt(g, `node ${(i * 2654435761 % 0xffffff).toString(16).padStart(6, '0')} · ${(0.05 + hash(i) * 0.4).toFixed(2)} ms`, 132, yc + 10, { s: 10.5, mono: true, c: C.ink4 });
    if (listW > 560) {
      g.fillStyle = wht(0.08); rr(g, listW - 150, yc - 3, 100, 6, 3); g.fill();
      g.fillStyle = hue === 0 ? C.accent : wht(0.4); rr(g, listW - 150, yc - 3, 100 * hash(i * 1.9), 6, 3); g.fill();
    }
    g.fillStyle = wht(0.05); g.fillRect(16, y + rh - 1, listW - 32, 1);
  }
  g.restore();
  // scrollbar
  const thumbY = top + 4 + (viewH - 36) * (pos / 100000);
  const sa = 0.3 + 0.6 * bump(t, 9.7, 10.7);
  g.fillStyle = wht(sa); rr(g, listW - 8, thumbY, 4, 28, 2); g.fill();
  // grid side
  if (gm > 0) {
    g.fillStyle = C.line; g.fillRect(listW, top, 1, viewH);
    g.save(); g.beginPath(); g.rect(listW + 1, top, w - listW - 1, viewH); g.clip();
    for (let i = 0; i < 12; i++) {
      const [x, y, cw, ch] = cardSmooth(t, i);
      const ca = E.outExpo(inv(10.8 + i * 0.02, 11.1 + i * 0.02, t));
      if (ca <= 0) continue;
      g.save(); g.globalAlpha *= ca;
      g.fillStyle = wht(0.035); rr(g, x, y + (1 - ca) * 20, cw, ch, 10); g.fill();
      g.strokeStyle = C.line; rr(g, x + 0.5, y + 0.5 + (1 - ca) * 20, cw - 1, ch - 1, 10); g.stroke();
      const th = 64, gr = g.createLinearGradient(x, y, x + cw, y + th);
      gr.addColorStop(0, i % 4 === 1 ? acc(0.5) : wht(0.09)); gr.addColorStop(1, wht(0.02));
      g.fillStyle = gr; rr(g, x + 8, y + 8 + (1 - ca) * 20, cw - 16, th - 8, 6); g.fill();
      g.strokeStyle = wht(0.3); g.lineWidth = 1.2;
      g.beginPath(); g.arc(x + 26, y + 34 + (1 - ca) * 20, 9, 0, 7); g.stroke();
      txt(g, ['Dialog', 'Sidebar', 'Tabs', 'Table', 'Slider', 'Toast', 'Select', 'Tree', 'Menu', 'Card', 'Sheet', 'Chart'][i], x + 10, y + th + 20, { s: 12.5, w: 500, c: C.ink });
      txt(g, `${(hash(i * 5.3) * 0.2 + 0.03).toFixed(2)} ms`, x + 10, y + th + 40, { s: 10.5, mono: true, c: C.ink4 });
      g.restore();
    }
    g.restore();
  }
  // footer
  g.fillStyle = C.line; g.fillRect(0, h - 30, w, 1);
  txt(g, `row ${fmt(pos)} of 100,000`, 16, h - 15, { s: 11, mono: true, c: C.ink3 });
  txt(g, 'scroll  7.9 ms / frame', w - 16, h - 15, { s: 11, mono: true, c: C.ink3, a: 'right' });
  g.globalAlpha = 1;
  // wireframe collapse state
  if (wire > 0) {
    g.strokeStyle = accHi(0.8 * wire); g.lineWidth = 1;
    for (let k = 0; k < 12; k++) g.strokeRect(16.5, 97.5 + k * 48, listW - 33, 40);
    if (gm > 0) for (let i = 0; i < 12; i++) { const [x, y, cw, ch] = cardSmooth(t, i); g.strokeRect(x + 0.5, y + 0.5, cw, ch); }
  }
  // resize edge highlight
  const drag = inv(10.7, 10.74, t) * (1 - inv(11.66, 11.72, t));
  chromeEnd(g, w, h, u, t, 12, 0.3);
  if (drag > 0) { g.fillStyle = acc(drag); g.fillRect(w - 2, 20, 2, h - 40); }
}
const listWin = new Win({ w: 660, h: 620, maxW: 1260, maxH: 700, x: 0, y: 20, z: 0, enter: 9.45, R: 1.5, paint: paintList, float: 0, mode: 'custom', shadow: true, glow: 0.6, tag: '<VirtualList>' });
listWin.world = (t, p) => {
  const { w } = listSize(t);
  const e = E.outExpo(inv(9.45, 10.2, t));
  return { x: LIST_LEFT + w / 2, y: 20 + (1 - e) * 120, z: (1 - e) * 2400, ry: (1 - e) * -0.3 };
};
function listCam(t) {
  const lag = listSize(t - 0.12).w;
  return { x: LIST_LEFT + lag / 2, y: 0, z: 0 };
}
function scenePerf(ctx, t) {
  if (t < PERF_T0 || t >= 12.25) return;
  const tunA = E.outCubic(inv(PERF_T0, PERF_T0 + 0.25, t)) * lerp(1, 0.4, E.inOutCubic(inv(9.4, 9.9, t))) * (1 - E.inOutCubic(inv(11.72, 12.2, t)));
  drawTunnel(ctx, t, tunA);
  if (t >= listWin.enter && t < 12.05) {
    const cam = listCam(t);
    const P = winScreen(listWin, t, cam);
    if (P) {
      listWin.render(t);
      P.alpha = E.outCubic(inv(9.45, 9.7, t)) * (1 - inv(11.86, 12.02, t));
      drawWin(ctx, listWin, P, t, 0, 1);
      // resize cursor + dimension badge
      if (t > 10.55 && t < 11.8) {
        const { w, h } = listSize(t);
        const pt = localToScreen(listWin, P, w, h * 0.55);
        const ca = E.outCubic(inv(10.55, 10.68, t)) * (1 - inv(11.7, 11.8, t));
        const ptc = t < 10.7 ? { x: lerp(pt.x + 160, pt.x, E.inOutCubic(inv(10.55, 10.7, t))), y: lerp(pt.y + 80, pt.y, E.inOutCubic(inv(10.55, 10.7, t))) } : pt;
        ctx.save(); ctx.globalAlpha = ca; ctx.translate(ptc.x, ptc.y);
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(-16, 0); ctx.lineTo(-8, -7); ctx.lineTo(-8, -3); ctx.lineTo(8, -3); ctx.lineTo(8, -7); ctx.lineTo(16, 0); ctx.lineTo(8, 7); ctx.lineTo(8, 3); ctx.lineTo(-8, 3); ctx.lineTo(-8, 7); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = C.accent; rr(ctx, 24, 14, 132, 30, 15); ctx.fill();
        txt(ctx, `${Math.round(w)} × ${Math.round(h)}`, 90, 29.5, { s: 14, mono: true, w: 500, c: '#fff', a: 'center' });
        ctx.restore();
      }
    }
  }
  drawHUD(ctx, t);
}

// ================================================================ SCENE 5 — collapse + hero
const HERO = { size: 250, weight: 700, ls: 22, base: 528 };
let WORD_CV = null, WORD_PTS = [];
const N_PART = 2600;
const PARTS = [];
function buildWordmark() {
  WORD_CV = document.createElement('canvas'); WORD_CV.width = W; WORD_CV.height = H;
  const g = WORD_CV.getContext('2d');
  font(g, HERO.size, HERO.weight, false, HERO.ls);
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  const gr = g.createLinearGradient(0, HERO.base - 190, 0, HERO.base);
  gr.addColorStop(0, '#FFFFFF'); gr.addColorStop(0.5, '#E9E9EE'); gr.addColorStop(1, '#8E909C');
  g.fillStyle = gr;
  g.fillText('TARVE', W / 2 + HERO.ls / 2, HERO.base);
  const img = g.getImageData(0, 0, W, H).data;
  const pts = [];
  for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) if (img[(y * W + x) * 4 + 3] > 140) pts.push([x, y]);
  WORD_PTS = pts;
  for (let i = 0; i < N_PART; i++) {
    const tgt = pts[Math.floor(hash(i * 1.618 + 0.5) * pts.length)];
    const fromWin = hash(i * 2.2) < 0.72;
    const sx = fromWin ? W / 2 + (hash(i * 3.3) - 0.5) * 1060 : hash(i * 4.4) * W;
    const sy = fromWin ? H / 2 + 20 + (hash(i * 5.5) - 0.5) * 640 : hash(i * 6.6) * H;
    const mx = (sx + tgt[0]) / 2, my = (sy + tgt[1]) / 2;
    const dx = tgt[0] - sx, dy = tgt[1] - sy;
    const bend = (hash(i * 7.7) - 0.5) * 1.3;
    PARTS.push({ sx, sy, tx: tgt[0], ty: tgt[1], cx: mx - dy * bend, cy: my + dx * bend, d: hash(i * 8.8) * 0.26, dur: 0.6 + hash(i * 9.9) * 0.2, acc: hash(i * 11.1) < 0.14, sz: 1.6 + hash(i * 12.3) * 2.8, shard: hash(i * 13.1) < 0.25 });
  }
}
const COL_T0 = 11.8, FORM_T = 12.8;
function sceneCollapse(ctx, t) {
  if (t < COL_T0 || t > FORM_T + 0.25) return;
  const fade = 1 - inv(FORM_T, FORM_T + 0.2, t);
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const p of PARTS) {
    const q0 = inv(COL_T0 + p.d, COL_T0 + p.d + p.dur, t);
    if (q0 <= 0) continue;
    const q = E.inOutCubic(q0);
    const x = (1 - q) * (1 - q) * p.sx + 2 * (1 - q) * q * p.cx + q * q * p.tx;
    const y = (1 - q) * (1 - q) * p.sy + 2 * (1 - q) * q * p.cy + q * q * p.ty;
    const a = fade * E.outCubic(inv(0, 0.1, q0)) * (0.55 + 0.45 * q);
    ctx.fillStyle = p.acc ? accHi(a) : wht(a * 0.9);
    const s = lerp(p.sz * (p.shard ? 2.6 : 1.2), 2.2, q);
    ctx.fillRect(x - s / 2, y - (p.shard ? s / 4 : s / 2), s, p.shard ? s / 2 : s);
  }
  ctx.restore();
  // converging glow
  const g = E.inCubic(inv(12.3, FORM_T, t)) * fade;
  if (g > 0) {
    const rg = ctx.createRadialGradient(W / 2, 450, 0, W / 2, 450, 700);
    rg.addColorStop(0, acc(0.22 * g)); rg.addColorStop(1, acc(0));
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  }
}

let SHEEN_CV = null;
function sceneHero(ctx, t) {
  if (t < FORM_T - 0.05) return;
  const u = t - FORM_T;
  const push = lerp(1.045, 1, E.outCubic(inv(0, 1.9, u)));
  ctx.save();
  ctx.translate(W / 2, H / 2); ctx.scale(push, push); ctx.translate(-W / 2, -H / 2);
  // stage: floor grid + horizon
  const st = E.outCubic(inv(0.1, 0.9, u));
  const cam = { x: 0, y: -120, z: 0 };
  drawFloor(ctx, cam, t, 520, st * 0.9);
  const bg = ctx.createRadialGradient(W / 2, 470, 0, W / 2, 470, 900);
  bg.addColorStop(0, acc(0.14 * st)); bg.addColorStop(1, acc(0));
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  // wordmark
  const wa = E.outCubic(inv(-0.05, 0.18, u));
  ctx.globalAlpha = wa;
  ctx.drawImage(WORD_CV, 0, 0);
  ctx.globalAlpha = 1;
  // specular sweep
  const sk = inv(0.3, 1.25, u);
  if (sk > 0 && sk < 1) {
    const g = SHEEN_CV.getContext('2d');
    g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, W, H);
    g.drawImage(WORD_CV, 0, 0);
    g.globalCompositeOperation = 'source-in';
    const x = lerp(400, 1600, E.inOutCubic(sk));
    const gr = g.createLinearGradient(x - 180, 0, x + 180, 0);
    gr.addColorStop(0, wht(0)); gr.addColorStop(0.5, 'rgba(210,228,255,0.95)'); gr.addColorStop(1, wht(0));
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(SHEEN_CV, 0, 0); ctx.globalCompositeOperation = 'source-over';
  }
  // horizon light under the wordmark
  const hl = E.outExpo(inv(0.05, 0.8, u));
  const hg = ctx.createLinearGradient(W / 2 - 520 * hl, 0, W / 2 + 520 * hl, 0);
  hg.addColorStop(0, acc(0)); hg.addColorStop(0.5, accHi(0.9)); hg.addColorStop(1, acc(0));
  ctx.fillStyle = hg; ctx.fillRect(W / 2 - 520 * hl, 574, 1040 * hl, 1.5);
  // tagline
  const words = [['Native', C.ink3], ['UI.', C.ink3], ['TypeScript', C.ink], ['velocity.', C.ink]];
  font(ctx, 46, 500, false, -0.8);
  const sp = ctx.measureText(' ').width;
  const widths = words.map(([s]) => ctx.measureText(s).width);
  let x = W / 2 - (widths.reduce((a, b) => a + b, 0) + sp * 3) / 2;
  words.forEach(([s, c], i) => {
    const p = E.outExpo(inv(0.3 + i * 0.07, 0.9 + i * 0.07, u));
    ctx.globalAlpha = p;
    txt(ctx, s, x, 668 + (1 - p) * 26, { s: 46, w: 500, c, ls: -0.8 });
    x += widths[i] + sp;
  });
  ctx.globalAlpha = 1;
  // install pill
  const pp = E.outExpo(inv(0.75, 1.35, u));
  if (pp > 0) {
    const pw = 400 * pp, ph = 68, px = W / 2 - pw / 2, py = 772;
    ctx.fillStyle = wht(0.035); rr(ctx, px, py, pw, ph, ph / 2); ctx.fill();
    ctx.strokeStyle = wht(0.16); ctx.lineWidth = 1.2; rr(ctx, px + 0.5, py + 0.5, pw - 1, ph - 1, ph / 2); ctx.stroke();
    const tg = ctx.createLinearGradient(px, 0, px + pw, 0); tg.addColorStop(0, accHi(0)); tg.addColorStop(0.5, accHi(0.6)); tg.addColorStop(1, accHi(0));
    ctx.strokeStyle = tg; line(ctx, px + 30, py + 0.5, px + pw - 30, py + 0.5);
    ctx.save(); rr(ctx, px, py, pw, ph, ph / 2); ctx.clip();
    const n = Math.floor(clamp((u - 0.95) / 0.3) * CMD.length + 0.0001);
    font(ctx, 30, 500, true); const cw = ctx.measureText('M').width;
    const tx = W / 2 - (CMD.length * cw + 30) / 2 + 30;
    ctx.globalAlpha = inv(0.85, 1.0, u);
    txt(ctx, '$', tx - 30, py + ph / 2 + 1, { s: 30, mono: true, c: C.accentHi, w: 500 });
    ctx.globalAlpha = 1;
    for (let i = 0; i < n; i++) txt(ctx, CMD[i], tx + i * cw, py + ph / 2 + 1, { s: 30, mono: true, w: i >= 8 ? 600 : 500, c: i < 3 ? C.ink : i < 8 ? C.ink3 : '#fff' });
    if (u > 0.95 && (u < 1.4 || (u * 1.8) % 1 < 0.55)) { ctx.fillStyle = C.accentHi; ctx.fillRect(tx + n * cw + 4, py + ph / 2 - 16, 14, 32); }
    ctx.restore();
  }
  // footer
  const fa = E.outCubic(inv(1.2, 1.6, u));
  ctx.globalAlpha = fa;
  txt(ctx, 'NATIVE DESKTOP UI FOR BUN + TSX      ·      TAFFY  ·  PARLEY  ·  VELLO      ·      APACHE-2.0', W / 2, 994, { s: 13, mono: true, c: C.ink4, a: 'center', ls: 3 });
  ctx.globalAlpha = 1;
  ctx.restore();
  // formation flash + anamorphic streak
  const fk = Math.exp(-Math.max(0, u) * 7) * (u >= -0.02 ? 1 : 0);
  if (fk > 0.01) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const sg = ctx.createLinearGradient(0, 0, W, 0);
    sg.addColorStop(0, accHi(0)); sg.addColorStop(0.5, wht(0.95 * fk)); sg.addColorStop(1, accHi(0));
    ctx.fillStyle = sg; ctx.fillRect(0, 438, W, 3);
    ctx.globalAlpha = 0.3; ctx.fillRect(0, 425, W, 30); ctx.globalAlpha = 1;
    const rg = ctx.createRadialGradient(W / 2, 440, 0, W / 2, 440, 1000);
    rg.addColorStop(0, wht(0.5 * fk)); rg.addColorStop(0.3, acc(0.3 * fk)); rg.addColorStop(1, acc(0));
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}

// ================================================================ frame + post
function cutFlash(ctx, t, t0, amt = 0.5, decay = 26) {
  const u = t - t0; if (u < 0 || u > 0.25) return;
  ctx.fillStyle = wht(amt * Math.exp(-u * decay)); ctx.fillRect(0, 0, W, H);
}
function drawFrame(ctx, t) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  sceneTerminal(ctx, t);
  sceneUI(ctx, t);
  sceneTech(ctx, t);
  scenePerf(ctx, t);
  sceneCollapse(ctx, t);
  sceneHero(ctx, t);
  cutFlash(ctx, t, TECH_T0, 0.3, 34);
  for (let i = 1; i < WORDS.length; i++) cutFlash(ctx, t, TECH_T0 + i * SLOT, 0.1, 40);
  cutFlash(ctx, t, STACK_T0, 0.12, 40);
}

const out = document.getElementById('out');
const octx = out.getContext('2d');
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const frameCv = mk(W, H), fctx = frameCv.getContext('2d');
const accCv = mk(W, H), actx = accCv.getContext('2d');
const bloomA = mk(W / 4, H / 4), bA = bloomA.getContext('2d');
const bloomB = mk(W / 8, H / 8), bB = bloomB.getContext('2d');
const grain = [];
const vignette = mk(W, H);
function buildPost() {
  const v = vignette.getContext('2d');
  const g = v.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 1.05);
  g.addColorStop(0, blk(0)); g.addColorStop(1, blk(0.72));
  v.fillStyle = g; v.fillRect(0, 0, W, H);
  for (let k = 0; k < 6; k++) {
    const c = mk(256, 256), g2 = c.getContext('2d'), id = g2.createImageData(256, 256);
    for (let i = 0; i < 256 * 256; i++) { const n = hash(i * 0.917 + k * 7919.3) * 255; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = n; id.data[i * 4 + 3] = 255; }
    g2.putImageData(id, 0, 0); grain.push(c);
  }
}
function renderFrame(t, samples = 1, shutter = 0.5) {
  if (samples <= 1) drawFrame(actx, t);
  else {
    actx.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = 0; i < samples; i++) {
      const ts = t + ((i + 0.5) / samples - 0.5) * shutter / FPS;
      drawFrame(fctx, clamp(ts, 0, DURATION - 1e-4));
      actx.globalAlpha = 1 / (i + 1); actx.globalCompositeOperation = 'source-over';
      actx.drawImage(frameCv, 0, 0);
    }
    actx.globalAlpha = 1;
  }
  // post: bloom
  octx.setTransform(1, 0, 0, 1, 0, 0); octx.globalAlpha = 1; octx.globalCompositeOperation = 'source-over'; octx.filter = 'none';
  octx.drawImage(accCv, 0, 0);
  bA.filter = 'brightness(0.85) contrast(2.4) blur(6px)'; bA.clearRect(0, 0, W / 4, H / 4); bA.drawImage(accCv, 0, 0, W / 4, H / 4); bA.filter = 'none';
  bB.filter = 'blur(10px)'; bB.clearRect(0, 0, W / 8, H / 8); bB.drawImage(bloomA, 0, 0, W / 8, H / 8); bB.filter = 'none';
  octx.globalCompositeOperation = 'lighter';
  const bg = lerp(1, 0.62, E.inOutCubic(inv(13.0, 14.2, t)));
  octx.globalAlpha = 0.42 * bg; octx.drawImage(bloomA, 0, 0, W, H);
  octx.globalAlpha = 0.38 * bg; octx.drawImage(bloomB, 0, 0, W, H);
  octx.globalCompositeOperation = 'source-over';
  octx.globalAlpha = 1; octx.drawImage(vignette, 0, 0);
  // grain
  const gi = Math.floor(t * FPS) % grain.length;
  octx.globalCompositeOperation = 'overlay'; octx.globalAlpha = 0.07;
  const pat = octx.createPattern(grain[gi], 'repeat');
  octx.fillStyle = pat; octx.save(); octx.translate(hash(t * 13) * 256, hash(t * 17) * 256); octx.fillRect(-256, -256, W + 512, H + 512); octx.restore();
  octx.globalCompositeOperation = 'lighter'; octx.globalAlpha = 0.018; octx.fillStyle = pat; octx.fillRect(0, 0, W, H);
  octx.globalAlpha = 1; octx.globalCompositeOperation = 'source-over';
}

const ready = (async () => {
  await Promise.all([
    document.fonts.load(`700 40px "Geist"`), document.fonts.load(`500 40px "Geist"`), document.fonts.load(`400 40px "Geist"`),
    document.fonts.load(`400 40px "Geist Mono"`), document.fonts.load(`500 40px "Geist Mono"`),
  ]);
  await document.fonts.ready;
  font(fctx, 13, 400, true); CW13 = fctx.measureText('M').width;
  CODE_TARGET.lx = 58 + CW13 * (CODE[0].slice(0, 12).reduce((a, [s]) => a + s.length, 0) + 3.5);
  CODE_TARGET.ly = 66;
  SHEEN_CV = mk(W, H);
  buildWordmark();
  buildPost();
})();

window.TARVE = { ready, renderFrame, W, H, FPS, DURATION };

// ---------------------------------------------------------------- live preview
const params = new URLSearchParams(location.search);
if (params.has('render')) { document.body.classList.add('render'); return; }
const still = params.get('t');
let playing = still == null, start = performance.now() - (Number(still) || 0) * 1000, cur = Number(still) || 0;
const samples = Number(params.get('samples') || 1);
const fill = document.getElementById('fill'), timeEl = document.getElementById('time'), playEl = document.getElementById('play');
function tick(now) {
  if (playing) { cur = ((now - start) / 1000) % DURATION; }
  renderFrame(cur, samples);
  fill.style.width = `${(cur / DURATION) * 100}%`; timeEl.textContent = `${cur.toFixed(2)}s`; playEl.textContent = playing ? '❚❚' : '▶';
  requestAnimationFrame(tick);
}
function seek(tt) { cur = clamp(tt, 0, DURATION - 0.001); start = performance.now() - cur * 1000; }
document.getElementById('track').addEventListener('click', e => { const r = e.currentTarget.getBoundingClientRect(); seek((e.clientX - r.left) / r.width * DURATION); });
addEventListener('keydown', e => {
  if (e.code === 'Space') { playing = !playing; seek(cur); }
  if (e.code === 'ArrowRight') seek(cur + (e.shiftKey ? 1 : 1 / FPS));
  if (e.code === 'ArrowLeft') seek(cur - (e.shiftKey ? 1 : 1 / FPS));
});
ready.then(() => requestAnimationFrame(tick));
})();
