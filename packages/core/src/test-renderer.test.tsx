import { describe, expect, test } from "bun:test";
import type { NativeCommand, NativeEvent, SceneDocument, Snapshot } from "../../protocol/src/index";
import { Button, Input, Text, Window } from "./components";
import type { NativeBridge } from "./bridge";
import { createTestRenderer, launchTestProcess, waitFor } from "./test-renderer";

function snapshot(): Snapshot {
  return {
    layoutNodes: 4,
    layoutNodesCreated: 4,
    measureCalls: 2,
    paintedNodes: 4,
    frames: 3,
    layouts: 1,
    shapes: 2,
    paints: 1,
    hovered: null,
    focused: null,
    width: 400,
    height: 240,
    scale: 1,
    nodes: [
      { id: "root", kind: "window", x: 0, y: 0, width: 400, height: 240, scroll: 0, scrollMax: 0, text: "" },
      { id: "save", kind: "button", x: 20, y: 20, width: 80, height: 32, scroll: 0, scrollMax: 0, text: "Save", control: { role: "button", label: "Save" } },
      { id: "name", kind: "input", x: 20, y: 70, width: 180, height: 32, scroll: 0, scrollMax: 0, text: "Ada", control: { role: "field", label: "Name" } },
      { id: "status", kind: "text", x: 20, y: 120, width: 120, height: 20, scroll: 0, scrollMax: 0, text: "Ready" },
    ],
  };
}

class AutomationBridge implements NativeBridge {
  commands: NativeCommand[] = [];
  document?: SceneDocument;
  current = snapshot();
  private listener?: (event: NativeEvent) => void;

  start(document: SceneDocument, onEvent: (event: NativeEvent) => void): void {
    this.document = document;
    this.listener = onEvent;
    onEvent({ type: "ready" });
  }

  send(command: NativeCommand): void {
    this.commands.push(command);
    if (command.type === "inspect") {
      this.listener?.({ type: "inspect", requestId: command.requestId, snapshot: this.current });
    } else if (command.type === "capture") {
      this.listener?.({ type: "captured", requestId: command.requestId, path: command.path });
    }
  }

  join(): void {}
}

describe("public TestRenderer automation", () => {
  test("queries by id, text and semantic role and rejects ambiguous locators", async () => {
    const bridge = new AutomationBridge();
    const renderer = await createTestRenderer(
      () => <Window><Button id="save">Save</Button><Input id="name" value="Ada"/><Text id="status">Ready</Text></Window>,
      { bridge, headless: true },
    );
    expect(bridge.document?.window.visible).toBe(false);
    expect((await renderer.getById("save").node()).text).toBe("Save");
    expect((await renderer.getByText("Ready").node()).id).toBe("status");
    expect((await renderer.getByRole("button", { name: "Save" }).node()).id).toBe("save");
    await expect(renderer.locator(() => true, "any node").node()).rejects.toThrow("Multiple nodes matched");
    await expect(renderer.getById("missing").node()).rejects.toThrow("No node matched");
    renderer.close();
  });

  test("click, fill, press, wheel and drag use diagnostic native input", async () => {
    const bridge = new AutomationBridge();
    const renderer = await createTestRenderer(() => <Window />, { bridge });
    bridge.commands.length = 0;

    await renderer.getById("save").click();
    await renderer.getById("name").fill("Grace");
    await renderer.getById("save").press("Enter");
    await renderer.getById("status").wheel({ deltaY: 120, deltaX: 4 });
    await renderer.getById("save").dragTo(renderer.getById("status"));

    expect(bridge.commands.filter(command => command.type === "input").map(command => command.action)).toEqual([
      "move", "down", "up",
      "key", "key", "text",
      "key",
      "move", "wheel",
      "move", "down", "move", "up",
    ]);
    expect(bridge.commands.filter(command => command.type === "focus").map(command => command.id)).toEqual(["name", "save"]);
    renderer.close();
  });

  test("waitFor and locator waitFor observe later snapshots", async () => {
    const bridge = new AutomationBridge();
    const renderer = await createTestRenderer(() => <Window />, { bridge });
    let attempts = 0;
    const value = await waitFor(() => (++attempts >= 3 ? "done" : false), { interval: 0, timeout: 100 });
    expect(value).toBe("done");

    bridge.current = { ...bridge.current, nodes: bridge.current.nodes.filter(node => node.id !== "status") };
    queueMicrotask(() => { bridge.current = snapshot(); });
    expect((await renderer.getById("status").waitFor({ interval: 0, timeout: 100 })).text).toBe("Ready");
    renderer.close();
  });

  test("zero-interval waitFor yields to timers", async () => {
    let ready = false;
    setTimeout(() => { ready = true; }, 0);
    await expect(waitFor(() => ready || false, { interval: 0, timeout: 250 })).resolves.toBe(true);
  });

  test("launchTestProcess exposes requested output pipes", async () => {
    const child = launchTestProcess({
      command: [process.execPath, "-e", "console.log('renderer-ready')"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.stdout).toBeDefined();
    expect(child.stderr).toBeDefined();
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(output.trim()).toBe("renderer-ready");
  });
});
