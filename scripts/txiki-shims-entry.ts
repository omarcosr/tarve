// Runs inside a txiki.js executable (see smoke-txiki-shims.ts): exercises each node:* shim.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, freemem, release, tmpdir, totalmem } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const results: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail?: unknown) => { results[name] = ok ? true : { failed: detail }; };

const root = mkdtempSync(join(tmpdir(), "tarve-txiki-shims-"));
try {
  mkdirSync(join(root, "a", "b"), { recursive: true });
  writeFileSync(join(root, "a", "b", "f.txt"), "héllo");
  check("fs.readFileSync", readFileSync(join(root, "a", "b", "f.txt"), "utf8") === "héllo");
  check("fs.statSync", statSync(join(root, "a", "b", "f.txt")).size === 6 && statSync(join(root, "a")).isDirectory());
  renameSync(join(root, "a", "b", "f.txt"), join(root, "a", "g.txt"));
  check("fs.readdirSync", JSON.stringify(readdirSync(join(root, "a")).sort()) === JSON.stringify(["b", "g.txt"]), readdirSync(join(root, "a")));
  let exclusive = false;
  try { writeFileSync(join(root, "a", "g.txt"), "x", { flag: "wx" }); } catch { exclusive = true; }
  check("fs.writeFileSync wx", exclusive);
  let missingDirectory = "";
  try { readdirSync(join(root, "missing")); } catch (error) { missingDirectory = (error as { code?: string }).code ?? "thrown"; }
  check("fs.readdirSync missing", missingDirectory === "ENOENT", missingDirectory);
  rmSync(join(root, "a", "g.txt"));
  check("fs.rmSync", !existsSync(join(root, "a", "g.txt")));
  mkdirSync(join(root, "tree", "deep"), { recursive: true });
  writeFileSync(join(root, "tree", "deep", "f.txt"), "x");
  rmSync(join(root, "tree"), { recursive: true });
  check("fs.rmSync recursive", !existsSync(join(root, "tree")));

  await mkdir(join(root, "p"), { recursive: true });
  await writeFile(join(root, "p", "x.json"), JSON.stringify({ ok: 1 }));
  check("fs/promises", JSON.parse(await readFile(join(root, "p", "x.json"), "utf8")).ok === 1 && (await readdir(join(root, "p")))[0] === "x.json");

  check("os", cpus().length > 0 && totalmem() > freemem() && freemem() > 0 && /^\d+\.\d+/.test(release()), { cpus: cpus().length, totalmem: totalmem(), freemem: freemem(), release: release() });
  check("crypto", createHash("sha256").update("abc").digest("hex") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" && randomUUID().length === 36);
  check("path", basename(join("a", "b.txt")) === "b.txt");
  check("Buffer", Buffer.from("hi").toString("base64") === "aGk=");
  check("Intl", new Intl.NumberFormat("en-US").format(1234567.891) === "1,234,567.891" && new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(2026, 9, 15)) === "Oct 15",
    [new Intl.NumberFormat("en-US").format(1234567.891), new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(2026, 9, 15))]);

  const emitter = new EventEmitter();
  setTimeout(() => emitter.emit("ready", 7), 1);
  check("events.once", (await once(emitter, "ready"))[0] === 7);
  const started = Date.now();
  await sleep(20);
  check("timers/promises", Date.now() - started >= 15);

  const command = process.platform === "win32" ? ["cmd", ["/c", "echo one&& echo two"]] as const : ["sh", ["-c", "echo one; echo two"]] as const;
  const child = spawn(command[0], [...command[1]], { stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  for await (const chunk of child.stdout!) output += chunk.toString();
  const [code] = child.exitCode !== null ? [child.exitCode] : await once(child, "exit");
  check("child_process.spawn", code === 0 && output.replace(/\r/g, "") === "one\ntwo\n", { code, output });
  // fetch (txiki/fetch.ts): exactly the app's headers, bodies, redirects, compression, streaming, abort.
  const base = process.argv[3]!;
  const echo = await (await fetch(base + "/echo", { method: "POST", headers: { origin: "https://example.com", "content-type": "application/json" }, body: JSON.stringify({ a: "ação" }) })).json() as { method: string; headers: Record<string, string[]>; body: string };
  check("fetch headers", JSON.stringify(echo.headers.origin) === JSON.stringify(["https://example.com"]) && !echo.headers.pragma && !echo.headers["cache-control"], echo.headers);
  check("fetch body", echo.method === "POST" && JSON.parse(echo.body).a === "ação", echo);
  check("fetch gzip", (await (await fetch(base + "/gzip")).text()) === "zipped ".repeat(200));
  check("fetch chunked", (await (await fetch(base + "/chunked")).text()) === "abc");
  const moved = await fetch(base + "/redirect?status=302", { method: "POST", body: "x" });
  const kept = await (await fetch(base + "/redirect?status=307", { method: "POST", body: "y" })).json() as { method: string; body: string };
  check("fetch redirects", moved.redirected && (await moved.json() as { method: string }).method === "GET" && kept.method === "POST" && kept.body === "y", kept);
  const cookies = await fetch(base + "/cookies");
  check("fetch set-cookie", (cookies.headers.get("set-cookie") ?? "").includes("a=1") && (cookies.headers.get("set-cookie") ?? "").includes("b=2"));
  const missing = await fetch(base + "/nothing");
  check("fetch status", missing.status === 404 && !missing.ok && missing.statusText === "Not Found");
  check("fetch connection-delimited body", (await (await fetch(base + "/no-length")).text()) === "streamed");
  const refused = await fetch("http://127.0.0.1:1/").then(() => "resolved", (error: Error) => error.name || "Error");
  check("fetch refused connection rejects", refused !== "resolved", refused);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const aborted = await fetch(base + "/slow", { signal: controller.signal }).then(() => "resolved", (error: Error) => error.name);
  check("fetch abort", aborted === "AbortError", aborted);
} catch (error) {
  results.error = String((error as Error)?.stack ?? error);
} finally {
  await rm(root, { recursive: true, force: true });
}
const failed = Object.entries(results).filter(([, value]) => value !== true);
writeFileSync(process.argv[2]!, JSON.stringify({ result: failed.length ? "FAIL" : "PASS", results }, null, 2));
