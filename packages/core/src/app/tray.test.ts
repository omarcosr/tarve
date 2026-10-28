import { describe, expect, test } from "bun:test";
import type { NativeCommand } from "../protocol";
import { createTrayController } from "./tray";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function harness(appIcon: () => string | undefined = () => undefined) {
  const sent: Extract<NativeCommand, { type: "tray" }>[] = [];
  const trays = createTrayController(appIcon, command => { sent.push(command); });
  return { trays, sent };
}

describe("createTrayController", () => {
  test("converts the menu, sends the icon once and routes item handlers", () => {
    const { trays, sent } = harness();
    const picked: string[] = [];
    trays.tray({ icon: PNG, tooltip: "Player", menu: [
      { id: "play", label: "Play", onSelect: () => { picked.push("play"); } },
      { type: "separator" },
      { id: "more", label: "More", items: [{ id: "quit", label: "Quit", checked: true }] },
    ] });
    expect(sent).toHaveLength(1);
    const first = sent[0]!.tray!;
    expect(first.tooltip).toBe("Player");
    expect(typeof first.iconData).toBe("string");
    expect(first.menu).toEqual([
      { id: "play", label: "Play" },
      { separator: true },
      { label: "More", items: [{ id: "quit", label: "Quit", checked: true }] },
    ]);
    trays.menuHandler("play")!();
    expect(picked).toEqual(["play"]);
    expect(trays.menuHandler("quit")).toBeUndefined();
    expect(trays.options()?.tooltip).toBe("Player");
  });

  test("update merges options and resends the icon only when it changes", () => {
    const { trays, sent } = harness();
    const handle = trays.tray({ icon: PNG, tooltip: "A" });
    handle.update({ tooltip: "B" });
    expect(sent[1]!.tray).toMatchObject({ tooltip: "B" });
    expect("iconData" in sent[1]!.tray!).toBe(false);
    handle.update({ icon: undefined });
    expect(sent[2]!.tray).not.toHaveProperty("iconData");
    expect(trays.options()).toMatchObject({ tooltip: "B" });
  });

  test("falls back to the app icon", () => {
    const { trays, sent } = harness(() => PNG);
    trays.tray({ tooltip: "x" });
    expect(typeof sent[0]!.tray!.iconData).toBe("string");
  });

  test("a replaced tray ignores the old handle; remove clears the shell icon", () => {
    const { trays, sent } = harness();
    const first = trays.tray({ tooltip: "first" });
    const second = trays.tray({ tooltip: "second" });
    first.update({ tooltip: "stale" });
    first.remove();
    expect(trays.options()?.tooltip).toBe("second");
    expect(sent).toHaveLength(2);
    second.remove();
    expect(sent[2]).toEqual({ type: "tray", tray: null });
    expect(trays.options()).toBeUndefined();
    expect(trays.menuHandler("anything")).toBeUndefined();
  });

  test("availability is a state: onAvailability on each change, kept for a replacing tray, cleared by remove", async () => {
    const { trays } = harness();
    const seen: unknown[] = [];
    const run = (_name: string, handler: (() => void) | undefined) => { handler?.(); return !!handler; };
    const first = trays.tray({ onAvailability: state => seen.push(state) });
    expect(first.availability()).toBeUndefined();
    const missing = { type: "trayAvailability", supported: true, available: false, reason: "no system tray host is running" } as const;
    expect(trays.dispatch(missing, run)).toBe(true);
    expect(trays.dispatch(missing, run)).toBe(false);
    expect(first.availability()).toEqual({ supported: true, available: false, reason: "no system tray host is running" });
    expect(trays.dispatch({ type: "trayAvailability", supported: true, available: true }, run)).toBe(true);
    expect(seen).toEqual([{ supported: true, available: false, reason: "no system tray host is running" }, { supported: true, available: true }]);
    const replaced: unknown[] = [];
    const second = trays.tray({ onAvailability: state => replaced.push(state) });
    await Promise.resolve();
    expect(replaced).toEqual([{ supported: true, available: true }]);
    expect(first.availability()).toBeUndefined();
    second.remove();
    expect(second.availability()).toBeUndefined();
    expect(trays.tray({}).availability()).toBeUndefined();
  });

  test("rejects menu items without an id or with a duplicate id", () => {
    const { trays } = harness();
    expect(() => trays.tray({ menu: [{ id: "", label: "x" }] })).toThrow(TypeError);
    expect(() => trays.tray({ menu: [{ id: "a", label: "x" }, { id: "a", label: "y" }] })).toThrow('duplicate tray menu id "a"');
  });
});
