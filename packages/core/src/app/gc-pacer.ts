/**
 * Garbage collection paced to a sustained signal animation. Each frame of thousands of
 * bound nodes leaves strings and lists behind; between the engine's own collections they
 * pile up in its allocator (Bun's grew to ~60 MB animating 6000 nodes, ~25 MB when still).
 * A full collection once a second while that lasts keeps it near the still size, for a
 * pause of a few milliseconds on the app's thread (native keeps drawing meanwhile).
 */
import { createRequire } from "node:module";

const gc: ((sync: boolean) => void) | undefined = (globalThis as { Bun?: { gc?: (sync: boolean) => void } }).Bun?.gc;
/** Values set since the last collection, and when it ran. */
let pending = 0;
let lastCollect = 0;
let scheduled = false;
const INTERVAL_MS = 1000;
/** Fewer values than this a second (a clock, a few counters) leave too little to matter. */
const MIN_VALUES = 20_000;

/** Notes `values` set by one flush; collects when a second's worth of them is pending. */
export function noteFlushedValues(values: number): void {
  if (!gc) return;
  pending += values;
  if (scheduled || pending < MIN_VALUES) return;
  const now = performance.now();
  if (now - lastCollect < INTERVAL_MS) return;
  scheduled = true;
  // After the flush that triggered it has been sent, outside its microtask.
  setTimeout(() => {
    scheduled = false;
    lastCollect = performance.now();
    pending = 0;
    gc(true);
  }, 0);
}

let nodeGc: (() => void) | null | undefined;
/** V8's full collection on Node, exposed at run time; null where the host has none (txiki.js, QuickJS). */
function v8Gc(): (() => void) | null {
  if (nodeGc !== undefined) return nodeGc;
  nodeGc = null;
  if (!process.versions?.node || process.versions.bun) return nodeGc;
  try {
    const require = createRequire(import.meta.url);
    (require("node:v8") as typeof import("node:v8")).setFlagsFromString("--expose-gc");
    const collect: unknown = (require("node:vm") as typeof import("node:vm")).runInNewContext("gc");
    if (typeof collect === "function") nodeGc = collect as () => void;
  } catch {}
  return nodeGc;
}

let backgroundScheduled = false;
/**
 * A window went to the background: a full collection while nothing can be seen takes the
 * engine's heap down from its last peak, then `release` asks native to free those pages.
 * Windows hidden together share one collection.
 */
export function collectInBackground(release: () => void): void {
  if (backgroundScheduled) return;
  const collect = gc ? () => gc(true) : v8Gc();
  if (!collect) return;
  backgroundScheduled = true;
  // After the events delivered with this one, outside their dispatch.
  setTimeout(() => {
    backgroundScheduled = false;
    lastCollect = performance.now();
    pending = 0;
    try { collect(); } catch {}
    release();
  }, 0);
}
