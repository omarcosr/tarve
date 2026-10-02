import type { Style } from "../../protocol/src/index";
import { Fragment, jsx, type BaseProps, type Child, type VNode } from "./jsx-runtime";
import {
  Button,
  Circle,
  Column,
  Icon,
  Image,
  Modal,
  Path,
  Pressable,
  Row,
  Svg,
  Text,
  View,
  type ButtonProps,
} from "./components";
import { buttonVariants, theme } from "./theme";

const c = theme.colors;
const transparent = "#00000000";

export interface SkeletonProps extends BaseProps {
  width?: Style["width"];
  height?: Style["height"];
  radius?: number;
}

export function Skeleton({ width = "100%", height = 16, radius = theme.radius.sm, style, ...props }: SkeletonProps): VNode {
  return jsx(View, {
    ...props,
    style: { width, height, radius, shrink: 0, background: c.muted, ...style },
  });
}

export interface SpinnerProps extends BaseProps {
  size?: number;
  label?: string;
}

/** A loading indicator: an arc that turns once every 800 ms, rotated natively by `style.spin`. */
export function Spinner({ size = 18, label = "Loading", style, ...props }: SpinnerProps): VNode {
  return jsx(Svg, {
    ...props,
    control: { role: "progress", label },
    size,
    viewBox: "0 0 24 24",
    strokeWidth: 2.5,
    color: c.foreground,
    style: { spin: 800, ...style },
    children: [
      jsx(Circle, { cx: 12, cy: 12, r: 9, opacity: 0.2 }),
      jsx(Path, { d: "M12 3a9 9 0 0 1 9 9" }),
    ],
  });
}

export interface AvatarProps extends BaseProps {
  src?: string;
  fallback?: string;
  size?: number;
  fit?: "cover" | "contain";
}

export function Avatar({ src, fallback = "?", size = 40, fit = "cover", style, id, ...props }: AvatarProps): VNode {
  const radius = size / 2;
  return jsx(View, {
    ...props,
    ...(id ? { id } : {}),
    style: {
      position: "relative",
      width: size,
      height: size,
      radius,
      shrink: 0,
      align: "center",
      justify: "center",
      background: c.muted,
      ...style,
    },
    children: src
      ? jsx(Image, {
          ...(id ? { id: `${id}-image` } : {}),
          src,
          fit,
          style: { width: "100%", height: "100%", radius },
        })
      : jsx(Text, {
          ...(id ? { id: `${id}-fallback` } : {}),
          size: Math.max(11, Math.round(size * 0.36)),
          weight: 600,
          color: c.mutedForeground,
          children: fallback,
        }),
  });
}

export interface BreadcrumbItem {
  label: string;
  disabled?: boolean;
  onClick?: () => void;
}

export interface BreadcrumbProps extends BaseProps {
  items: BreadcrumbItem[];
  separator?: Child;
}

export function Breadcrumb({ items, separator = "/", style, id, ...props }: BreadcrumbProps): VNode {
  const children: Child[] = [];
  items.forEach((item, index) => {
    if (index > 0) {
      children.push(typeof separator === "string" || typeof separator === "number"
        ? jsx(Text, {
            ...(id ? { id: `${id}-separator-${index}` } : {}),
            size: 13,
            color: c.mutedForeground,
            children: separator,
          })
        : separator);
    }
    const current = index === items.length - 1;
    if (item.onClick && !current) {
      children.push(
        jsx(Pressable, {
          ...(id ? { id: `${id}-item-${index}` } : {}),
          disabled: item.disabled,
          control: { role: "button", label: item.label },
          onClick: item.onClick,
          style: {
            padding: { left: 4, right: 4, top: 2, bottom: 2 },
            radius: theme.radius.sm,
            background: transparent,
            hover: { background: c.muted },
          },
          children: jsx(Text, {
            size: 13,
            color: item.disabled ? c.disabledForeground : c.mutedForeground,
            children: item.label,
          }),
        }),
      );
    } else {
      children.push(
        jsx(Text, {
          ...(id ? { id: `${id}-item-${index}` } : {}),
          size: 13,
          weight: current ? 500 : 400,
          color: current ? c.foreground : c.mutedForeground,
          children: item.label,
        }),
      );
    }
  });
  return jsx(Row, { ...props, ...(id ? { id } : {}), gap: 4, style, children });
}

function paginationRange(page: number, pageCount: number, siblingCount: number): Array<number | "ellipsis"> {
  const wanted = new Set<number>([1, pageCount]);
  for (let value = page - siblingCount; value <= page + siblingCount; value += 1) {
    if (value >= 1 && value <= pageCount) wanted.add(value);
  }
  const ordered = [...wanted].sort((a, b) => a - b);
  const result: Array<number | "ellipsis"> = [];
  for (let index = 0; index < ordered.length; index += 1) {
    if (index > 0 && ordered[index] - ordered[index - 1] > 1) result.push("ellipsis");
    result.push(ordered[index]);
  }
  return result;
}

export interface PaginationProps extends BaseProps {
  page: number;
  pageCount: number;
  siblingCount?: number;
  disabled?: boolean;
  onPageChange?: (page: number) => void;
}

export function Pagination({
  page,
  pageCount,
  siblingCount = 1,
  disabled,
  onPageChange,
  style,
  id,
  ...props
}: PaginationProps): VNode {
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new RangeError("Pagination pageCount must be a positive integer");
  if (!Number.isInteger(page) || page < 1 || page > pageCount) throw new RangeError("Pagination page must be within pageCount");
  if (!Number.isInteger(siblingCount) || siblingCount < 0) throw new RangeError("Pagination siblingCount must be a non-negative integer");

  const buttonStyle: Style = { minWidth: 34, padding: { left: 8, right: 8 } };
  const go = (next: number) => () => onPageChange?.(next);
  const children: Child[] = [
    jsx(Button, {
      ...(id ? { id: `${id}-previous` } : {}),
      variant: "outline",
      size: "sm",
      disabled: disabled || page === 1,
      onClick: go(page - 1),
      style: buttonStyle,
      children: "‹",
    }),
  ];
  let ellipsisIndex = 0;
  for (const value of paginationRange(page, pageCount, siblingCount)) {
    if (value === "ellipsis") {
      children.push(
        jsx(Text, {
          ...(id ? { id: `${id}-ellipsis-${ellipsisIndex++}` } : {}),
          size: 13,
          color: c.mutedForeground,
          style: { width: 24, textAlign: "center" },
          children: "…",
        }),
      );
      continue;
    }
    children.push(
      jsx(Button, {
        ...(id ? { id: `${id}-page-${value}` } : {}),
        variant: value === page ? "default" : "ghost",
        size: "sm",
        disabled,
        onClick: go(value),
        style: buttonStyle,
        children: value,
      }),
    );
  }
  children.push(
    jsx(Button, {
      ...(id ? { id: `${id}-next` } : {}),
      variant: "outline",
      size: "sm",
      disabled: disabled || page === pageCount,
      onClick: go(page + 1),
      style: buttonStyle,
      children: "›",
    }),
  );
  return jsx(Row, { ...props, ...(id ? { id } : {}), gap: 4, style, children });
}

const calendarMonths = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;
const calendarWeekdays = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

export type CalendarWeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6;

interface ParsedDate {
  year: number;
  month: number;
  day: number;
  serial: number;
}

function parseCalendarDate(value: string, label: string): ParsedDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`${label} must use YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const serial = Date.UTC(year, month - 1, day);
  const parsed = new Date(serial);
  if (
    !Number.isFinite(serial)
    || parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new RangeError(`${label} must be a valid calendar date`);
  }
  return { year, month, day, serial };
}

function parseCalendarMonth(value: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError("Calendar month must use YYYY-MM");
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new RangeError("Calendar month must be between 01 and 12");
  return { year, month };
}

function calendarDateString(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function calendarMonthString(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function moveCalendarMonth(value: string, amount: number): string {
  const { year, month } = parseCalendarMonth(value);
  const date = new Date(Date.UTC(year, month - 1 + amount, 1));
  return calendarMonthString(date.getUTCFullYear(), date.getUTCMonth() + 1);
}

function validateCalendarInputs(
  month: string,
  value?: string,
  min?: string,
  max?: string,
  weekStartsOn: CalendarWeekStartsOn = 0,
): { selected?: ParsedDate; minimum?: ParsedDate; maximum?: ParsedDate } {
  parseCalendarMonth(month);
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) {
    throw new RangeError("Calendar weekStartsOn must be between 0 and 6");
  }
  const selected = value === undefined ? undefined : parseCalendarDate(value, "Calendar value");
  const minimum = min === undefined ? undefined : parseCalendarDate(min, "Calendar min");
  const maximum = max === undefined ? undefined : parseCalendarDate(max, "Calendar max");
  if (minimum && maximum && minimum.serial > maximum.serial) {
    throw new RangeError("Calendar min must be before or equal to max");
  }
  if (selected && minimum && selected.serial < minimum.serial) {
    throw new RangeError("Calendar value must be on or after min");
  }
  if (selected && maximum && selected.serial > maximum.serial) {
    throw new RangeError("Calendar value must be on or before max");
  }
  return { selected, minimum, maximum };
}

export interface CalendarProps extends BaseProps {
  month: string;
  value?: string;
  min?: string;
  max?: string;
  weekStartsOn?: CalendarWeekStartsOn;
  disabled?: boolean;
  isDateDisabled?: (date: string) => boolean;
  onValueChange?: (date: string) => void;
  onMonthChange?: (month: string) => void;
}

export function Calendar({
  month,
  value,
  min,
  max,
  weekStartsOn = 0,
  disabled,
  isDateDisabled,
  onValueChange,
  onMonthChange,
  style,
  id,
  ...props
}: CalendarProps): VNode {
  const { selected, minimum, maximum } = validateCalendarInputs(month, value, min, max, weekStartsOn);
  const visible = parseCalendarMonth(month);
  const daysInMonth = new Date(Date.UTC(visible.year, visible.month, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(visible.year, visible.month - 1, 1)).getUTCDay();
  const leading = (firstWeekday - weekStartsOn + 7) % 7;
  const trailing = (7 - ((leading + daysInMonth) % 7)) % 7;
  const weekdayLabels = Array.from({ length: 7 }, (_, index) => calendarWeekdays[(weekStartsOn + index) % 7]);
  const cells: Child[] = [];
  for (let index = 0; index < leading; index += 1) {
    cells.push(jsx(View, { style: { width: 34, height: 34 } }, `leading-${index}`));
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = calendarDateString(visible.year, visible.month, day);
    const parsed = parseCalendarDate(date, "Calendar date");
    const blocked = disabled
      || (minimum !== undefined && parsed.serial < minimum.serial)
      || (maximum !== undefined && parsed.serial > maximum.serial)
      || isDateDisabled?.(date) === true;
    const active = selected?.serial === parsed.serial;
    const variant = buttonVariants[active ? "default" : "ghost"];
    cells.push(
      jsx(Pressable, {
        ...(id ? { id: `${id}-day-${date}` } : {}),
        disabled: blocked,
        control: { role: "radio", label: date, checked: active },
        onClick: () => onValueChange?.(date),
        style: {
          width: 34,
          minWidth: 34,
          height: 34,
          padding: 0,
          align: "center",
          justify: "center",
          shrink: 0,
          ...variant,
          disabled: { background: c.disabled, foreground: c.disabledForeground },
        },
        children: jsx(Text, {
          size: 13,
          weight: 500,
          color: blocked ? c.disabledForeground : active ? c.primaryForeground : c.foreground,
          children: day,
        }),
      }, date),
    );
  }
  for (let index = 0; index < trailing; index += 1) {
    cells.push(jsx(View, { style: { width: 34, height: 34 } }, `trailing-${index}`));
  }

  return jsx(Column, {
    ...props,
    ...(id ? { id } : {}),
    gap: 10,
    style: {
      width: 270,
      padding: 12,
      background: c.card,
      borderWidth: 1,
      borderColor: c.border,
      radius: theme.radius.md,
      ...style,
    },
    children: [
      jsx(Row, {
        align: "center",
        justify: "between",
        children: [
          jsx(Button, {
            ...(id ? { id: `${id}-previous` } : {}),
            variant: "ghost",
            size: "sm",
            disabled,
            onClick: () => onMonthChange?.(moveCalendarMonth(month, -1)),
            style: { width: 32, minWidth: 32, padding: 0 },
            children: "‹",
          }),
          jsx(Text, {
            ...(id ? { id: `${id}-label` } : {}),
            size: 14,
            weight: 600,
            children: `${calendarMonths[visible.month - 1]} ${visible.year}`,
          }),
          jsx(Button, {
            ...(id ? { id: `${id}-next` } : {}),
            variant: "ghost",
            size: "sm",
            disabled,
            onClick: () => onMonthChange?.(moveCalendarMonth(month, 1)),
            style: { width: 32, minWidth: 32, padding: 0 },
            children: "›",
          }),
        ],
      }),
      jsx(View, {
        style: { display: "grid", columns: 7, gap: 4 },
        children: weekdayLabels.map((label, index) => jsx(Text, {
          size: 11,
          weight: 500,
          color: c.mutedForeground,
          style: { width: 34, textAlign: "center" },
          children: label,
        }, `weekday-${index}`)),
      }),
      jsx(View, {
        ...(id ? { id: `${id}-grid` } : {}),
        control: { role: "radiogroup", orientation: "horizontal" },
        style: { display: "grid", columns: 7, gap: 4 },
        children: cells,
      }),
    ],
  });
}

export interface DatePickerProps extends BaseProps {
  open: boolean;
  month: string;
  value?: string;
  placeholder?: string;
  min?: string;
  max?: string;
  weekStartsOn?: CalendarWeekStartsOn;
  disabled?: boolean;
  isDateDisabled?: (date: string) => boolean;
  formatValue?: (date: string) => string;
  onOpenChange?: (open: boolean) => void;
  onValueChange?: (date: string) => void;
  onMonthChange?: (month: string) => void;
}

function defaultDatePickerLabel(value: string): string {
  const parsed = parseCalendarDate(value, "DatePicker value");
  return `${calendarMonths[parsed.month - 1]} ${parsed.day}, ${parsed.year}`;
}

export function DatePicker({
  open,
  month,
  value,
  placeholder = "Pick a date",
  min,
  max,
  weekStartsOn = 0,
  disabled,
  isDateDisabled,
  formatValue = defaultDatePickerLabel,
  onOpenChange,
  onValueChange,
  onMonthChange,
  style,
  id,
  ...props
}: DatePickerProps): VNode {
  validateCalendarInputs(month, value, min, max, weekStartsOn);
  const choose = (date: string) => {
    onValueChange?.(date);
    onOpenChange?.(false);
  };
  return jsx(View, {
    ...props,
    ...(id ? { id } : {}),
    style: { position: "relative", width: 270, ...style },
    children: [
      jsx(Button, {
        ...(id ? { id: `${id}-trigger` } : {}),
        variant: "outline",
        disabled,
        onClick: () => onOpenChange?.(!open),
        style: { width: "100%", justify: "start" },
        children: value ? formatValue(value) : placeholder,
      }),
      open && !disabled
        ? jsx(Calendar, {
            ...(id ? { id: `${id}-calendar` } : {}),
            portal: true,
            dismissOnOutside: true,
            onOutsideClick: () => onOpenChange?.(false),
            month,
            value,
            min,
            max,
            weekStartsOn,
            isDateDisabled,
            onValueChange: choose,
            onMonthChange,
            style: { position: "absolute", top: 42, left: 0, zIndex: 100, pointerEvents: "block" },
          })
        : null,
    ],
  });
}

export interface CollapsibleProps extends BaseProps {
  open: boolean;
  trigger: Child;
  label?: string;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Collapsible({ open, trigger, label = "Toggle section", disabled, onOpenChange, children, style, id, ...props }: CollapsibleProps): VNode {
  return jsx(Column, {
    ...props,
    ...(id ? { id } : {}),
    style,
    children: [
      jsx(Pressable, {
        ...(id ? { id: `${id}-trigger` } : {}),
        disabled,
        control: { role: "button", label, expanded: open },
        onClick: () => onOpenChange?.(!open),
        style: { background: transparent },
        children: trigger,
      }),
      open
        ? jsx(Column, {
            ...(id ? { id: `${id}-content` } : {}),
            children,
          })
        : null,
    ],
  });
}

function asCell(value: Child): Child {
  if (value == null || typeof value === "boolean") return jsx(Text, { children: value == null ? "" : String(value) });
  if (typeof value === "string" || typeof value === "number") return jsx(Text, { size: 13, children: value });
  return value;
}

export interface TableColumn<T> {
  key: string;
  header: Child;
  accessor?: keyof T | ((row: T, index: number) => Child);
  render?: (row: T, index: number) => Child;
  width?: Style["width"];
  align?: Style["align"];
}

export interface TableProps<T> extends BaseProps {
  columns: TableColumn<T>[];
  data: T[];
  rowKey?: (row: T, index: number) => string | number;
  empty?: Child;
  onRowClick?: (row: T, index: number) => void;
}

function tableValue<T>(column: TableColumn<T>, row: T, index: number): Child {
  if (column.render) return column.render(row, index);
  if (typeof column.accessor === "function") return column.accessor(row, index);
  if (column.accessor !== undefined) {
    const value = row[column.accessor];
    if (value == null) return "";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    return String(value);
  }
  return "";
}

export function Table<T>({ columns, data, rowKey, empty = "No results.", onRowClick, style, id, ...props }: TableProps<T>): VNode {
  if (new Set(columns.map(column => column.key)).size !== columns.length) throw new TypeError("Table column keys must be unique");
  const header = jsx(Row, {
    ...(id ? { id: `${id}-header` } : {}),
    style: { minHeight: 40, borderWidth: { bottom: 1 }, borderColor: c.border },
    children: columns.map(column =>
      jsx(View, {
        style: {
          width: column.width,
          flex: column.width === undefined ? 1 : undefined,
          padding: { left: 12, right: 12, top: 8, bottom: 8 },
          align: column.align ?? "start",
          justify: "center",
        },
        children: typeof column.header === "string" || typeof column.header === "number"
          ? jsx(Text, { size: 12, weight: 600, color: c.mutedForeground, children: column.header })
          : column.header,
      }, column.key),
    ),
  });
  const rows = data.map((row, index) => {
    const key = rowKey?.(row, index) ?? index;
    const rowId = id ? `${id}-row-${String(key)}` : undefined;
    const cells = columns.map(column =>
      jsx(View, {
        style: {
          width: column.width,
          flex: column.width === undefined ? 1 : undefined,
          padding: { left: 12, right: 12, top: 10, bottom: 10 },
          align: column.align ?? "start",
          justify: "center",
        },
        children: asCell(tableValue(column, row, index)),
      }, column.key),
    );
    return onRowClick
      ? jsx(Pressable, {
          ...(rowId ? { id: rowId } : {}),
          control: { role: "button", label: `Row ${index + 1}` },
          onClick: () => onRowClick(row, index),
          style: {
            direction: "row",
            minHeight: 42,
            radius: 0,
            borderWidth: index < data.length - 1 ? { bottom: 1 } : 0,
            borderColor: c.border,
            background: transparent,
            hover: { background: c.muted },
          },
          children: cells,
        }, key)
      : jsx(Row, {
          ...(rowId ? { id: rowId } : {}),
          style: {
            minHeight: 42,
            borderWidth: index < data.length - 1 ? { bottom: 1 } : 0,
            borderColor: c.border,
          },
          children: cells,
        }, key);
  });
  const body = data.length > 0
    ? rows
    : jsx(View, {
        ...(id ? { id: `${id}-empty` } : {}),
        style: { minHeight: 72, padding: 16, align: "center", justify: "center" },
        children: asCell(empty),
      });
  return jsx(Column, {
    ...props,
    ...(id ? { id } : {}),
    style: { width: "100%", borderWidth: 1, borderColor: c.border, radius: theme.radius.md, ...style },
    children: [header, body],
  });
}

export type DataTableProps<T> = TableProps<T>;
export function DataTable<T>(props: DataTableProps<T>): VNode {
  return Table(props);
}

export interface AlertDialogProps extends BaseProps {
  open: boolean;
  title: string;
  description?: string;
  cancelLabel?: string;
  actionLabel?: string;
  actionVariant?: ButtonProps["variant"];
  actionDisabled?: boolean;
  closeOnEscape?: boolean;
  onCancel?: () => void;
  onAction?: () => void;
  onOpenChange?: (open: boolean) => void;
}

export function AlertDialog({
  open,
  title,
  description,
  cancelLabel = "Cancel",
  actionLabel = "Continue",
  actionVariant = "default",
  actionDisabled,
  closeOnEscape = false,
  onCancel,
  onAction,
  onOpenChange,
  children,
  style,
  id,
  ...props
}: AlertDialogProps): VNode {
  const close = () => onOpenChange?.(false);
  const footer = [
    jsx(Button, {
      ...(id ? { id: `${id}-cancel` } : {}),
      variant: "outline",
      onClick: () => {
        onCancel?.();
        close();
      },
      children: cancelLabel,
    }),
    jsx(Button, {
      ...(id ? { id: `${id}-action` } : {}),
      variant: actionVariant,
      disabled: actionDisabled,
      onClick: () => {
        onAction?.();
        close();
      },
      children: actionLabel,
    }),
  ];
  return jsx(Modal, {
    ...props,
    ...(id ? { id } : {}),
    open,
    onOpenChange,
    title,
    description,
    footer,
    closeOnOverlay: false,
    closeOnEscape,
    showClose: false,
    style,
    children,
  });
}

export type SheetSide = "left" | "right" | "top" | "bottom";
export interface SheetProps extends BaseProps {
  open: boolean;
  side?: SheetSide;
  size?: Style["width"];
  title?: string;
  description?: string;
  footer?: Child;
  closeOnOverlay?: boolean;
  closeOnEscape?: boolean;
  showClose?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function sheetPlacement(side: SheetSide, size: Style["width"]): Style {
  if (side === "left") return { top: 0, bottom: 0, left: 0, width: size, height: "100%" };
  if (side === "right") return { top: 0, bottom: 0, right: 0, width: size, height: "100%" };
  if (side === "top") return { top: 0, left: 0, right: 0, width: "100%", height: size };
  return { bottom: 0, left: 0, right: 0, width: "100%", height: size };
}

export function Sheet({
  open,
  side = "right",
  size = 400,
  title,
  description,
  footer,
  closeOnOverlay = true,
  closeOnEscape = true,
  showClose = true,
  onOpenChange,
  children,
  style,
  id,
  ...props
}: SheetProps): VNode {
  if (!open) return jsx(Fragment, {});
  const close = () => onOpenChange?.(false);
  const header = title || description
    ? jsx(Column, {
        gap: 5,
        style: { padding: { right: showClose ? 28 : 0 } },
        children: [
          title ? jsx(Text, { size: 18, weight: 600, children: title }) : null,
          description ? jsx(Text, { size: 13, color: c.mutedForeground, children: description }) : null,
        ],
      })
    : null;
  const closeButton = showClose
    ? jsx(Pressable, {
        ...(id ? { id: `${id}-close` } : {}),
        control: { role: "button", label: "Close sheet" },
        onClick: close,
        style: {
          position: "absolute",
          top: 14,
          right: 14,
          width: 30,
          height: 30,
          radius: theme.radius.sm,
          align: "center",
          justify: "center",
          background: transparent,
          hover: { background: c.muted },
        },
        children: jsx(Icon, { name: "x", size: 16, color: c.mutedForeground }),
      })
    : null;
  const panel = jsx(Column, {
    ...(id ? { id: `${id}-content` } : {}),
    ...((title || description) ? {
      control: { role: "group", label: title ?? "", description: description ?? "" },
    } : {}),
    modal: true,
    gap: 18,
    style: {
      position: "absolute",
      ...sheetPlacement(side, size),
      padding: 24,
      background: c.card,
      borderWidth: 1,
      borderColor: c.border,
      pointerEvents: "block",
      ...style,
    },
    children: [header, closeButton, children, footer ? jsx(Row, { gap: 8, justify: "end", children: footer }) : null],
  });
  return jsx(Pressable, {
    ...props,
    ...(id ? { id } : {}),
    portal: true,
    focusable: false,
    onClick: closeOnOverlay ? close : undefined,
    onEscape: closeOnEscape ? close : undefined,
    style: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      background: c.overlay,
      pointerEvents: "block",
    },
    children: panel,
  });
}

export type ToastVariant = "default" | "success" | "destructive";
export interface ToastAction {
  label: string;
  onClick: () => void;
}
export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  variant?: ToastVariant;
  action?: ToastAction;
}
export interface ToastProps extends BaseProps {
  id: string;
  title: string;
  description?: string;
  variant?: ToastVariant;
  action?: ToastAction;
  onDismiss?: (id: string) => void;
}

export function Toast({ id, title, description, variant = "default", action, onDismiss, style, ...props }: ToastProps): VNode {
  const accents: Record<ToastVariant, string> = {
    default: c.border,
    success: c.success,
    destructive: c.destructive,
  };
  return jsx(Row, {
    ...props,
    id,
    gap: 12,
    style: {
      width: 360,
      minHeight: 72,
      padding: 14,
      align: "start",
      background: c.card,
      borderWidth: 1,
      borderColor: accents[variant],
      radius: theme.radius.md,
      ...style,
    },
    children: [
      jsx(Column, {
        gap: 3,
        flex: 1,
        children: [
          jsx(Text, { weight: 600, children: title }),
          description ? jsx(Text, { size: 13, color: c.mutedForeground, children: description }) : null,
        ],
      }),
      action ? jsx(Button, { variant: "outline", size: "sm", onClick: action.onClick, children: action.label }) : null,
      onDismiss
        ? jsx(Pressable, {
            id: `${id}-dismiss`,
            control: { role: "button", label: "Dismiss notification" },
            onClick: () => onDismiss(id),
            style: {
              width: 28,
              height: 28,
              radius: theme.radius.sm,
              align: "center",
              justify: "center",
              background: transparent,
              hover: { background: c.muted },
            },
            children: jsx(Icon, { name: "x", size: 14, color: c.mutedForeground }),
          })
        : null,
    ],
  });
}

export type ToasterPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export interface ToasterProps extends BaseProps {
  toasts: ToastItem[];
  position?: ToasterPosition;
  onDismiss?: (id: string) => void;
}

function toasterPlacement(position: ToasterPosition): Style {
  const style: Style = { position: "absolute", zIndex: 1000 };
  if (position.startsWith("top")) style.top = 16;
  else style.bottom = 16;
  if (position.endsWith("left")) style.left = 16;
  else style.right = 16;
  return style;
}

/** Render-driven toaster: callers own the toast array and remove items in onDismiss. */
export function Toaster({ toasts, position = "bottom-right", onDismiss, style, id, ...props }: ToasterProps): VNode {
  return jsx(Column, {
    ...props,
    ...(id ? { id } : {}),
    portal: true,
    gap: 8,
    style: { ...toasterPlacement(position), ...style },
    children: toasts.map(toast => jsx(Toast, { ...toast, onDismiss }, toast.id)),
  });
}

export interface MenubarItem {
  value: string;
  label: string;
  disabled?: boolean;
  checked?: boolean;
  shortcut?: string;
  onSelect?: () => void;
}
export interface MenubarMenu {
  value: string;
  label: string;
  disabled?: boolean;
  items: MenubarItem[];
}
export interface MenubarProps extends BaseProps {
  menus: MenubarMenu[];
  openMenu?: string;
  onOpenMenuChange?: (value: string | undefined) => void;
  onSelect?: (menuValue: string, itemValue: string) => void;
}

export function Menubar({ menus, openMenu, onOpenMenuChange, onSelect, style, id, ...props }: MenubarProps): VNode {
  if (new Set(menus.map(menu => menu.value)).size !== menus.length) throw new TypeError("Menubar menu values must be unique");
  return jsx(Row, {
    ...props,
    ...(id ? { id } : {}),
    gap: 2,
    style: { position: "relative", padding: 3, background: c.card, borderWidth: 1, borderColor: c.border, radius: theme.radius.sm, ...style },
    children: menus.map(menu => {
      const expanded = openMenu === menu.value;
      return jsx(View, {
        style: { position: "relative" },
        children: [
          jsx(Pressable, {
            ...(id ? { id: `${id}-menu-${menu.value}` } : {}),
            disabled: menu.disabled,
            control: { role: "button", label: menu.label, expanded },
            onClick: () => onOpenMenuChange?.(expanded ? undefined : menu.value),
            style: {
              height: 30,
              padding: { left: 10, right: 10 },
              align: "center",
              justify: "center",
              background: expanded ? c.muted : transparent,
              hover: { background: c.muted },
            },
            children: jsx(Text, { size: 13, weight: 500, children: menu.label }),
          }),
          expanded
            ? jsx(Column, {
                ...(id ? { id: `${id}-content-${menu.value}` } : {}),
                portal: true,
                dismissOnOutside: true,
                onOutsideClick: () => onOpenMenuChange?.(undefined),
                style: {
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  minWidth: 180,
                  padding: 4,
                  background: c.card,
                  borderWidth: 1,
                  borderColor: c.border,
                  radius: theme.radius.md,
                  zIndex: 100,
                },
                children: menu.items.map(item =>
                  jsx(Pressable, {
                    ...(id ? { id: `${id}-item-${menu.value}-${item.value}` } : {}),
                    disabled: item.disabled,
                    control: { role: "menuitem", label: item.label, checked: item.checked },
                    onClick: () => {
                      item.onSelect?.();
                      onSelect?.(menu.value, item.value);
                      onOpenMenuChange?.(undefined);
                    },
                    style: {
                      direction: "row",
                      minHeight: 32,
                      padding: { left: 8, right: 8 },
                      align: "center",
                      justify: "between",
                      background: transparent,
                      hover: { background: c.muted },
                    },
                    children: [
                      jsx(Row, {
                        gap: 7,
                        children: [
                          item.checked ? jsx(Icon, { name: "check", size: 13 }) : jsx(View, { style: { width: 13 } }),
                          jsx(Text, { size: 13, color: item.disabled ? c.disabledForeground : c.foreground, children: item.label }),
                        ],
                      }),
                      item.shortcut ? jsx(Text, { size: 12, color: c.mutedForeground, children: item.shortcut }) : null,
                    ],
                  }, item.value),
                ),
              })
            : null,
        ],
      }, menu.value);
    }),
  });
}

export type HoverCardSide = "top" | "right" | "bottom" | "left";
export interface HoverCardProps extends BaseProps {
  open: boolean;
  trigger: Child;
  side?: HoverCardSide;
  width?: Style["width"];
  onOpenChange?: (open: boolean) => void;
}

function hoverCardPlacement(side: HoverCardSide): Style {
  if (side === "top") return { bottom: "100%", left: 0 };
  if (side === "right") return { left: "100%", top: 0 };
  if (side === "left") return { right: "100%", top: 0 };
  return { top: "100%", left: 0 };
}

function hoverCardTrigger(trigger: Child, onHover: (hovered: boolean) => void, id?: string): Child {
  if (trigger && typeof trigger === "object" && !Array.isArray(trigger)) {
    const vnode = trigger as VNode;
    const nativeInteractive = typeof vnode.type === "string"
      && ["button", "pressable", "input", "textarea", "slider"].includes(vnode.type);
    if (vnode.type === Button || vnode.type === Pressable || nativeInteractive) {
      const previous = vnode.props.onHover as ((hovered: boolean) => void) | undefined;
      return {
        ...vnode,
        props: {
          ...vnode.props,
          ...(id && vnode.props.id === undefined ? { id: `${id}-trigger` } : {}),
          onHover: (hovered: boolean) => {
            previous?.(hovered);
            onHover(hovered);
          },
        },
      };
    }
  }
  return jsx(Pressable, {
    ...(id ? { id: `${id}-trigger` } : {}),
    focusable: false,
    onHover,
    style: { background: transparent },
    children: trigger,
  });
}

export function HoverCard({ open, trigger, side = "bottom", width = 280, onOpenChange, children, style, id, ...props }: HoverCardProps): VNode {
  const setHovered = (hovered: boolean) => onOpenChange?.(hovered);
  return jsx(View, {
    ...props,
    ...(id ? { id } : {}),
    style: { position: "relative" },
    children: [
      hoverCardTrigger(trigger, setHovered, id),
      open
        ? jsx(Column, {
            ...(id ? { id: `${id}-content` } : {}),
            portal: true,
            style: {
              position: "absolute",
              ...hoverCardPlacement(side),
              width,
              padding: 16,
              background: c.card,
              borderWidth: 1,
              borderColor: c.border,
              radius: theme.radius.md,
              zIndex: 100,
              ...style,
            },
            children,
          })
        : null,
    ],
  });
}
