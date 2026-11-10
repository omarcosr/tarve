import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { createHandler, serveStdio, textResult, type Tool } from "./server";
import { AppSession } from "./session";
import { createTools, keyName, outline } from "./tools";
import { parseArgs, resolveLaunch } from "./cli-args";

const echo: Tool = {
  name: "echo",
  description: "Echoes",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  async run(args) {
    if (args.text === "boom") throw new Error("exploded");
    return textResult(String(args.text));
  },
};
const info = { name: "tarve", version: "0.0.0", instructions: "hi" };

test("initialize negotiates the protocol version and lists tools", async () => {
  const handle = createHandler([echo], info);
  const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  expect(init?.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "tarve" }, instructions: "hi" });
  const future = await handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } });
  expect((future?.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
  expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
  const list = await handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  expect((list?.result as { tools: { name: string }[] }).tools.map(tool => tool.name)).toEqual(["echo"]);
  expect((await handle({ jsonrpc: "2.0", id: 4, method: "ping" }))?.result).toEqual({});
});

test("tool failures are results, unknown tools and methods are errors", async () => {
  const handle = createHandler([echo], info);
  expect((await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: "a" } } }))?.result).toEqual({ content: [{ type: "text", text: "a" }] });
  expect((await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "boom" } } }))?.result).toEqual({ content: [{ type: "text", text: "exploded" }], isError: true });
  expect((await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } }))?.error?.code).toBe(-32602);
  expect((await handle({ jsonrpc: "2.0", id: 4, method: "resources/list" }))?.error?.code).toBe(-32601);
});

test("serveStdio frames newline-delimited JSON and answers parse errors", async () => {
  const input = new PassThrough(), output = new PassThrough();
  const lines: unknown[] = [];
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => { for (const line of chunk.split("\n")) if (line) lines.push(JSON.parse(line)); });
  const served = serveStdio([echo], info, { input, output });
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\r\n{oops}\n');
  input.end('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"text":"x"}}}');
  await served;
  expect(lines).toContainEqual({ jsonrpc: "2.0", id: 1, result: {} });
  expect(lines).toContainEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  expect(lines).toContainEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "x" }] } });
});

test("arguments: an entry or a command after --", () => {
  expect(parseArgs(["app.tsx", "--run", "--inspect"], "/p")).toMatchObject({ entry: "app.tsx", mode: "run", inspect: true });
  expect(parseArgs(["--", "bun", "--hot", "app.tsx"], "/p").command).toEqual(["bun", "--hot", "app.tsx"]);
  expect(parseArgs(["--exec", "bun", "--hot", "app.tsx"], "/p").command).toEqual(["bun", "--hot", "app.tsx"]);
  expect(resolveLaunch(parseArgs([process.execPath], "/p"))).toMatchObject({ command: process.execPath, args: [] });
  expect(() => parseArgs(["a.tsx", "b.tsx"])).toThrow("one app entry");
  expect(() => parseArgs(["--bogus"])).toThrow("Unknown option");
  expect(resolveLaunch(parseArgs(["--inspect", "--", "node", "x.js"], "/p"))).toEqual({ command: "node", args: ["x.js"], cwd: "/p", env: { TARVE_INSPECTOR: "1" } });
});

test("the tree outline shows content, boxes and limits", () => {
  const tree = { id: "r", kind: "view", children: [{ id: "a", kind: "text", text: "Hi", children: [] }, { id: "b", kind: "input", value: "v", children: [] }] };
  const snapshot = { focused: "b", hovered: null, nodes: [{ id: "a", kind: "text", x: 1, y: 2, width: 30, height: 10, scroll: 0, scrollMax: 0, text: "Hi" }] } as never;
  expect(outline(tree, snapshot)).toBe('view#r\n  text#a "Hi" [1,2 30x10]\n  input#b value="v" (focused)');
  expect(outline(tree, snapshot, { maxNodes: 1 })).toBe("view#r\n… 2 more nodes (raise maxNodes or pass root)");
  expect(keyName("enter")).toBe("Enter");
  expect(keyName("a")).toBe("a");
});

describe_app();

function describe_app(): void {
  const fixture = fileURLToPath(new URL("./fixtures/fake-app.mjs", import.meta.url));
  let session: AppSession;
  let call: (name: string, args?: Record<string, unknown>) => Promise<{ content: { type: string; text?: string; data?: string }[]; isError?: boolean }>;
  beforeAll(async () => {
    session = new AppSession({ command: process.execPath, args: [fixture] }, { connectTimeoutMs: 10_000 });
    const handle = createHandler(createTools(session), info);
    let id = 0;
    call = async (name, args = {}) => (await handle({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }))!.result as never;
    void session.start();
  });
  afterAll(() => session.dispose());
  const text = (result: Awaited<ReturnType<typeof call>>) => result.content.map(part => part.text ?? "").join("\n");

  test("a tool called while the app starts waits for it, and reads the tree", async () => {
    const tree = await call("inspect_tree");
    expect(tree.isError).toBeUndefined();
    expect(text(tree)).toContain('text#count "Count: 0" [10,10 80x20]');
    expect(JSON.parse(text(await call("app_status")))).toMatchObject({ running: true, connected: true, runtime: "fake", window: { width: 300, height: 200 } });
  });

  test("query, click by label, events and logs", async () => {
    const found = JSON.parse(text(await call("query_nodes", { text: "Increment" })));
    expect(found.nodes.map((node: { id: string }) => node.id)).toEqual(["inc"]);
    const clicked = JSON.parse(text(await call("click", { text: "Increment" })));
    expect(clicked).toMatchObject({ clicked: { id: "inc" }, at: { x: 60, y: 55 } });
    expect(text(await call("wait_for", { text: "Count: 1", timeoutMs: 1000 }))).toContain("count");
    const events = JSON.parse(text(await call("get_events")));
    expect(events.events.map((entry: { event: unknown }) => entry.event)).toContainEqual({ type: "click", id: "inc" });
    await call("type_text", { text: "hello", id: "field" });
    const logs = text(await call("get_logs"));
    expect(logs).toContain("fake app started");
    expect(logs).toContain("! a warning");
    expect(logs).toContain("typed hello");
    expect((await call("click", { text: "Nowhere" })).isError).toBe(true);
  });

  test("screenshot returns the PNG and reload restarts the process", async () => {
    const shot = await call("screenshot");
    expect(shot.content[0]).toMatchObject({ type: "image", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") });
    const before = session.status().pid;
    const status = JSON.parse(text(await call("reload")));
    expect(status).toMatchObject({ running: true, connected: true, starts: 2 });
    expect(status.pid).not.toBe(before);
    expect(text(await call("inspect_tree"))).toContain("Count: 0");
  });
}
