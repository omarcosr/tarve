import { expect, test } from "bun:test";
import { PhaseSamples } from "./stats";

test("phase samples report nearest-rank percentiles over the most recent 600", () => {
  const samples = new PhaseSamples();
  expect(samples.summary()).toEqual({ count: 0, p50: 0, p95: 0, p99: 0, max: 0 });
  for (let ms = 1; ms <= 100; ms++) samples.push(ms);
  expect(samples.summary()).toEqual({ count: 100, p50: 50, p95: 95, p99: 99, max: 100 });
  for (let i = 0; i < 600; i++) samples.push(1);
  expect(samples.summary()).toEqual({ count: 600, p50: 1, p95: 1, p99: 1, max: 1 });
  samples.reset();
  expect(samples.summary().count).toBe(0);
});

test("time records the duration even when the work throws", () => {
  const samples = new PhaseSamples();
  expect(samples.time(() => 7)).toBe(7);
  expect(() => samples.time(() => { throw new Error("boom"); })).toThrow("boom");
  expect(samples.summary().count).toBe(2);
});
