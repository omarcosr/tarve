import { describe, expect, test } from "bun:test";
import type { NativeCommand, NativeEvent, SceneDocument } from "./protocol";
import { createApp } from "./app";
import type { NativeBridge } from "./bridge";
import { Input, Pressable, Text, TextArea, Window } from "./components";

class FakeBridge implements NativeBridge {
  commands: NativeCommand[] = [];
  document?: SceneDocument;
  start(document: SceneDocument, onEvent: (event: NativeEvent) => void): void { this.document = document; onEvent({ type: "ready" }); }
  send(command: NativeCommand): void { this.commands.push(command); }
  join(): void {}
  focuses(): string[] { return this.commands.filter(command => command.type === "focus").map(command => (command as { id: string }).id); }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("autoFocus", () => {
  test("focuses a control once when it appears, again only after it went away", async () => {
    const bridge = new FakeBridge();
    let open = false;
    let label = "a";
    const app = createApp(() => (
      <Window>
        <Input id="search" autoFocus />
        {open ? <TextArea id="note" autoFocus value={label} /> : <Text>closed</Text>}
      </Window>
    ), { bridge });
    await app.ready;
    expect(bridge.focuses()).toEqual(["search"]);
    open = true; app.update(); await tick();
    expect(bridge.focuses()).toEqual(["search", "note"]);
    label = "b"; app.update(); await tick();
    expect(bridge.focuses()).toEqual(["search", "note"]);
    open = false; app.update(); await tick();
    open = true; app.update(); await tick();
    expect(bridge.focuses()).toEqual(["search", "note", "note"]);
    expect(JSON.stringify(bridge.document)).not.toContain("autoFocus");
    app.close();
  });

  test("Pressable takes it; disabled or unfocusable controls do not", async () => {
    const bridge = new FakeBridge();
    const app = createApp(() => (
      <Window>
        <Pressable id="pane" autoFocus><Text>terminal</Text></Pressable>
        <Input id="off" autoFocus disabled />
        <Pressable id="skip" autoFocus focusable={false}><Text>x</Text></Pressable>
      </Window>
    ), { bridge });
    await app.ready;
    expect(bridge.focuses()).toEqual(["pane"]);
    app.close();
  });
});
