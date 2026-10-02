import type { Style } from "../../protocol/src/index";
import { jsx, type BaseProps, type Child, type VNode } from "./jsx-runtime";
import { Button, Column, Icon, Pressable, Row, Scroll, Text, Input, View, type IconName } from "./components";
import { Checkbox, RadioGroup, type RadioOption } from "./controls";
import { Field } from "./form-controls";
import { Sheet, type SheetSide } from "./extra-controls";
import { theme } from "./theme";

const c = theme.colors;
const transparent = "#00000000";

export interface CarouselItem {
  value: string;
  content: Child;
  label?: string;
}
export interface CarouselProps extends BaseProps {
  items: readonly CarouselItem[];
  index: number;
  loop?: boolean;
  showIndicators?: boolean;
  previousLabel?: string;
  nextLabel?: string;
  onIndexChange?: (index: number) => void;
}
export function Carousel({ items, index, loop = false, showIndicators = true, previousLabel = "Previous slide",
  nextLabel = "Next slide", onIndexChange, style, id, ...props }: CarouselProps): VNode {
  if (items.length === 0) throw new RangeError("Carousel requires at least one item");
  if (!Number.isInteger(index) || index < 0 || index >= items.length) throw new RangeError("Carousel index must reference an item");
  if (new Set(items.map(item => item.value)).size !== items.length) throw new TypeError("Carousel item values must be unique");
  const go = (amount: number) => {
    const next = index + amount;
    if (loop) onIndexChange?.((next + items.length) % items.length);
    else onIndexChange?.(Math.max(0, Math.min(next, items.length - 1)));
  };
  return jsx(Column, {
    ...props,
    ...(id ? { id } : {}),
    gap: 10,
    style,
    children: [
      jsx(View, { ...(id ? { id: `${id}-viewport` } : {}), style: { width: "100%", position: "relative" },
        children: items[index].content }),
      jsx(Row, { align: "center", justify: "between", children: [
        jsx(Button, { ...(id ? { id: `${id}-previous` } : {}), variant: "outline", size: "sm",
          disabled: !loop && index === 0, onClick: () => go(-1), children: previousLabel }),
        showIndicators ? jsx(Row, { ...(id ? { id: `${id}-indicators` } : {}), gap: 6,
          control: { role: "radiogroup", orientation: "horizontal" }, children: items.map((item, itemIndex) => jsx(Pressable, {
          ...(id ? { id: `${id}-indicator-${item.value}` } : {}),
          control: { role: "radio", label: item.label ?? `Slide ${itemIndex + 1}`, checked: itemIndex === index },
          onClick: () => onIndexChange?.(itemIndex),
          style: { width: 8, height: 8, radius: 4, padding: 0, background: itemIndex === index ? c.primary : c.border },
        }, item.value)) }) : null,
        jsx(Button, { ...(id ? { id: `${id}-next` } : {}), variant: "outline", size: "sm",
          disabled: !loop && index === items.length - 1, onClick: () => go(1), children: nextLabel }),
      ] }),
    ],
  });
}

export interface ChartDatum {
  label: string;
  value: number;
  color?: string;
}
export interface ChartProps extends BaseProps {
  data: readonly ChartDatum[];
  max?: number;
  height?: number;
  barWidth?: number;
  showValues?: boolean;
  showLabels?: boolean;
}
export function Chart({ data, max, height = 180, barWidth = 36, showValues = true, showLabels = true,
  style, id, ...props }: ChartProps): VNode {
  if (data.some(datum => !Number.isFinite(datum.value) || datum.value < 0)) throw new RangeError("Chart values must be finite and non-negative");
  if (!Number.isFinite(height) || height <= 0) throw new RangeError("Chart height must be greater than zero");
  if (!Number.isFinite(barWidth) || barWidth <= 0) throw new RangeError("Chart barWidth must be greater than zero");
  const ceiling = max ?? Math.max(1, ...data.map(datum => datum.value));
  if (!Number.isFinite(ceiling) || ceiling <= 0) throw new RangeError("Chart max must be greater than zero");
  return jsx(Row, {
    ...props,
    ...(id ? { id } : {}),
    gap: 10,
    align: "end",
    style: { width: "100%", height, borderWidth: { bottom: 1 }, borderColor: c.border, ...style },
    children: data.map((datum, index) => {
      const ratio = Math.max(0, Math.min(datum.value / ceiling, 1));
      return jsx(Column, {
        ...(id ? { id: `${id}-item-${index}` } : {}),
        gap: 4,
        align: "center",
        style: { width: barWidth, height: "100%", shrink: 0 },
        children: [
          showValues ? jsx(Text, { size: 11, color: c.mutedForeground, children: datum.value }) : null,
          jsx(View, { ...(id ? { id: `${id}-plot-${index}` } : {}),
            flex: 1, style: { width: "100%", minHeight: 0, justify: "end" },
            children: jsx(View, { ...(id ? { id: `${id}-bar-${index}` } : {}),
              control: { role: "progress", label: datum.label, value: datum.value, min: 0, max: ceiling },
              style: { width: "100%", height: `${ratio * 100}%`, minHeight: datum.value > 0 ? 2 : 0,
                radius: theme.radius.sm, background: datum.color ?? c.primary } }) }),
          showLabels ? jsx(Text, { size: 11, color: c.mutedForeground, style: { textAlign: "center" }, children: datum.label }) : null,
        ],
      }, `${datum.label}-${index}`);
    }),
  });
}

export interface DrawerProps extends BaseProps {
  open: boolean;
  side?: SheetSide;
  title?: string;
  description?: string;
  size?: Style["width"];
  showClose?: boolean;
  closeOnOverlay?: boolean;
  closeOnEscape?: boolean;
  onOpenChange?: (open: boolean) => void;
}
export function Drawer({ side = "bottom", size = 320, ...props }: DrawerProps): VNode {
  if (typeof size === "number" && (!Number.isFinite(size) || size <= 0)) throw new RangeError("Drawer size must be greater than zero");
  return jsx(Sheet, { ...props, side, size });
}

export interface NavigationMenuLink {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}
export interface NavigationMenuItem {
  value: string;
  label: string;
  disabled?: boolean;
  links?: readonly NavigationMenuLink[];
}
export interface NavigationMenuProps extends BaseProps {
  items: readonly NavigationMenuItem[];
  value?: string;
  openValue?: string;
  onValueChange?: (value: string) => void;
  onOpenValueChange?: (value: string | undefined) => void;
}
export function NavigationMenu({ items, value, openValue, onValueChange, onOpenValueChange, style, id, ...props }: NavigationMenuProps): VNode {
  if (new Set(items.map(item => item.value)).size !== items.length) throw new TypeError("NavigationMenu item values must be unique");
  const selectableValues = items.flatMap(item => item.links?.map(link => link.value) ?? [item.value]);
  if (new Set(selectableValues).size !== selectableValues.length) throw new TypeError("NavigationMenu selectable values must be unique");
  if (value !== undefined && !selectableValues.includes(value)) throw new RangeError("NavigationMenu value must reference a selectable item");
  if (openValue !== undefined && !items.some(item => item.value === openValue && item.links && item.links.length > 0)) {
    throw new RangeError("NavigationMenu openValue must reference an item with links");
  }
  return jsx(Row, {
    ...props,
    ...(id ? { id } : {}),
    control: { role: "navigation", orientation: "horizontal" },
    gap: 4,
    style: { position: "relative", ...style },
    children: items.map(item => {
      const open = openValue === item.value;
      const direct = !item.links || item.links.length === 0;
      const current = direct ? value === item.value : item.links!.some(link => link.value === value);
      return jsx(Column, {
        style: { position: "relative" },
        children: [
          jsx(Pressable, {
            ...(id ? { id: `${id}-trigger-${item.value}` } : {}),
            disabled: item.disabled,
            control: direct
              ? { role: "menuitem", label: item.label, checked: value === item.value }
              : { role: "menuitem", label: item.label, expanded: open },
            onClick: direct ? () => { onValueChange?.(item.value); onOpenValueChange?.(undefined); }
              : () => onOpenValueChange?.(open ? undefined : item.value),
            style: { minHeight: 36, padding: { left: 12, right: direct ? 12 : 8 }, direction: "row", gap: 4, align: "center",
              justify: "center", radius: theme.radius.sm, background: open || current ? c.muted : transparent,
              hover: { background: c.muted } },
            children: [
              jsx(Text, { weight: 500, color: item.disabled ? c.disabledForeground : c.foreground, children: item.label }),
              direct ? null : jsx(Icon, { name: open ? "chevron-up" : "chevron-down", size: 14, color: c.mutedForeground }),
            ],
          }),
          open && !direct ? jsx(Column, {
            ...(id ? { id: `${id}-content-${item.value}` } : {}),
            portal: true,
            dismissOnOutside: true,
            onOutsideClick: () => onOpenValueChange?.(undefined),
            onEscape: () => onOpenValueChange?.(undefined),
            gap: 2,
            style: { position: "absolute", top: "100%", left: 0, margin: { top: 6 }, minWidth: 240, padding: 6, background: c.card,
              borderWidth: 1, borderColor: c.border, radius: theme.radius.md, zIndex: 1000, pointerEvents: "block" },
            children: item.links!.map(link => jsx(Pressable, {
              ...(id ? { id: `${id}-link-${link.value}` } : {}),
              disabled: link.disabled,
              control: { role: "menuitem", label: link.label, checked: value === link.value },
              onClick: () => { onValueChange?.(link.value); onOpenValueChange?.(undefined); },
              style: { minHeight: 40, padding: 8, radius: theme.radius.sm, hover: { background: c.muted },
                background: value === link.value ? c.muted : transparent },
              children: jsx(Column, { gap: 2, children: [
                jsx(Text, { weight: 500, children: link.label }),
                link.description ? jsx(Text, { size: 12, color: c.mutedForeground, children: link.description }) : null,
              ] }),
            }, link.value)),
          }) : null,
        ],
      }, item.value);
    }),
  });
}

export interface ResizableProps extends BaseProps {
  orientation?: "horizontal" | "vertical";
  size: number;
  min?: number;
  max?: number;
  step?: number;
  first: Child;
  second: Child;
  label?: string;
  disabled?: boolean;
  onSizeChange?: (size: number) => void;
}
export function Resizable({ orientation = "horizontal", size, min = 10, max = 90, step = 1, first, second,
  label = "Resize panels", disabled, onSizeChange, style, id, ...props }: ResizableProps): VNode {
  if (!Number.isFinite(size) || !Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step)
      || min < 0 || max > 100 || min >= max || step <= 0) {
    throw new RangeError("Resizable requires finite size/min/max/step, 0 <= min < max <= 100 and step > 0");
  }
  const clamped = Math.max(min, Math.min(size, max));
  const Split = orientation === "horizontal" ? Row : Column;
  const panelStyle = (amount: number): Style => orientation === "horizontal"
    ? { flex: amount, minWidth: 0, height: "100%" }
    : { flex: amount, minHeight: 0, width: "100%" };
  const handleStyle: Style = orientation === "horizontal"
    ? { width: 10, height: "100%", shrink: 0, background: c.border,
        hover: { background: c.mutedForeground }, active: { background: c.primary } }
    : { width: "100%", height: 10, shrink: 0, background: c.border,
        hover: { background: c.mutedForeground }, active: { background: c.primary } };
  return jsx(Split, {
    ...props,
    ...(id ? { id } : {}),
    gap: 0,
    style: { width: "100%", ...style },
    children: [
      jsx(View, { ...(id ? { id: `${id}-first` } : {}), style: panelStyle(clamped), children: first }),
      jsx("splitter", { ...(id ? { id: `${id}-handle` } : {}), disabled, onValueChange: onSizeChange,
        control: { role: "slider", label, orientation, value: clamped, min, max, step }, style: handleStyle }),
      jsx(View, { ...(id ? { id: `${id}-second` } : {}), style: panelStyle(100 - clamped), children: second }),
    ],
  });
}

export interface SidebarItem {
  value: string;
  label: string;
  icon?: IconName;
  disabled?: boolean;
  badge?: Child;
}
export interface SidebarProps extends BaseProps {
  items: readonly SidebarItem[];
  value?: string;
  collapsed?: boolean;
  width?: number;
  collapsedWidth?: number;
  header?: Child;
  footer?: Child;
  onValueChange?: (value: string) => void;
  onCollapsedChange?: (collapsed: boolean) => void;
}
export function Sidebar({ items, value, collapsed = false, width = 248, collapsedWidth = 64, header, footer,
  onValueChange, onCollapsedChange, style, id, ...props }: SidebarProps): VNode {
  if (new Set(items.map(item => item.value)).size !== items.length) throw new TypeError("Sidebar item values must be unique");
  if (![width, collapsedWidth].every(value => Number.isFinite(value) && value > 0)) {
    throw new RangeError("Sidebar widths must be finite and greater than zero");
  }
  return jsx(Column, {
    ...props,
    ...(id ? { id } : {}),
    gap: 8,
    style: { width: collapsed ? collapsedWidth : width, height: "100%", padding: 8, background: c.card,
      borderWidth: { right: 1 }, borderColor: c.border, shrink: 0, ...style },
    children: [
      jsx(Row, { justify: "between", gap: 8, children: [collapsed ? null : header,
        jsx(Button, { ...(id ? { id: `${id}-toggle` } : {}), variant: "ghost", size: "sm",
          onClick: () => onCollapsedChange?.(!collapsed), children: collapsed ? ">" : "<" })] }),
      jsx(Scroll, { ...(id ? { id: `${id}-items` } : {}), flex: 1, style: { width: "100%" }, children:
        jsx(Column, { gap: 2, style: { width: "100%", shrink: 0 }, children: items.map(item => {
          const foreground = item.disabled ? c.disabledForeground : c.foreground;
          const icon = item.icon ? jsx(Icon, { ...(id ? { id: `${id}-icon-${item.value}` } : {}), name: item.icon, size: 16, color: foreground }) : null;
          const label = jsx(Text, { weight: 500, color: foreground, children: item.label });
          const leading = collapsed ? (icon ?? jsx(Text, { weight: 500, color: foreground, children: item.label.slice(0, 1).toUpperCase() }))
            : jsx(Row, { gap: 8, children: [icon, label] });
          return jsx(Pressable, {
            ...(id ? { id: `${id}-item-${item.value}` } : {}),
            disabled: item.disabled,
            control: { role: "toggle", label: item.label, checked: item.value === value },
            onClick: () => onValueChange?.(item.value),
            style: { minHeight: 38, padding: { left: collapsed ? 6 : 10, right: collapsed ? 6 : 10 },
              align: "center", justify: collapsed ? "center" : "between", direction: "row",
              background: item.value === value ? c.muted : transparent, hover: { background: c.muted } },
            children: [leading, collapsed ? null : item.badge],
          }, item.value);
        }) }) }),
      collapsed ? null : footer,
    ],
  });
}

export type QuestionnaireAnswer = string | string[];
export interface QuestionnaireQuestion {
  id: string;
  title: string;
  description?: string;
  type: "text" | "single" | "multiple";
  options?: readonly RadioOption[];
  required?: boolean;
  placeholder?: string;
}
export interface QuestionnaireProps extends BaseProps {
  questions: readonly QuestionnaireQuestion[];
  values: Readonly<Record<string, QuestionnaireAnswer | undefined>>;
  current: number;
  previousLabel?: string;
  nextLabel?: string;
  submitLabel?: string;
  onCurrentChange?: (index: number) => void;
  onValueChange?: (questionId: string, value: QuestionnaireAnswer) => void;
  onSubmit?: () => void;
}
export function Questionnaire({ questions, values, current, previousLabel = "Previous", nextLabel = "Next",
  submitLabel = "Submit", onCurrentChange, onValueChange, onSubmit, style, id, ...props }: QuestionnaireProps): VNode {
  if (questions.length === 0) throw new RangeError("Questionnaire requires at least one question");
  if (!Number.isInteger(current) || current < 0 || current >= questions.length) throw new RangeError("Questionnaire current must reference a question");
  if (new Set(questions.map(question => question.id)).size !== questions.length) throw new TypeError("Questionnaire question ids must be unique");
  for (const candidate of questions) {
    const candidateOptions = candidate.options ?? [];
    if ((candidate.type === "single" || candidate.type === "multiple") && candidateOptions.length === 0) {
      throw new TypeError(`Questionnaire question ${candidate.id} requires options`);
    }
    if (new Set(candidateOptions.map(option => option.value)).size !== candidateOptions.length) {
      throw new TypeError(`Questionnaire question ${candidate.id} option values must be unique`);
    }
    const candidateAnswer = values[candidate.id];
    if (candidateAnswer === undefined) continue;
    if (candidate.type === "text") {
      if (typeof candidateAnswer !== "string") throw new TypeError(`Questionnaire answer ${candidate.id} must be a string`);
    } else if (candidate.type === "single") {
      if (typeof candidateAnswer !== "string"
          || (candidateAnswer !== "" && !candidateOptions.some(option => option.value === candidateAnswer))) {
        throw new TypeError(`Questionnaire answer ${candidate.id} must reference an option`);
      }
    } else {
      if (!Array.isArray(candidateAnswer)
          || new Set(candidateAnswer).size !== candidateAnswer.length
          || candidateAnswer.some(answerValue => !candidateOptions.some(option => option.value === answerValue))) {
        throw new TypeError(`Questionnaire answer ${candidate.id} must contain unique option values`);
      }
    }
  }
  const question = questions[current];
  const answer = values[question.id];
  const options = question.options ?? [];
  const hasAnswer = question.type === "text"
    ? typeof answer === "string" && answer.trim().length > 0
    : question.type === "single"
      ? typeof answer === "string" && options.some(option => option.value === answer)
      : Array.isArray(answer) && answer.length > 0;
  const canContinue = !question.required || hasAnswer;
  let control: Child;
  if (question.type === "text") {
    control = jsx(Input, { ...(id ? { id: `${id}-input-${question.id}` } : {}), value: typeof answer === "string" ? answer : "",
      placeholder: question.placeholder, onChange: (value: string) => onValueChange?.(question.id, value) });
  } else if (question.type === "single") {
    control = jsx(RadioGroup, { ...(id ? { id: `${id}-single-${question.id}` } : {}), value: typeof answer === "string" ? answer : "",
      options: [...options], onValueChange: (value: string) => onValueChange?.(question.id, value) });
  } else {
    const selected = Array.isArray(answer) ? answer : [];
    control = jsx(Column, { gap: 6, children: options.map(option => jsx(Checkbox, {
      ...(id ? { id: `${id}-multiple-${question.id}-${option.value}` } : {}), checked: selected.includes(option.value), label: option.label,
      disabled: option.disabled, onCheckedChange: (checked: boolean) => onValueChange?.(question.id,
        checked ? [...selected, option.value] : selected.filter(value => value !== option.value)),
    }, option.value)) });
  }
  const last = current === questions.length - 1;
  return jsx(Column, {
    ...props,
    ...(id ? { id } : {}),
    gap: 16,
    style: { width: "100%", ...style },
    children: [
      jsx(Row, { justify: "between", children: [
        jsx(Text, { size: 12, color: c.mutedForeground, children: `${current + 1} / ${questions.length}` }),
        jsx(Text, { size: 12, color: c.mutedForeground, children: `${Math.round(((current + 1) / questions.length) * 100)}%` }),
      ] }),
      jsx(Field, { ...(id ? { id: `${id}-field-${question.id}` } : {}), label: question.title, description: question.description,
        required: question.required, children: control }),
      jsx(Row, { justify: "between", children: [
        jsx(Button, { ...(id ? { id: `${id}-previous` } : {}), variant: "outline", disabled: current === 0,
          onClick: () => onCurrentChange?.(current - 1), children: previousLabel }),
        jsx(Button, { ...(id ? { id: last ? `${id}-submit` : `${id}-next` } : {}), disabled: !canContinue,
          onClick: () => last ? onSubmit?.() : onCurrentChange?.(current + 1), children: last ? submitLabel : nextLabel }),
      ] }),
    ],
  });
}
