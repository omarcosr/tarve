import { describe, expect, test } from "bun:test";
import { normalizeHotkey } from "./hotkeys";

describe("hotkeys", () => {
  test("normalizes aliases and modifier ordering", () => {
    expect(normalizeHotkey("shift+control+s")).toBe("Ctrl+Shift+S");
    expect(normalizeHotkey("cmd+option+f2")).toBe("Alt+Meta+F2");
    expect(normalizeHotkey("esc")).toBe("Escape");
    expect(() => normalizeHotkey("ctrl++")).toThrow(TypeError);
  });

  test("rejects ambiguous or modifier-only shortcuts", () => {
    expect(() => normalizeHotkey("Ctrl+Ctrl+S")).toThrow(TypeError);
    expect(() => normalizeHotkey("Ctrl")).toThrow(TypeError);
    expect(() => normalizeHotkey("Ctrl+Save")).toThrow(TypeError);
  });
});
