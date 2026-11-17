import type { NativeStats } from "../protocol";
import type { AppJsStats } from "./types";

/** Synchronous native requests (`app.layout()`, `app.textSelection()`): each blocks the JS thread. */
export interface SyncRequestStats {
  count: number;
  /** Requests that got no answer in time. */
  timedOut: number;
  /** Milliseconds the JS thread waited, in total and at most. */
  totalMs: number;
  maxMs: number;
}

/** One window's performance reading (`app.performance()`). */
export interface AppPerformance {
  /** JS update phases of this window, ms percentiles over the last 600 updates. */
  js: AppJsStats;
  /**
   * Native frame phases of this window (apply, layout, paint, present, frame, gpu, eventWait), ms
   * percentiles over the last 600 samples; null in the browser build.
   */
  native: NativeStats["phases"];
  /**
   * Native events this window received since performance was first read (`performance()` or
   * `onPerformance`), in total and by type. Counting starts there, so it costs nothing before.
   */
  events: { total: number; byType: Record<string, number> };
  syncRequests: SyncRequestStats;
}

export interface PerformanceMonitorOptions {
  jsStats: () => AppJsStats;
  nativeStats: () => Promise<NativeStats>;
  report: (error: unknown) => void;
}

const MIN_INTERVAL_MS = 100;

/**
 * Backs `app.performance()` and `app.onPerformance()` over samples the app keeps anyway (the
 * JS phase samples and the native stats request). Event counting starts with the first reading
 * and a reading runs only when asked for or on a listener's interval: no work per frame.
 */
export function createPerformanceMonitor(options: PerformanceMonitorOptions) {
  /** Undefined until performance is first read: `count` then is a single check per event. */
  let events: Map<string, number> | undefined;
  let total = 0;
  const sync: SyncRequestStats = { count: 0, timedOut: 0, totalMs: 0, maxMs: 0 };
  const timers = new Set<ReturnType<typeof setInterval>>();
  let disposed = false;

  async function read(): Promise<AppPerformance> {
    events ??= new Map();
    const native = await options.nativeStats();
    return {
      js: options.jsStats(),
      native: native.phases,
      events: { total, byType: Object.fromEntries(events) },
      syncRequests: { ...sync },
    };
  }

  return {
    count(type: string): void {
      if (!events) return;
      total++;
      events.set(type, (events.get(type) ?? 0) + 1);
    },
    /** Times one synchronous request; an undefined answer counts as timed out. */
    sync<T>(request: () => T): T {
      const started = performance.now();
      const answer = request();
      const elapsed = performance.now() - started;
      sync.count++;
      if (answer === undefined) sync.timedOut++;
      sync.totalMs += elapsed;
      if (elapsed > sync.maxMs) sync.maxMs = elapsed;
      return answer;
    },
    read,
    listen(listener: (reading: AppPerformance) => void, intervalMs = 1000): () => void {
      if (disposed) return () => {};
      if (typeof listener !== "function") throw new TypeError("onPerformance listener must be a function");
      if (!Number.isFinite(intervalMs)) throw new RangeError("onPerformance interval must be a finite number of milliseconds");
      events ??= new Map();
      let reading = false;
      const timer = setInterval(() => {
        // A slow native answer does not stack readings.
        if (reading) return;
        reading = true;
        read().then(listener).catch(options.report).finally(() => { reading = false; });
      }, Math.max(MIN_INTERVAL_MS, intervalMs));
      timers.add(timer);
      return () => {
        if (timers.delete(timer)) clearInterval(timer);
      };
    },
    dispose(): void {
      disposed = true;
      for (const timer of timers) clearInterval(timer);
      timers.clear();
    },
  };
}

export type PerformanceMonitor = ReturnType<typeof createPerformanceMonitor>;
