import { describe, expect, test } from "bun:test";
import type { NativeCommand, NativeEvent, SceneDocument } from "./protocol";
import { createApp, type AppErrorEvent } from "./app";
import type { NativeBridge } from "./bridge";
import { Text, Window } from "./components";
import { TitleBar } from "./components/titlebar";
import { render } from "./app";
import { DEV_ERROR_DISMISS_ID } from "./dev-overlay";

class FakeBridge implements NativeBridge {
  commands: NativeCommand[] = [];
  starts = 0;
  joins = 0;
  document?: SceneDocument;
  startError?: Error;
  joinError?: Error;
  failNextSend?: Error;
  private listener?: (event: NativeEvent) => void;
  start(document: SceneDocument, onEvent: (event: NativeEvent) => void): void {
    this.starts++;
    if (this.startError) throw this.startError;
    this.document = document;
    this.listener = onEvent;
    onEvent({ type: "ready" });
  }
  send(command: NativeCommand): void {
    if (this.failNextSend) {
      const error = this.failNextSend;
      this.failNextSend = undefined;
      throw error;
    }
    this.commands.push(command);
  }
  join(): void {
    this.joins++;
    if (this.joinError) throw this.joinError;
  }
  emit(event: NativeEvent): void { this.listener?.(event); }
}

describe("development runtime tooling", () => {
  const texts = (bridge: FakeBridge): string => JSON.stringify(bridge.commands.at(-1));
  test("dev mode renders runtime errors in the same window and recovers on dismiss", async () => {
    const bridge = new FakeBridge();
    let broken = false;
    const errors: AppErrorEvent[] = [];
    const app = createApp(() => {
      if (broken) throw new Error("kaboom");
      return <Window title="App"><Text id="ok">fine</Text></Window>;
    }, { bridge, dev: true, onError: event => errors.push(event) });
    await app.ready;
    broken = true;
    app.update();
    await Bun.sleep(0);
    expect(errors.map(event => event.source)).toEqual(["render"]);
    expect(texts(bridge)).toContain("kaboom");
    expect(bridge.starts).toBe(1);
    broken = false;
    bridge.emit({ type: "click", id: DEV_ERROR_DISMISS_ID });
    await Bun.sleep(0);
    expect(texts(bridge)).not.toContain("kaboom");
    expect(texts(bridge)).toContain("fine");
    app.close();
  });

  test("dev overlay keeps undecorated windows closable", async () => {
    const bridge = new FakeBridge();
    let broken = false;
    const app = createApp(() => {
      if (broken) throw new Error("kaboom");
      return <Window><TitleBar title="Custom" /><Text>fine</Text></Window>;
    }, { bridge, dev: true, onError: () => {} });
    await app.ready;
    broken = true;
    app.update();
    await Bun.sleep(0);
    expect(texts(bridge)).toContain("kaboom");
    expect(texts(bridge)).toContain("\"windowAction\":\"close\"");
    app.close();
  });

  test("dev overlay stays off outside dev mode", async () => {
    const bridge = new FakeBridge();
    let broken = false;
    const app = createApp(() => {
      if (broken) throw new Error("kaboom");
      return <Window><Text>fine</Text></Window>;
    }, { bridge, dev: false, onError: () => {} });
    await app.ready;
    const sent = bridge.commands.length;
    broken = true;
    app.update();
    await Bun.sleep(0);
    expect(JSON.stringify(bridge.commands.slice(sent))).not.toContain("kaboom");
    app.close();
  });

  test("remount swaps the view in the same window and resets component state", async () => {
    const bridge = new FakeBridge();
    const app = createApp(() => <Window><Text>first</Text></Window>, { bridge });
    await app.ready;
    app.remount(() => <Window><Text>second</Text></Window>);
    await Bun.sleep(0);
    expect(bridge.starts).toBe(1);
    expect(texts(bridge)).toContain("second");
    app.close();
  });

  test("render() in dev mode reuses the open window on reload", async () => {
    const bridge = new FakeBridge();
    const first = render(() => <Window><Text>v1</Text></Window>, { bridge, dev: true });
    await Bun.sleep(0);
    const second = render(() => <Window><Text>v2</Text></Window>, { bridge: new FakeBridge(), dev: true });
    await Bun.sleep(0);
    expect(bridge.starts).toBe(1);
    expect(texts(bridge)).toContain("v2");
    const registry = globalThis as Record<symbol, unknown>;
    (registry[Symbol.for("tarve.devApp")] as { close(): void }).close();
    delete registry[Symbol.for("tarve.devApp")];
    void first; void second;
  });

  test("frame overlay is a native command, sent once on ready when enabled", async () => {
    const bridge = new FakeBridge();
    const app = createApp(() => <Window />, { bridge, frameOverlay: true });
    await app.ready;
    expect(bridge.commands.filter(command => command.type === "frameOverlay")).toEqual([{ type: "frameOverlay", enabled: true }]);
    app.setFrameOverlay(false);
    expect(bridge.commands.at(-1)).toEqual({ type: "frameOverlay", enabled: false });
    app.close();
  });

  test("maxFps and setMaxFps send the animation frame rate", async () => {
    const bridge = new FakeBridge();
    const app = createApp(() => <Window />, { bridge, maxFps: 30 });
    await app.ready;
    expect(bridge.commands.filter(command => command.type === "frameRate")).toEqual([{ type: "frameRate", maxFps: 30 }]);
    app.setMaxFps(null);
    expect(bridge.commands.at(-1)).toEqual({ type: "frameRate", maxFps: null });
    expect(() => app.setMaxFps(0)).toThrow(RangeError);
    app.close();
  });
});

