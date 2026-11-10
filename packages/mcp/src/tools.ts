import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { NodeSnapshot, Snapshot } from "@tarve/core/protocol";
import { textResult, type Tool, type ToolResult } from "./server";
import type { AppSession } from "./session";

/** The app's tree as `controlTree` sends it (packages/core/src/devtools/control.ts). */
export interface ControlNode {
  id: string;
  kind: string;
  text?: string;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  src?: string;
  style?: Record<string, unknown>;
  children: ControlNode[];
}

interface Point { x: number; y: number }

const KEYS: Record<string, string> = {
  enter: "Enter", return: "Enter", tab: "Tab", esc: "Escape", escape: "Escape", space: "Space",
  backspace: "Backspace", delete: "Delete", del: "Delete", home: "Home", end: "End",
  pageup: "PageUp", pagedown: "PageDown", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight", selectall: "SelectAll",
};
export const keyName = (key: string): string => KEYS[key.trim().toLowerCase()] ?? key.trim();

const label = (node: NodeSnapshot): string => node.control?.label ?? node.text ?? "";
const visible = (node: NodeSnapshot): boolean => node.width > 0 && node.height > 0;
const round = (value: number): number => Math.round(value * 10) / 10;
const box = (node: { x: number; y: number; width: number; height: number }): string => `${round(node.x)},${round(node.y)} ${round(node.width)}x${round(node.height)}`;
const quote = (text: string, max = 80): string => JSON.stringify(text.length > max ? `${text.slice(0, max - 1)}…` : text);
const json = (value: unknown): ToolResult => textResult(JSON.stringify(value, null, 2));

/** The node for `text`: exact label first, then substring; the smallest box wins (as `--tarve-script click:`). */
export function findByText(snapshot: Snapshot, text: string, exact = false): NodeSnapshot | undefined {
  const shown = snapshot.nodes.filter(visible);
  const same = shown.filter(node => label(node) === text);
  const matches = same.length || exact ? same : shown.filter(node => label(node).includes(text));
  return matches.sort((a, b) => a.width * a.height - b.width * b.height)[0];
}

/** An indented outline of the tree, one node per line, with each node's window box. */
export function outline(root: ControlNode, snapshot: Snapshot | undefined, options: { maxDepth?: number; maxNodes?: number; styles?: boolean; visibleOnly?: boolean } = {}): string {
  const maxDepth = options.maxDepth ?? 12, maxNodes = options.maxNodes ?? 400;
  const boxes = new Map(snapshot?.nodes.map(node => [node.id, node]) ?? []);
  const lines: string[] = [];
  let omitted = 0;
  const walk = (node: ControlNode, depth: number) => {
    const shot = boxes.get(node.id);
    if (options.visibleOnly && shot && !visible(shot)) return;
    if (lines.length >= maxNodes) { omitted++; return; }
    const parts = [`${node.kind}#${node.id}`];
    const content = shot?.text || node.text;
    if (content) parts.push(quote(content));
    if (node.value !== undefined) parts.push(`value=${quote(String(node.value))}`);
    if (node.placeholder) parts.push(`placeholder=${quote(node.placeholder)}`);
    if (shot?.control?.label && shot.control.label !== content) parts.push(`label=${quote(shot.control.label)}`);
    if (node.disabled) parts.push("disabled");
    if (node.src) parts.push(`src=${quote(node.src, 60)}`);
    if (shot) parts.push(`[${box(shot)}]`);
    if (shot && shot.scrollMax > 0) parts.push(`scroll=${round(shot.scroll)}/${round(shot.scrollMax)}`);
    if (snapshot?.focused === node.id) parts.push("(focused)");
    if (snapshot?.hovered === node.id) parts.push("(hovered)");
    if (options.styles && node.style) parts.push(`style=${JSON.stringify(node.style)}`);
    lines.push(`${"  ".repeat(depth)}${parts.join(" ")}`);
    if (depth + 1 > maxDepth) {
      if (node.children.length) lines.push(`${"  ".repeat(depth + 1)}… ${node.children.length} children (raise maxDepth)`);
      return;
    }
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  if (omitted) lines.push(`… ${omitted} more nodes (raise maxNodes or pass root)`);
  return lines.join("\n");
}

function findNode(node: ControlNode, id: string): ControlNode | undefined {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

const str = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined;
const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const int = (value: unknown, fallback: number, max: number): number => Math.max(1, Math.min(max, Math.floor(num(value) ?? fallback)));

const TARGET = {
  text: { type: "string", description: "Visible text or control label of the node (exact match first, then substring; the smallest node wins)" },
  id: { type: "string", description: "Node id (from inspect_tree or query_nodes)" },
  x: { type: "number", description: "Window x in logical px (with y, instead of text/id)" },
  y: { type: "number", description: "Window y in logical px" },
} as const;

/** The window point a tool acts on: `x,y`, else the centre of the node by `id` or `text`. */
async function resolvePoint(session: AppSession, args: Record<string, unknown>, prefix = ""): Promise<{ point: Point; node?: NodeSnapshot }> {
  const x = num(args[`${prefix}x`]), y = num(args[`${prefix}y`]);
  if (x !== undefined && y !== undefined) return { point: { x, y } };
  const id = str(args[`${prefix}id`]), text = str(args[`${prefix}text`]);
  if (!id && !text) throw new Error(`Give ${prefix}text, ${prefix}id or ${prefix}x and ${prefix}y`);
  const snapshot = await session.request<Snapshot>("inspect");
  const node = id ? snapshot.nodes.find(candidate => candidate.id === id) : findByText(snapshot, text!);
  if (!node) throw new Error(id ? `No node has id ${JSON.stringify(id)}` : `No visible node shows ${JSON.stringify(text)}`);
  if (!visible(node)) throw new Error(`Node ${node.id} is not laid out (zero size)`);
  return { point: { x: node.x + node.width / 2, y: node.y + node.height / 2 }, node };
}

/** Waits for the frame after an input, then reports where focus and the pointer are. */
async function settled(session: AppSession, done: Record<string, unknown>): Promise<ToolResult> {
  const snapshot = await session.request<Snapshot>("settle", {}, 10_000);
  return json({ ...done, focused: snapshot.focused, hovered: snapshot.hovered });
}

const input = (session: AppSession, params: Record<string, unknown>) => session.request("input", params);
const describe = (node: NodeSnapshot | undefined) => node ? { id: node.id, kind: node.kind, text: label(node) } : undefined;

export function createTools(session: AppSession): Tool[] {
  let shots = 0;
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
  const acts = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
  return [
    // Reading the app.
    {
      name: "app_status",
      description: "Whether the app is running and connected, its pid and runtime, window size and scale, fps, and the focused and hovered nodes.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "App status", ...readOnly },
      async run() {
        const status = session.status();
        if (!status.connected) return json(status);
        const snapshot = await session.request<Snapshot>("inspect");
        return json({ ...status, window: { width: snapshot.width, height: snapshot.height, scale: snapshot.scale }, fps: snapshot.fps, focused: snapshot.focused, hovered: snapshot.hovered, nodes: snapshot.nodes.length });
      },
    },
    {
      name: "inspect_tree",
      description: "The app's node tree as an indented outline: `kind#id \"text\" [x,y wxh]` per node (window coordinates, logical px), with values, labels, scroll, focus and hover. Use the ids with the other tools.",
      inputSchema: {
        type: "object",
        properties: {
          root: { type: "string", description: "Only the subtree of this node id" },
          maxDepth: { type: "number", description: "Default 12" },
          maxNodes: { type: "number", description: "Default 400" },
          styles: { type: "boolean", description: "Include each node's style (verbose)" },
          visibleOnly: { type: "boolean", description: "Skip nodes with no size" },
        },
        additionalProperties: false,
      },
      annotations: { title: "Inspect node tree", ...readOnly },
      async run(args) {
        const styles = args.styles === true;
        const [tree, snapshot] = await Promise.all([session.request<ControlNode | null>("tree", { styles }), session.request<Snapshot>("inspect")]);
        if (!tree) return textResult("The app has not rendered a tree yet.", true);
        const rootId = str(args.root);
        const root = rootId ? findNode(tree, rootId) : tree;
        if (!root) return textResult(`No node has id ${JSON.stringify(rootId)}`, true);
        const header = `window ${snapshot.width}x${snapshot.height} @${snapshot.scale}x, focused=${snapshot.focused ?? "none"}, hovered=${snapshot.hovered ?? "none"}`;
        return textResult(`${header}\n${outline(root, snapshot, { maxDepth: int(args.maxDepth, 12, 200), maxNodes: int(args.maxNodes, 400, 5000), styles, visibleOnly: args.visibleOnly === true })}`);
      },
    },
    {
      name: "query_nodes",
      description: "Finds laid-out nodes by text/label (substring unless exact), id or kind, with their boxes, scroll and control state.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          exact: { type: "boolean", description: "Text must match the whole label" },
          id: { type: "string" },
          kind: { type: "string", description: "Node kind: view, text, pressable, input, textarea, scroll, image…" },
          includeHidden: { type: "boolean", description: "Also nodes with no size" },
          limit: { type: "number", description: "Default 20" },
        },
        additionalProperties: false,
      },
      annotations: { title: "Query nodes", ...readOnly },
      async run(args) {
        const snapshot = await session.request<Snapshot>("inspect");
        const text = str(args.text), id = str(args.id), kind = str(args.kind);
        const matches = snapshot.nodes.filter(node =>
          (args.includeHidden === true || visible(node))
          && (!id || node.id === id)
          && (!kind || node.kind === kind)
          && (!text || (args.exact === true ? label(node) === text : label(node).includes(text))));
        const limit = int(args.limit, 20, 500);
        return json({ total: matches.length, nodes: matches.slice(0, limit) });
      },
    },
    {
      name: "screenshot",
      description: "A PNG of the app window as it is drawn now.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "Screenshot", ...readOnly },
      async run() {
        const path = join(session.directory, `shot-${++shots}.png`);
        await session.request("capture", { path }, 20_000);
        try {
          const data = readFileSync(path).toString("base64");
          const snapshot = await session.request<Snapshot>("inspect");
          return { content: [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: `${snapshot.width}x${snapshot.height} logical px @${snapshot.scale}x` }] };
        } finally {
          rmSync(path, { force: true });
        }
      },
    },
    // Driving it.
    {
      name: "click",
      description: "Moves the pointer to a node (by text or id) or a window point and clicks there, through native hit testing like a user. Waits for the next frame.",
      inputSchema: { type: "object", properties: { ...TARGET, double: { type: "boolean", description: "Double click" } }, additionalProperties: false },
      annotations: { title: "Click", ...acts },
      async run(args) {
        const { point, node } = await resolvePoint(session, args);
        await input(session, { action: "move", ...point });
        for (let count = args.double === true ? 2 : 1; count > 0; count--) {
          await input(session, { action: "down" });
          await input(session, { action: "up" });
        }
        return settled(session, { clicked: describe(node), at: point });
      },
    },
    {
      name: "hover",
      description: "Moves the pointer over a node (by text or id) or to a window point.",
      inputSchema: { type: "object", properties: TARGET, additionalProperties: false },
      annotations: { title: "Hover", ...acts },
      async run(args) {
        const { point, node } = await resolvePoint(session, args);
        await input(session, { action: "move", ...point });
        return settled(session, { hovering: describe(node), at: point });
      },
    },
    {
      name: "type_text",
      description: "Types text into the focused field, or first focuses the node given by id (or clicks the node given by text).",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "What to type" }, id: TARGET.id, target: { type: "string", description: "Text or label of the field to click first" }, clear: { type: "boolean", description: "Select all and delete first" } },
        required: ["text"],
        additionalProperties: false,
      },
      annotations: { title: "Type text", ...acts },
      async run(args) {
        if (typeof args.text !== "string") throw new Error("text must be a string");
        const id = str(args.id), target = str(args.target);
        if (id) await session.request("focus", { id });
        else if (target) {
          const { point } = await resolvePoint(session, { text: target });
          await input(session, { action: "move", ...point });
          await input(session, { action: "down" });
          await input(session, { action: "up" });
          await session.request("settle");
        }
        if (args.clear === true) {
          await input(session, { action: "key", text: "SelectAll" });
          await input(session, { action: "key", text: "Backspace" });
        }
        if (args.text) await input(session, { action: "text", text: args.text });
        return settled(session, { typed: args.text });
      },
    },
    {
      name: "press_key",
      description: "Presses a key (Enter, Tab, Escape, Space, Backspace, Delete, Home, End, PageUp, PageDown, ArrowUp/Down/Left/Right, SelectAll or a character), optionally focusing a node id first.",
      inputSchema: { type: "object", properties: { key: { type: "string" }, id: TARGET.id, repeat: { type: "number", description: "Times to press it. Default 1" } }, required: ["key"], additionalProperties: false },
      annotations: { title: "Press key", ...acts },
      async run(args) {
        const key = str(args.key);
        if (!key) throw new Error("key must be a non-empty string");
        const id = str(args.id);
        if (id) await session.request("focus", { id });
        const name = keyName(key);
        for (let count = int(args.repeat, 1, 100); count > 0; count--) await input(session, { action: "key", text: name });
        return settled(session, { pressed: name });
      },
    },
    {
      name: "scroll",
      description: "Scrolls with the wheel over a node (by text or id) or a window point; positive deltaY scrolls down. With `to` and an id, jumps a scroll container to start or end instead.",
      inputSchema: {
        type: "object",
        properties: { ...TARGET, deltaY: { type: "number", description: "Pixels, positive is down" }, deltaX: { type: "number", description: "Pixels, positive is right" }, to: { type: "string", enum: ["start", "end"], description: "With id: scroll that container to its start or end" } },
        additionalProperties: false,
      },
      annotations: { title: "Scroll", ...acts },
      async run(args) {
        const id = str(args.id);
        if (args.to === "start" || args.to === "end") {
          if (!id) throw new Error("to needs the id of a scroll container");
          await session.request("scrollTo", { id, y: args.to });
          return settled(session, { scrolled: id, to: args.to });
        }
        const deltaY = num(args.deltaY) ?? 0, deltaX = num(args.deltaX) ?? 0;
        if (!deltaY && !deltaX) throw new Error("Give deltaY or deltaX (or to)");
        const { point, node } = await resolvePoint(session, args);
        await input(session, { action: "move", ...point });
        await input(session, { action: "wheel", ...(deltaY ? { deltaY } : {}), ...(deltaX ? { deltaX } : {}) });
        return settled(session, { scrolled: describe(node), at: point, deltaX, deltaY });
      },
    },
    {
      name: "drag",
      description: "Presses on one node or point, moves to another and releases (sliders, splitters, drag and drop). Targets: fromText/fromId/fromX+fromY and toText/toId/toX+toY.",
      inputSchema: {
        type: "object",
        properties: {
          fromText: { type: "string" }, fromId: { type: "string" }, fromX: { type: "number" }, fromY: { type: "number" },
          toText: { type: "string" }, toId: { type: "string" }, toX: { type: "number" }, toY: { type: "number" },
          steps: { type: "number", description: "Intermediate moves. Default 8" },
        },
        additionalProperties: false,
      },
      annotations: { title: "Drag", ...acts },
      async run(args) {
        const from = (await resolvePoint(session, args, "from")).point;
        const to = (await resolvePoint(session, args, "to")).point;
        const steps = int(args.steps, 8, 100);
        await input(session, { action: "move", ...from });
        await input(session, { action: "down" });
        for (let step = 1; step <= steps; step++) {
          await input(session, { action: "move", x: from.x + (to.x - from.x) * step / steps, y: from.y + (to.y - from.y) * step / steps });
        }
        await input(session, { action: "up" });
        return settled(session, { from, to });
      },
    },
    {
      name: "focus",
      description: "Gives keyboard focus to a node by id.",
      inputSchema: { type: "object", properties: { id: TARGET.id }, required: ["id"], additionalProperties: false },
      annotations: { title: "Focus", ...acts },
      async run(args) {
        const id = str(args.id);
        if (!id) throw new Error("id must be a non-empty string");
        await session.request("focus", { id });
        return settled(session, { focusing: id });
      },
    },
    {
      name: "wait_for",
      description: "Waits until a node showing the text appears (or, with gone, disappears).",
      inputSchema: { type: "object", properties: { text: { type: "string" }, gone: { type: "boolean" }, exact: { type: "boolean" }, timeoutMs: { type: "number", description: "Default 5000, at most 60000" } }, required: ["text"], additionalProperties: false },
      annotations: { title: "Wait for text", ...readOnly },
      async run(args) {
        const text = str(args.text);
        if (!text) throw new Error("text must be a non-empty string");
        const deadline = Date.now() + Math.min(num(args.timeoutMs) ?? 5000, 60_000);
        for (;;) {
          const node = findByText(await session.request<Snapshot>("inspect"), text, args.exact === true);
          if (args.gone === true ? !node : node) return json(args.gone === true ? { gone: text } : { found: describe(node), box: node && box(node) });
          if (Date.now() >= deadline) return textResult(`Timed out: ${JSON.stringify(text)} ${args.gone === true ? "is still shown" : "never appeared"}`, true);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      },
    },
    // Development loop.
    {
      name: "reload",
      description: "Restarts the app process (a clean start: state is lost). Edits already hot-reload in dev mode; use this after a crash, a closed window or changes hot reload cannot apply.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "Reload app", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      async run() {
        await session.restart();
        await session.request("settle", {}, 15_000).catch(() => {});
        return json(session.status());
      },
    },
    {
      name: "get_metrics",
      description: "Performance: percentiles (ms) of the JS update phases (render, diff, shadow, send, update) and native frame phases (apply, layout, paint, present, frame, gpu), memory, fps and frame/layout/paint counters.",
      inputSchema: { type: "object", properties: { reset: { type: "boolean", description: "Clear the samples after reading them" } }, additionalProperties: false },
      annotations: { title: "Metrics", ...readOnly },
      async run(args) {
        const [stats, snapshot] = await Promise.all([session.request("stats", { reset: args.reset === true }), session.request<Snapshot>("inspect")]);
        const { nodes: _nodes, ...counters } = snapshot;
        return json({ counters, ...(stats as Record<string, unknown>) });
      },
    },
    {
      name: "get_events",
      description: "Recent native events of the app (clicks, keys, focus, size, window…), oldest first. Pass `since` (the `last` of a previous call) for only new ones.",
      inputSchema: { type: "object", properties: { since: { type: "number" }, limit: { type: "number", description: "Default 50" } }, additionalProperties: false },
      annotations: { title: "Events", ...readOnly },
      async run(args) {
        return json(session.events(num(args.since), int(args.limit, 50, 500)));
      },
    },
    {
      name: "get_logs",
      description: "The app's stdout and stderr (console output, errors, stack traces), oldest first. Pass `since` (the `last` of a previous call) for only new lines.",
      inputSchema: { type: "object", properties: { since: { type: "number" }, limit: { type: "number", description: "Default 100" }, stream: { type: "string", enum: ["stdout", "stderr"] } }, additionalProperties: false },
      annotations: { title: "Logs", ...readOnly },
      async run(args) {
        const { lines, last } = session.logs(num(args.since), int(args.limit, 100, 1000));
        const stream = args.stream === "stdout" || args.stream === "stderr" ? args.stream : undefined;
        const shown = stream ? lines.filter(line => line.stream === stream) : lines;
        return textResult(`${shown.map(line => `${line.seq} ${line.stream === "stderr" ? "!" : " "} ${line.text}`).join("\n") || "(no output)"}\nlast=${last}`);
      },
    },
  ];
}
