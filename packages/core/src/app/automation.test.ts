import { describe, expect, test } from "bun:test";
import type { NodeSnapshot, Snapshot } from "../protocol";
import { findByText, parseAutomationScript, readAutomation } from "./automation";

describe("command-line automation", () => {
  test("parses steps and normalizes key names", () => {
    expect(parseAutomationScript("click:Tasks; type:Hi there ;key:enter;wait:50;capture:a.png")).toEqual([
      { kind: "click", text: "Tasks" },
      { kind: "type", text: "Hi there " },
      { kind: "key", key: "Enter" },
      { kind: "wait", ms: 50 },
      { kind: "capture", path: "a.png" },
    ]);
    expect(parseAutomationScript("key:F5")).toEqual([{ kind: "key", key: "F5" }]);
    expect(() => parseAutomationScript("tap:x")).toThrow("unknown step");
    expect(() => parseAutomationScript("wait:soon")).toThrow("milliseconds");
  });

  test("reads flags before environment and stays off without them", () => {
    expect(readAutomation(["app.exe"], {})).toBeUndefined();
    expect(readAutomation(["app.exe", "--tarve-snapshot=shot.png", "--tarve-script=key:tab"], { TARVE_SNAPSHOT: "env.png" }))
      .toEqual({ steps: [{ kind: "key", key: "Tab" }], snapshot: "shot.png", keep: false });
    expect(readAutomation([], { TARVE_INSPECT: "tree.json", TARVE_KEEP: "1" })).toEqual({ steps: [], inspect: "tree.json", keep: true });
  });

  test("clicks the smallest exact match, then a substring", () => {
    const node = (id: string, text: string, width: number, height = 20): NodeSnapshot => ({ id, text, width, height, x: 0, y: 0 }) as unknown as NodeSnapshot;
    const snapshot = { nodes: [node("row", "Tasks", 400), node("button", "Tasks", 80), node("hidden", "Tasks", 0), node("other", "Open tasks list", 50)] } as unknown as Snapshot;
    expect(findByText(snapshot, "Tasks")?.id).toBe("button");
    expect(findByText(snapshot, "tasks list")?.id).toBe("other");
    expect(findByText(snapshot, "missing")).toBeUndefined();
  });
});
