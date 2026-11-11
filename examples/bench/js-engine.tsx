// Pure JavaScript kernels, no Tarve calls in the timed part: compares the engines themselves
// (Bun/JavaScriptCore, Node/V8, QuickJS-ng in txiki.js and in the Android runtime).
// Desktop: bun examples/bench/js-engine.tsx · Android: build it as an APK, read `adb logcat -s tarve`.
import { Text, Window, createApp } from "@tarve/core";

const kernels: Record<string, () => unknown> = {
  "int loop": () => { let s = 0; for (let i = 0; i < 3_000_000; i++) s = (s + i * 7) | 0; return s; },
  "float math": () => { let s = 0; for (let i = 0; i < 1_000_000; i++) s += Math.sqrt(i) * Math.sin(i); return s; },
  "calls": () => { const f = (a: number, b: number) => a + b; let s = 0; for (let i = 0; i < 1_000_000; i++) s = f(s, i) % 1e9; return s; },
  "object alloc": () => { let s = 0; for (let i = 0; i < 300_000; i++) { const o = { x: i, y: i + 1, z: { w: i } }; s += o.x + o.z.w; } return s; },
  "spread props": () => { const base = { a: 1, b: 2, c: 3, d: 4 }; let s = 0; for (let i = 0; i < 200_000; i++) { const o = { ...base, e: i, ...(i & 1 ? { f: 1 } : {}) }; s += o.e; } return s; },
  "array push/map": () => { const a: number[] = []; for (let i = 0; i < 300_000; i++) a.push(i); return a.map(x => x * 2).filter(x => x % 3 === 0).length; },
  "sort": () => { const a = Array.from({ length: 100_000 }, (_, i) => (i * 7919) % 100_003); a.sort((x, y) => x - y); return a[0]; },
  "Map/Set": () => { const m = new Map<string, number>(); for (let i = 0; i < 100_000; i++) m.set("k" + i, i); let s = 0; for (const [, v] of m) s += v; const set = new Set(m.keys()); return s + set.size; },
  "string build": () => { let s = ""; for (let i = 0; i < 100_000; i++) s += "row " + i + ";"; return s.length; },
  "JSON": () => { const o = Array.from({ length: 5_000 }, (_, i) => ({ id: i, name: "item " + i, tags: ["a", "b"], v: i / 3 })); return JSON.parse(JSON.stringify(o)).length; },
  "for-in keys": () => { const o = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }; let s = 0; for (let i = 0; i < 100_000; i++) for (const k in o) s += (o as Record<string, number>)[k]!; return s; },
  "closures": () => { let s = 0; for (let i = 0; i < 300_000; i++) { const g = () => i; s += g(); } return s; },
};

const results: Record<string, number> = {};
for (const [name, run] of Object.entries(kernels)) {
  run();
  const times: number[] = [];
  for (let i = 0; i < 5; i++) { const t = performance.now(); run(); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  results[name] = Math.round(times[2]! * 100) / 100;
}
results.total = Math.round(Object.values(results).reduce((a, b) => a + b, 0) * 10) / 10;
console.log("@engine " + JSON.stringify(results));

const app = createApp(() => <Window title="js-engine"><Text>{JSON.stringify(results, null, 1)}</Text></Window>);
await app.ready;
if (typeof process !== "undefined" && process.env.TARVE_ENGINE_STAY !== "1") setTimeout(() => app.close(), 500);
