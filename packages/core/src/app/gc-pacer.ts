/**
 * Garbage collection paced to a sustained signal animation. Each frame of thousands of
 * bound nodes leaves strings and lists behind; between the engine's own collections they
 * pile up in its allocator (Bun's grew to ~60 MB animating 6000 nodes, ~25 MB when still).
 * A full collection once a second while that lasts keeps it near the still size, for a
 * pause of a few milliseconds on the app's thread (native keeps drawing meanwhile).
 */
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
