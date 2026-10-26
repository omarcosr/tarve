import type { NativeCommand, NativeTrayMenuItem } from "../protocol";
import type { HotkeyHandler } from "../hotkeys";
import { accessKey, type MenuBarItem } from "../menu-bar";
import { TitleBar } from "../components/titlebar";
import { Window } from "../components/window";
import type { Child, VNode } from "../jsx-runtime";

export type { MenuBarItem } from "../menu-bar";

export interface MenuBarOptions {
  /**
   * The system menu bar instead of the one drawn in the theme: a Win32 menu on Windows
   * (a framed window, light only). Other systems report an error for now.
   */
  native?: boolean;
}

export interface MenuBarController {
  set(items: readonly MenuBarItem[] | null, options?: MenuBarOptions): void;
  /** `onSelect` of the item with this id. */
  handler(id: string): (() => void) | undefined;
  /** The items of the drawn menu bar (ids filled in, handlers kept here), or null. */
  drawn(): readonly MenuBarItem[] | null;
}

type MenuBarCommand = Extract<NativeCommand, { type: "menuBar" }>;

export interface MenuBarHost {
  send(command: MenuBarCommand): void;
  registerHotkey(shortcut: string, handler: HotkeyHandler): () => void;
  /** Re-render the window (the drawn bar changed or a menu opened). */
  update(): void;
  /** Open top-level menu `index` of the drawn bar and focus its first item; null focuses the bar. */
  openMenu(index: number | null): void;
}

export function createMenuBarController(host: MenuBarHost): MenuBarController {
  const handlers = new Map<string, () => void>();
  let unregister: Array<() => void> = [];
  let generated = 0;
  let drawn: MenuBarItem[] | null = null;
  let nativeShown = false;
  return {
    set(items, options = {}) {
      for (const dispose of unregister) dispose();
      unregister = [];
      handlers.clear();
      const seen = new Set<string>();
      const prepare = (list: readonly MenuBarItem[]): MenuBarItem[] => list.map(item => {
        if (item.type === "separator") return item;
        if (item.items?.length) {
          const { onSelect: _, ...rest } = item;
          return { ...rest, items: prepare(item.items) };
        }
        const id = item.id ?? `menu-${++generated}`;
        if (seen.has(id)) throw new TypeError(`duplicate menu bar id "${id}"`);
        seen.add(id);
        if (item.onSelect) {
          handlers.set(id, item.onSelect);
          if (item.accelerator && !item.disabled) unregister.push(host.registerHotkey(item.accelerator, item.onSelect));
        }
        const { onSelect: _, ...rest } = item;
        return { ...rest, id };
      });
      const prepared = items ? prepare(items) : null;
      if (options.native) {
        drawn = null;
        nativeShown = !!prepared;
        host.send({ type: "menuBar", menu: prepared ? toNative(prepared) : null });
      } else {
        if (nativeShown) host.send({ type: "menuBar", menu: null });
        nativeShown = false;
        drawn = prepared;
        if (prepared) {
          // F10 and Alt+<access key> reach the drawn bar, as they reach a system one.
          unregister.push(host.registerHotkey("F10", () => host.openMenu(null)));
          const used = new Set<string>();
          prepared.forEach((item, index) => {
            if (item.type === "separator" || item.disabled) return;
            const key = accessKey(item.label).key;
            if (!key || used.has(key) || !/^[A-Z0-9]$/.test(key)) return;
            used.add(key);
            unregister.push(host.registerHotkey(`Alt+${key}`, () => host.openMenu(index)));
          });
        }
      }
      host.update();
    },
    handler: id => handlers.get(id),
    drawn: () => drawn,
  };
}

function toNative(list: readonly MenuBarItem[]): NativeTrayMenuItem[] {
  return list.map(item => {
    if (item.type === "separator") return { separator: true };
    if (item.items?.length) return { label: item.label, ...(item.disabled ? { disabled: true } : {}), items: toNative(item.items) };
    return {
      id: item.id, label: item.label,
      ...(item.accelerator ? { accelerator: item.accelerator } : {}),
      ...(item.checked !== undefined ? { checked: item.checked } : {}),
      ...(item.disabled ? { disabled: true } : {}),
    };
  });
}

/** The view with the app's drawn menu bar at the top of its window, after a TitleBar. */
export function withMenuBar(view: VNode, bar: VNode): VNode {
  // The view is often a component that returns the Window (`() => <App />`): expand it.
  for (let depth = 0; typeof view.type === "function" && view.type !== Window && depth < 32; depth++) {
    const expanded = (view.type as (props: Record<string, unknown>) => unknown)(view.props);
    if (!expanded || typeof expanded !== "object" || Array.isArray(expanded)) return view;
    view = expanded as VNode;
  }
  if (view.type !== Window) return view;
  const raw = view.props.children;
  const children: Child[] = Array.isArray(raw) ? [...raw] : raw === undefined ? [] : [raw];
  const titleBar = children.findIndex(child => !!child && typeof child === "object" && !Array.isArray(child) && (child as VNode).type === TitleBar);
  children.splice(titleBar + 1, 0, bar);
  return { ...view, props: { ...view.props, children } };
}
