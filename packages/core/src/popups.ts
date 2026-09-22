import type { Style } from "../../protocol/src/index";
import { jsx, type BaseProps, type Child, type VNode } from "./jsx-runtime";
import { Column, Icon, Pressable, Row, Scroll, Text, TextInput, View, type IconName } from "./components";
import { theme } from "./theme";

const c = theme.colors;
const POPUP_Z_INDEX = 1000;
const MENU_MAX_HEIGHT = 240;
const COMMAND_MAX_HEIGHT = 280;

function boundedHeight(count: number, rowHeight: number, maxHeight: number, extra = 0): number {
  return Math.min(maxHeight, Math.max(0, count * rowHeight + extra));
}

export type PopupSide = "top" | "right" | "bottom" | "left";

function popupPosition(side: PopupSide, gap = 6): Style {
  switch (side) {
    case "top":
      return { bottom: "100%", left: 0, margin: { bottom: gap } };
    case "right":
      return { top: 0, left: "100%", margin: { left: gap } };
    case "left":
      return { top: 0, right: "100%", margin: { right: gap } };
    case "bottom":
    default:
      return { top: "100%", left: 0, margin: { top: gap } };
  }
}

function popupSurface(side: PopupSide, style?: Style): Style {
  return {
    position: "absolute",
    zIndex: POPUP_Z_INDEX + 1,
    minWidth: 180,
    padding: 4,
    background: c.card,
    borderWidth: 1,
    borderColor: c.border,
    radius: theme.radius.md,
    pointerEvents: "block",
    ...popupPosition(side),
    ...style,
  };
}

function triggerLabel(label: string | undefined, child: Child): string | undefined {
  if (label) return label;
  return typeof child === "string" || typeof child === "number" ? String(child) : undefined;
}

function assertUniqueValues(component: string, values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${component} values must be unique`);
  }
}

function includesQuery(label: string, value: string, keywords: readonly string[] | undefined, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [label, value, ...(keywords ?? [])].some(part => part.toLocaleLowerCase().includes(needle));
}

export interface TooltipProps extends BaseProps {
  id: string;
  open: boolean;
  trigger: Child;
  content: Child;
  side?: PopupSide;
  label?: string;
  onOpenChange?: (open: boolean) => void;
  contentStyle?: Style;
}

export function Tooltip({
  id,
  open,
  trigger,
  content,
  side = "top",
  label,
  onOpenChange,
  contentStyle,
  style,
}: TooltipProps): VNode {
  const tooltipContent = typeof content === "string" || typeof content === "number"
    ? jsx(Text, { size: 12, color: c.background, children: content })
    : content;
  return jsx(View, {
    id,
    style: { position: "relative", zIndex: open ? POPUP_Z_INDEX : 0, ...style },
    children: [
      jsx(Pressable, {
        id: `${id}-trigger`,
        focusable: false,
        control: { role: "button", label: triggerLabel(label, trigger), checked: open },
        onHover: (hovered: boolean) => onOpenChange?.(hovered),
        style: { background: "#00000000" },
        children: trigger,
      }),
      open
        ? jsx(View, {
            id: `${id}-content`,
            portal: true,
            style: popupSurface(side, {
              minWidth: 0,
              padding: { left: 8, right: 8, top: 5, bottom: 5 },
              background: c.foreground,
              foreground: c.background,
              ...contentStyle,
            }),
            children: tooltipContent,
          })
        : null,
    ],
  });
}

export interface PopoverProps extends BaseProps {
  id: string;
  open: boolean;
  trigger: Child;
  label?: string;
  side?: PopupSide;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerStyle?: Style;
  contentStyle?: Style;
}

export function Popover({
  id,
  open,
  trigger,
  label,
  side = "bottom",
  disabled = false,
  onOpenChange,
  triggerStyle,
  contentStyle,
  children,
  style,
}: PopoverProps): VNode {
  const setOpen = (next: boolean) => {
    if (!disabled) onOpenChange?.(next);
  };
  return jsx(View, {
    id,
    style: { position: "relative", zIndex: open ? POPUP_Z_INDEX : 0, ...style },
    children: [
      jsx(Pressable, {
        id: `${id}-trigger`,
        disabled,
        control: { role: "button", label: triggerLabel(label, trigger), checked: open },
        onClick: () => setOpen(!open),
        onEscape: () => setOpen(false),
        onKeyDown: (key: string) => {
          if (key === "Escape") setOpen(false);
        },
        style: { background: "#00000000", ...triggerStyle },
        children: trigger,
      }),
      open && !disabled
        ? jsx(Column, {
            id: `${id}-content`,
            portal: true,
            dismissOnOutside: true,
            onOutsideClick: () => setOpen(false),
            style: popupSurface(side, contentStyle),
            children,
          })
        : null,
    ],
  });
}

export interface DropdownMenuItem {
  value: string;
  label: string;
  icon?: IconName;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
}

export interface DropdownMenuProps extends BaseProps {
  id: string;
  open: boolean;
  trigger: Child;
  items: readonly DropdownMenuItem[];
  label?: string;
  side?: PopupSide;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSelect?: (value: string) => void;
  triggerStyle?: Style;
  contentStyle?: Style;
}

function menuItems(
  id: string,
  items: readonly DropdownMenuItem[],
  onSelect: ((value: string) => void) | undefined,
  close: () => void,
): Child[] {
  return items.map(item => jsx(Pressable, {
    id: `${id}-item-${item.value}`,
    key: item.value,
    disabled: item.disabled,
    focusable: false,
    control: { role: "button", label: item.label, checked: item.checked },
    onClick: item.disabled ? undefined : () => {
      onSelect?.(item.value);
      close();
    },
    style: {
      minHeight: 32,
      padding: { left: 8, right: 8 },
      direction: "row",
      align: "center",
      justify: "between",
      gap: 12,
      radius: theme.radius.sm,
      hover: { background: c.muted },
      disabled: { foreground: c.disabledForeground },
    },
    children: [
      jsx(Row, {
        gap: 8,
        children: [
          item.checked ? jsx(Icon, { name: "check", size: 14 }) : item.icon ? jsx(Icon, { name: item.icon, size: 14 }) : null,
          jsx(Text, { color: item.disabled ? c.disabledForeground : c.foreground, children: item.label }),
        ],
      }),
      item.shortcut ? jsx(Text, { size: 12, color: c.mutedForeground, children: item.shortcut }) : null,
    ],
  }, item.value));
}

export function DropdownMenu({
  id,
  open,
  trigger,
  items,
  label,
  side = "bottom",
  disabled = false,
  onOpenChange,
  onSelect,
  triggerStyle,
  contentStyle,
  style,
}: DropdownMenuProps): VNode {
  assertUniqueValues("DropdownMenu", items.map(item => item.value));
  const setOpen = (next: boolean) => {
    if (!disabled) onOpenChange?.(next);
  };
  const close = () => setOpen(false);
  return jsx(View, {
    id,
    style: { position: "relative", zIndex: open ? POPUP_Z_INDEX : 0, ...style },
    children: [
      jsx(Pressable, {
        id: `${id}-trigger`,
        disabled,
        control: { role: "button", label: triggerLabel(label, trigger), checked: open },
        onClick: () => setOpen(!open),
        onEscape: close,
        onKeyDown: (key: string) => {
          if (key === "Escape") close();
          else if (key === "ArrowDown" || key === "Enter" || key === " ") setOpen(true);
        },
        style: { background: "#00000000", ...triggerStyle },
        children: trigger,
      }),
      open && !disabled
        ? jsx(Column, {
            id: `${id}-content`,
            portal: true,
            dismissOnOutside: true,
            onOutsideClick: close,
            style: popupSurface(side, contentStyle),
            children: jsx(Scroll, {
              id: `${id}-scroll`,
              gap: 2,
              style: { height: boundedHeight(items.length, 34, MENU_MAX_HEIGHT) },
              children: menuItems(id, items, onSelect, close),
            }),
          })
        : null,
    ],
  });
}

export interface ContextMenuProps extends BaseProps {
  id: string;
  open: boolean;
  trigger: Child;
  items: readonly DropdownMenuItem[];
  label?: string;
  side?: PopupSide;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSelect?: (value: string) => void;
  contentStyle?: Style;
}

export function ContextMenu({
  id,
  open,
  trigger,
  items,
  label,
  side = "bottom",
  disabled = false,
  onOpenChange,
  onSelect,
  contentStyle,
  children,
  style,
}: ContextMenuProps): VNode {
  assertUniqueValues("ContextMenu", items.map(item => item.value));
  const setOpen = (next: boolean) => {
    if (!disabled) onOpenChange?.(next);
  };
  const close = () => setOpen(false);
  return jsx(View, {
    id,
    style: { position: "relative", zIndex: open ? POPUP_Z_INDEX : 0, ...style },
    children: [
      jsx(Pressable, {
        id: `${id}-trigger`,
        disabled,
        control: { role: "button", label: triggerLabel(label, trigger), checked: open },
        onContextMenu: () => setOpen(true),
        onEscape: close,
        style: { background: "#00000000" },
        children: trigger,
      }),
      children,
      open && !disabled
        ? jsx(Column, {
            id: `${id}-content`,
            portal: true,
            dismissOnOutside: true,
            onOutsideClick: close,
            style: popupSurface(side, contentStyle),
            children: jsx(Scroll, {
              id: `${id}-scroll`,
              gap: 2,
              style: { height: boundedHeight(items.length, 34, MENU_MAX_HEIGHT) },
              children: menuItems(id, items, onSelect, close),
            }),
          })
        : null,
    ],
  });
}

export interface ComboboxOption {
  value: string;
  label: string;
  keywords?: readonly string[];
  disabled?: boolean;
}

export interface ComboboxProps extends BaseProps {
  id: string;
  open: boolean;
  query: string;
  options: readonly ComboboxOption[];
  value?: string;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  onQueryChange?: (query: string) => void;
  onValueChange?: (value: string) => void;
  contentStyle?: Style;
}

export function Combobox({
  id,
  open,
  query,
  options,
  value,
  placeholder = "Select an option",
  searchPlaceholder = "Search...",
  emptyText = "No results found.",
  disabled = false,
  onOpenChange,
  onQueryChange,
  onValueChange,
  contentStyle,
  style,
}: ComboboxProps): VNode {
  assertUniqueValues("Combobox", options.map(option => option.value));
  const selected = options.find(option => option.value === value);
  const visible = options.filter(option => includesQuery(option.label, option.value, option.keywords, query));
  const setOpen = (next: boolean) => {
    if (!disabled) onOpenChange?.(next);
  };
  const choose = (next: string) => {
    onValueChange?.(next);
    setOpen(false);
  };
  return jsx(View, {
    id,
    style: { position: "relative", width: 220, zIndex: open ? POPUP_Z_INDEX : 0, ...style },
    children: [
      jsx(Pressable, {
        id: `${id}-trigger`,
        disabled,
        control: { role: "select", label: selected?.label ?? placeholder, checked: open },
        onClick: () => setOpen(!open),
        onEscape: () => setOpen(false),
        onKeyDown: (key: string) => {
          if (key === "Escape") setOpen(false);
          else if (key === "ArrowDown" || key === "Enter" || key === " ") setOpen(true);
        },
        style: {
          width: "100%",
          height: 38,
          direction: "row",
          align: "center",
          justify: "between",
          padding: { left: 12, right: 10 },
          background: c.input,
          borderWidth: 1,
          borderColor: c.border,
          radius: theme.radius.sm,
          hover: { borderColor: c.mutedForeground },
          disabled: { background: c.disabled, foreground: c.disabledForeground },
        },
        children: [
          jsx(Text, { size: 14, color: selected ? c.foreground : c.placeholder, children: selected?.label ?? placeholder }),
          jsx(Icon, { name: "chevron-down", size: 14, color: c.mutedForeground }),
        ],
      }),
      open && !disabled
        ? jsx(Column, {
            id: `${id}-content`,
            portal: true,
            dismissOnOutside: true,
            onOutsideClick: () => setOpen(false),
            gap: 4,
            style: popupSurface("bottom", { width: "100%", margin: { top: 4 }, ...contentStyle }),
            children: [
              jsx(Row, {
                gap: 6,
                style: { align: "center", padding: { left: 8 }, borderWidth: { bottom: 1 }, borderColor: c.border },
                children: [
                  jsx(Icon, { name: "search", size: 14, color: c.mutedForeground }),
                  jsx(TextInput, {
                    id: `${id}-input`,
                    value: query,
                    placeholder: searchPlaceholder,
                    onChange: onQueryChange,
                    style: { flex: 1, minWidth: 0, borderWidth: 0, background: "#00000000" },
                  }),
                ],
              }),
              visible.length === 0
                ? jsx(Text, { id: `${id}-empty`, size: 13, color: c.mutedForeground, style: { padding: 8 }, children: emptyText })
                : jsx(Scroll, {
                    id: `${id}-results`,
                    gap: 2,
                    style: { height: boundedHeight(visible.length, 34, MENU_MAX_HEIGHT) },
                    children: visible.map(option => jsx(Pressable, {
                      id: `${id}-option-${option.value}`,
                      key: option.value,
                      disabled: option.disabled,
                      focusable: false,
                      control: { role: "button", label: option.label, checked: option.value === value },
                      onClick: option.disabled ? undefined : () => choose(option.value),
                      style: {
                        minHeight: 32,
                        padding: { left: 8, right: 8 },
                        direction: "row",
                        align: "center",
                        justify: "between",
                        radius: theme.radius.sm,
                        hover: { background: c.muted },
                      },
                      children: [
                        jsx(Text, { color: option.disabled ? c.disabledForeground : c.foreground, children: option.label }),
                        option.value === value ? jsx(Icon, { name: "check", size: 14 }) : null,
                      ],
                    }, option.value)),
                  }),
            ],
          })
        : null,
    ],
  });
}

export interface CommandItem {
  value: string;
  label: string;
  keywords?: readonly string[];
  icon?: IconName;
  group?: string;
  shortcut?: string;
  disabled?: boolean;
}

export interface CommandProps extends BaseProps {
  id: string;
  query: string;
  items: readonly CommandItem[];
  value?: string;
  placeholder?: string;
  emptyText?: string;
  onQueryChange?: (query: string) => void;
  onValueChange?: (value: string) => void;
  onSelect?: (value: string) => void;
}

export function Command({
  id,
  query,
  items,
  value,
  placeholder = "Type a command or search...",
  emptyText = "No results found.",
  onQueryChange,
  onValueChange,
  onSelect,
  style,
}: CommandProps): VNode {
  assertUniqueValues("Command", items.map(item => item.value));
  const visible = items.filter(item => includesQuery(item.label, item.value, item.keywords, query));
  const groups = new Map<string, CommandItem[]>();
  for (const item of visible) {
    const group = item.group ?? "";
    const bucket = groups.get(group);
    if (bucket) bucket.push(item);
    else groups.set(group, [item]);
  }
  const choose = (item: CommandItem) => {
    if (item.disabled) return;
    onValueChange?.(item.value);
    onSelect?.(item.value);
  };
  const resultNodes: Child[] = [];
  for (const [group, groupItems] of groups) {
    if (group) {
      resultNodes.push(jsx(Text, {
        id: `${id}-group-${group}`,
        key: `group-${group}`,
        size: 12,
        weight: 600,
        color: c.mutedForeground,
        style: { padding: { left: 8, right: 8, top: 8, bottom: 4 } },
        children: group,
      }));
    }
    resultNodes.push(...groupItems.map(item => jsx(Pressable, {
      id: `${id}-item-${item.value}`,
      key: item.value,
      disabled: item.disabled,
      control: { role: "button", label: item.label, checked: item.value === value },
      onClick: item.disabled ? undefined : () => choose(item),
      style: {
        minHeight: 34,
        padding: { left: 8, right: 8 },
        direction: "row",
        align: "center",
        justify: "between",
        gap: 12,
        radius: theme.radius.sm,
        hover: { background: c.muted },
      },
      children: [
        jsx(Row, { gap: 8, children: [
          item.icon ? jsx(Icon, { name: item.icon, size: 14 }) : null,
          jsx(Text, { color: item.disabled ? c.disabledForeground : c.foreground, children: item.label }),
        ] }),
        item.shortcut ? jsx(Text, { size: 12, color: c.mutedForeground, children: item.shortcut }) : null,
      ],
    }, item.value)));
  }
  return jsx(Column, {
    id,
    style: {
      minWidth: 260,
      background: c.card,
      borderWidth: 1,
      borderColor: c.border,
      radius: theme.radius.md,
      ...style,
    },
    children: [
      jsx(Row, {
        gap: 8,
        style: { align: "center", padding: { left: 10 }, borderWidth: { bottom: 1 }, borderColor: c.border },
        children: [
          jsx(Icon, { name: "search", size: 15, color: c.mutedForeground }),
          jsx(TextInput, {
            id: `${id}-input`,
            value: query,
            placeholder,
            onChange: onQueryChange,
            style: { flex: 1, minWidth: 0, borderWidth: 0, background: "#00000000" },
          }),
        ],
      }),
      jsx(Scroll, {
        id: `${id}-results`,
        gap: 2,
        style: {
          height: visible.length === 0
            ? 46
            : boundedHeight(visible.length, 36, COMMAND_MAX_HEIGHT, groups.size * 28 + 8),
          padding: 4,
        },
        children: visible.length === 0
          ? jsx(Text, { id: `${id}-empty`, size: 13, color: c.mutedForeground, style: { padding: 10 }, children: emptyText })
          : resultNodes,
      }),
    ],
  });
}

export interface CommandPaletteProps extends Omit<CommandProps, "style" | "onSelect"> {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  onSelect?: (value: string) => void;
  closeOnSelect?: boolean;
  closeOnOverlay?: boolean;
  width?: number;
}

export function CommandPalette({
  id,
  open,
  onOpenChange,
  onSelect,
  closeOnSelect = true,
  closeOnOverlay = true,
  width = 520,
  ...commandProps
}: CommandPaletteProps): VNode {
  if (!open) return jsx("fragment", {});
  const close = () => onOpenChange?.(false);
  return jsx(Pressable, {
    id,
    modal: true,
    portal: true,
    focusable: false,
    onClick: closeOnOverlay ? close : undefined,
    onEscape: close,
    style: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      zIndex: POPUP_Z_INDEX,
      padding: { top: 72, left: 24, right: 24 },
      align: "center",
      background: c.overlay,
      pointerEvents: "block",
    },
    children: jsx(Column, {
      id: `${id}-content`,
      style: { width, maxWidth: "90%", pointerEvents: "block" },
      children: jsx(Command, {
        ...commandProps,
        id: `${id}-command`,
        onSelect: (value: string) => {
          onSelect?.(value);
          if (closeOnSelect) close();
        },
      }),
    }),
  });
}
