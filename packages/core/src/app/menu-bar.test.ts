import { describe, expect, test } from "bun:test";
import { createMenuBarController } from "./menu-bar";

function host() {
  const sent: unknown[] = [];
  const hotkeys = new Map<string, () => void>();
  const opened: (number | null)[] = [];
  let updates = 0;
  return {
    sent, hotkeys, opened, updates: () => updates,
    host: {
      send: (command: unknown) => sent.push(command),
      registerHotkey: (shortcut: string, handler: () => void) => { hotkeys.set(shortcut, handler); return () => hotkeys.delete(shortcut); },
      update: () => { updates++; },
      openMenu: (index: number | null) => opened.push(index),
    },
  };
}

describe("menu bar controller", () => {
  test("a drawn bar keeps handlers here and registers accelerators, F10 and access keys", () => {
    const h = host();
    const menus = createMenuBarController(h.host as never);
    const ran: string[] = [];
    menus.set([
      { label: "&File", items: [{ id: "save", label: "&Save", accelerator: "Ctrl+S", onSelect: () => ran.push("save") }, { type: "separator" }, { id: "off", label: "Off", disabled: true, accelerator: "Ctrl+O", onSelect: () => ran.push("off") }] },
      { label: "&Edit", items: [{ label: "Undo", onSelect: () => ran.push("undo") }] },
      { label: "Plain", onSelect: () => ran.push("plain") },
    ]);
    expect(h.sent).toEqual([]);
    expect(h.updates()).toBe(1);
    const drawn = menus.drawn()!;
    expect(JSON.stringify(drawn)).not.toContain("onSelect");
    expect((drawn[1] as { items: { id: string }[] }).items[0]!.id).toBe("menu-1");
    menus.handler("save")?.();
    menus.handler("menu-2")?.();
    h.hotkeys.get("Ctrl+S")?.();
    expect(ran).toEqual(["save", "plain", "save"]);
    expect(h.hotkeys.has("Ctrl+O")).toBe(false);
    h.hotkeys.get("F10")?.();
    h.hotkeys.get("Alt+E")?.();
    expect(h.opened).toEqual([null, 1]);
    menus.set(null);
    expect(menus.drawn()).toBeNull();
    expect(h.hotkeys.size).toBe(0);
    expect(() => menus.set([{ id: "a", label: "A" }, { id: "a", label: "B" }])).toThrow(/duplicate/);
  });

  test("native: true sends the Win32 menu and switching back removes it", () => {
    const h = host();
    const menus = createMenuBarController(h.host as never);
    menus.set([{ label: "&File", items: [{ id: "save", label: "&Save", accelerator: "Ctrl+S" }, { type: "separator" }] }], { native: true });
    expect(h.sent.at(-1)).toEqual({ type: "menuBar", menu: [{ label: "&File", items: [{ id: "save", label: "&Save", accelerator: "Ctrl+S" }, { separator: true }] }] });
    expect(menus.drawn()).toBeNull();
    expect(h.hotkeys.has("F10")).toBe(false);
    menus.set([{ id: "x", label: "X" }]);
    expect(h.sent.at(-1)).toEqual({ type: "menuBar", menu: null });
    expect(menus.drawn()).not.toBeNull();
  });
});
