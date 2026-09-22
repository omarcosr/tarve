import type { Style } from "../../protocol/src/index";
import { jsx, type BaseProps, type Child, type VNode } from "./jsx-runtime";
import { Column, Icon, Pressable, Row, Text, View, type ViewProps } from "./components";
import { theme } from "./theme";

const c = theme.colors;

export interface CheckboxProps extends BaseProps {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}
export function Checkbox({ checked, label, disabled, onCheckedChange, style, ...props }: CheckboxProps): VNode {
  return jsx(Pressable, {
    ...props, disabled, control: { role: "checkbox", label, checked },
    onClick: () => onCheckedChange?.(!checked),
    style: { direction: "row", align: "center", gap: 9, minHeight: 28, ...style },
    children: [
      jsx(View, { style: { width: 18, height: 18, shrink: 0, radius: 4, borderWidth: 1,
        borderColor: checked ? c.primary : c.border, background: checked ? c.primary : c.input,
        justify: "center", align: "center" },
        children: jsx(Icon, { name: "check", size: 14, color: checked ? c.primaryForeground : "#00000000" }) }),
      jsx(Text, { color: disabled ? c.disabledForeground : c.foreground, children: label }),
    ],
  });
}

export interface SwitchProps extends BaseProps {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}
export function Switch({ checked, label, disabled, onCheckedChange, style, ...props }: SwitchProps): VNode {
  return jsx(Pressable, {
    ...props, disabled, control: { role: "switch", label, checked },
    onClick: () => onCheckedChange?.(!checked),
    style: { direction: "row", align: "center", gap: 9, minHeight: 28, ...style },
    children: [
      jsx(View, { style: { position: "relative", width: 36, height: 20, shrink: 0, radius: 10,
        background: disabled ? c.disabled : checked ? c.primary : c.border },
        children: jsx(View, { style: { position: "absolute", top: 2, left: checked ? 18 : 2,
          width: 16, height: 16, radius: 8, background: c.sliderThumb } }) }),
      jsx(Text, { color: disabled ? c.disabledForeground : c.foreground, children: label }),
    ],
  });
}

export interface RadioOption { value: string; label: string; disabled?: boolean }
export interface RadioGroupProps extends BaseProps {
  value: string;
  options: RadioOption[];
  orientation?: "horizontal" | "vertical";
  disabled?: boolean;
  onValueChange?: (value: string) => void;
}
export function RadioGroup({ value, options, orientation = "vertical", disabled, onValueChange, style, ...props }: RadioGroupProps): VNode {
  return jsx(orientation === "horizontal" ? Row : Column, {
    ...props, control: { role: "radiogroup", orientation }, gap: 8, style,
    children: options.map(option => {
      const selected = option.value === value;
      const inactive = disabled || option.disabled;
      return jsx(Pressable, {
        disabled: inactive,
        control: { role: "radio", label: option.label, checked: selected },
        onClick: () => onValueChange?.(option.value),
        style: { direction: "row", align: "center", gap: 9, minHeight: 28 },
        children: [
          jsx(View, { style: { width: 18, height: 18, shrink: 0, radius: 9, borderWidth: selected ? 5 : 1,
            borderColor: selected ? c.primary : c.border, background: c.input } }),
          jsx(Text, { color: inactive ? c.disabledForeground : c.foreground, children: option.label }),
        ],
      }, option.value);
    }),
  });
}

export interface SliderProps extends BaseProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  orientation?: "horizontal" | "vertical";
  disabled?: boolean;
  onValueChange?: (value: number) => void;
}
export function Slider({ value, min = 0, max = 100, step = 1, label, orientation = "horizontal", disabled, onValueChange, style, ...props }: SliderProps): VNode {
  if (![value, min, max, step].every(Number.isFinite) || max <= min || step <= 0) {
    throw new RangeError("Slider requires finite values, max > min and step > 0");
  }
  return jsx("slider", { ...props, disabled, onValueChange,
    control: { role: "slider", label, orientation, value: Math.max(min, Math.min(value, max)), min, max, step },
    style: { width: orientation === "horizontal" ? 160 : 24, height: orientation === "horizontal" ? 24 : 160,
      shrink: 0, foreground: disabled ? c.disabledForeground : c.primary,
      borderColor: c.border, thumbColor: c.sliderThumb,
      ...style },
  });
}

export interface CardProps extends ViewProps {
  title?: string;
  description?: string;
  footer?: Child;
}
export function Card({ title, description, footer, children, style, ...props }: CardProps): VNode {
  return jsx(Column, { ...props, gap: 18,
    style: { background: c.card, borderWidth: 1, borderColor: c.border, radius: theme.radius.lg,
      padding: 22, ...style },
    children: [title || description ? jsx(Column, { gap: 4, children: [
      title ? jsx(Text, { size: 17, weight: 600, children: title }) : null,
      description ? jsx(Text, { size: 13, color: c.mutedForeground, children: description }) : null,
    ] }) : null, children, footer ? jsx(Row, { gap: 8, justify: "end", children: footer }) : null],
  });
}

export interface BadgeProps extends BaseProps { variant?: "default" | "secondary" | "outline" | "destructive" }
export function Badge({ variant = "default", style, ...props }: BadgeProps): VNode {
  const variants: Record<NonNullable<BadgeProps["variant"]>, Style> = {
    default: { background: c.primary, foreground: c.primaryForeground },
    secondary: { background: c.secondary, foreground: c.secondaryForeground },
    outline: { background: c.card, foreground: c.foreground, borderWidth: 1, borderColor: c.border },
    destructive: { background: c.destructive, foreground: c.destructiveForeground },
  };
  return jsx(View, { ...props, style: { padding: { left: 8, right: 8, top: 3, bottom: 3 },
    radius: theme.radius.sm, shrink: 0, ...variants[variant], ...style },
    children: jsx(Text, { size: 12, weight: 500, color: style?.foreground ?? variants[variant].foreground,
      children: props.children }),
  });
}

export interface SeparatorProps extends BaseProps { orientation?: "horizontal" | "vertical" }
export function Separator({ orientation = "horizontal", style, ...props }: SeparatorProps): VNode {
  return jsx(View, { ...props, style: { width: orientation === "horizontal" ? "100%" : 1,
    height: orientation === "horizontal" ? 1 : "100%", shrink: 0, background: c.border, ...style } });
}

export interface ProgressProps extends BaseProps { value: number; max?: number; label?: string }
export function Progress({ value, max = 100, label, style, ...props }: ProgressProps): VNode {
  const ratio = Number.isFinite(value) && Number.isFinite(max) && max > 0 ? Math.max(0, Math.min(value / max, 1)) : 0;
  return jsx(View, { ...props, control: { role: "progress", label, value: ratio * max, min: 0, max },
    style: { width: "100%", height: 8, radius: 4, background: c.secondary, ...style },
    children: jsx(View, { style: { width: `${ratio * 100}%`, height: "100%", radius: 4, background: c.primary } }),
  });
}

export interface TabItem { value: string; label: string; content: Child; disabled?: boolean }
export interface TabsProps extends BaseProps {
  value: string;
  items: TabItem[];
  onValueChange?: (value: string) => void;
}
export function Tabs({ value, items, onValueChange, style, ...props }: TabsProps): VNode {
  const selected = items.find(item => item.value === value);
  return jsx(Column, { ...props, gap: 14, style,
    children: [jsx(Row, { gap: 4, control: { role: "tablist" },
      style: { padding: 4, background: c.muted, radius: theme.radius.md },
      children: items.map(item => jsx(Pressable, { disabled: item.disabled,
        control: { role: "tab", label: item.label, checked: value === item.value },
        onClick: () => onValueChange?.(item.value),
        style: { height: 32, padding: { left: 12, right: 12 }, align: "center", justify: "center",
          background: value === item.value ? c.card : "#00000000",
          hover: { background: value === item.value ? c.card : c.secondaryHover } },
        children: jsx(Text, { size: 13, weight: 500, color: item.disabled ? c.disabledForeground : c.foreground,
          children: item.label }),
      }, item.value)) }), selected?.content],
  });
}

export interface AccordionItem { value: string; title: string; content: Child; disabled?: boolean }
export interface AccordionProps extends BaseProps {
  value?: string;
  items: AccordionItem[];
  onValueChange?: (value: string | undefined) => void;
}
export function Accordion({ value, items, onValueChange, style, ...props }: AccordionProps): VNode {
  return jsx(Column, { ...props, style, children: items.map(item => {
    const open = value === item.value;
    return jsx(Column, { style: { borderWidth: { bottom: 1 }, borderColor: c.border },
      children: [jsx(Pressable, { disabled: item.disabled,
        control: { role: "button", label: item.title, checked: open },
        onClick: () => onValueChange?.(open ? undefined : item.value),
        style: { direction: "row", minHeight: 44, align: "center", justify: "between",
          hover: { foreground: c.mutedForeground } },
        children: [jsx(Text, { weight: 500, children: item.title }),
          jsx(Icon, { name: open ? "chevron-up" : "chevron-down", size: 16 })],
      }), open ? jsx(Column, { style: { padding: { bottom: 16 } }, children: item.content }) : null],
    }, item.value);
  }) });
}
