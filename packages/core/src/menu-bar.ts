import { jsx, type BaseProps, type Child, type VNode } from "./jsx-runtime";
import { Column, Icon, Pressable, Row, Text, View } from "./components";
import { theme } from "./theme";
import { currentRenderScope, scopedState } from "./render-scope";
import type { Style } from "./protocol";

const c = theme.colors;
const POPUP_Z_INDEX = 1000;
const ACTIVE_APP_KEY = Symbol.for("tarve.activeApp");

/**
 * An item of a menu bar (`<AppMenuBar>` or `app.menuBar`). Top-level items with `items`
 * are the bar's menus (`&File`; `&` marks the Alt access key, `&&` a literal `&`).
 * `accelerator` (`Ctrl+S`) is shown next to the label; `app.menuBar` also registers it
 * as a hotkey that runs `onSelect`.
 */
export type MenuBarItem =
  | { type: "separator" }
  | { type?: "item"; id?: string; label: string; accelerator?: string; checked?: boolean; disabled?: boolean; onSelect?: () => void; items?: MenuBarItem[] };

type Entry = Exclude<MenuBarItem, { type: "separator" }>;

export interface AppMenuBarProps extends BaseProps {
  items: readonly MenuBarItem[];
  /** After an item's own `onSelect`, with its id (`menu-<n>` when it has none). */
  onSelect?: (id: string) => void;
}

/** Which menu (and submenu) of a menu bar is open, per render scope. */
interface MenuBarState { open: number | null; sub: number | null }
const STATES = Symbol("tarve.menuBar");

export function menuBarState(id: string, scope: object = currentRenderScope()): MenuBarState {
  const states = scopedState(STATES, () => new Map<string, MenuBarState>(), scope);
  let state = states.get(id);
  if (!state) states.set(id, state = { open: null, sub: null });
  return state;
}

/** The label without its access-key marker, and the access key. */
export function accessKey(label: string): { text: string; key?: string } {
  let key: string | undefined;
  const text = label.replace(/&(&|.)/g, (_, next: string) => {
    if (next === "&") return "&";
    key ??= next.toUpperCase();
    return next;
  });
  return { text, ...(key ? { key } : {}) };
}

function focus(id: string): void {
  const app = (globalThis as Record<symbol, { focus?(id: string): void } | undefined>)[ACTIVE_APP_KEY];
  app?.focus?.(id);
}

function entries(items: readonly MenuBarItem[]): Array<{ item: MenuBarItem; index: number }> {
  return items.map((item, index) => ({ item, index }));
}

const itemStyle: Style = {
  minHeight: 30, padding: { left: 8, right: 10 }, direction: "row", align: "center", justify: "between", gap: 24,
  radius: theme.radius.sm, background: "#00000000", hover: { background: c.muted }, focus: { background: c.muted },
};

/**
 * A menu bar drawn by the app, in the theme: the same on every system, in a framed or
 * frameless window, or inside a `TitleBar`. Arrow keys move along the bar and through a
 * menu, Enter/Space choose, Escape closes; menus open on click and follow the pointer
 * while one is open, like a system menu bar. `app.menuBar(items)` places one at the top
 * of the window (after a `TitleBar`) and adds Alt access keys, F10 and accelerators.
 */
export function AppMenuBar({ id = "menubar", items, onSelect, style, ...props }: AppMenuBarProps): VNode {
  const state = menuBarState(id);
  const close = () => { state.open = null; state.sub = null; };
  const tops = entries(items).filter(({ item }) => item.type !== "separator") as Array<{ item: Entry; index: number }>;
  const openAt = (position: number, focusFirst: boolean) => {
    const next = tops[(position + tops.length) % tops.length];
    if (!next) return;
    if (!next.item.items?.length) { close(); focus(`${id}-menu-${next.index}`); return; }
    state.open = next.index;
    state.sub = null;
    if (focusFirst) {
      const first = entries(next.item.items).find(({ item }) => item.type !== "separator" && !item.disabled);
      if (first) setTimeout(() => focus(`${id}-item-${next.index}-${first.index}`), 0);
    } else focus(`${id}-menu-${next.index}`);
  };
  const choose = (item: Entry, fallback: string) => {
    close();
    item.onSelect?.();
    onSelect?.(item.id ?? fallback);
  };
  const menuEntries = (list: readonly MenuBarItem[], path: string, top: number, nested: boolean): Child[] => entries(list).map(({ item, index }) => {
    if (item.type === "separator") {
      return jsx(View, { style: { height: 1, margin: { top: 4, bottom: 4, left: 6, right: 6 }, background: c.border } }, `sep-${index}`);
    }
    const itemId = `${id}-item-${path}-${index}`;
    const label = accessKey(item.label).text;
    const submenu = !!item.items?.length;
    const subOpen = submenu && !nested && state.sub === index;
    const position = tops.findIndex(entry => entry.index === top);
    return jsx(View, {
      style: { position: "relative" },
      children: [
        jsx(Pressable, {
          id: itemId,
          disabled: item.disabled,
          control: { role: "menuitem", label, ...(item.checked !== undefined ? { checked: item.checked } : {}), ...(submenu ? { expanded: subOpen } : {}) },
          onClick: item.disabled ? undefined : () => {
            if (submenu) { state.sub = index; return; }
            choose(item, item.id ?? itemId);
          },
          onHover: (entered: boolean) => { if (entered && !nested) state.sub = submenu ? index : null; },
          onKeyDown: (key: string) => {
            if (key === "ArrowRight" && submenu && !nested) { state.sub = index; return; }
            if (key === "ArrowLeft" && nested) { state.sub = null; focus(`${id}-item-${top}-${path.split("-").at(-1)}`); return; }
            if (key === "ArrowRight") openAt(position + 1, true);
            else if (key === "ArrowLeft") openAt(position - 1, true);
          },
          style: { ...itemStyle, disabled: { foreground: c.disabledForeground } },
          children: [
            jsx(Row, {
              gap: 8,
              style: { align: "center" },
              children: [
                item.checked ? jsx(Icon, { name: "check", size: 14 }) : jsx(View, { style: { width: 14 } }),
                jsx(Text, { size: 13, color: item.disabled ? c.disabledForeground : c.foreground, children: label }),
              ],
            }),
            submenu
              ? jsx(Icon, { name: "chevron-right", size: 13, color: c.mutedForeground })
              : item.accelerator ? jsx(Text, { size: 12, color: c.mutedForeground, children: item.accelerator }) : null,
          ],
        }),
        subOpen ? popup(`${id}-submenu-${top}-${index}`, { top: -5, left: "100%" }, menuEntries(item.items!, `${path}-${index}`, top, true), false) : null,
      ],
    }, `item-${index}`);
  });
  // The menu's surface: a portal over the window (a submenu is drawn inside its menu's).
  const popup = (popupId: string, at: Style, children: Child[], portal = true) => jsx(Column, {
    id: popupId,
    portal,
    control: { role: "navigation", orientation: "vertical" },
    style: {
      position: "absolute", ...at, zIndex: POPUP_Z_INDEX + 1, minWidth: 200, padding: 4, background: c.card,
      borderWidth: 1, borderColor: c.border, radius: theme.radius.md, pointerEvents: "block",
      shadow: { x: 0, y: 6, blur: 18, color: "#0000002e" },
    },
    children,
  });
  return jsx(Row, {
    ...props,
    id,
    control: { role: "navigation", orientation: "horizontal" },
    style: { height: 30, padding: { left: 4, right: 4 }, gap: 1, align: "center", shrink: 0, position: "relative", zIndex: state.open !== null ? POPUP_Z_INDEX : 0, ...style },
    children: tops.map(({ item, index }, position) => {
      const open = state.open === index;
      const label = accessKey(item.label).text;
      const menu = !!item.items?.length;
      return jsx(View, {
        style: { position: "relative" },
        children: [
          jsx(Pressable, {
            id: `${id}-menu-${index}`,
            rovingGroup: true,
            disabled: item.disabled,
            control: { role: menu ? "button" : "menuitem", label, ...(menu ? { expanded: open } : {}) },
            onClick: item.disabled ? undefined : () => {
              if (!menu) { choose(item, item.id ?? `${id}-menu-${index}`); return; }
              if (open) close(); else { state.open = index; state.sub = null; }
            },
            onHover: (entered: boolean) => { if (entered && state.open !== null && state.open !== index && menu) { state.open = index; state.sub = null; } },
            onKeyDown: (key: string) => {
              if (menu && (key === "ArrowDown" || key === "Enter" || key === "Space")) openAt(position, true);
              else if (state.open !== null && (key === "ArrowRight" || key === "ArrowLeft")) openAt(position + (key === "ArrowRight" ? 1 : -1), true);
            },
            style: {
              height: 26, padding: { left: 9, right: 9 }, align: "center", justify: "center", radius: theme.radius.sm,
              background: open ? c.muted : "#00000000", hover: { background: c.muted }, focus: { background: c.muted },
              disabled: { foreground: c.disabledForeground },
            },
            children: jsx(Text, { size: 13, color: item.disabled ? c.disabledForeground : c.foreground, children: label }),
          }),
          open && menu
            ? jsx(View, {
                id: `${id}-content-${index}`,
                portal: true,
                dismissOnOutside: true,
                onOutsideClick: close,
                onEscape: () => { close(); focus(`${id}-menu-${index}`); },
                style: { position: "absolute", top: "100%", left: 0, zIndex: POPUP_Z_INDEX + 1, positionTryFallbacks: "flip-block, flip-inline, flip-block flip-inline" },
                children: popup(`${id}-popup-${index}`, { top: 2, left: 0 }, menuEntries(item.items!, String(index), index, false)),
              })
            : null,
        ],
      }, `menu-${index}`);
    }),
  });
}
