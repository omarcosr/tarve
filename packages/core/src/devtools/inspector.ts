import type { AppHandle } from "../app";
import type { CompiledTree } from "../reconciler";
import type { LayoutBox, NativeEvent, NativeNode } from "../protocol";
import { ComponentTracer } from "./trace";
import { ancestorKeys, buildInspectorTree, expandToDepth, indexTree, hitTest, truncate, describeValue, type InspectorNode, type Rect } from "./tree";
import { InspectorView } from "./view";

export const INSPECTOR_WINDOW_ID = "tarve-inspector";
/** Every node the inspector adds to the app's tree has an id with this prefix. */
export const INSPECTOR_ID_PREFIX = "__tarve-inspector";
export const INSPECTOR_OVERLAY_ID = `${INSPECTOR_ID_PREFIX}-overlay`;
export const INSPECTOR_CAPTURE_ID = `${INSPECTOR_ID_PREFIX}-capture`;
export const INSPECTOR_HIGHLIGHT_ID = `${INSPECTOR_ID_PREFIX}-highlight`;
/** The app handle's (non-enumerable) slot holding its inspector, for smoke tests. */
export const INSPECTOR_SLOT = Symbol.for("tarve.inspector");
export const isInspectorId = (id: string): boolean => id.startsWith(INSPECTOR_ID_PREFIX);

/** Development options: `true` turns dev mode on; `{ inspector: true }` also opens the inspector window. */
export interface DevOptions {
  /** Open the visual inspector in a window of its own (`tarve dev --inspect`, `TARVE_INSPECTOR=1`). */
  inspector?: boolean;
}

export interface LoggedEvent { seq: number; time: number; type: string; id?: string; detail: string }

export interface InspectorState {
  tree?: InspectorNode;
  index: ReturnType<typeof indexTree>;
  expanded: Set<string>;
  selected?: string;
  /** The native node the app window highlights. */
  highlight?: string;
  /** Picker mode: a transparent layer over the app window picks the node under the pointer. */
  picking: boolean;
  /** The native node under the pointer while picking. */
  pickHover?: string;
  /** The row the pointer is over in the inspector window. */
  rowHover?: string;
  /** Native boxes by id, window coordinates, from the last `inspect` snapshot. */
  boxes: Map<string, Rect>;
  layout?: { id: string; box: LayoutBox | Rect; source: "layout" | "inspect" };
  events: LoggedEvent[];
  eventsTotal: number;
  /** Renders of the app the inspector has seen. */
  commits: number;
}

export interface Inspector {
  readonly state: InspectorState;
  readonly tracer: ComponentTracer;
  /** The inspector's own window, once open. */
  readonly window: AppHandle | undefined;
  /** Runs the app's compile with the component trace installed. */
  compile<T>(compile: () => T): T;
  /** Records the compiled tree and adds the highlight and picker overlay to it. */
  decorate(tree: CompiledTree): void;
  open(): AppHandle | undefined;
  select(key: string | undefined): void;
  toggle(key: string): void;
  setPicking(on: boolean): void;
  /** Picker hover at a window point: highlights and returns the innermost node there. */
  hoverAt(x: number, y: number): string | undefined;
  /** Selects the node the picker hovers and leaves picker mode. */
  commitPick(): void;
  /** Re-reads the native boxes (inspect snapshot) used by the picker and the layout panel. */
  refreshBoxes(): Promise<void>;
  dispose(): void;
}

/** Request/response traffic and the inspector's own pointer tracking are not app events. */
const QUIET_EVENTS = new Set(["inspect", "layout", "stats", "selection", "captured", "motionAdvanced", "ready", "frame"]);

function eventDetail(event: NativeEvent): string {
  const { type: _type, id: _id, window: _window, ...rest } = event as Record<string, unknown>;
  return Object.keys(rest).length ? truncate(describeValue(rest, 1), 160) : "";
}

const borderLeftTop = (node: NativeNode): { left: number; top: number } => {
  const width = node.style.borderWidth;
  if (typeof width === "number") return { left: width, top: width };
  return { left: width?.left ?? 0, top: width?.top ?? 0 };
};

export interface InspectorOptions {
  /** Events kept in the log. Default 300. */
  eventLimit?: number;
  /** Open the window when the app is ready. Default true. */
  autoOpen?: boolean;
}

/**
 * The visual inspector of one app: traces its renders (component tree and render
 * counts), logs its events, highlights and picks nodes in its window through an
 * overlay node added to its tree, and shows all of it in a window of the same app.
 */
export function createInspector(app: AppHandle, options: InspectorOptions = {}): Inspector {
  const eventLimit = options.eventLimit ?? 300;
  const tracer = new ComponentTracer();
  const state: InspectorState = { index: new Map(), expanded: new Set(), picking: false, boxes: new Map(), events: [], eventsTotal: 0, commits: 0 };
  let expandedOnce = false;
  let appRoot: NativeNode | undefined;
  let window: AppHandle | undefined;
  let disposed = false;
  /** The next app render is the inspector's own (a highlight move): it does not count as a component render. */
  let quiet = false;
  let windowTimer: ReturnType<typeof setTimeout> | undefined;
  let boxesPending: Promise<void> | undefined;
  let boxesAgain = false;
  let boxesRead = 0;
  /** Whether the last compile was the app's own render (counted), not a highlight move. */
  let lastCounted = true;

  function renderApp(): void {
    quiet = true;
    app.update();
  }
  function renderWindow(): void {
    if (!window || windowTimer || disposed) return;
    windowTimer = setTimeout(() => { windowTimer = undefined; window?.update(); }, 40);
  }
  function selectedNode(): InspectorNode | undefined {
    return state.selected === undefined ? undefined : state.index.get(state.selected)?.node;
  }
  function updateHighlight(): void {
    const next = state.picking ? state.pickHover : state.rowHover ?? selectedNode()?.id;
    if (next === state.highlight) return;
    state.highlight = next;
    renderApp();
  }
  function readLayout(): void {
    const id = selectedNode()?.id;
    if (id === undefined) { state.layout = undefined; return; }
    const boxes = app.layout([id]);
    const box = boxes?.[id];
    if (box) { state.layout = { id, box, source: "layout" }; return; }
    const rect = state.boxes.get(id);
    state.layout = rect ? { id, box: rect, source: "inspect" } : undefined;
  }

  async function refreshBoxes(): Promise<void> {
    if (boxesPending) { boxesAgain = true; return boxesPending; }
    boxesPending = (async () => {
      try {
        do {
          boxesAgain = false;
          boxesRead = Date.now();
          const before = state.highlight === undefined ? undefined : state.boxes.get(state.highlight);
          const snapshot = await app.inspect();
          state.boxes = new Map(snapshot.nodes.map(node => [node.id, { x: node.x, y: node.y, width: node.width, height: node.height }]));
          const after = state.highlight === undefined ? undefined : state.boxes.get(state.highlight);
          // The highlight box moves with its node.
          if (JSON.stringify(before) !== JSON.stringify(after)) renderApp();
        } while (boxesAgain && !disposed);
        if (state.layout?.source !== "layout") readLayout();
        renderWindow();
      } catch {
        // The app closed while the snapshot was pending.
      } finally {
        boxesPending = undefined;
      }
    })();
    return boxesPending;
  }

  function overlayOrigin(): { x: number; y: number } {
    const own = state.boxes.get(INSPECTOR_CAPTURE_ID) ?? state.boxes.get(INSPECTOR_OVERLAY_ID);
    if (own) return own;
    const root = appRoot && state.boxes.get(appRoot.id);
    const border = appRoot ? borderLeftTop(appRoot) : { left: 0, top: 0 };
    return { x: (root?.x ?? 0) + border.left, y: (root?.y ?? 0) + border.top };
  }

  function highlightNode(): NativeNode | undefined {
    const id = state.highlight;
    const box = id === undefined ? undefined : state.boxes.get(id);
    if (!id || !box) return undefined;
    const origin = overlayOrigin();
    const name = state.index.get(`h:${id}`)?.node.name ?? "";
    const left = box.x - origin.x, top = box.y - origin.y;
    const label: NativeNode = {
      id: `${INSPECTOR_HIGHLIGHT_ID}-label`, kind: "text", children: [],
      text: `${name}${id.includes("/") ? "" : ` #${id}`}  ${Math.round(box.width)}×${Math.round(box.height)}`,
      style: {
        position: "absolute", left: 0, ...(top >= 18 ? { top: -18 } : { top: box.height }),
        background: "#1d4ed8", foreground: "#ffffff", fontSize: 11, whiteSpace: "nowrap", padding: { left: 4, right: 4, top: 1, bottom: 1 }, radius: 3,
      },
    };
    return {
      id: INSPECTOR_HIGHLIGHT_ID, kind: "view", children: [label],
      style: {
        position: "absolute", left, top, width: Math.max(0, box.width), height: Math.max(0, box.height),
        borderWidth: 2, borderColor: "#3b82f6", background: "#3b82f633", pointerEvents: "none",
      },
    };
  }

  function overlay(tree: CompiledTree): void {
    const highlight = highlightNode();
    if (!highlight && !state.picking) return;
    const container: NativeNode = state.picking
      ? {
        id: INSPECTOR_CAPTURE_ID, kind: "pressable", focusable: false, reportPointer: true,
        style: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0, zIndex: 2_000_000_000, cursor: "crosshair", background: "#3b82f60d" },
        children: highlight ? [highlight] : [],
      }
      : {
        id: INSPECTOR_OVERLAY_ID, kind: "view",
        style: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0, zIndex: 2_000_000_000, pointerEvents: "none" },
        children: highlight ? [highlight] : [],
      };
    const root = tree.document.root;
    const decorated: NativeNode = { ...root, children: [...root.children, container] };
    tree.document.root = decorated;
    tree.nodes.set(root.id, decorated);
    const register = (node: NativeNode) => { tree.nodes.set(node.id, node); node.children.forEach(register); };
    register(container);
    if (state.picking) tree.handlers.set(INSPECTOR_CAPTURE_ID, { onClick: () => inspector.commitPick() });
  }

  function reveal(key: string): void {
    for (const ancestor of ancestorKeys(state.index, key) ?? []) state.expanded.add(ancestor);
  }

  function logEvent(event: NativeEvent): void {
    if (QUIET_EVENTS.has(event.type)) return;
    const id = "id" in event && typeof event.id === "string" ? event.id : undefined;
    if (id !== undefined && isInspectorId(id)) {
      if (event.type === "pointerMove" && id === INSPECTOR_CAPTURE_ID && state.picking) {
        const origin = overlayOrigin();
        inspector.hoverAt(origin.x + event.x, origin.y + event.y);
        // Scrolling and animation move nodes: re-read the boxes now and then while picking.
        if (Date.now() - boxesRead > 300) void refreshBoxes();
      } else if (event.type === "pointerLeave" && state.picking && state.pickHover !== undefined) {
        state.pickHover = undefined;
        updateHighlight();
      }
      return;
    }
    state.events.push({ seq: ++state.eventsTotal, time: Date.now(), type: event.type, ...(id !== undefined ? { id } : {}), detail: eventDetail(event) });
    if (state.events.length > eventLimit) state.events.splice(0, state.events.length - eventLimit);
    renderWindow();
  }

  const view = () => InspectorView({
    title: "Tarve Inspector",
    ...(state.tree ? { tree: state.tree } : {}),
    expanded: state.expanded,
    ...(selectedNode() ? { selected: selectedNode()! } : {}),
    renders: tracer.renders,
    picking: state.picking,
    commits: state.commits,
    ...(state.layout ? { layout: state.layout } : {}),
    events: state.events,
    eventsTotal: state.eventsTotal,
    onPick: () => inspector.setPicking(!state.picking),
    onSelect: key => inspector.select(key),
    onToggle: key => inspector.toggle(key),
    onHoverRow: id => { state.rowHover = id; updateHighlight(); },
    onExpandAll: () => { if (state.tree) state.expanded = expandToDepth(state.tree, Infinity); },
    onCollapseAll: () => { if (state.tree) state.expanded = expandToDepth(state.tree, 1); },
    onClearEvents: () => { state.events = []; },
  });

  const unsubscribe = app.onEvent(logEvent);

  const inspector: Inspector = {
    state,
    tracer,
    get window() { return window; },
    compile<T>(compile: () => T): T {
      lastCounted = !quiet;
      quiet = false;
      return tracer.trace(compile, lastCounted);
    },
    decorate(tree: CompiledTree): void {
      appRoot = tree.document.root;
      state.tree = buildInspectorTree(appRoot, tracer.frames, isInspectorId);
      state.index = indexTree(state.tree);
      if (!expandedOnce) { state.expanded = expandToDepth(state.tree, 8); expandedOnce = true; }
      if (state.selected !== undefined && !state.index.has(state.selected)) state.selected = undefined;
      state.commits++;
      overlay(tree);
      renderWindow();
      // The app changed: the highlighted or selected node may have moved.
      if (lastCounted && (state.highlight !== undefined || state.selected !== undefined)) {
        queueMicrotask(() => { readLayout(); void refreshBoxes(); });
      }
    },
    open(): AppHandle | undefined {
      if (window || disposed) return window;
      try {
        window = app.openWindow(view, { id: INSPECTOR_WINDOW_ID, dev: false });
      } catch (error) {
        console.error("[tarve] inspector window failed to open", error);
        return undefined;
      }
      void window.closed.then(() => { window = undefined; });
      return window;
    },
    select(key: string | undefined): void {
      state.selected = key !== undefined && state.index.has(key) ? key : undefined;
      if (state.selected !== undefined) reveal(state.selected);
      readLayout();
      updateHighlight();
      renderWindow();
      void refreshBoxes();
    },
    toggle(key: string): void {
      if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
      renderWindow();
    },
    setPicking(on: boolean): void {
      if (state.picking === on) return;
      state.picking = on;
      state.pickHover = undefined;
      state.highlight = undefined;
      renderApp();
      renderWindow();
      if (on) void refreshBoxes();
    },
    hoverAt(x: number, y: number): string | undefined {
      if (!appRoot) return undefined;
      const id = hitTest(appRoot, state.boxes, x, y, isInspectorId);
      if (id !== state.pickHover) {
        state.pickHover = id;
        updateHighlight();
      }
      return id;
    },
    commitPick(): void {
      const id = state.pickHover;
      // The app re-renders after this click handler: that render is the inspector's own.
      quiet = true;
      state.picking = false;
      state.pickHover = undefined;
      if (id !== undefined) inspector.select(`h:${id}`);
      else { state.highlight = undefined; renderWindow(); }
    },
    refreshBoxes,
    dispose(): void {
      disposed = true;
      unsubscribe();
      if (windowTimer) clearTimeout(windowTimer);
      window?.close();
    },
  };

  if (options.autoOpen !== false) {
    void app.ready.then(() => { inspector.open(); void refreshBoxes(); }, () => {});
  }
  void app.closed.then(() => inspector.dispose());
  return inspector;
}
