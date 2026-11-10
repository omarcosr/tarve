import { connect, type Socket } from "node:net";
import type { AppHandle } from "../app";
import { settle } from "../app/automation";
import type { NativeCommand, NativeEvent, NativeNode } from "../protocol";
import { isInspectorId } from "./inspector";

/**
 * Remote control of a running app for development tools (`@tarve/mcp`): when `TARVE_CONTROL`
 * names a local socket (a named pipe on Windows, a Unix socket elsewhere), the app connects to
 * it, introduces itself with `TARVE_CONTROL_TOKEN`, answers requests (snapshot, node tree,
 * capture, input, stats) and reports its events. The app only connects out: it listens on
 * nothing, and without the variable (a normal launch) none of this runs.
 *
 * Wire format: one JSON object per line. Tool → app `{ id, method, params }`; app → tool
 * `{ type: "hello", token, pid, runtime }`, `{ id, result }` or `{ id, error }`,
 * `{ type: "event", event }` and `{ type: "closed" }` when the app closes.
 */
export const CONTROL_ENV = "TARVE_CONTROL";
export const CONTROL_TOKEN_ENV = "TARVE_CONTROL_TOKEN";

export function readControlAddress(env: Record<string, string | undefined> = globalThis.process?.env ?? {}): string | undefined {
  return env[CONTROL_ENV] || undefined;
}

export interface ControlTarget {
  app: AppHandle;
  /** The app's committed native tree. */
  root(): NativeNode | undefined;
}

/** A native node as the control sends it: structure and content, styles only on request. */
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

const CONTENT_KEYS = ["text", "value", "placeholder", "disabled", "src"] as const;
/** Request/response traffic and per-frame notices are not app events. */
const QUIET_EVENTS = new Set(["inspect", "layout", "stats", "captured", "motionAdvanced", "frame", "selection", "textSelection"]);
const INPUT_ACTIONS = new Set(["move", "down", "up", "wheel", "text", "key"]);
const CONTROL_KEY = Symbol.for("tarve.control");

interface Link {
  socket: Socket;
  /** This side ended (the app closed): nothing more is written. */
  ended?: boolean;
  target?: ControlTarget;
  detach?: () => void;
}

export function controlTree(node: NativeNode, styles = false): ControlNode {
  const out: ControlNode = { id: node.id, kind: node.kind, children: [] };
  for (const key of CONTENT_KEYS) {
    const value = node[key];
    if (value !== undefined && value !== "") (out as unknown as Record<string, unknown>)[key] = value;
  }
  if (styles && Object.keys(node.style ?? {}).length) out.style = { ...node.style } as Record<string, unknown>;
  for (const child of node.children) if (!isInspectorId(child.id)) out.children.push(controlTree(child, styles));
  return out;
}

const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value) throw new TypeError(`${name} must be a non-empty string`);
  return value;
};
const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

function inputCommand(params: Record<string, unknown>): Extract<NativeCommand, { type: "input" }> {
  const action = params.action;
  if (typeof action !== "string" || !INPUT_ACTIONS.has(action)) throw new TypeError(`input action must be one of ${[...INPUT_ACTIONS].join(", ")}`);
  const command: Extract<NativeCommand, { type: "input" }> = { type: "input", action: action as Extract<NativeCommand, { type: "input" }>["action"] };
  for (const key of ["x", "y", "delta", "deltaX", "deltaY"] as const) {
    const value = finite(params[key]);
    if (value !== undefined) command[key] = value;
  }
  if (action === "move" && (command.x === undefined || command.y === undefined)) throw new TypeError("input move needs finite x and y");
  if (action === "text" || action === "key") command.text = text(params.text, `input ${action} text`);
  return command;
}

type ScrollPosition = number | "start" | "end" | undefined;
const scrollPosition = (value: unknown): ScrollPosition => value === "start" || value === "end" ? value : finite(value);

async function call(target: ControlTarget, method: string, params: Record<string, unknown>): Promise<unknown> {
  const { app } = target;
  switch (method) {
    case "inspect": return app.inspect();
    case "settle": return settle(app, Math.min(finite(params.timeoutMs) ?? 3000, 30_000));
    case "tree": {
      const root = target.root();
      return root ? controlTree(root, params.styles === true) : null;
    }
    case "layout": {
      const ids = Array.isArray(params.ids) ? params.ids.filter((id): id is string => typeof id === "string") : [];
      return app.layout(ids) ?? null;
    }
    case "stats": return app.stats({ reset: params.reset === true });
    case "capture": await app.capture(text(params.path, "capture path")); return null;
    case "input": app.debug(inputCommand(params)); return null;
    case "focus": app.focus(text(params.id, "focus id")); return null;
    case "scrollTo": {
      const x = scrollPosition(params.x), y = scrollPosition(params.y);
      app.scrollTo(text(params.id, "scrollTo id"), { ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }), smooth: params.smooth === true });
      return null;
    }
    // After the reply is written: closing ends the connection.
    case "close": setTimeout(() => app.close(), 0); return null;
    default: throw new Error(`Unknown control method ${JSON.stringify(method)}`);
  }
}

function write(link: Link, message: unknown): void {
  if (!link.ended && !link.socket.destroyed) link.socket.write(JSON.stringify(message) + "\n");
}

function open(address: string): Link {
  const socket = connect(address);
  const link: Link = { socket };
  socket.setEncoding("utf8");
  socket.on("connect", () => {
    write(link, {
      type: "hello",
      token: globalThis.process?.env?.[CONTROL_TOKEN_ENV] ?? "",
      pid: globalThis.process?.pid,
      runtime: globalThis.process?.versions?.bun ? "bun" : "tjs" in globalThis ? "txiki" : globalThis.process?.versions?.node ? "node" : "other",
    });
  });
  // The tool went away: the app keeps running without it.
  socket.on("error", () => {});
  let buffer = "";
  socket.on("data", chunk => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim()) void answer(link, line);
    }
    if (buffer.length > 1 << 24) socket.destroy();
  });
  return link;
}

async function answer(link: Link, line: string): Promise<void> {
  let request: { id?: unknown; method?: unknown; params?: unknown };
  try { request = JSON.parse(line); } catch { return; }
  const id = request.id;
  try {
    if (!link.target) throw new Error("The app has closed");
    if (typeof request.method !== "string") throw new TypeError("method must be a string");
    const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
    write(link, { id, result: await call(link.target, request.method, params) ?? null });
  } catch (error) {
    write(link, { id, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Connects the app to the control socket at `address`, or points this process's existing
 * connection at it (a remount or a new app after a hot reload): the latest app answers.
 */
export function attachControl(address: string, target: ControlTarget): void {
  const registry = globalThis as { [CONTROL_KEY]?: Link };
  let link = registry[CONTROL_KEY];
  if (!link || link.ended || link.socket.destroyed) registry[CONTROL_KEY] = link = open(address);
  const current = link;
  current.detach?.();
  current.target = target;
  const stop = target.app.onEvent((event: NativeEvent) => {
    if (!QUIET_EVENTS.has(event.type)) write(current, { type: "event", event });
  });
  let attached = true;
  current.detach = () => { attached = false; stop(); };
  const closed = (): void => {
    if (!attached) return;
    current.detach?.();
    current.detach = undefined;
    current.target = undefined;
    write(current, { type: "closed" });
    // An open socket would keep the process alive after its app closed.
    current.ended = true;
    current.socket.end();
    if (registry[CONTROL_KEY] === current) registry[CONTROL_KEY] = undefined;
  };
  void target.app.closed.then(closed, closed);
}
