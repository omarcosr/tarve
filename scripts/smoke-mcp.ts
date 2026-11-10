import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Real-window smoke for @tarve/mcp: the MCP server starts scripts/smoke-mcp-app.tsx and this
// script drives it as an MCP client would, over stdio.
//   bun scripts/smoke-mcp.ts            server on Bun, app with `tarve dev` on Bun
//   bun scripts/smoke-mcp.ts --node     server on Node.js (packages/mcp/dist), app with `tarve dev --runtime node`
//   bun scripts/smoke-mcp.ts --txiki    server on Bun, app built as a txiki.js executable (`tarve-mcp app.exe`)
const root = resolve(import.meta.dirname, "..");
const mode = process.argv.includes("--node") ? "node" : process.argv.includes("--txiki") ? "txiki" : "bun";
const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed`);
};
let command: string[];
if (mode === "node") {
  run(process.execPath, ["packages/mcp/build.ts"]);
  command = ["node", "packages/mcp/dist/cli.js", "scripts/smoke-mcp-app.tsx", "--runtime", "node"];
} else if (mode === "txiki") {
  mkdirSync(resolve(root, "work"), { recursive: true });
  const exe = resolve(root, "work", process.platform === "win32" ? "smoke-mcp-txiki.exe" : "smoke-mcp-txiki");
  run(process.execPath, ["packages/core/cli.ts", "build", "scripts/smoke-mcp-app.tsx", "--outfile", exe, "--runtime", "txiki"]);
  command = [process.execPath, "packages/mcp/src/cli.ts", exe];
} else {
  command = [process.execPath, "packages/mcp/src/cli.ts", "scripts/smoke-mcp-app.tsx"];
}
const server = spawn(command[0]!, command.slice(1), { cwd: root, stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map<number, (message: any) => void>();
let buffer = "";
server.stdout.setEncoding("utf8");
server.stdout.on("data", (chunk: string) => {
  buffer += chunk;
  let end: number;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    pending.get(message.id)?.(message);
  }
});
let nextId = 0;
function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++nextId;
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`${method} timed out`)), 90_000);
    pending.set(id, message => { clearTimeout(timer); message.error ? fail(new Error(message.error.message)) : done(message.result); });
  });
}
async function tool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; content: any[] }> {
  const result = await rpc("tools/call", { name, arguments: args });
  const text = result.content.map((part: any) => part.text ?? "").join("\n");
  assert(!result.isError, `${name} failed: ${text}`);
  return { text, content: result.content };
}

try {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  assert.equal(init.serverInfo.name, "tarve");
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = (await rpc("tools/list")).tools.map((entry: { name: string }) => entry.name);
  for (const name of ["inspect_tree", "screenshot", "click", "type_text", "reload", "get_metrics"]) assert(tools.includes(name), name);

  await tool("wait_for", { text: "Count: 0", timeoutMs: 60_000 });
  const tree = await tool("inspect_tree");
  assert.match(tree.text, /#count "Count: 0"/);
  console.log(tree.text.split("\n").slice(0, 12).join("\n"));

  const shot = await tool("screenshot");
  assert.equal(shot.content[0].type, "image");
  assert(Buffer.from(shot.content[0].data, "base64").subarray(1, 4).toString() === "PNG", "screenshot is a PNG");

  await tool("click", { text: "Bump" });
  await tool("wait_for", { text: "Count: 1" });
  await tool("type_text", { id: "name", text: "Ana" });
  await tool("wait_for", { text: "Hello Ana" });
  await tool("press_key", { key: "backspace", id: "name" });
  await tool("wait_for", { text: "Hello An", exact: true });

  const metrics = JSON.parse((await tool("get_metrics")).text);
  assert(metrics.counters.frames > 0 && metrics.js.update.count > 0, "metrics have frames and updates");
  assert.match((await tool("get_logs")).text, /bumped 1/);
  assert((JSON.parse((await tool("get_events")).text).events as unknown[]).length > 0, "events are logged");

  const before = JSON.parse((await tool("app_status")).text).pid;
  const after = JSON.parse((await tool("reload")).text);
  assert.notEqual(after.pid, before);
  await tool("wait_for", { text: "Count: 0", timeoutMs: 60_000 });
  const runtime = JSON.parse((await tool("app_status")).text).runtime;
  assert.equal(runtime, mode, `the app runs on ${mode}`);
  console.log(`smoke-mcp (${mode}): ok`);
} finally {
  server.stdin.end();
  await new Promise(done => server.once("exit", done));
}
