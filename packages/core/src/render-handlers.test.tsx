import { expect, test } from "bun:test";
import * as core from "./index";
import { compileTree } from "./reconciler";

/**
 * Compiled JSX (jsx-compile.ts) reuses a template while its non-event props are equal and
 * forwards `on*` props to the latest handler, so a component must call an `on*` prop only
 * in response to an event, never while rendering. This renders every exported component
 * with throwing `on*` props and fails when one is called during render or compile.
 */
class RenderCall extends Error {}

/** Props components require to render at all (validation would throw before any handler). */
const REQUIRED: Record<string, Record<string, unknown>> = {
  AnimatePresence: { id: "presence", present: true, children: <core.Text>x</core.Text>, exit: { opacity: 0 } },
  AspectRatio: { ratio: 1.5 },
  Calendar: { month: "2026-03", value: "2026-03-05" },
  Carousel: { items: [{ value: "a", content: "A" }, { value: "b", content: "B" }], index: 0 },
  DataGrid: { columns: [{ key: "name", header: "Name", sortable: true }], rows: [{ name: "a" }, { name: "b" }], rowKey: (_: unknown, index: number) => index, selectedKeys: [0] },
  DatePicker: { month: "2026-03", value: "2026-03-05" },
  Icon: { name: "check" },
  InputOTP: { value: "12", length: 4 },
  Link: { href: "https://example.com" },
  List: { items: [1, 2], renderItem: (item: number) => <core.Text>{String(item)}</core.Text> },
  Menubar: { menus: [{ value: "file", label: "File", items: [{ value: "open", label: "Open" }] }], openMenu: "file" },
  NavigationMenu: { items: [{ value: "a", label: "A", links: [{ value: "a1", label: "A1" }] }, { value: "b", label: "B" }], value: "a1", openValue: "a" },
  Svg: { width: 10, height: 10, viewBox: "0 0 10 10", children: <core.Circle cx={5} cy={5} r={2} /> },
  Pagination: { page: 2, pageCount: 5 },
  Questionnaire: { questions: [{ id: "q", title: "Q", type: "single", options: [{ value: "y", label: "Yes" }] }], values: { q: "y" }, current: 0 },
  Resizable: { size: 40, min: 10, max: 90, step: 5, first: "A", second: "B" },
  Slider: { value: 5, min: 0, max: 10, step: 1 },
  Toaster: { toasts: [{ id: "t", title: "Saved", action: { label: "Undo", onClick: () => {} } }] },
  ToggleGroup: { value: "a", items: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
  TreeView: { nodes: [{ id: "a", label: "A", children: [{ id: "b", label: "B" }] }], expandedIds: ["a"], selectedId: "b" },
  VirtualList: { id: "virtual", items: [1, 2, 3], itemHeight: 20, height: 100, offset: 0, renderItem: (item: number) => <core.Text>{String(item)}</core.Text> },
};
/** SVG shapes only render inside <Svg>; classes and test helpers are not components. */
const NOT_RENDERABLE = new Set(["BunFfiBridge", "CanvasGradient", "CanvasRenderingContext2D", "Locator", "TestRenderer", "Circle", "Ellipse", "Line", "Path", "Polygon", "Polyline", "SvgRect"]);

function propsFor(variant: number, calls: string[], name = ""): object {
  const values: Record<string, unknown> = {
    children: "x", label: "x", title: "x", value: variant ? "b" : "a", items: [], options: [], rows: [], columns: [], data: [],
    open: variant === 0, checked: variant === 0, selected: variant === 0, src: "", source: "", code: "", text: "x",
    ...REQUIRED[name],
  };
  return new Proxy({}, {
    get(_, key) {
      if (typeof key === "string" && /^on[A-Z]/.test(key)) {
        return (..._args: unknown[]) => { calls.push(key); throw new RenderCall(key); };
      }
      return typeof key === "string" ? values[key] : undefined;
    },
    has: (_, key) => typeof key === "string" && (/^on[A-Z]/.test(key) || key in values),
  });
}

function check(components: Record<string, unknown>) {
  const offenders: string[] = [];
  let checked = 0;
  const skipped: string[] = [];
  for (const [name, value] of Object.entries(components)) {
    if (!/^[A-Z]/.test(name) || typeof value !== "function" || name === "Window" || NOT_RENDERABLE.has(name)) continue;
    let rendered = false;
    for (const variant of [0, 1]) {
      const calls: string[] = [];
      try {
        const element = (value as (props: object) => unknown)(propsFor(variant, calls, name));
        if (!element || typeof element !== "object" || !("type" in (element as object))) break;
        compileTree(<core.Window>{element as core.VNode}</core.Window>);
        rendered = true;
      } catch (error) {
        if (!(error instanceof RenderCall) && !calls.length) continue;
      }
      if (calls.length) offenders.push(`${name} calls ${[...new Set(calls)].join(", ")} while rendering`);
    }
    if (rendered) checked++;
    else skipped.push(name);
  }
  return { offenders, checked, skipped };
}

test("no exported component calls an on* prop while rendering", () => {
  const { offenders, skipped } = check(core);
  expect(offenders).toEqual([]);
  // Every component must actually render here, or the check proves nothing for it:
  // a new component that needs props gets an entry in REQUIRED.
  expect(skipped).toEqual([]);
});

test("the check catches a component that calls an on* prop while rendering", () => {
  const Formatted = ({ onFormat }: { onFormat: (value: number) => string }) => <core.Text>{onFormat(42)}</core.Text>;
  const Guarded = ({ onFormat }: { onFormat?: (value: number) => string }) => <core.Button onClick={() => onFormat?.(1)}>ok</core.Button>;
  expect(check({ Formatted, Guarded }).offenders).toEqual(["Formatted calls onFormat while rendering", "Formatted calls onFormat while rendering"]);
});
