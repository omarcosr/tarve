import { describe, expect, test } from "bun:test";
import type { NativeCommand, NativeEvent, NativeStats, SceneDocument } from "../protocol";
import { createApp, type AppPerformance } from "../app";
import type { NativeBridge } from "../bridge";
import { Text, Window } from "../components";

const phase = { count: 3, p50: 1, p95: 2, p99: 3, max: 4 };
const native: NativeStats = {
  phases: { apply: phase, layout: phase, paint: phase, present: phase, frame: phase, gpu: phase, eventWait: phase },
  memory: null,
};

class StatsBridge implements NativeBridge {
  commands: NativeCommand[] = [];
  syncAnswers = true;
  private listener?: (event: NativeEvent) => void;
  start(_: SceneDocument, onEvent: (event: NativeEvent) => void): void {
    this.listener = onEvent;
    onEvent({ type: "ready" });
  }
  send(command: NativeCommand): void {
    this.commands.push(command);
    // Answer stats requests on the next turn, as the native thread does.
    if (command.type === "stats") queueMicrotask(() => this.emit({ type: "stats", requestId: command.requestId, stats: native }));
  }
  requestSync(command: NativeCommand & { requestId: string }): NativeEvent | undefined {
    return this.syncAnswers ? { type: "layout", requestId: command.requestId, boxes: {} } : undefined;
  }
  join(): void {}
  emit(event: NativeEvent): void { this.listener?.(event); }
}

describe("app.performance", () => {
  test("reads phases, counts events from the first reading and times sync requests", async () => {
    const bridge = new StatsBridge();
    const app = createApp(() => <Window><Text>x</Text></Window>, { bridge });
    await app.ready;
    bridge.emit({ type: "windowFocus", focused: true });
    const first = await app.performance();
    const request = bridge.commands.findLast(command => command.type === "stats");
    expect(request?.type === "stats" && request.reset).toBe(false);
    expect(first.native).toEqual(native.phases);
    expect(first.js.update.count).toBeGreaterThanOrEqual(0);
    // Counting starts with the reading: the focus event before it is not counted, its stats answer is.
    expect(first.events.byType).toEqual({ stats: 1 });
    bridge.emit({ type: "windowFocus", focused: false });
    bridge.emit({ type: "windowFocus", focused: true });
    app.layout(["root"]);
    bridge.syncAnswers = false;
    app.layout(["root"]);
    const second = await app.performance();
    expect(second.events.byType.windowFocus).toBe(2);
    expect(second.syncRequests.count).toBe(2);
    expect(second.syncRequests.timedOut).toBe(1);
    expect(second.syncRequests.maxMs).toBeGreaterThanOrEqual(0);
    expect(second.syncRequests.totalMs).toBeGreaterThanOrEqual(second.syncRequests.maxMs);
    app.close();
  });

  test("onPerformance reports on its interval until unsubscribed, without overlapping readings", async () => {
    const bridge = new StatsBridge();
    const app = createApp(() => <Window><Text>x</Text></Window>, { bridge });
    await app.ready;
    const readings: AppPerformance[] = [];
    const stop = app.onPerformance(reading => readings.push(reading), 10);
    await new Promise(resolve => setTimeout(resolve, 260));
    stop();
    const count = readings.length;
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(3);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(readings.length).toBe(count);
    expect(() => app.onPerformance(() => {}, Number.NaN)).toThrow(RangeError);
    app.close();
  });
});
