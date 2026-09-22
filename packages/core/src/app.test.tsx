import { describe, expect, test } from "bun:test";
import type { NativeCommand, NativeEvent, SceneDocument } from "../../protocol/src/index";
import { createApp } from "./app";
import type { NativeBridge } from "./bridge";
import { Slider } from "./controls";
import { Input, Window } from "./components";
import { InputOTP } from "./form-controls";

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

describe("controlled native reconciliation", () => {
  test("reverts a native text edit when a controlled handler rejects it", async () => {
    const bridge = new FakeBridge();
    let value = "12";
    const app = createApp(() => (
      <Window><Input id="input" value={value} onChange={next => { if (/^\d*$/.test(next)) value = next; }} /></Window>
    ), { bridge });
    await app.ready;
    bridge.emit({ type: "change", id: "input", value: "12a" });
    await Bun.sleep(0);
    const patch = bridge.commands.find(command => command.type === "patch");
    expect(patch?.type).toBe("patch");
    if (patch?.type === "patch") expect(patch.nodes.find(node => node.id === "input")?.value).toBe("12");
  });

  test("reverts a native slider edit when controlled state stays unchanged", async () => {
    const bridge = new FakeBridge();
    let value = 20;
    const app = createApp(() => (
      <Window><Slider id="slider" value={value} onValueChange={next => { if (next <= 20) value = next; }} /></Window>
    ), { bridge });
    await app.ready;
    bridge.emit({ type: "valueChange", id: "slider", value: 21 });
    await Bun.sleep(0);
    const patch = bridge.commands.find(command => command.type === "patch");
    expect(patch?.type).toBe("patch");
    if (patch?.type === "patch") expect(patch.nodes.find(node => node.id === "slider")?.control?.value).toBe(20);
  });

  test("InputOTP filters native edits and patches rejected characters back out", async () => {
    const bridge = new FakeBridge();
    let value = "1234";
    const app = createApp(() => (
      <Window><InputOTP id="otp" value={value} length={4} onValueChange={next => { value = next; }} /></Window>
    ), { bridge });
    await app.ready;
    bridge.emit({ type: "change", id: "otp-input", value: "1234x" });
    await Bun.sleep(0);
    expect(value).toBe("1234");
    const patch = bridge.commands.find(command => command.type === "patch");
    expect(patch?.type).toBe("patch");
    if (patch?.type === "patch") expect(patch.nodes.find(node => node.id === "otp-input")?.value).toBe("1234");
  });
});
