import type { PhaseSummary } from "../protocol";

/** Samples kept per phase, as on the native side. */
const CAPACITY = 600;

/** A ring of recent durations (ms) with nearest-rank percentiles. */
export class PhaseSamples {
  private readonly values = new Float64Array(CAPACITY);
  private size = 0;
  private next = 0;

  push(ms: number): void {
    this.values[this.next] = ms;
    this.next = (this.next + 1) % CAPACITY;
    if (this.size < CAPACITY) this.size++;
  }

  /** Runs `work` and records how long it took. */
  time<T>(work: () => T): T {
    const started = performance.now();
    try {
      return work();
    } finally {
      this.push(performance.now() - started);
    }
  }

  summary(): PhaseSummary {
    const sorted = this.values.slice(0, this.size).sort();
    const at = (q: number) => sorted.length === 0 ? 0 : round(sorted[Math.min(sorted.length, Math.max(1, Math.ceil(sorted.length * q))) - 1]!);
    return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.length === 0 ? 0 : round(sorted[sorted.length - 1]!) };
  }

  reset(): void {
    this.size = 0;
    this.next = 0;
  }
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}
