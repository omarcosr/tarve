import type { VNode } from "../jsx-runtime";
import type { LayoutBox } from "../protocol";
import { Button } from "../components/button";
import { Column, Row } from "../components/layout";
import { Pressable } from "../components/pressable";
import { Scroll } from "../components/scroll";
import { Text } from "../components/text";
import { Window } from "../components/window";
import { darkTheme } from "../theme";
import { describeEntries, describeValue, flattenTree, nativeFields, type InspectorNode, type Rect } from "./tree";
import type { LoggedEvent } from "./inspector";

export const INSPECTOR_ROWS_LIMIT = 600;
export const INSPECTOR_PICK_ID = "inspector-pick";

const COLORS = {
  panel: "#18181b", border: "#3f3f46", muted: "#a1a1aa", text: "#e4e4e7",
  component: "#c4b5fd", host: "#7dd3fc", selected: "#1e3a8a", badge: "#fbbf24", rendered: "#4ade80",
};
const MONO = "Cascadia Mono, Consolas, Menlo, DejaVu Sans Mono, monospace";

/** What the inspector window shows; the controller (inspector.ts) owns it. */
export interface InspectorViewModel {
  title: string;
  tree?: InspectorNode;
  expanded: ReadonlySet<string>;
  selected?: InspectorNode;
  renders: ReadonlyMap<string, number>;
  picking: boolean;
  commits: number;
  layout?: { box: LayoutBox | Rect; source: "layout" | "inspect" };
  events: readonly LoggedEvent[];
  eventsTotal: number;
  onPick(): void;
  onSelect(key: string): void;
  onToggle(key: string): void;
  onHoverRow(id: string | undefined): void;
  onExpandAll(): void;
  onCollapseAll(): void;
  onClearEvents(): void;
}

function table(title: string, entries: readonly [string, string][]): VNode[] {
  if (!entries.length) return [];
  return [
    Text({ size: 11, weight: 600, color: COLORS.muted, style: { margin: { top: 10 } }, children: title }),
    ...entries.map(([key, value]) => Row({
      align: "start", gap: 8,
      children: [
        Text({ size: 12, color: COLORS.component, style: { width: 130, shrink: 0, fontFamily: MONO }, children: key }),
        Text({ size: 12, color: COLORS.text, style: { flex: 1, minWidth: 0, fontFamily: MONO }, children: value }),
      ],
    })),
  ];
}

function layoutEntries(layout: InspectorViewModel["layout"]): [string, string][] {
  if (!layout) return [["box", "not laid out (or not reported yet)"]];
  const { box, source } = layout;
  const out: [string, string][] = [["position", `${round(box.x)}, ${round(box.y)}`]];
  if ("borderWidth" in box) {
    out.push(["border box", `${round(box.borderWidth)} × ${round(box.borderHeight)}`], ["content", `${round(box.width)} × ${round(box.height)}`]);
  } else out.push(["size", `${round(box.width)} × ${round(box.height)}`]);
  out.push(["source", source === "layout" ? "native layout request" : "native inspect snapshot"]);
  return out;
}
const round = (value: number) => Math.round(value * 100) / 100;

function details(model: InspectorViewModel): VNode[] {
  const node = model.selected;
  if (!node) return [Text({ size: 12, color: COLORS.muted, children: "Select a node in the tree, or pick one in the app window." })];
  const head = Text({ size: 15, weight: 600, color: node.kind === "component" ? COLORS.component : COLORS.host, children: node.kind === "component" ? `<${node.name}>` : node.name });
  if (node.kind === "component") {
    const frame = node.frame;
    const props = frame?.props ?? {};
    const children = props.children;
    return [
      head,
      ...table("Component", [
        ["renders", String(model.renders.get(frame?.key ?? "") ?? 0)],
        ["last commit", frame?.rendered === false ? "reused (memo)" : "rendered"],
        ["memo", String(frame?.memo ?? false)],
        ["path", frame?.path ?? ""],
        ["host nodes", (frame?.roots ?? []).join(", ") || "(none)"],
      ]),
      ...table("Props", [...describeEntries(props, ["children"]), ...(children !== undefined ? [["children", describeValue(children, 1)] as [string, string]] : [])]),
      ...table("Layout (first host node)", layoutEntries(model.layout)),
    ];
  }
  const native = node.node!;
  return [
    head,
    ...table("Node", [["id", native.id], ...nativeFields(native)]),
    ...table("Layout", layoutEntries(model.layout)),
    ...table("Style (resolved)", describeEntries(native.style as Record<string, unknown>)),
  ];
}

function treeRows(model: InspectorViewModel): VNode[] {
  if (!model.tree) return [Text({ size: 12, color: COLORS.muted, children: "Waiting for the first render…" })];
  const { rows, truncated } = flattenTree(model.tree, model.expanded, INSPECTOR_ROWS_LIMIT);
  // Ids by row position: tree keys hold `/`, which anonymous child ids (`<id>/children`) use too.
  const out = rows.map((row, index) => {
    const selected = row.key === model.selected?.key;
    const renders = row.kind === "component" ? model.renders.get(row.key.slice(2)) : undefined;
    return Row({
      id: `tree-item-${index}`,
      gap: 2,
      style: { padding: { left: 4 + row.depth * 14 }, background: selected ? COLORS.selected : "transparent", radius: 4 },
      children: [
        Pressable({
          id: `tree-toggle-${index}`, focusable: false,
          style: { width: 16, align: "center" },
          ...(row.hasChildren ? { onClick: () => model.onToggle(row.key) } : {}),
          children: Text({ size: 11, color: COLORS.muted, children: row.hasChildren ? (row.expanded ? "-" : "+") : " " }),
        }),
        Pressable({
          id: `tree-row-${index}`, flex: 1, focusable: false,
          style: { direction: "row", gap: 8, padding: { top: 1, bottom: 1 } },
          onClick: () => model.onSelect(row.key),
          onHover: hovered => model.onHoverRow(hovered ? row.id : undefined),
          children: [
            Text({ size: 12, color: row.kind === "component" ? COLORS.component : COLORS.host, style: { fontFamily: MONO, whiteSpace: "nowrap" }, children: row.kind === "component" ? `<${row.label}>` : row.label }),
            renders !== undefined ? Text({ size: 11, color: COLORS.badge, style: { fontFamily: MONO }, children: `×${renders}` }) : null,
          ],
        }),
      ],
    });
  });
  if (truncated) out.push(Text({ size: 11, color: COLORS.muted, children: `… ${truncated} more rows (collapse nodes to see them)` }));
  return out;
}

function eventRows(model: InspectorViewModel): VNode[] {
  if (!model.events.length) return [Text({ size: 11, color: COLORS.muted, children: "No events yet." })];
  return [...model.events].reverse().map(event => Text({
    id: `event:${event.seq}`, size: 11, color: COLORS.text, style: { fontFamily: MONO, whiteSpace: "pre-wrap" },
    children: `#${event.seq} ${new Date(event.time).toISOString().slice(11, 23)} ${event.type}${event.id ? ` #${event.id}` : ""}${event.detail ? ` ${event.detail}` : ""}`,
  }));
}

/** The inspector window: tree on the left, the selected node and the event log on the right. */
export function InspectorView(model: InspectorViewModel): VNode {
  const components = model.renders.size;
  return Window({
    title: model.title, width: 980, height: 700, minWidth: 560, minHeight: 360, theme: darkTheme,
    style: { background: COLORS.panel },
    children: Column({
      flex: 1, gap: 0,
      children: [
        Row({
          gap: 8, padding: 8, style: { borderWidth: { bottom: 1 }, borderColor: COLORS.border },
          children: [
            Button({ id: INSPECTOR_PICK_ID, size: "sm", variant: model.picking ? "default" : "outline", onClick: model.onPick, children: model.picking ? "Picking… (click a node)" : "Pick node" }),
            Button({ id: "inspector-expand", size: "sm", variant: "ghost", onClick: model.onExpandAll, children: "Expand all" }),
            Button({ id: "inspector-collapse", size: "sm", variant: "ghost", onClick: model.onCollapseAll, children: "Collapse" }),
            Text({ id: "inspector-summary", size: 12, color: COLORS.muted, style: { flex: 1, textAlign: "end" }, children: `${components} component${components === 1 ? "" : "s"} · commit ${model.commits}` }),
          ],
        }),
        Row({
          flex: 1, align: "stretch", gap: 0,
          children: [
            Scroll({ id: "inspector-tree", flex: 1, padding: 6, style: { minWidth: 0, borderWidth: { right: 1 }, borderColor: COLORS.border }, children: Column({ gap: 0, children: treeRows(model) }) }),
            Column({
              flex: 1, gap: 0, style: { minWidth: 0 },
              children: [
                Scroll({ id: "inspector-details", flex: 1, padding: 10, children: Column({ gap: 2, children: details(model) }) }),
                Row({
                  gap: 8, padding: 6, style: { borderWidth: { top: 1, bottom: 1 }, borderColor: COLORS.border },
                  children: [
                    Text({ size: 11, weight: 600, color: COLORS.muted, style: { flex: 1 }, children: `Events (${model.eventsTotal})` }),
                    Button({ id: "inspector-clear-events", size: "sm", variant: "ghost", onClick: model.onClearEvents, children: "Clear" }),
                  ],
                }),
                Scroll({ id: "inspector-events", padding: 6, style: { height: 200 }, children: Column({ gap: 1, children: eventRows(model) }) }),
              ],
            }),
          ],
        }),
      ],
    }),
  });
}
