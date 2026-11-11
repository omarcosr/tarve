import { afterEach, describe, expect, test } from "bun:test";
import type { NativeCommand, NativeEvent, SceneDocument } from "./protocol";
import { createApp } from "./app";
import type { NativeBridge } from "./bridge";
import { Text, Window } from "./components";
import { activeToasts, dismissToast, toast, TOASTER_ID } from "./toast";

class FakeBridge implements NativeBridge {
  documents: SceneDocument[] = [];
  commands: NativeCommand[] = [];
  private listener?: (event: NativeEvent) => void;
  start(document: SceneDocument, onEvent: (event: NativeEvent) => void): void {
    this.documents.push(document);
    this.listener = onEvent;
    onEvent({ type: "ready" });
  }
  send(command: NativeCommand): void { this.commands.push(command); }
  join(): void {}
  emit(event: NativeEvent): void { this.listener?.(event); }
}

const sent = (bridge: FakeBridge) => JSON.stringify([bridge.documents, bridge.commands]);
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

afterEach(() => { for (const item of [...activeToasts()]) dismissToast(item.id); });

describe("toast()", () => {
  test("shows over the app's window, updates in place and dismisses itself", async () => {
    const bridge = new FakeBridge();
    const app = createApp(() => <Window><Text>body</Text></Window>, { bridge });
    await app.ready;
    expect(sent(bridge)).not.toContain(TOASTER_ID);
    const saved = toast("Saved", { tone: "ok", duration: 20 });
    await tick();
    expect(sent(bridge)).toContain(TOASTER_ID);
    expect(sent(bridge)).toContain("Saved");
    toast("Copying 1/3", { id: "copy", duration: null });
    toast("Copying 2/3", { id: "copy", duration: null });
    expect(activeToasts().map(item => item.title)).toEqual(["Saved", "Copying 2/3"]);
    expect(activeToasts()[0]!.variant).toBe("success");
    await tick(40);
    expect(activeToasts().map(item => item.id)).toEqual(["copy"]);
    dismissToast("copy");
    saved.dismiss();
    expect(activeToasts()).toEqual([]);
    bridge.emit({ type: "closed" });
    await app.closed;
  });

  test("an action dismisses its toast; bad input throws", () => {
    let pressed = 0;
    toast("Deleted", { tone: "error", action: { label: "Undo", onClick: () => { pressed++; } } });
    activeToasts()[0]!.action!.onClick();
    expect(pressed).toBe(1);
    expect(activeToasts()).toEqual([]);
    expect(() => toast("x", { duration: -1 })).toThrow("duration");
    expect(() => toast("x", { tone: "loud" as never })).toThrow("tone");
  });
});
