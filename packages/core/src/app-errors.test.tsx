import { describe, expect, test } from "bun:test";
import type { NativeCommand, NativeEvent, SceneDocument } from "./protocol";
import { createApp, type AppErrorEvent } from "./app";
import type { NativeBridge } from "./bridge";
import { Image, Text, Window } from "./components";

class FakeBridge implements NativeBridge {
  commands: NativeCommand[] = [];
  private listener?: (event: NativeEvent) => void;
  start(_document: SceneDocument, onEvent: (event: NativeEvent) => void): void {
    this.listener = onEvent;
    onEvent({ type: "ready" });
  }
  send(command: NativeCommand): void { this.commands.push(command); }
  join(): void {}
  emit(event: NativeEvent): void { this.listener?.(event); }
}

describe("app errors from native element events", () => {
  test("an image failure is the app's error only when the image has no onError", async () => {
    const bridge = new FakeBridge();
    const errors: AppErrorEvent[] = [];
    const heard: string[] = [];
    const app = createApp(() => (
      <Window>
        <Image id="handled" src="https://example.com/a.png" fallbackSrc="b.png" width={10} height={10} onError={event => heard.push(event.message)} />
        <Image id="bare" src="https://example.com/c.png" width={10} height={10} />
      </Window>
    ), { bridge, onError: event => errors.push(event) });
    await app.ready;
    bridge.emit({ type: "imageError", id: "handled", src: "https://example.com/a.png", message: "http status: 404" });
    await Bun.sleep(0);
    expect(heard).toEqual(["http status: 404"]);
    expect(errors).toEqual([]);
    bridge.emit({ type: "imageError", id: "bare", src: "https://example.com/c.png", message: "http status: 404" });
    await Bun.sleep(0);
    expect(errors.map(event => [event.source, event.event, event.targetId, event.error.message])).toEqual([["native", "imageError", "bare", "Image 'https://example.com/c.png': http status: 404"]]);
    app.close();
  });
});

describe("errors nothing caught", () => {
  test("with onError the app takes the process's unhandled rejections and uncaught exceptions until it closes", async () => {
    const bridge = new FakeBridge();
    const errors: AppErrorEvent[] = [];
    const before = [process.listenerCount("unhandledRejection"), process.listenerCount("uncaughtException")];
    const app = createApp(() => <Window><Text>hi</Text></Window>, { bridge, onError: event => errors.push(event) });
    await app.ready;
    expect(process.listenerCount("unhandledRejection")).toBe(before[0]! + 1);
    process.emit("unhandledRejection", new Error("lost promise"), Promise.resolve());
    process.emit("uncaughtException", new Error("thrown in a timer"), "uncaughtException");
    expect(errors.map(event => [event.source, event.event, event.error.message])).toEqual([
      ["process", "unhandledRejection", "lost promise"],
      ["process", "uncaughtException", "thrown in a timer"],
    ]);
    bridge.emit({ type: "closed" });
    await app.closed;
    expect([process.listenerCount("unhandledRejection"), process.listenerCount("uncaughtException")]).toEqual(before);
  });

  test("without onError the process keeps its own behaviour", async () => {
    const bridge = new FakeBridge();
    const before = process.listenerCount("unhandledRejection");
    const app = createApp(() => <Window><Text>hi</Text></Window>, { bridge });
    await app.ready;
    expect(process.listenerCount("unhandledRejection")).toBe(before);
    bridge.emit({ type: "closed" });
    await app.closed;
  });
});
