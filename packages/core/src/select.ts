import { jsx, type BaseProps, type VNode } from "./jsx-runtime";
import { Column, Icon, Pressable, Row, Text } from "./components";
import { theme } from "./theme";

export interface SelectOption { value: string; label: string; disabled?: boolean }
export interface SelectProps extends BaseProps {
  id: string;
  value?: string;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onValueChange?: (value: string) => void;
}

const openSelects = new Set<string>();

export function Select({ id, value, options, placeholder = "Select an option", disabled = false,
  open, onOpenChange, onValueChange, style }: SelectProps): VNode {
  if (new Set(options.map(option => option.value)).size !== options.length) {
    throw new TypeError("Select option values must be unique");
  }
  const expanded = open ?? openSelects.has(id);
  const enabled = options.filter(option => !option.disabled);
  const selected = options.find(option => option.value === value);
  const setOpen = (next: boolean) => {
    if (open === undefined) {
      if (next) openSelects.add(id); else openSelects.delete(id);
    }
    onOpenChange?.(next);
  };
  const choose = (next: string) => { setOpen(false); onValueChange?.(next); };
  const move = (direction: number) => {
    if (enabled.length === 0) return;
    const current = enabled.findIndex(option => option.value === value);
    const next = current < 0 ? (direction > 0 ? 0 : enabled.length - 1)
      : (current + direction + enabled.length) % enabled.length;
    onValueChange?.(enabled[next].value);
  };
  const edge = (end: boolean) => {
    if (enabled.length > 0) onValueChange?.(enabled[end ? enabled.length - 1 : 0].value);
  };
  return jsx(Column, { id, style: { position: "relative", width: 220, height: 38, shrink: 0,
    zIndex: expanded ? 100 : 0, ...style },
    children: [
      jsx(Pressable, { id: `${id}-trigger`, disabled, focusable: true,
        control: { role: "select", label: selected?.label ?? placeholder, checked: expanded },
        onClick: () => setOpen(!expanded),
        onBlur: () => setOpen(false),
        onKeyDown: (key: string) => {
          if (key === "ArrowDown") move(1);
          else if (key === "ArrowUp") move(-1);
          else if (key === "Home") edge(false);
          else if (key === "End") edge(true);
          else if (key === "Escape") setOpen(false);
        },
        style: { width: "100%", height: 38, direction: "row", align: "center", justify: "between",
          padding: { left: 12, right: 10 }, background: theme.colors.input,
          borderWidth: 1, borderColor: theme.colors.border, radius: theme.radius.sm,
          hover: { borderColor: theme.colors.mutedForeground },
          disabled: { background: theme.colors.disabled, foreground: theme.colors.disabledForeground } },
        children: [jsx(Text, { size: 14, color: selected ? theme.colors.foreground : theme.colors.placeholder,
          children: selected?.label ?? placeholder }),
          jsx(Icon, { name: "chevron-down", size: 14, color: theme.colors.mutedForeground })],
      }),
      expanded && !disabled ? jsx(Column, { id: `${id}-popup`, gap: 2,
        style: { position: "absolute", top: 42, left: 0, width: "100%", padding: 4,
          background: theme.colors.card, borderWidth: 1, borderColor: theme.colors.border,
          radius: theme.radius.md, pointerEvents: "block" },
        children: options.map(option => jsx(Pressable, { id: `${id}-option-${option.value}`,
          disabled: option.disabled, focusable: false,
          control: { role: "button", label: option.label, checked: option.value === value },
          onClick: () => choose(option.value),
          style: { minHeight: 32, padding: { left: 8, right: 8 }, radius: theme.radius.sm,
            direction: "row", align: "center", justify: "between",
            hover: { background: theme.colors.muted } },
          children: jsx(Row, { gap: 8, children: [jsx(Text, { color: option.disabled ? theme.colors.disabledForeground : theme.colors.foreground,
            children: option.label }), option.value === value ? jsx(Icon, { name: "check", size: 14 }) : null] }),
        }, option.value)) }) : null,
    ],
  });
}
