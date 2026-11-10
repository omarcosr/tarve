import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How to start the app: a program and its arguments. */
export interface LaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface SessionOptions {
  /** How long the app may take to connect after it starts. Default 60 s (a first `bun --hot` compile). */
  connectTimeoutMs?: number;
  /** App events kept for `events()`. Default 500. */
  eventLimit?: number;
  /** Output lines kept for `logs()`. Default 1000. */
  logLimit?: number;
}

export interface AppEvent { seq: number; time: number; event: Record<string, unknown> }
export interface LogLine { seq: number; time: number; stream: "stdout" | "stderr"; text: string }

export interface SessionStatus {
  running: boolean;
  connected: boolean;
  pid?: number;
  /** The app process's runtime, as it reported it. */
  runtime?: string;
  exitCode?: number | null;
  starts: number;
  command: string[];
}

/** A bounded log with increasing sequence numbers, so readers can ask for what is new. */
class Ring<T extends { seq: number }> {
  private items: T[] = [];
  private next = 1;
  private readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  push(item: Omit<T, "seq">): void {
    this.items.push({ ...item, seq: this.next++ } as T);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
  }
  since(seq = 0, limit = 100): T[] {
    const newer = this.items.filter(item => item.seq > seq);
    return newer.slice(Math.max(0, newer.length - limit));
  }
  get last(): number { return this.next - 1; }
}

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/** A private socket address: a named pipe on Windows, a Unix socket in a 0700 temporary directory elsewhere. */
function controlAddress(): { address: string; cleanup(): void } {
  const key = randomBytes(16).toString("hex");
  if (process.platform === "win32") return { address: `\\\\.\\pipe\\tarve-mcp-${key}`, cleanup() {} };
  const directory = mkdtempSync(join(tmpdir(), "tarve-mcp-"));
  return { address: join(directory, "control.sock"), cleanup() { rmSync(directory, { recursive: true, force: true }); } };
}

/**
 * One app driven by the MCP server: it starts the app with `TARVE_CONTROL` pointing at a
 * socket only this session knows (and a token the app must present), keeps its output and
 * events, sends it requests and restarts it.
 */
export class AppSession {
  readonly launch: LaunchSpec;
  readonly directory: string;
  private readonly options: Required<SessionOptions>;
  private readonly token = randomBytes(24).toString("hex");
  private readonly addr: { address: string; cleanup(): void };
  private server: Server | undefined;
  private listening: Promise<void> | undefined;
  private child: ChildProcess | undefined;
  private socket: Socket | undefined;
  private runtime: string | undefined;
  private exitCode: number | null | undefined;
  private starts = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private connected: Promise<void> | undefined;
  private connectWaiter: { resolve(): void; reject(error: Error): void } | undefined;
  private readonly eventLog: Ring<AppEvent>;
  private readonly logLog: Ring<LogLine>;

  constructor(launch: LaunchSpec, options: SessionOptions = {}) {
    this.launch = launch;
    this.options = { connectTimeoutMs: options.connectTimeoutMs ?? 60_000, eventLimit: options.eventLimit ?? 500, logLimit: options.logLimit ?? 1000 };
    this.eventLog = new Ring(this.options.eventLimit);
    this.logLog = new Ring(this.options.logLimit);
    this.addr = controlAddress();
    this.directory = mkdtempSync(join(tmpdir(), "tarve-mcp-shots-"));
  }

  status(): SessionStatus {
    return {
      running: !!this.child && this.child.exitCode === null && this.child.signalCode === null,
      connected: !!this.socket && !this.socket.destroyed,
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
      ...(this.runtime ? { runtime: this.runtime } : {}),
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
      starts: this.starts,
      command: [this.launch.command, ...this.launch.args],
    };
  }

  events(since?: number, limit?: number): { events: AppEvent[]; last: number } {
    return { events: this.eventLog.since(since, limit), last: this.eventLog.last };
  }

  logs(since?: number, limit?: number): { lines: LogLine[]; last: number } {
    return { lines: this.logLog.since(since, limit), last: this.logLog.last };
  }

  private listen(): Promise<void> {
    return this.listening ??= new Promise((resolve, reject) => {
      const server = createServer(socket => this.accept(socket));
      server.on("error", reject);
      server.listen(this.addr.address, () => { this.server = server; resolve(); });
    });
  }

  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    let buffer = "";
    let introduced = false;
    socket.on("data", chunk => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: Record<string, unknown>;
        try { message = JSON.parse(line); } catch { continue; }
        if (!introduced) {
          // Only the app this session started knows the token.
          if (message.type !== "hello" || message.token !== this.token) { socket.destroy(); return; }
          introduced = true;
          this.socket?.destroy();
          this.socket = socket;
          this.runtime = typeof message.runtime === "string" ? message.runtime : undefined;
          this.connectWaiter?.resolve();
          continue;
        }
        this.receive(message);
      }
      if (buffer.length > 1 << 26) socket.destroy();
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.rejectPending(new Error("The app disconnected"));
    });
  }

  private receive(message: Record<string, unknown>): void {
    if (message.type === "event" && message.event && typeof message.event === "object") {
      this.eventLog.push({ time: Date.now(), event: message.event as Record<string, unknown> });
      return;
    }
    if (message.type === "closed") {
      this.eventLog.push({ time: Date.now(), event: { type: "closed" } });
      return;
    }
    const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (!pending) return;
    this.pending.delete(message.id as number);
    clearTimeout(pending.timer);
    if (typeof message.error === "string") pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private recentErrors(): string {
    const lines = this.logLog.since(0, 15).map(line => line.text);
    return lines.length ? `\n${lines.join("\n")}` : "";
  }

  /** Starts the app (when it is not running) and resolves once it has connected. */
  async start(): Promise<void> {
    if (this.connected && this.status().running) return this.connected;
    await this.listen();
    this.starts++;
    this.exitCode = undefined;
    const { command, args, cwd, env } = this.launch;
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env, TARVE_CONTROL: this.addr.address, TARVE_CONTROL_TOKEN: this.token, TARVE_DEV: process.env.TARVE_DEV ?? "1" },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group on Unix, so a stop reaches the runtime a CLI forwards to.
      detached: process.platform !== "win32",
      windowsHide: true,
      // Windows runs `.cmd` shims (npx, bunx) through the shell only.
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
    });
    this.child = child;
    for (const stream of ["stdout", "stderr"] as const) {
      let rest = "";
      child[stream]?.setEncoding("utf8");
      child[stream]?.on("data", (chunk: string) => {
        const parts = (rest + chunk).split(/\r?\n/);
        rest = parts.pop() ?? "";
        for (const text of parts) this.logLog.push({ time: Date.now(), stream, text });
      });
      child[stream]?.on("end", () => { if (rest) this.logLog.push({ time: Date.now(), stream, text: rest }); rest = ""; });
    }
    const connected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error(`The app did not connect within ${this.options.connectTimeoutMs} ms${this.recentErrors()}`)), this.options.connectTimeoutMs);
      const fail = (error: Error) => { clearTimeout(timer); this.connectWaiter = undefined; reject(error); };
      this.connectWaiter = { resolve: () => { clearTimeout(timer); this.connectWaiter = undefined; resolve(); }, reject: fail };
      child.once("error", error => fail(new Error(`Could not start ${command}: ${error.message}`)));
      child.once("exit", code => {
        this.exitCode = code;
        if (this.child === child) this.rejectPending(new Error(`The app exited (code ${code})`));
        if (this.connectWaiter) fail(new Error(`The app exited (code ${code}) before it connected${this.recentErrors()}`));
      });
    });
    this.connected = connected;
    connected.catch(() => {});
    return connected;
  }

  /** Sends a control request to the connected app. */
  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    // A tool called while the app is still starting waits for it to connect.
    if (!this.socket && this.connectWaiter && this.connected) await this.connected;
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      const exited = this.exitCode !== undefined ? ` (it exited with code ${this.exitCode})` : "";
      return Promise.reject(new Error(`The app is not connected${exited}: call reload to start it again`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  /** Stops the app: asks it to close, then ends its process tree. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    await this.request("close", {}, 1500).catch(() => {});
    const closed = await Promise.race([exited.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 3000))]);
    if (!closed) {
      this.kill(child);
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
  }

  private kill(child: ChildProcess): void {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      else process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    this.connected = undefined;
    return this.start();
  }

  /** Stops the app and removes the socket and screenshots. */
  async dispose(): Promise<void> {
    await this.stop();
    this.socket?.destroy();
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve());
    this.addr.cleanup();
    rmSync(this.directory, { recursive: true, force: true });
  }

  /** Synchronous last resort when the server process exits. */
  killNow(): void {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.kill(this.child);
  }
}
