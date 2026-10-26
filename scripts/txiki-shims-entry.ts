// Runs inside a txiki.js executable (see smoke-txiki-shims.ts): exercises each node:* shim.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { accessSync, closeSync, constants, copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, freemem, release, tmpdir, totalmem } from "node:os";
import { createServer, connect } from "node:net";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { deflateSync, gunzipSync, gzipSync, inflateSync } from "node:zlib";

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
  // What the updater uses: access, descriptors with a position, copies, a write stream.
  writeFileSync(join(root, "h.bin"), "0123456789");
  let noAccess = "";
  try { accessSync(join(root, "missing"), constants.W_OK); } catch (error) { noAccess = (error as { code?: string }).code ?? "thrown"; }
  accessSync(join(root, "h.bin"), constants.R_OK | constants.W_OK);
  accessSync(root, constants.W_OK);
  check("fs.accessSync", noAccess === "ENOENT", noAccess);
  const fd = openSync(join(root, "h.bin"), "r");
  const head = new Uint8Array(8);
  const headRead = readSync(fd, head, 2, 4, 3);
  closeSync(fd);
  check("fs.openSync readSync closeSync", headRead === 4 && Buffer.from(head.subarray(2, 6)).toString() === "3456" && head[0] === 0, [headRead, [...head]]);
  copyFileSync(join(root, "h.bin"), join(root, "copy.bin"));
  let copyExclusive = "";
  try { copyFileSync(join(root, "h.bin"), join(root, "copy.bin"), constants.COPYFILE_EXCL); } catch (error) { copyExclusive = (error as { code?: string }).code ?? "thrown"; }
  check("fs.copyFileSync", readFileSync(join(root, "copy.bin"), "utf8") === "0123456789" && copyExclusive === "EEXIST", copyExclusive);
  const stream = createWriteStream(join(root, "stream.bin"), { mode: 0o755 });
  const writes = [stream.write("ab"), stream.write(Buffer.from("cd"))];
  await new Promise<void>((resolve, reject) => stream.end((error?: Error | null) => error ? reject(error) : resolve()));
  check("fs.createWriteStream", writes.every(Boolean) && readFileSync(join(root, "stream.bin"), "utf8") === "abcd" && stream.bytesWritten === 4, { writes, bytes: stream.bytesWritten });

  await mkdir(join(root, "p"), { recursive: true });
  await writeFile(join(root, "p", "x.json"), JSON.stringify({ ok: 1 }));
  check("fs/promises", JSON.parse(await readFile(join(root, "p", "x.json"), "utf8")).ok === 1 && (await readdir(join(root, "p")))[0] === "x.json");

  check("os", cpus().length > 0 && totalmem() > freemem() && freemem() > 0 && /^\d+\.\d+/.test(release()), { cpus: cpus().length, totalmem: totalmem(), freemem: freemem(), release: release() });
  check("crypto", createHash("sha256").update("abc").digest("hex") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" && randomUUID().length === 36);
  check("path", basename(join("a", "b.txt")) === "b.txt");
  // node:zlib through the native library: Node.js's bytes for "hello", a 1 MiB stream that inflates
  // past the first output buffer, a view at an offset, and data that is not zlib.
  const zeros = new Uint8Array(1 << 20);
  const hello = Buffer.from("789ccb48cdc9c90700062c0215", "hex");
  let corrupt = "accepted";
  try { inflateSync(Buffer.from("not zlib")); } catch (error) { corrupt = (error as Error).message; }
  check("zlib", Buffer.from(deflateSync(Buffer.from("hello"))).toString("hex") === hello.toString("hex")
    && Buffer.from(inflateSync(hello)).toString() === "hello"
    && inflateSync(deflateSync(zeros, { level: 9 })).length === zeros.length
    && Buffer.from(inflateSync(Buffer.concat([Buffer.from("xx"), hello]).subarray(2))).toString() === "hello"
    && corrupt.startsWith("zlib.inflateSync: invalid zlib data"),
    { hello: Buffer.from(deflateSync(Buffer.from("hello"))).toString("hex"), corrupt });
  // gzip: Node.js's bytes for "hello" (the OS byte is 0a on Windows, 03 on Linux), joined members, damage.
  const gzipped = Buffer.from(`1f8b08000000000000${process.platform === "win32" ? "0a" : "03"}cb48cdc9c9070086a6103605000000`, "hex");
  let damaged = "accepted";
  try { gunzipSync(Buffer.from("not gzip")); } catch (error) { damaged = (error as Error).message; }
  check("zlib gzip", Buffer.from(gzipSync(Buffer.from("hello"))).toString("hex") === gzipped.toString("hex")
    && Buffer.from(gunzipSync(gzipped)).toString() === "hello"
    && gunzipSync(gzipSync(zeros, { level: 9 })).length === zeros.length
    && Buffer.from(gunzipSync(Buffer.concat([gzipSync(Buffer.from("ab")), gzipSync(Buffer.from("cd"))]))).toString() === "abcd"
    && damaged === "zlib.gunzipSync: incorrect header check",
    { gzip: Buffer.from(gzipSync(Buffer.from("hello"))).toString("hex"), damaged });
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
  // spawnSync (CreateProcessW / posix_spawnp): output, exit code, cwd, env, a missing command, the timeout.
  const windows = process.platform === "win32";
  const shell = (script: string) => windows ? ["cmd.exe", ["/d", "/s", "/c", script]] as const : ["sh", ["-c", script]] as const;
  const [shellCommand, shellArgs] = shell(windows ? "echo out& echo err 1>&2& exit /b 3" : "echo out; echo err >&2; exit 3");
  const sync = spawnSync(shellCommand, [...shellArgs], { encoding: "utf8", windowsHide: true });
  check("child_process.spawnSync", sync.status === 3 && sync.signal === null && sync.stdout.trim() === "out" && sync.stderr.trim() === "err" && !sync.error && sync.pid > 0, { status: sync.status, stdout: sync.stdout, stderr: sync.stderr, error: sync.error?.message });
  const [envCommand, envArgs] = shell(windows ? "echo %TARVE_SHIM%& cd" : "echo $TARVE_SHIM; pwd");
  const placed = spawnSync(envCommand, [...envArgs], { encoding: "utf8", cwd: root, env: { ...process.env, TARVE_SHIM: "shim-env" }, windowsHide: true });
  const placedLines = placed.stdout.trim().split(/\r?\n/);
  check("child_process.spawnSync cwd env", placed.status === 0 && placedLines[0] === "shim-env" && placedLines[1]!.endsWith(basename(root)), placed.stdout);
  const absent = spawnSync("tarve-no-such-command", ["x"], { encoding: "utf8" });
  check("child_process.spawnSync ENOENT", (absent.error as { code?: string } | undefined)?.code === "ENOENT" && absent.status === null, absent.error?.message);
  const [slowCommand, slowArgs] = shell(windows ? "ping -n 6 127.0.0.1 >NUL" : "sleep 5");
  const slowStarted = Date.now();
  const slow = spawnSync(slowCommand, [...slowArgs], { timeout: 300, windowsHide: true });
  check("child_process.spawnSync timeout", (slow.error as { code?: string } | undefined)?.code === "ETIMEDOUT" && slow.status === null && slow.signal === "SIGTERM" && Date.now() - slowStarted < 3000, { error: slow.error?.message, status: slow.status, signal: slow.signal, ms: Date.now() - slowStarted });
  // node:net over tjs pipes (requestSingleInstance): a round trip, then close() lets the process exit.
  const address = windows ? `\\\\.\\pipe\\tarve-shims-${randomUUID()}` : join(root, "shims.sock");
  const server = createServer(socket => {
    socket.setEncoding("utf8");
    socket.on("data", chunk => socket.end(`echo:${chunk}`));
  });
  await new Promise<void>((resolve, reject) => { server.on("error", reject); server.listen(address, () => resolve()); });
  const reply = await new Promise<string>((resolve, reject) => {
    let text = "";
    const socket = connect(address, () => socket.write("hi"));
    socket.setEncoding("utf8");
    socket.on("data", chunk => { text += chunk; });
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
  });
  server.close();
  let unref = "";
  try { server.unref(); } catch (error) { unref = (error as Error).message; }
  check("net server", reply === "echo:hi" && unref.includes("close() the server"), { reply, unref });
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
  // QuickJS's stack has no message line.
  results.error = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  await rm(root, { recursive: true, force: true });
}
const failed = Object.entries(results).filter(([, value]) => value !== true);
writeFileSync(process.argv[2]!, JSON.stringify({ result: failed.length ? "FAIL" : "PASS", results }, null, 2));
