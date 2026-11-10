import { afterEach, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppHandle } from "../app";
import type { NativeEvent, NativeNode, Snapshot } from "../protocol";
import { attachControl, controlTree, readControlAddress } from "./control";
import { INSPECTOR_OVERLAY_ID } from "./inspector";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function address(): string {
  const key = Math.random().toString(36).slice(2);
  if (process.platform === "win32") return `\\\\.\\pipe\\tarve-control-test-${key}`;
  const directory = mkdtempSync(join(tmpdir(), "tarve-control-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "c.sock");
}

/** The tool side: accepts the app, collects its lines, sends requests. */
async function tool(path: string): Promise<{ server: Server; connected: Promise<{ socket: Socket; lines: Record<string, any>[]; next(match: (line: Record<string, any>) => boolean): Promise<Record<string, any>> }> }> {
  let accept!: (value: any) => void;
  const connected = new Promise<any>(resolve => { accept = resolve; });
  const server = createServer(socket => {
    const lines: Record<string, any>[] = [];
    const waiters: { match: (line: Record<string, any>) => boolean; resolve: (line: Record<string, any>) => void }[] = [];
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        lines.push(line);
        for (const waiter of [...waiters]) if (waiter.match(line)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(line); }
      }
    });
    accept({
      socket, lines,
      next: (match: (line: Record<string, any>) => boolean) => {
        const seen = lines.find(match);
        return seen ? Promise.resolve(seen) : new Promise(resolve => waiters.push({ match, resolve }));
      },
    });
  });
  await new Promise<void>(resolve => server.listen(path, () => resolve()));
  cleanups.push(() => server.close());
  return { server, connected };
}

const snapshot = (frames: number): Snapshot => ({
  layoutNodes: 2, layoutNodesCreated: 2, measureCalls: 0, paintedNodes: 2, frames, layouts: 1, shapes: 1, paints: frames, fps: 60, activeMotions: 0,
  hovered: null, focused: "field", width: 320, height: 200, scale: 1,
  nodes: [{ id: "root", kind: "view", x: 0, y: 0, width: 320, height: 200, scroll: 0, scrollMax: 0, text: "" }],
});

function fakeApp(): { app: AppHandle; inputs: unknown[]; emit(event: NativeEvent): void; close(): void } {
  const inputs: unknown[] = [];
  const listeners = new Set<(event: NativeEvent) => void>();
  let closeApp!: () => void;
  const closed = new Promise<void>(resolve => { closeApp = resolve; });
  const app = {
    ready: Promise.resolve(),
    closed,
    inspect: async () => snapshot(3),
    layout: (ids: string[]) => Object.fromEntries(ids.map(id => [id, { width: 1, height: 1, x: 0, y: 0 }])),
    stats: async () => ({ js: {}, native: { phases: null, memory: null } }),
    capture: async () => {},
    debug: (command: unknown) => { inputs.push(command); },
    focus: (id: string) => { inputs.push({ focus: id }); },
    scrollTo: (id: string, position: unknown) => { inputs.push({ scrollTo: id, position }); },
    close: () => closeApp(),
    onEvent: (listener: (event: NativeEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  } as unknown as AppHandle;
  return { app, inputs, emit: event => { for (const listener of listeners) listener(event); }, close: () => closeApp() };
}

const root: NativeNode = {
  id: "root", kind: "view", style: { padding: 4 }, children: [
    { id: "field", kind: "input", style: {}, value: "hi", placeholder: "Name", children: [] },
    { id: INSPECTOR_OVERLAY_ID, kind: "view", style: {}, children: [] },
  ],
};

test("readControlAddress reads TARVE_CONTROL only when set", () => {
  expect(readControlAddress({})).toBeUndefined();
  expect(readControlAddress({ TARVE_CONTROL: "" })).toBeUndefined();
  expect(readControlAddress({ TARVE_CONTROL: "/tmp/x.sock" })).toBe("/tmp/x.sock");
});

test("controlTree keeps structure and content, drops inspector nodes and styles unless asked", () => {
  expect(controlTree(root)).toEqual({ id: "root", kind: "view", children: [{ id: "field", kind: "input", value: "hi", placeholder: "Name", children: [] }] });
  expect(controlTree(root, true).style).toEqual({ padding: 4 });
});

test("the app introduces itself, answers requests, reports events and says when it closed", async () => {
  const path = address();
  const { connected } = await tool(path);
  const fake = fakeApp();
  process.env.TARVE_CONTROL_TOKEN = "secret";
  attachControl(path, { app: fake.app, root: () => root });
  const peer = await connected;
  const hello = await peer.next(line => line.type === "hello");
  expect(hello).toMatchObject({ token: "secret", pid: process.pid });

  const ask = (id: number, method: string, params: Record<string, unknown> = {}) => {
    peer.socket.write(JSON.stringify({ id, method, params }) + "\n");
    return peer.next(line => line.id === id);
  };
  expect((await ask(1, "inspect")).result.focused).toBe("field");
  expect((await ask(2, "tree")).result.children.map((child: { id: string }) => child.id)).toEqual(["field"]);
  expect((await ask(3, "settle")).result.frames).toBe(3);
  expect((await ask(4, "input", { action: "move", x: 5, y: 6 })).result).toBeNull();
  expect(fake.inputs).toEqual([{ type: "input", action: "move", x: 5, y: 6 }]);
  expect((await ask(5, "input", { action: "eval", text: "x" })).error).toContain("input action must be one of");
  expect((await ask(6, "input", { action: "move" })).error).toContain("finite x and y");
  expect((await ask(7, "nope")).error).toContain("Unknown control method");
  await ask(8, "scrollTo", { id: "list", y: "end" });
  expect(fake.inputs.at(-1)).toEqual({ scrollTo: "list", position: { y: "end", smooth: false } });

  fake.emit({ type: "click", id: "field" });
  fake.emit({ type: "inspect" } as unknown as NativeEvent);
  expect((await peer.next(line => line.type === "event")).event).toEqual({ type: "click", id: "field" });

  await ask(9, "close");
  await peer.next(line => line.type === "closed");
  expect(peer.lines.filter(line => line.type === "event")).toHaveLength(1);
  delete process.env.TARVE_CONTROL_TOKEN;
});
