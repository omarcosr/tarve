import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySavedState, WindowStateStore } from "./window-state";
import type { WindowOptions } from "./protocol";

const window: WindowOptions = { title: "x", width: 800, height: 600, minWidth: 400, minHeight: 300, background: "#fff", decorations: true, resizable: true, position: "center" };

describe("window state", () => {
  test("a saved state sets size, position and maximized, kept within the minimum", () => {
    expect(applySavedState(window, undefined)).toEqual({ ...window, reportWindowState: true });
    expect(applySavedState(window, { x: 10, y: 20, width: 200, height: 900, maximized: true }))
      .toMatchObject({ width: 400, height: 900, position: { x: 10, y: 20 }, maximized: true, reportWindowState: true });
    expect(applySavedState({ ...window, desktopWidget: { columns: 2, rows: 2 } }, { x: 1, y: 1, width: 500, height: 500, maximized: false }).position).toBe("center");
  });

  test("the store writes after a pause, on flush, and ignores bad entries", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tarve-state-")), "nested", "window-state.json");
    const store = new WindowStateStore(path);
    store.set("main", { x: 1, y: 2, width: 300, height: 200, maximized: false });
    store.set("bad", { x: Number.NaN, y: 0, width: 1, height: 1, maximized: false });
    store.flush();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ main: { x: 1, y: 2, width: 300, height: 200, maximized: false } });
    writeFileSync(path, JSON.stringify({ main: { x: 5, y: 5, width: 0, height: 10, maximized: false }, other: { x: 5, y: 6, width: 7, height: 8, maximized: true } }));
    const reread = new WindowStateStore(path);
    expect(reread.get("main")).toBeUndefined();
    expect(reread.get("other")).toEqual({ x: 5, y: 6, width: 7, height: 8, maximized: true });
    writeFileSync(path, "not json");
    expect(new WindowStateStore(path).get("other")).toBeUndefined();
  });
});
