// Builds scripts/txiki-shims-entry.ts as a txiki.js executable and checks every node:* shim inside it.
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "../packages/core/build";
import { buildNative } from "./native";

const root = resolve(import.meta.dir, "..");
const directory = await mkdtemp(join(root, "work/txiki shims "));
try {
  const executable = join(directory, "Shims.exe");
  await build({ entrypoint: join(root, "scripts/txiki-shims-entry.ts"), outfile: executable, runtime: "txiki", nativeLibrary: await buildNative(true) });
  const report = join(directory, "report.json");
  // HTTP endpoints for the fetch checks (the txiki.js fetch shim, txiki/fetch.ts).
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/echo") {
      const headers: Record<string, string[]> = {};
      request.headers.forEach((value, name) => { (headers[name] ??= []).push(value); });
      return Response.json({ method: request.method, headers, body: await request.text() });
    }
    if (url.pathname === "/gzip") return new Response(Bun.gzipSync(new TextEncoder().encode("zipped ".repeat(200))), { headers: { "content-encoding": "gzip" } });
    if (url.pathname === "/chunked") return new Response(new ReadableStream({ async start(controller) { for (const part of ["a", "b", "c"]) { controller.enqueue(new TextEncoder().encode(part)); await Bun.sleep(20); } controller.close(); } }));
    if (url.pathname === "/redirect") return new Response(null, { status: Number(url.searchParams.get("status")), headers: { location: "/echo" } });
    if (url.pathname === "/cookies") { const headers = new Headers(); headers.append("set-cookie", "a=1"); headers.append("set-cookie", "b=2"); return new Response("ok", { headers }); }
    if (url.pathname === "/no-length") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("streamed")); controller.close(); } }), { headers: { "content-length": "bogus" } });
    if (url.pathname === "/slow") { await Bun.sleep(3000); return new Response("late"); }
    return new Response("missing", { status: 404, statusText: "Not Found" });
  } });
  const child = Bun.spawn([executable, report, `http://127.0.0.1:${server.port}`], { stdout: "inherit", stderr: "inherit" });
  const exited = await child.exited;
  server.stop(true);
  if (exited !== 0) throw new Error("The txiki.js shim executable failed");
  const result = await Bun.file(report).json();
  console.log(JSON.stringify(result, null, 2));
  if (result.result !== "PASS") process.exit(1);
} finally {
  await rm(directory, { recursive: true, force: true });
}
