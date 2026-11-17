import { expect, test } from "bun:test";
import type { NativeCommand, NativeEvent, SceneDocument } from "../protocol";
import { createApp, type WindowFocusChange } from "../app";
import type { NativeBridge } from "../bridge";
import { Text, Window } from "../components";

class FocusBridge implements NativeBridge {
  private listener?: (event: NativeEvent) => void;
  start(_: SceneDocument, onEvent: (event: NativeEvent) => void): void {
    this.listener = onEvent;
    onEvent({ type: "ready" });
  }
  send(_: NativeCommand): void {}
  join(): void {}
  emit(event: NativeEvent): void { this.listener?.(event); }
}

test("onFocusChange says which window and node took the focus on blur", async () => {
  const bridge = new FocusBridge();
  const app = createApp(() => <Window><Text>menu</Text></Window>, { bridge });
  await app.ready;
  const changes: [boolean, WindowFocusChange][] = [];
  app.onFocusChange((focused, change) => changes.push([focused, change]));
  bridge.emit({ type: "windowFocus", focused: true });
  bridge.emit({ type: "windowFocus", focused: false, to: "dock", pointerTarget: "menu-anchor" });
  bridge.emit({ type: "windowFocus", focused: true });
  bridge.emit({ type: "windowFocus", focused: false });
  expect(changes).toEqual([
    [true, {}],
    [false, { to: "dock", pointerTarget: "menu-anchor" }],
    [true, {}],
    [false, {}],
  ]);
  app.close();
});
