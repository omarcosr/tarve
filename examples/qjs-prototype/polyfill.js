// Minimum a plain QuickJS context lacks for @tarve/core.
const timers = [];
let nextTimer = 1;
globalThis.setTimeout = (fn, ms = 0, ...args) => { const id = nextTimer++; timers.push({ id, at: Date.now() + ms, fn, args }); return id; };
globalThis.clearTimeout = id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); };
globalThis.setInterval = (fn, ms) => { const id = nextTimer++; const run = () => { fn(); timers.push({ id, at: Date.now() + ms, fn: run, args: [] }); }; timers.push({ id, at: Date.now() + ms, fn: run, args: [] }); return id; };
globalThis.clearInterval = globalThis.clearTimeout;
globalThis.queueMicrotask ??= fn => Promise.resolve().then(fn);
globalThis.__tick = () => { const now = Date.now(); for (let i = 0; i < timers.length; i++) if (timers[i].at <= now) { const t = timers.splice(i--, 1)[0]; t.fn(...t.args); } return timers.length; };
globalThis.performance ??= { now: () => Date.now() };
globalThis.process ??= { env: {}, platform: "win32", versions: {}, argv: [], cwd: () => "/", on() {}, off() {}, exit() {} };
globalThis.crypto ??= { randomUUID: () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => ((Math.random() * 16) | 0).toString(16)), getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; return a; } };
{ const log = (...a) => globalThis.__log?.(a.map(v => v instanceof Error ? v.name + ": " + v.message + "\n" + v.stack : typeof v === "object" ? JSON.stringify(v) : String(v)).join(" ")); globalThis.console = { log, warn: log, error: log, info: log, debug: log }; }
globalThis.structuredClone ??= v => JSON.parse(JSON.stringify(v));
