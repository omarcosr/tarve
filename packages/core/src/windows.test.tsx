import { describe, expect, test } from "bun:test";
import { Window, Text, Pressable } from "./components";
import { createApp } from "./app";
import type { NativeBridge } from "./bridge";
import type { NativeCommand, NativeEvent, SceneDocument } from "./protocol";

class FakeBridge implements NativeBridge {
  commands: NativeCommand[] = [];
  onEvent!: (event: NativeEvent) => void;
  start(_document: SceneDocument, onEvent: (event: NativeEvent) => void): void { this.onEvent = onEvent; onEvent({ type: "ready" }); }
  send(command: NativeCommand): void { this.commands.push(command); }
  join(): void {}
  emit(event: NativeEvent & { window?: string }): void { this.onEvent(event); }
}

describe("app.openWindow", () => {
  test("a second window opens with its own document, commands and events", async () => {
    const bridge = new FakeBridge();
    const app = createApp(() => <Window title="Main"><Text>main</Text></Window>, { bridge });
    await app.ready;
    let clicks = 0;
    const child = app.openWindow(() => (
      <Window title="Settings" width={300} height={200}>
        <Pressable id="go" onClick={() => { clicks++; }}><Text>go</Text></Pressable>
      </Window>
    ), { id: "settings" });
    const open = bridge.commands.find(command => command.type === "openWindow");
    expect(open).toMatchObject({ type: "openWindow", window: "settings", document: { window: { title: "Settings", width: 300 } } });
    bridge.emit({ type: "ready", window: "settings" });
    await child.ready;
    // Its events reach its own handlers, not the main window's.
    const seen: string[] = [];
    app.onEvent(event => seen.push(event.type));
    bridge.emit({ type: "click", id: "go", window: "settings" });
    expect(clicks).toBe(1);
    expect(seen).toEqual([]);
    // Its commands go to it.
    child.close();
    expect(bridge.commands.at(-1)).toEqual({ type: "toWindow", window: "settings", command: { type: "close" } });
    bridge.emit({ type: "closed", window: "settings" });
    await child.closed;
    // The main window is still running and can open the id again.
    const again = app.openWindow(() => <Window><Text>x</Text></Window>, { id: "settings" });
    expect(() => app.openWindow(() => <Window><Text>x</Text></Window>, { id: "settings" })).toThrow(/already open/);
    bridge.emit({ type: "ready", window: "settings" });
    await again.ready;
    // Closing the main window closes the others.
    bridge.emit({ type: "closed" });
    await app.closed;
    await again.closed;
  });

  test("a window native refuses fails its ready instead of waiting", async () => {
    const bridge = new FakeBridge();
    const app = createApp(() => <Window><Text>main</Text></Window>, { bridge });
    await app.ready;
    const errors: string[] = [];
    const child = app.openWindow(() => <Window><Text>x</Text></Window>, { id: "raced", onError: event => errors.push(event.error.message) });
    bridge.emit({ type: "error", message: "window 'raced' is already open", window: "raced" });
    bridge.emit({ type: "closed", window: "raced" });
    await expect(child.ready).rejects.toThrow(/already open/);
    await child.closed;
    expect(errors.some(message => /already open/.test(message))).toBe(true);
    bridge.emit({ type: "closed" });
    await app.closed;
  });
});
