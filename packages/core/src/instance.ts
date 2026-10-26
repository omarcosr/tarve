import { createHash } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { runtimeAppMetadata } from "./app-metadata";
import { urlsOf } from "./associations";
import { openLibrary } from "./bridge/binding";
import { nativePath } from "#tarve/runtime";

/** How the app was launched: its arguments, working directory and the URLs among them. */
export interface InstanceLaunch {
  args: string[];
  cwd: string;
  /** Arguments that are URLs of the app's schemes (`myapp://…`), as an OS opens a link. */
  urls: string[];
}

export interface SingleInstanceOptions {
  /** Names the app across processes. Default: package.json `tarve.appId`, else the app name, else the executable. */
  id?: string;
  /** URL schemes whose links are picked out of the arguments (`urls`); default every `scheme://` argument. */
  schemes?: string[];
}

export interface SingleInstance {
  /** This process is the app's first instance. When false, its launch went to that one: exit. */
  readonly primary: boolean;
  /** This launch (arguments after the script, working directory, URLs). */
  readonly launch: InstanceLaunch;
  /**
   * Another launch of the app (opening a file or a link, a second click on the icon) was
   * forwarded here. Typically `app.activate()` and then handle `urls`/`args`.
   */
  onSecondInstance(listener: (launch: InstanceLaunch) => void): () => void;
  /** Stops answering later launches (they become first instances themselves). */
  release(): void;
}

/**
 * The arguments after the program and its script. Compiled executables keep that
 * shape too: Bun puts the embedded entry at `argv[1]`, a Node.js SEA repeats the
 * executable there.
 */
function launchArgs(argv = process.argv): string[] {
  return argv.slice(2);
}

const RUNTIMES = /^(bun|node|tjs|txiki)(\.exe)?$/i;

/** A `tarve build` executable, not a runtime running a script (`bun`, `node`, `tjs`). */
function compiled(): boolean {
  return !RUNTIMES.test(basename(process.execPath));
}

export { desktopQuote, quote, urlsOf } from "./associations";

type LaunchListener = (launch: InstanceLaunch) => void;
const FORWARDED_KEY = Symbol.for("tarve.forwardedLaunches");

/** Every launch a primary instance of this process hears (what `app.onOpenUrl`/`onOpenFiles` follow). */
function forwardedListeners(): Set<LaunchListener> {
  const registry = globalThis as { [FORWARDED_KEY]?: Set<LaunchListener> };
  return registry[FORWARDED_KEY] ??= new Set();
}

const RELEASE_KEY = Symbol.for("tarve.singleInstanceRelease");

/** The `release` of each first instance this process holds. */
function heldInstances(): Set<() => void> {
  const registry = globalThis as { [RELEASE_KEY]?: Set<() => void> };
  return registry[RELEASE_KEY] ??= new Set();
}

/**
 * Stops answering later launches: what the app does when it closes, so its listener does not
 * keep the process alive (the same in every runtime; txiki.js cannot unref a listener).
 */
export function releaseSingleInstance(): void {
  for (const release of [...heldInstances()]) release();
}

/** Hears launches forwarded to this process by `requestSingleInstance`, whoever asked for it. */
export function onForwardedLaunch(listener: LaunchListener): () => void {
  forwardedListeners().add(listener);
  return () => { forwardedListeners().delete(listener); };
}

function appId(id?: string): string {
  const metadata = runtimeAppMetadata();
  return id ?? metadata.appId ?? metadata.name ?? basename(compiled() ? process.execPath : (process.argv[1] ?? process.execPath));
}

/** Where the first instance listens: a named pipe (Windows) or a Unix socket, per app and user. */
export function instanceAddress(id: string): string {
  let user = "user";
  try { user = userInfo().username; } catch {}
  const key = createHash("sha256").update(`${id}\0${user}`).digest("hex").slice(0, 24);
  return process.platform === "win32" ? `\\\\.\\pipe\\tarve-${key}` : join(privateSocketDirectory(), `tarve-${key}.sock`);
}

/**
 * A directory only this user can enter, for the instance socket: anyone who can reach
 * it could hand the app arguments. $XDG_RUNTIME_DIR (0700 by spec), else a 0700
 * directory of this user under the temporary directory.
 */
function privateSocketDirectory(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime && existsSync(runtime)) return runtime;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const directory = join(tmpdir(), `tarve-${uid ?? "user"}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = statSync(directory);
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${directory} belongs to another user`);
  if ((stat.mode & 0o077) !== 0) chmodSync(directory, 0o700);
  return directory;
}

/** Lets the first instance take the foreground for the launch handed to it (Windows). */
function allowForeground(pid: number): void {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return;
  // Through the native library, so Bun, Node.js and txiki.js behave the same.
  try {
    const library = openLibrary(nativePath());
    try { library.symbols.tarve_allow_foreground(pid); } finally { library.close(); }
  } catch {}
}

/** Hands this launch to a running first instance; its pid, or undefined when none answers. */
function forward(address: string, launch: InstanceLaunch, timeoutMs = 2000): Promise<number | undefined> {
  return new Promise(resolve => {
    let reply = "";
    let settled = false;
    const done = (pid?: number) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(pid); };
    const timer = setTimeout(() => done(), timeoutMs);
    const socket: Socket = connect(address, () => socket.write(JSON.stringify(launch) + "\n"));
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      reply += chunk;
      const line = reply.indexOf("\n");
      if (line >= 0) done(Number(reply.slice(0, line)));
    });
    socket.on("error", () => done());
    socket.on("close", () => done());
  });
}

function listen(address: string, onLaunch: (launch: InstanceLaunch) => void): Promise<Server | undefined> {
  return new Promise(resolve => {
    const server = createServer(socket => {
      let data = "";
      socket.setEncoding("utf8");
      socket.on("error", () => {});
      socket.on("data", chunk => {
        data += chunk;
        const line = data.indexOf("\n");
        if (line < 0) {
          if (data.length > 1 << 20) socket.destroy();
          return;
        }
        // The pid first, so the launcher can let this process take the foreground.
        socket.removeAllListeners("data");
        socket.end(`${process.pid}\n`);
        try {
          const launch = JSON.parse(data.slice(0, line)) as Partial<InstanceLaunch>;
          if (!Array.isArray(launch.args) || !launch.args.every(arg => typeof arg === "string")) return;
          onLaunch({ args: launch.args, cwd: typeof launch.cwd === "string" ? launch.cwd : "", urls: Array.isArray(launch.urls) ? launch.urls.filter(url => typeof url === "string") : [] });
        } catch {}
      });
    });
    server.on("error", () => resolve(undefined));
    server.listen(address, () => resolve(server));
  });
}

/**
 * Keeps the app to one process per user, like a desktop app: the first launch gets
 * `primary: true` and hears later ones through `onSecondInstance`; a later launch
 * hands its arguments (files, links) to the first and gets `primary: false`, and
 * should exit. Call it before `createApp`. The first instance answers until `release()`,
 * until the app (`createApp`/`render`, not a window it opened) closes, or until the process
 * exits; while it answers, it keeps the process alive.
 *
 * ```ts
 * const instance = await requestSingleInstance({ schemes: ["myapp"] });
 * if (!instance.primary) process.exit(0);
 * const app = createApp(view);
 * instance.onSecondInstance(({ urls }) => { app.activate(); open(urls); });
 * ```
 */
export async function requestSingleInstance(options: SingleInstanceOptions = {}): Promise<SingleInstance> {
  const args = launchArgs();
  const launch: InstanceLaunch = { args, cwd: process.cwd(), urls: urlsOf(args, options.schemes) };
  // Android starts one process per app and brings its activity back on a later launch.
  if ((process.platform as string) === "android") return { primary: true, launch, onSecondInstance: () => () => {}, release() {} };
  const address = instanceAddress(appId(options.id));
  const listeners = new Set<(launch: InstanceLaunch) => void>();
  const deliver = (next: InstanceLaunch) => {
    const urls = urlsOf(next.args, options.schemes);
    for (const listener of [...listeners, ...forwardedListeners()]) {
      try { listener({ ...next, urls }); } catch (error) { console.error("[tarve] onSecondInstance", error); }
    }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const pid = await forward(address, launch);
    if (pid !== undefined) {
      allowForeground(pid);
      return { primary: false, launch, onSecondInstance: () => () => {}, release() {} };
    }
    // Nobody answered: a Unix socket left by a crashed instance is in the way.
    if (process.platform !== "win32" && existsSync(address)) rmSync(address, { force: true });
    const server = await listen(address, deliver);
    if (server) {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        heldInstances().delete(release);
        server.close();
          if (process.platform !== "win32") rmSync(address, { force: true });
      };
      heldInstances().add(release);
      process.once("exit", release);
      return {
        primary: true,
        launch,
        onSecondInstance(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        release,
      };
    }
    // Another first launch won the race to listen: hand the launch to it.
  }
  throw new Error("Could not reach or become the app's first instance");
}

/** Options of `registerUrlScheme` (the same as `registerProtocol`'s). */
export type { RegistrationOptions as UrlSchemeOptions } from "./associations";
/** The earlier names of `registerProtocol` / `unregisterProtocol` (see associations.ts). */
export { registerProtocol as registerUrlScheme, unregisterProtocol as unregisterUrlScheme } from "./associations";
