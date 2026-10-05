import type { Child, VNode } from "./jsx-runtime";
import { jsx } from "./jsx-runtime";
import { Button } from "./components/button";
import { Text } from "./components/text";
import { Column, Row, View } from "./components/layout";
import { Pressable } from "./components/pressable";
import { Checkbox, Progress, RadioGroup, Slider } from "./controls";
import { DatePicker } from "./extra-controls";
import { canonicalizeIntrinsicStyle } from "./intrinsic-style";
import { theme } from "./theme";

/**
 * HTML elements that are not single native nodes: the remaining `<input>` types,
 * `<form>`, `<fieldset>`, lists, tables and `<details>`. Each expands to Tarve
 * components with the browser's user-agent defaults. Uncontrolled elements keep
 * their state here, keyed by id, the way a browser keeps it in the DOM.
 */

export const HTML_ELEMENTS = new Set(["pre", "blockquote", "meter", "form", "fieldset", "legend", "ul", "ol", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "details", "summary"]);
export const HTML_INPUT_TYPES = new Set(["checkbox", "radio", "range", "date", "file"]);

const state = new Map<string, unknown>();
/** Named values of a form, kept across renders like the DOM keeps field values. */
export function formValues(key: string): Map<string, FormValue> {
  const id = `form:${key}`;
  let values = state.get(id) as Map<string, FormValue> | undefined;
  if (!values) state.set(id, values = new Map());
  return values;
}
/** Forgets uncontrolled HTML element state (tests and remounts). */
export function resetHtmlState(): void { state.clear(); }

export type FormValue = string | boolean | string[];
export interface FormContext {
  values: Map<string, FormValue>;
  required: Set<string>;
  submit(): void;
}

interface ActiveApp {
  openFileDialog(options?: { filters?: { name: string; extensions: string[] }[] }): Promise<string | undefined>;
  openFilesDialog(options?: { filters?: { name: string; extensions: string[] }[] }): Promise<string[]>;
  update(): void;
}
const ACTIVE_APP = Symbol.for("tarve.activeApp");
function activeApp(): ActiveApp | undefined {
  return (globalThis as Record<symbol, ActiveApp | undefined>)[ACTIVE_APP];
}

function uncontrolled<T>(key: string, controlled: T | undefined, initial: T): T {
  if (controlled !== undefined) return controlled;
  return (state.has(key) ? state.get(key) : initial) as T;
}

function acceptFilters(accept: unknown): { name: string; extensions: string[] }[] | undefined {
  if (typeof accept !== "string" || !accept.trim()) return undefined;
  const extensions = accept.split(",").map(part => part.trim()).filter(part => part.startsWith(".")).map(part => part.slice(1));
  return extensions.length ? [{ name: "Accepted files", extensions }] : undefined;
}

/** `<input type="checkbox|radio|range|date|file">`. */
export function expandInput(props: Record<string, any>, key: string, form: FormContext | undefined): VNode {
  const id = String(props.id ?? key);
  const name = props.name as string | undefined;
  const style = canonicalizeIntrinsicStyle(props.style);
  const record = (value: FormValue) => { if (form && name) form.values.set(name, value); };
  if (form && name && props.required) form.required.add(name);
  switch (props.type) {
    case "checkbox": {
      const checked = uncontrolled<boolean>(id, props.checked, props.defaultChecked === true);
      if (!form?.values.has(name ?? "")) record(checked);
      return Checkbox({ id, style, label: props.label ?? props.ariaLabel ?? "", checked, disabled: props.disabled,
        onCheckedChange: next => { state.set(id, next); record(next); props.onCheckedChange?.(next); props.onChange?.(String(next)); } });
    }
    case "radio": {
      const group = `radio:${name ?? id}`;
      const value = String(props.value ?? "on");
      const selected = props.checked !== undefined ? (props.checked ? value : undefined) : uncontrolled<string | undefined>(group, undefined, props.defaultChecked ? value : undefined);
      if (props.checked === undefined && props.defaultChecked && !state.has(group)) state.set(group, value);
      if (selected === value) record(value);
      return RadioGroup({ id, style, value: selected === value ? value : "", disabled: props.disabled,
        options: [{ value, label: props.label ?? props.ariaLabel ?? "" }],
        onValueChange: next => { state.set(group, next); record(next); props.onChange?.(next); } });
    }
    case "range": {
      const min = Number(props.min ?? 0);
      const max = Number(props.max ?? 100);
      const fallback = max < min ? min : min + (max - min) / 2;
      const value = Number(uncontrolled<string | number>(id, props.value, props.defaultValue ?? fallback));
      record(String(value));
      return Slider({ id, style, value, min, max, step: Number(props.step ?? 1), label: props.label ?? props.ariaLabel, disabled: props.disabled,
        onValueChange: next => { state.set(id, next); record(String(next)); props.onChange?.(String(next)); } });
    }
    case "date": {
      const value = uncontrolled<string | undefined>(id, props.value, props.defaultValue);
      if (value) record(value);
      const open = (state.get(`${id}:open`) as boolean | undefined) ?? false;
      const month = (state.get(`${id}:month`) as string | undefined) ?? (value ?? new Date().toISOString()).slice(0, 7);
      return DatePicker({ id, style, value, open, month, min: props.min, max: props.max, disabled: props.disabled, placeholder: props.placeholder ?? "yyyy-mm-dd",
        onOpenChange: next => { state.set(`${id}:open`, next); },
        onMonthChange: next => { state.set(`${id}:month`, next); },
        onValueChange: next => { state.set(id, next); record(next); props.onChange?.(next); } });
    }
    case "file": {
      const files = uncontrolled<string[]>(id, undefined, []);
      record(props.multiple ? files : files[0] ?? "");
      const label = files.length === 0 ? "No file chosen" : files.length === 1 ? files[0]!.split(/[\\/]/).pop()! : `${files.length} files`;
      return Row({ id, gap: 8, align: "center", style, children: [
        Button({ id: `${id}-choose`, variant: "outline", size: "sm", disabled: props.disabled, children: props.multiple ? "Choose files…" : "Choose file…",
          onClick: () => {
            const app = activeApp();
            if (!app) throw new Error("<input type=\"file\"> needs a running app");
            const options = { filters: acceptFilters(props.accept) };
            const done = (paths: string[]) => {
              if (paths.length === 0) return;
              state.set(id, paths);
              record(props.multiple ? paths : paths[0]!);
              props.onFiles?.(paths);
              props.onChange?.(paths[0]!);
              app.update();
            };
            if (props.multiple) void app.openFilesDialog(options).then(done);
            else void app.openFileDialog(options).then(path => done(path ? [path] : []));
          } }),
        Text({ id: `${id}-name`, color: theme.colors.mutedForeground, children: label }),
      ] });
    }
  }
  throw new Error(`Unsupported input type: ${String(props.type)}`);
}

function childList(children: Child): Child[] {
  return (Array.isArray(children) ? children.flat(Infinity as 1) : [children]).filter(child => child != null && typeof child !== "boolean") as Child[];
}
function isElement(child: Child, type: string): child is VNode {
  return typeof child === "object" && child != null && !Array.isArray(child) && (child as VNode).type === type;
}
function block(props: Record<string, any>, extra: Record<string, unknown>, children: Child): VNode {
  return View({ ...(props.id ? { id: props.id } : {}), style: { ...extra, ...canonicalizeIntrinsicStyle(props.style) }, children } as never);
}

/** Lists, tables, fieldsets and details, with Chromium's user-agent spacing. */
export function expandHtml(type: string, props: Record<string, any>, key: string): VNode {
  const children = props.children as Child;
  switch (type) {
    case "pre":
      // User-agent: white-space: pre; font-family: monospace.
      return jsx("p", { ...props, style: { fontFamily: "monospace", whiteSpace: "pre", ...canonicalizeIntrinsicStyle(props.style) } });
    case "blockquote":
      return block(props, { direction: "column", margin: { left: 40, right: 40 } }, children);
    case "meter": {
      const min = Number(props.min ?? 0);
      const max = Number(props.max ?? 1);
      const value = Math.min(max, Math.max(min, Number(props.value ?? 0)));
      return Progress({ ...(props.id ? { id: props.id } : {}), value: value - min, max: max - min, label: props.ariaLabel ?? props.title ?? "Meter",
        style: { width: 80, height: 16, ...canonicalizeIntrinsicStyle(props.style) } } as never);
    }
    case "fieldset":
      return block(props, { direction: "column", gap: 4, padding: { top: 6, right: 12, bottom: 10, left: 12 }, margin: { left: 2, right: 2 }, borderWidth: 2, borderColor: "#c0c0c0" },
        jsx(View, { control: { role: "group", label: textOf(childList(children).find(child => isElement(child, "legend"))) }, style: { direction: "column", gap: 4 }, children }));
    case "legend":
      return Text({ ...(props.id ? { id: props.id } : {}), weight: 600, style: canonicalizeIntrinsicStyle(props.style), children });
    case "ul":
    case "ol": {
      const items = childList(children);
      let number = Number(props.start ?? 1);
      return block(props, { direction: "column", padding: { left: 40 } }, items.map((item, index) => {
        if (!isElement(item, "li")) return item;
        const marker = type === "ul" ? "•" : `${number++}.`;
        const itemProps = item.props as Record<string, any>;
        return Row({ key: itemProps.id ?? index, align: "start", style: { width: "100%" }, children: [
          View({ style: { position: "absolute", left: -40, width: 34, align: "end" }, children: Text({ children: marker }) }),
          View({ ...(itemProps.id ? { id: itemProps.id } : {}), style: { flex: 1, direction: "column", ...canonicalizeIntrinsicStyle(itemProps.style) }, children: itemProps.children }),
        ] } as never);
      }));
    }
    case "li":
      return block(props, { direction: "column" }, children);
    case "dl":
      return block(props, { direction: "column" }, children);
    case "dt":
      return block(props, { direction: "column" }, children);
    case "dd":
      return block(props, { direction: "column", padding: { left: 40 } }, children);
    case "details": {
      const id = String(props.id ?? key);
      const open = uncontrolled<boolean>(id, props.open, false);
      const items = childList(children);
      const summary = items.find(child => isElement(child, "summary")) as VNode | undefined;
      const rest = items.filter(child => child !== summary);
      const toggle = () => { const next = !open; state.set(id, next); props.onToggle?.(next); };
      return block({ ...props, id }, { direction: "column" }, [
        Pressable({ id: `${id}-summary`, control: { role: "button", label: textOf(summary) || "Details", expanded: open } as never, onClick: toggle,
          style: { direction: "row", gap: 6, align: "center", radius: 0 }, children: [
            Text({ children: open ? "▾" : "▸" }),
            ...(summary ? childList((summary.props as Record<string, any>).children).map(child => typeof child === "string" ? Text({ children: child }) : child) : [Text({ children: "Details" })]),
          ] }),
        ...(open ? rest : []),
      ]);
    }
    case "summary":
      return Text({ children });
    case "table":
      return expandTable(props, key);
    case "thead": case "tbody": case "tfoot": case "tr": case "th": case "td": case "caption":
      throw new Error(`<${type}> must be inside a <table>`);
  }
  throw new Error(`Unknown HTML element <${type}>`);
}

function textOf(child: Child | undefined): string {
  if (child == null || typeof child === "boolean") return "";
  if (typeof child === "string" || typeof child === "number") return String(child);
  if (Array.isArray(child)) return child.map(textOf).join("");
  return textOf((child as VNode).props?.children as Child);
}

/** HTML tables lay out as a CSS grid of auto columns; `border-spacing: 2px`, cell padding 1px. */
function expandTable(props: Record<string, any>, key: string): VNode {
  const rows: { cells: VNode[]; style: Record<string, unknown>; section: string }[] = [];
  let caption: VNode | undefined;
  const collect = (children: Child, section: string) => {
    for (const child of childList(children)) {
      if (isElement(child, "caption")) caption = child;
      else if (isElement(child, "thead") || isElement(child, "tbody") || isElement(child, "tfoot")) collect((child.props as Record<string, any>).children, String(child.type));
      else if (isElement(child, "tr")) {
        const trProps = child.props as Record<string, any>;
        rows.push({ section, style: canonicalizeIntrinsicStyle(trProps.style) as Record<string, unknown>,
          cells: childList(trProps.children).filter(cell => isElement(cell, "td") || isElement(cell, "th")) as VNode[] });
      } else throw new Error("table children must be caption, thead, tbody, tfoot or tr");
    }
  };
  collect(props.children, "tbody");
  // Columns: the widest row, counting colSpan and cells still spanning down from rows above.
  let columns = 1;
  const carried: number[] = [];
  for (const row of rows) {
    let width = 0;
    for (const cell of row.cells) width += Number((cell.props as Record<string, any>).colSpan ?? 1);
    const pending = carried.filter(rowsLeft => rowsLeft > 0).length;
    columns = Math.max(columns, width + pending);
    for (let i = 0; i < carried.length; i++) carried[i]!--;
    for (const cell of row.cells) {
      const span = Number((cell.props as Record<string, any>).rowSpan ?? 1);
      for (let c = 0; c < Number((cell.props as Record<string, any>).colSpan ?? 1); c++) if (span > 1) carried.push(span - 1);
    }
  }
  const id = String(props.id ?? key);
  const cells = rows.flatMap((row, r) => row.cells.map((cell, c) => {
    const cellProps = cell.props as Record<string, any>;
    const header = cell.type === "th" || row.section === "thead";
    const { background } = row.style;
    const colSpan = Number(cellProps.colSpan ?? 1);
    const rowSpan = Number(cellProps.rowSpan ?? 1);
    const content = typeof cellProps.children === "object" && cellProps.children !== null && !Array.isArray(cellProps.children) && typeof (cellProps.children as VNode).type !== "string"
      ? cellProps.children
      : Text({ ...(header ? { weight: 700 } : {}), style: { textAlign: header ? "center" : "start" }, children: cellProps.children });
    return View({ key: `${r}:${c}`, ...(cellProps.id ? { id: cellProps.id } : {}),
      style: { padding: 1, justify: "center", ...(colSpan > 1 ? { gridColumn: `span ${colSpan}` } : {}), ...(rowSpan > 1 ? { gridRow: `span ${rowSpan}` } : {}), ...(background ? { background } : {}), ...canonicalizeIntrinsicStyle(cellProps.style) },
      children: content } as never);
  }));
  const grid = View({ id, control: { role: "grid", label: textOf(caption) || "Table" } as never,
    style: { display: "grid", columns: `repeat(${columns}, auto)`, gap: 2, padding: 2, justify: "start", ...canonicalizeIntrinsicStyle(props.style) }, children: cells } as never);
  return caption ? Column({ align: "start", children: [Text({ style: { textAlign: "center" }, children: (caption.props as Record<string, any>).children }), grid] } as never) : grid;
}
