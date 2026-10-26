// Tarve plugins: third-party modules (JS only, or JS over a native library) that an app
// installs from npm and passes to `createApp({ plugins: [...] })`, like Flutter plugins or
// React Native Turbo Modules. A plugin is `definePlugin({ name, version, setup(ctx) })`;
// `setup` registers commands the UI calls (`app.invoke("ns.command", ...)` or the typed
// `plugin.client(app)`), subscribes to the app's lifecycle, talks to the native runtime
// through `ctx.request`, and opens its own native library with `ctx.loadLibrary`.
// Plugin API versioning: PLUGIN_API_VERSION (a major number; see reports/gap/plugins.md).
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AppHandle } from "../app";
import type { OpenFilesListener, OpenUrlListener } from "../app/open-requests";
import { nativeAssetPath } from "../embedded-assets";
import type { NativeCommand, NativeEvent } from "../protocol";
import { discoverPlugins, findPackageRoot, PLUGIN_API_VERSION, readPluginManifest, type DiscoverPluginsOptions, type PluginManifest } from "./discovery";
import { openPluginLibrary, PluginFfiUnsupportedError, type FfiSymbols, type PluginLibrary } from "./ffi";
import { hostPluginTarget, PLUGIN_TARGETS, type PluginTarget } from "./targets";

export { PLUGIN_API_VERSION } from "./discovery";

type MaybePromise<T> = T | Promise<T>;

/** A plugin's commands: what `setup` returns and `ctx.registerCommand` adds. */
export type PluginCommand = (...args: never[]) => unknown;
export type PluginCommands = Readonly<Record<string, PluginCommand>>;

/** Native requests the plugin can send: every protocol command answered by a `requestId`. */
type RequestCommand = Extract<NativeCommand, { requestId: string }>;
export type PluginRequest = RequestCommand extends infer C ? C extends unknown ? Omit<C, "requestId"> : never : never;

export interface PluginRequestOptions {
  /** Default 10 s; `null` waits forever (a dialog, a prompt). */
  timeoutMs?: number | null;
}

/** Where `ctx.loadLibrary` finds the library: one path for every target, or a path per target. */
export type NativeLibrarySource = string | Partial<Record<PluginTarget, string>>;

export interface PluginContext {
  readonly name: string;
  readonly version: string;
  /** Prefix of this plugin's command ids (`<namespace>.<command>`). */
  readonly namespace: string;
  /** The plugin API this Tarve implements. */
  readonly apiVersion: number;
  /** This process's native target (`win32-x64`, `linux-x64`, `darwin-arm64`, `android-arm64`…), if a plugin can target it. */
  readonly target: PluginTarget | undefined;
  /** The app the plugin is installed in. */
  readonly app: AppHandle;
  /** Adds a command the UI calls with `app.invoke("<namespace>.<name>", ...args)`; returns its removal. */
  registerCommand<A extends unknown[], R>(name: string, handler: (...args: A) => R): () => void;
  /** After the window is up and every plugin's setup finished (right away when that already happened). */
  onReady(listener: () => MaybePromise<void>): () => void;
  /** After the app's last window closed; libraries the plugin loaded are closed after these listeners. */
  onClosed(listener: () => MaybePromise<void>): () => void;
  /** Links of the app's `protocols` (see `app.onOpenUrl`). */
  onOpenUrl(listener: OpenUrlListener): () => void;
  /** Files of the app's `fileTypes` (see `app.onOpenFiles`). */
  onOpenFiles(listener: OpenFilesListener): () => void;
  /**
   * Sends a protocol request to the Tarve runtime and resolves with its answer (what `app`'s own
   * dialogs, permissions and stats use). With `expect`, the answer must be that event type and
   * its `error` field, if any, rejects.
   */
  request(command: PluginRequest, options?: PluginRequestOptions): Promise<NativeEvent>;
  request<E extends NativeEvent["type"]>(command: PluginRequest, options: PluginRequestOptions & { expect: E }): Promise<Extract<NativeEvent, { type: E }>>;
  /**
   * Opens the plugin's native library with the runtime's FFI (bun:ffi, node:ffi on Node.js
   * 26.10+, tjs:ffi on txiki.js) and binds `symbols`. Without `source` the library comes from
   * the executable (`tarve build` embeds it) or package.json `tarve.native`. Relative paths
   * resolve against the plugin's package. Throws PluginFfiUnsupportedError on a runtime with no FFI.
   */
  loadLibrary<const S extends FfiSymbols>(symbols: S): PluginLibrary<S>;
  loadLibrary<const S extends FfiSymbols>(source: NativeLibrarySource | undefined, symbols: S): PluginLibrary<S>;
  /** Where `loadLibrary` would open the library from, without opening it. */
  resolveLibrary(source?: NativeLibrarySource): string;
}

export interface PluginDefinition<C extends PluginCommands = {}> {
  /** The npm package name (it keys `tarve.native` discovery and the libraries `tarve build` embeds). */
  name: string;
  /** The plugin's own semver version. */
  version: string;
  /** Command prefix; default `name`. */
  namespace?: string;
  /** Plugin API major version the plugin is written against; default 1. */
  tarvePluginApi?: number;
  /** The plugin package's directory (`import.meta.dirname`): relative library paths and package.json resolve against it. */
  root?: string;
  /** Runs once per app, before its window opens. Returned functions become the plugin's commands. */
  setup(ctx: PluginContext): MaybePromise<C | void>;
}

/** Typed calls of a plugin's commands through an app: `hello.client(app).add(1, 2)`. */
export type PluginClient<C extends PluginCommands> = {
  readonly [K in keyof C]: C[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

const PLUGIN_BRAND = Symbol.for("tarve.plugin");

export interface TarvePlugin<C extends PluginCommands = PluginCommands> {
  readonly [PLUGIN_BRAND]: true;
  readonly name: string;
  readonly version: string;
  readonly namespace: string;
  readonly tarvePluginApi: number;
  readonly root: string | undefined;
  readonly setup: (ctx: PluginContext) => MaybePromise<C | void>;
  client(app: Pick<AppHandle, "invoke">): PluginClient<C>;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NAMESPACE = /^[A-Za-z0-9@_][A-Za-z0-9@/_.-]*$/;
const COMMAND = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function definePlugin<C extends PluginCommands = {}>(definition: PluginDefinition<C>): TarvePlugin<C> {
  const { name, version, setup } = definition;
  if (typeof name !== "string" || !name.trim()) throw new TypeError("definePlugin needs a name");
  if (typeof version !== "string" || !SEMVER.test(version)) throw new TypeError(`Plugin ${name}: version must be semver (got ${String(version)})`);
  if (typeof setup !== "function") throw new TypeError(`Plugin ${name}: setup must be a function`);
  const namespace = definition.namespace ?? name;
  if (!NAMESPACE.test(namespace)) throw new TypeError(`Plugin ${name}: invalid namespace ${namespace}`);
  const api = definition.tarvePluginApi ?? 1;
  if (!Number.isInteger(api) || api < 1) throw new TypeError(`Plugin ${name}: tarvePluginApi must be a positive integer`);
  const plugin: TarvePlugin<C> = {
    [PLUGIN_BRAND]: true,
    name, version, namespace, tarvePluginApi: api, root: definition.root, setup,
    client(app) {
      return new Proxy({}, {
        get: (_target, key) => typeof key === "string" ? (...args: unknown[]) => app.invoke(`${namespace}.${key}`, ...args) : undefined,
      }) as PluginClient<C>;
    },
  };
  return Object.freeze(plugin);
}

export function isTarvePlugin(value: unknown): value is TarvePlugin {
  return !!value && typeof value === "object" && (value as Record<symbol, unknown>)[PLUGIN_BRAND] === true;
}

/** Throws when a plugin needs a plugin API this Tarve does not implement. */
export function assertPluginCompatible(plugin: Pick<TarvePlugin, "name" | "tarvePluginApi">): void {
  if (plugin.tarvePluginApi > PLUGIN_API_VERSION) {
    throw new Error(`Plugin ${plugin.name} needs Tarve plugin API ${plugin.tarvePluginApi}; this Tarve implements ${PLUGIN_API_VERSION}. Update @tarve/core.`);
  }
}

// ---- Libraries embedded by `tarve build` ------------------------------------------------

const EMBEDDED_KEY = Symbol.for("tarve.pluginNatives");
type EmbeddedNatives = Record<string, Partial<Record<PluginTarget, () => string>>>;

/** Called by the code `tarve build` generates: the libraries inside the executable, by plugin name. */
export function registerEmbeddedPluginNatives(natives: EmbeddedNatives): void {
  const registry = ((globalThis as Record<symbol, unknown>)[EMBEDDED_KEY] ??= {}) as EmbeddedNatives;
  for (const [name, targets] of Object.entries(natives)) registry[name] = { ...registry[name], ...targets };
}

function embeddedNative(name: string, target: PluginTarget): (() => string) | undefined {
  return ((globalThis as Record<symbol, unknown>)[EMBEDDED_KEY] as EmbeddedNatives | undefined)?.[name]?.[target];
}

// ---- Host -----------------------------------------------------------------------------------

export interface PluginHostOptions {
  app: AppHandle;
  request(command: NativeCommand & { requestId: string }, timeoutMs?: number | null): Promise<NativeEvent>;
  /** Reports an error a plugin threw outside a command call (setup, lifecycle listeners). */
  report(error: unknown, event: string): void;
  /** Package manifests for `loadLibrary` without paths (default: discovery from the entry's package). */
  manifest?(plugin: TarvePlugin): PluginManifest | undefined;
  /** Default `hostPluginTarget()`. */
  target?: PluginTarget | undefined;
}

export interface PluginHost {
  /** Settles once every plugin's setup finished (failed setups were reported). */
  readonly ready: Promise<void>;
  invoke(command: string, args: readonly unknown[]): Promise<unknown>;
  /** Registered command ids. */
  commands(): string[];
}

interface CommandEntry { plugin: string; handler: PluginCommand }

/** Runs each plugin's setup against `app`; app.ts calls it once per app, before the window opens. */
export function createPluginHost(plugins: readonly TarvePlugin[], options: PluginHostOptions): PluginHost {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  for (const plugin of plugins) {
    if (!isTarvePlugin(plugin)) throw new TypeError("createApp plugins must come from definePlugin()");
    assertPluginCompatible(plugin);
    if (names.has(plugin.name)) throw new Error(`Plugin ${plugin.name} is installed twice`);
    if (namespaces.has(plugin.namespace)) throw new Error(`Two plugins use the command namespace ${plugin.namespace}`);
    names.add(plugin.name);
    namespaces.add(plugin.namespace);
  }
  const { app } = options;
  const target = "target" in options ? options.target : hostPluginTarget();
  const commands = new Map<string, CommandEntry>();
  const setupFailures = new Map<string, Error>();
  const readyListeners = new Set<() => MaybePromise<void>>();
  const closedListeners = new Set<() => MaybePromise<void>>();
  const libraries = new Set<PluginLibrary<FfiSymbols>>();
  let readyFired = false;
  let closedFired = false;
  const call = async (listener: () => MaybePromise<void>, event: string) => {
    try { await listener(); } catch (error) { options.report(error, event); }
  };
  const manifestCache = new Map<string, PluginManifest | undefined>();
  const manifestOf = (plugin: TarvePlugin): PluginManifest | undefined => {
    if (manifestCache.has(plugin.name)) return manifestCache.get(plugin.name);
    let manifest: PluginManifest | undefined;
    try { manifest = options.manifest ? options.manifest(plugin) : defaultManifest(plugin); } catch { manifest = undefined; }
    manifestCache.set(plugin.name, manifest);
    return manifest;
  };

  function context(plugin: TarvePlugin): PluginContext {
    const id = (command: string) => `${plugin.namespace}.${command}`;
    const resolveLibrary = (source?: NativeLibrarySource): string => {
      if (!target) throw new PluginFfiUnsupportedError(`Plugin ${plugin.name}: no native target for ${process.platform}-${process.arch}`);
      const embedded = embeddedNative(plugin.name, target);
      if (embedded) return embedded();
      const manifest = source === undefined ? manifestOf(plugin) : undefined;
      let path: string | undefined;
      if (typeof source === "string") path = source;
      else if (source) {
        path = source[target];
        if (!path) throw new PluginFfiUnsupportedError(`Plugin ${plugin.name} has no native library for ${target} (it ships ${Object.keys(source).join(", ") || "none"}).`);
      } else {
        if (!manifest) throw new Error(`Plugin ${plugin.name}: pass library paths to loadLibrary or declare package.json tarve.native (package not found from ${plugin.root ?? process.cwd()}).`);
        path = manifest.native[target];
        if (!path) throw new PluginFfiUnsupportedError(`Plugin ${plugin.name} has no native library for ${target} (package.json tarve.native lists ${Object.keys(manifest.native).join(", ") || "none"}).`);
      }
      const base = plugin.root ?? manifestOf(plugin)?.directory ?? process.cwd();
      const absolute = nativeAssetPath(isAbsolute(path) ? path : resolve(base, path));
      if (!/^https?:/i.test(absolute) && !existsSync(absolute)) {
        throw new Error(`Plugin ${plugin.name}: native library not found: ${absolute}. Build it first (e.g. cargo build --release).`);
      }
      return absolute;
    };
    const ctx: PluginContext = {
      name: plugin.name,
      version: plugin.version,
      namespace: plugin.namespace,
      apiVersion: PLUGIN_API_VERSION,
      target,
      app,
      registerCommand(name, handler) {
        if (!COMMAND.test(name)) throw new TypeError(`Plugin ${plugin.name}: invalid command name ${name}`);
        if (typeof handler !== "function") throw new TypeError(`Plugin ${plugin.name}: command ${name} needs a function`);
        const key = id(name);
        if (commands.has(key)) throw new Error(`Plugin command ${key} is already registered`);
        const entry: CommandEntry = { plugin: plugin.name, handler: handler as PluginCommand };
        commands.set(key, entry);
        return () => { if (commands.get(key) === entry) commands.delete(key); };
      },
      onReady(listener) {
        readyListeners.add(listener);
        if (readyFired) queueMicrotask(() => { if (readyListeners.has(listener)) void call(listener, `${plugin.name}:ready`); });
        return () => { readyListeners.delete(listener); };
      },
      onClosed(listener) {
        closedListeners.add(listener);
        return () => { closedListeners.delete(listener); };
      },
      onOpenUrl: listener => app.onOpenUrl(listener),
      onOpenFiles: listener => app.onOpenFiles(listener),
      async request(command: PluginRequest, requestOptions: PluginRequestOptions & { expect?: string } = {}): Promise<never> {
        const event = await options.request({ ...command, requestId: crypto.randomUUID() } as RequestCommand, requestOptions.timeoutMs);
        if (requestOptions.expect !== undefined) {
          if (event.type !== requestOptions.expect) throw new Error(`Plugin ${plugin.name}: expected a ${requestOptions.expect} answer to ${command.type}, got ${event.type}`);
          const error = (event as { error?: unknown }).error;
          if (typeof error === "string" && error) throw new Error(error);
        }
        return event as never;
      },
      loadLibrary<const S extends FfiSymbols>(first: NativeLibrarySource | undefined | S, second?: S): PluginLibrary<S> {
        const [source, symbols] = second === undefined ? [undefined, first as S] : [first as NativeLibrarySource | undefined, second];
        const library = openPluginLibrary(resolveLibrary(source), symbols, `Plugin ${plugin.name}`);
        libraries.add(library as unknown as PluginLibrary<FfiSymbols>);
        return library;
      },
      resolveLibrary,
    };
    return ctx;
  }

  const setups = plugins.map(async plugin => {
    try {
      const ctx = context(plugin);
      const returned = await plugin.setup(ctx);
      if (returned && typeof returned === "object") {
        for (const [name, handler] of Object.entries(returned)) {
          if (typeof handler === "function") ctx.registerCommand(name, handler as (...args: unknown[]) => unknown);
        }
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      setupFailures.set(plugin.name, failure);
      options.report(failure, `${plugin.name}:setup`);
    }
  });
  const ready = Promise.all(setups).then(() => undefined);

  void Promise.all([app.ready, ready]).then(async () => {
    if (closedFired) return;
    readyFired = true;
    for (const listener of [...readyListeners]) await call(listener, "ready");
  }, () => { /* The window failed to open: app.ready reports it. */ });

  void app.closed.then(async () => {
    closedFired = true;
    await ready;
    for (const listener of [...closedListeners]) await call(listener, "closed");
    for (const library of libraries) {
      try { library.close(); } catch (error) { options.report(error, "closeLibrary"); }
    }
    libraries.clear();
    commands.clear();
    readyListeners.clear();
    closedListeners.clear();
  });

  return {
    ready,
    async invoke(command, args) {
      let entry = commands.get(command);
      if (!entry) {
        // Commands of an async setup appear once it finishes.
        await ready;
        entry = commands.get(command);
      }
      if (!entry) {
        const namespace = command.includes(".") ? command.slice(0, command.lastIndexOf(".")) : command;
        const owner = plugins.find(plugin => plugin.namespace === namespace);
        const failure = owner && setupFailures.get(owner.name);
        if (failure) throw new Error(`Plugin ${owner.name} failed to set up: ${failure.message}`, { cause: failure });
        throw new Error(`Unknown plugin command: ${command}${commands.size ? ` (registered: ${[...commands.keys()].join(", ")})` : ""}`);
      }
      return await (entry.handler as (...args: unknown[]) => unknown)(...args);
    },
    commands: () => [...commands.keys()],
  };
}

/** The package.json manifest of a plugin: from `root`, else among the dependencies of the app's package. */
function defaultManifest(plugin: TarvePlugin): PluginManifest | undefined {
  if (plugin.root) {
    const directory = findPackageRoot(plugin.root);
    const manifest = directory ? readPluginManifest(directory) : undefined;
    if (manifest?.name === plugin.name) return manifest;
  }
  const bunMain = typeof Bun !== "undefined" ? Bun.main : undefined;
  const roots = [process.env.TARVE_ENTRY, bunMain, process.argv[1]].filter((root): root is string => !!root).map(root => dirname(resolve(root)));
  for (const root of [...roots, process.cwd()]) {
    const found = discoverPlugins({ root }).plugins.find(manifest => manifest.name === plugin.name);
    if (found) return found;
  }
  return undefined;
}

/**
 * Imports the discovered plugins of the app's package (development and tooling: a compiled
 * app should import its plugins statically so the bundler includes them). Each entry's
 * default export (or `plugin` export) must come from definePlugin.
 */
export async function loadPlugins(options: DiscoverPluginsOptions = {}): Promise<TarvePlugin[]> {
  const { plugins, problems } = discoverPlugins(options);
  if (problems.length) throw new Error(problems.map(problem => `${problem.package}: ${problem.message}`).join("\n"));
  const loaded: TarvePlugin[] = [];
  for (const manifest of plugins) {
    const module = await import(manifest.entry) as { default?: unknown; plugin?: unknown };
    const plugin = module.default ?? module.plugin;
    if (!isTarvePlugin(plugin)) throw new TypeError(`${manifest.name}: ${manifest.entry} must export a definePlugin() plugin as default`);
    if (plugin.name !== manifest.name) throw new TypeError(`${manifest.name}: its plugin is named ${plugin.name}; definePlugin's name must be the package name`);
    loaded.push(plugin);
  }
  return loaded;
}

export { PLUGIN_TARGETS };
