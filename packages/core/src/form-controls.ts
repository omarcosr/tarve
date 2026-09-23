import type { Style } from "../../protocol/src/index";
import { jsx, type BaseProps, type Child, type VNode } from "./jsx-runtime";
import { Button, Column, Pressable, Row, Text, TextArea, Input, View, type ButtonProps, type IconName } from "./components";
import { Checkbox, RadioGroup, Slider, Switch } from "./controls";
import { Select, type SelectOption } from "./select";
import { theme } from "./theme";

const c = theme.colors;
const transparent = "#00000000";

export type AlertVariant = "default" | "destructive" | "success";
export interface AlertProps extends BaseProps {
  title?: string;
  description?: string;
  variant?: AlertVariant;
  icon?: Child;
}
export function Alert({ title, description, variant = "default", icon, children, style, ...props }: AlertProps): VNode {
  const palette: Record<AlertVariant, { border: string; background: string; foreground: string }> = {
    default: { border: c.border, background: c.card, foreground: c.foreground },
    destructive: { border: c.destructive, background: c.card, foreground: c.destructive },
    success: { border: c.success, background: c.successMuted, foreground: c.success },
  };
  const selected = palette[variant];
  return jsx(Row, {
    ...props,
    control: { role: variant === "destructive" ? "alert" : "status", label: title ?? description },
    gap: 10,
    align: "start",
    style: { width: "100%", padding: 14, radius: theme.radius.md, borderWidth: 1, borderColor: selected.border,
      background: selected.background, ...style },
    children: [
      icon,
      jsx(Column, { gap: 3, flex: 1, children: [
        title ? jsx(Text, { weight: 600, color: selected.foreground, children: title }) : null,
        description ? jsx(Text, { size: 13, color: variant === "default" ? c.mutedForeground : selected.foreground, children: description }) : null,
        children,
      ] }),
    ],
  });
}

export interface AspectRatioProps extends BaseProps {
  ratio: number;
  width?: Style["width"];
}
export function AspectRatio({ ratio, width = 320, style, children, ...props }: AspectRatioProps): VNode {
  if (!Number.isFinite(ratio) || ratio <= 0) throw new RangeError("AspectRatio ratio must be greater than zero");
  if (typeof width === "number" && (!Number.isFinite(width) || width <= 0)) throw new RangeError("AspectRatio width must be greater than zero");
  return jsx(View, { ...props, style: { position: "relative", ...style, width, height: undefined, aspectRatio: ratio }, children });
}

export interface ButtonGroupProps extends BaseProps {
  orientation?: "horizontal" | "vertical";
  gap?: number;
}
export function ButtonGroup({ orientation = "horizontal", gap = 0, style, children, ...props }: ButtonGroupProps): VNode {
  const Component = orientation === "horizontal" ? Row : Column;
  return jsx(Component, { ...props, control: { role: "group", orientation }, gap, style, children });
}

export interface EmptyProps extends BaseProps {
  title: string;
  description?: string;
  icon?: Child;
  action?: Child;
}
export function Empty({ title, description, icon, action, children, style, ...props }: EmptyProps): VNode {
  return jsx(Column, {
    ...props,
    gap: 10,
    align: "center",
    style: { width: "100%", minHeight: 180, padding: 24, justify: "center", borderWidth: 1, borderColor: c.border,
      radius: theme.radius.lg, background: c.card, ...style },
    children: [
      icon,
      jsx(Text, { size: 16, weight: 600, style: { textAlign: "center" }, children: title }),
      description ? jsx(Text, { size: 13, color: c.mutedForeground, style: { textAlign: "center" }, children: description }) : null,
      children,
      action,
    ],
  });
}

export interface LabelProps extends BaseProps {
  required?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}
export function Label({ required, disabled, onClick, children, style, ...props }: LabelProps): VNode {
  const label = jsx(Text, { size: 13, weight: 500, color: disabled ? c.disabledForeground : c.foreground,
    children: [children, required ? " *" : null] });
  const control = { role: "label" as const, label: typeof children === "string" ? children : undefined };
  if (!onClick) return jsx(View, { ...props, control, style, children: label });
  return jsx(Pressable, { ...props, disabled, onClick, control,
    style: { background: transparent, ...style }, children: label });
}

export interface FieldProps extends BaseProps {
  label?: string;
  description?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
}
function disableFormChild(child: Child, disabled: boolean | undefined): Child {
  if (!disabled) return child;
  if (Array.isArray(child)) return child.map(item => disableFormChild(item, true));
  if (!child || typeof child !== "object") return child;
  const disable = child.type === Input || child.type === TextArea || child.type === Select || child.type === NativeSelect
    || child.type === InputGroup || child.type === InputOTP || child.type === Toggle || child.type === ToggleGroup
    || child.type === Checkbox || child.type === Switch || child.type === RadioGroup || child.type === Slider;
  const nested = child.props.children === undefined ? undefined : disableFormChild(child.props.children, true);
  return { ...child, props: { ...child.props, ...(disable ? { disabled: true } : {}),
    ...(child.props.children === undefined ? {} : { children: nested }) } };
}
export function Field({ label, description, error, required, disabled, children, style, id, ...props }: FieldProps): VNode {
  const semanticGroup = label !== undefined || description !== undefined || error !== undefined || required === true;
  return jsx(Column, {
    ...props,
    ...(id ? { id } : {}),
    disabled,
    control: semanticGroup ? {
      role: "field",
      label: label ?? "",
      description: description ?? "",
      required: required === true,
    } : undefined,
    gap: 6,
    style,
    children: [
      label ? jsx(Label, { ...(id ? { id: `${id}-label` } : {}), required, disabled, children: label }) : null,
      disableFormChild(children, disabled),
      error
        ? jsx(Text, { ...(id ? { id: `${id}-error` } : {}), control: { role: "alert", label: error }, size: 12, color: c.destructive, children: error })
        : description
          ? jsx(Text, { ...(id ? { id: `${id}-description` } : {}), size: 12, color: c.mutedForeground, children: description })
          : null,
    ],
  });
}

export interface InputGroupProps extends BaseProps {
  prefix?: Child;
  suffix?: Child;
  disabled?: boolean;
}
export function InputGroup({ prefix, suffix, disabled, children, style, ...props }: InputGroupProps): VNode {
  return jsx(Row, {
    ...props,
    disabled,
    control: { role: "group" },
    gap: 8,
    style: { width: "100%", minHeight: 38, padding: { left: 10, right: 10 }, borderWidth: 1, borderColor: c.border,
      radius: theme.radius.sm, background: disabled ? c.disabled : c.input, ...style },
    children: [prefix, jsx(View, { flex: 1, children: disableFormChild(children, disabled) }), suffix],
  });
}

export interface InputOTPProps extends BaseProps {
  value: string;
  length?: number;
  disabled?: boolean;
  mask?: boolean;
  pattern?: RegExp;
  onValueChange?: (value: string) => void;
  slotWidth?: number;
}
function matchesInputPattern(pattern: RegExp, char: string): boolean {
  pattern.lastIndex = 0;
  const matched = pattern.test(char);
  pattern.lastIndex = 0;
  return matched;
}
export function InputOTP({ value, length = 6, disabled, mask = false, pattern = /^[0-9]$/, onValueChange,
  slotWidth = 36, style, id, ...props }: InputOTPProps): VNode {
  if (!Number.isInteger(length) || length < 1 || length > 32) throw new RangeError("InputOTP length must be between 1 and 32");
  if (!(pattern instanceof RegExp)) throw new TypeError("InputOTP pattern must be a RegExp");
  if (!Number.isFinite(slotWidth) || slotWidth <= 0) throw new RangeError("InputOTP slotWidth must be greater than zero");
  const normalized = [...value];
  if (normalized.length > length) throw new RangeError("InputOTP value cannot be longer than length");
  if (normalized.some(char => !matchesInputPattern(pattern, char))) throw new TypeError("InputOTP value must match pattern");
  const slotGap = 8;
  const slotHeight = 42;
  const totalWidth = length * slotWidth + (length - 1) * slotGap;
  const update = (input: string) => {
    const accepted = [...input].filter(char => matchesInputPattern(pattern, char)).slice(0, length).join("");
    onValueChange?.(accepted);
  };
  return jsx(View, {
    ...props,
    ...(id ? { id } : {}),
    disabled,
    style: { position: "relative", width: totalWidth, height: slotHeight, ...style },
    children: [
      jsx(Input, {
        ...(id ? { id: `${id}-input` } : {}),
        disabled,
        value,
        onChange: update,
        style: { position: "absolute", top: 0, left: 0, width: totalWidth, minWidth: totalWidth, height: slotHeight,
          padding: 0, borderWidth: 0, background: transparent, foreground: transparent,
          caretColor: transparent, selectionColor: transparent,
          focus: { outlineWidth: 0, outlineOffset: 0 } },
      }),
      jsx(Row, { gap: slotGap, style: { width: totalWidth, height: slotHeight },
       children: Array.from({ length }, (_, index) => jsx(View, {
         ...(id ? { id: `${id}-slot-${index}` } : {}),
          ...(id ? { control: { role: "otpSlot", group: `${id}-input`, value: index, max: length - 1 } } : {}),
         style: { width: slotWidth, minWidth: slotWidth, height: slotHeight, align: "center", justify: "center",
            borderWidth: 1, borderColor: normalized[index] ? c.ringSoft : c.border, radius: theme.radius.sm,
           background: disabled ? c.disabled : c.input },
          children: jsx(Text, { size: 16, weight: 500, color: disabled ? c.disabledForeground : c.foreground,
            children: normalized[index] ? (mask ? "•" : normalized[index]) : "" }),
        }, index)),
      }),
    ],
  });
}

export interface ItemProps extends BaseProps {
  title: string;
  description?: string;
  leading?: Child;
  trailing?: Child;
  disabled?: boolean;
  selected?: boolean;
  onClick?: () => void;
}
export function Item({ title, description, leading, trailing, disabled, selected, onClick, style, ...props }: ItemProps): VNode {
  const body = jsx(Row, {
    gap: 10,
    style: { width: "100%" },
    children: [
      leading,
      jsx(Column, { gap: 2, flex: 1, children: [
        jsx(Text, { weight: 500, color: disabled ? c.disabledForeground : c.foreground, children: title }),
        description ? jsx(Text, { size: 12, color: c.mutedForeground, children: description }) : null,
      ] }),
      trailing,
    ],
  });
  const itemStyle: Style = { width: "100%", minHeight: 44, padding: { left: 10, right: 10, top: 8, bottom: 8 },
    background: selected ? c.muted : transparent, ...style };
  if (!onClick) return jsx(View, { ...props, style: itemStyle, children: body });
  return jsx(Pressable, { ...props, disabled, onClick,
    control: selected === undefined ? { role: "button", label: title } : { role: "option", label: title, selected },
    style: { ...itemStyle, hover: { background: c.muted } }, children: body });
}

export interface KbdProps extends BaseProps {}
export function Kbd({ children, style, ...props }: KbdProps): VNode {
  return jsx(View, { ...props, style: { minHeight: 22, padding: { left: 6, right: 6, top: 2, bottom: 2 },
    borderWidth: 1, borderColor: c.border, radius: 4, background: c.muted, shrink: 0, ...style },
    children: jsx(Text, { size: 11, weight: 600, children }) });
}

export interface NativeSelectProps extends Omit<BaseProps, "children"> {
  id: string;
  value?: string;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onValueChange?: (value: string) => void;
}
export function NativeSelect(props: NativeSelectProps): VNode {
  return jsx(Select, props);
}

export interface ToggleProps extends BaseProps {
  pressed: boolean;
  label?: string;
  disabled?: boolean;
  variant?: "default" | "outline";
  size?: ButtonProps["size"];
  onPressedChange?: (pressed: boolean) => void;
}
export function Toggle({ pressed, label, disabled, variant = "default", size = "default", onPressedChange,
  children, style, ...props }: ToggleProps): VNode {
  const height = { sm: 32, default: 36, lg: 40 }[size ?? "default"];
  return jsx(Pressable, {
    ...props,
    disabled,
    control: { role: "toggle", label, checked: pressed },
    onClick: () => onPressedChange?.(!pressed),
    style: { height, minWidth: height, padding: { left: 10, right: 10 }, align: "center", justify: "center",
      background: pressed ? c.secondary : transparent, borderWidth: variant === "outline" ? 1 : 0,
      borderColor: c.border, hover: { background: c.muted }, disabled: { background: c.disabled, foreground: c.disabledForeground }, ...style },
    children: typeof children === "string" || typeof children === "number"
      ? jsx(Text, { weight: 500, color: disabled ? c.disabledForeground : c.foreground, children })
      : children,
  });
}

export interface ToggleGroupItem {
  value: string;
  label: string;
  content?: Child;
  disabled?: boolean;
}
export interface ToggleGroupProps extends BaseProps {
  type?: "single" | "multiple";
  value: string | string[];
  items: readonly ToggleGroupItem[];
  disabled?: boolean;
  onValueChange?: (value: string | string[]) => void;
}
export function ToggleGroup({ type = "single", value, items, disabled, onValueChange, style, id, ...props }: ToggleGroupProps): VNode {
  if (new Set(items.map(item => item.value)).size !== items.length) throw new TypeError("ToggleGroup item values must be unique");
  if (type === "single" && Array.isArray(value)) throw new TypeError("ToggleGroup single value must be a string");
  if (type === "multiple" && !Array.isArray(value)) throw new TypeError("ToggleGroup multiple value must be an array");
  const selected = Array.isArray(value) ? value : value ? [value] : [];
  const allowed = new Set(items.map(item => item.value));
  if (selected.some(entry => !allowed.has(entry))) throw new RangeError("ToggleGroup value must reference an existing item");
  if (new Set(selected).size !== selected.length) throw new TypeError("ToggleGroup selected values must be unique");
  const choose = (item: ToggleGroupItem) => {
    if (type === "single") onValueChange?.(selected.includes(item.value) ? "" : item.value);
    else onValueChange?.(selected.includes(item.value) ? selected.filter(entry => entry !== item.value) : [...selected, item.value]);
  };
  const children = items.map(item => {
    const pressed = selected.includes(item.value);
    const inactive = disabled || item.disabled;
    if (type === "multiple") return jsx(Toggle, {
      ...(id ? { id: `${id}-item-${item.value}` } : {}), pressed, label: item.label, disabled: inactive,
      onPressedChange: () => choose(item), children: item.content ?? item.label,
    }, item.value);
    return jsx(Pressable, {
      ...(id ? { id: `${id}-item-${item.value}` } : {}),
      disabled: inactive,
      control: { role: "radio", label: item.label, checked: pressed },
      onClick: () => choose(item),
      style: { height: 36, minWidth: 36, padding: { left: 10, right: 10 }, align: "center", justify: "center",
        background: pressed ? c.secondary : transparent, borderWidth: 0, borderColor: c.border,
        hover: { background: c.muted }, disabled: { background: c.disabled, foreground: c.disabledForeground } },
      children: typeof (item.content ?? item.label) === "string" || typeof (item.content ?? item.label) === "number"
        ? jsx(Text, { weight: 500, color: inactive ? c.disabledForeground : c.foreground, children: item.content ?? item.label })
        : item.content,
    }, item.value);
  });
  return jsx(Row, { ...props, ...(id ? { id } : {}),
    control: type === "single"
      ? { role: "radiogroup", orientation: "horizontal" }
      : { role: "togglegroup", orientation: "horizontal" },
    gap: 2, style, children });
}

export type TypographyVariant = "h1" | "h2" | "h3" | "h4" | "p" | "lead" | "large" | "small" | "muted" | "code" | "blockquote";
export interface TypographyProps extends BaseProps {
  variant?: TypographyVariant;
}
export function Typography({ variant = "p", children, style, ...props }: TypographyProps): VNode {
  const variants: Record<TypographyVariant, Style> = {
    h1: { fontSize: 32, fontWeight: 700, lineHeight: 1.15 },
    h2: { fontSize: 26, fontWeight: 650, lineHeight: 1.2 },
    h3: { fontSize: 22, fontWeight: 600, lineHeight: 1.25 },
    h4: { fontSize: 18, fontWeight: 600, lineHeight: 1.3 },
    p: { fontSize: 14, fontWeight: 400, lineHeight: 1.6 },
    lead: { fontSize: 18, fontWeight: 400, foreground: c.mutedForeground },
    large: { fontSize: 16, fontWeight: 600 },
    small: { fontSize: 12, fontWeight: 500 },
    muted: { fontSize: 13, fontWeight: 400, foreground: c.mutedForeground },
    code: { fontSize: 12, fontWeight: 500, fontFamily: "Consolas", background: c.muted },
    blockquote: { fontSize: 14, fontWeight: 400, foreground: c.mutedForeground, borderWidth: { left: 3 }, borderColor: c.border,
      padding: { left: 12 } },
  };
  const selected = variants[variant];
  if (variant === "code") return jsx(Text, { ...props, size: selected.fontSize, weight: selected.fontWeight,
    color: selected.foreground, style: { padding: { left: 6, right: 6, top: 3, bottom: 3 }, radius: 4,
      ...selected, ...style }, children });
  return jsx(Text, { ...props, size: selected.fontSize, weight: selected.fontWeight, color: selected.foreground,
    style: { ...selected, ...style }, children });
}

export interface DirectionProps extends BaseProps {
  dir?: "ltr" | "rtl";
  orientation?: "horizontal" | "vertical";
  gap?: number;
}
/** Layout direction helper. RTL reverses visual horizontal flow while preserving logical/focus order. Text bidi is not changed. */
export function Direction({ dir = "ltr", orientation = "horizontal", gap = 0, children, style, ...props }: DirectionProps): VNode {
  const Component = orientation === "horizontal" ? Row : Column;
  const direction: Style["direction"] = orientation === "horizontal"
    ? (dir === "rtl" ? "row-reverse" : "row")
    : "column";
  return jsx(Component, { ...props, gap, style: { ...style, direction }, children });
}
