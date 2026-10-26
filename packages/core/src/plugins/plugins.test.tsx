import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppErrorEvent } from "../app";
import type { NativeBridge } from "../bridge";
import { Text, Window } from "../components";
import type { NativeCommand, NativeEvent } from "../protocol";
import { createPluginHost, definePlugin, PLUGIN_API_VERSION, registerEmbeddedPluginNatives, type PluginContext } from ".";
import { discoverPlugins, readPluginManifest } from "./discovery";
import { validateSymbols } from "./ffi";
import { hostPluginTarget, isPluginTarget, nativeLibraryFileName, pluginTargetForBuild } from "./targets";
import { planPluginNatives, pluginNativeRuntimeLines } from "../../plugins-build";

const scratch = mkdtempSync(join(tmpdir(), "tarve-plugins-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

/** An app package depending on `plugins` (name → package.json `tarve` field), laid out in node_modules. */
function appWith(name: string, plugins: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  const root = join(scratch, name);
  writeJson(join(root, "package.json"), { name, dependencies: Object.fromEntries(Object.keys(plugins).map(plugin => [plugin, "1.0.0"])), ...extra });
  for (const [plugin, tarve] of Object.entries(plugins)) {
    writeJson(join(root, "node_modules", ...plugin.split("/"), "package.json"), { name: plugin, version: "1.2.3", ...(tarve === undefined ? {} : { tarve }) });
  }
  return root;
}

class FakeBridge implements NativeBridge {
  commands: NativeCommand[] = [];
  private listener?: (event: NativeEvent) => void;
  start(_document: unknown, onEvent: (event: NativeEvent) => void): void {
    this.listener = onEvent;
    queueMicrotask(() => onEvent({ type: "ready" }));
  }
  send(command: NativeCommand): void {
    this.commands.push(command);
    if (command.type === "close") queueMicrotask(() => this.listener?.({ type: "closed" }));
    if (command.type === "permissions") {
      queueMicrotask(() => this.listener?.({ type: "permissions", requestId: command.requestId, results: { CAMERA: "granted" } }));
    }
  }
  join(): void {}
}

const View = () => <Window title="plugins"><Text>plugins</Text></Window>;

describe("plugin targets", () => {
  test("host and build targets map onto plugin targets", () => {
    expect(hostPluginTarget("win32", "x64")).toBe("win32-x64");
    expect(hostPluginTarget("android", "arm64")).toBe("android-arm64");
    expect(hostPluginTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(hostPluginTarget("freebsd", "x64")).toBeUndefined();
    expect(pluginTargetForBuild("windows-x64")).toBe("win32-x64");
    expect(pluginTargetForBuild("linux-x64")).toBe("linux-x64");
    expect(pluginTargetForBuild("darwin-x64")).toBe("darwin-x64");
    expect(pluginTargetForBuild("arm64-v8a")).toBe("android-arm64");
    expect(pluginTargetForBuild("android-arm64")).toBe("android-arm64");
    expect(pluginTargetForBuild("x86")).toBeUndefined();
    expect(isPluginTarget("linux-arm64")).toBe(true);
    expect(nativeLibraryFileName("hello", "win32-x64")).toBe("hello.dll");
    expect(nativeLibraryFileName("hello", "darwin-arm64")).toBe("libhello.dylib");
    expect(nativeLibraryFileName("hello", "android-arm64")).toBe("libhello.so");
  });
});

describe("plugin discovery", () => {
  test("finds dependencies with tarve.plugin and resolves their native paths", () => {
    const root = appWith("discover-app", {
      "tarve-plugin-a": { tarvePluginApi: 1, plugin: "./dist/plugin.js", native: { "win32-x64": "./native/a.dll", "linux-x64": "./native/liba.so" } },
      "@scope/tarve-plugin-b": { plugin: "./plugin.js" },
      "not-a-plugin": undefined,
      "tarve-app-metadata-only": { name: "Something" },
    });
    const { plugins, problems } = discoverPlugins({ root: join(root, "src") });
    expect(problems).toEqual([]);
    expect(plugins.map(plugin => plugin.name)).toEqual(["tarve-plugin-a", "@scope/tarve-plugin-b"]);
    const [a, b] = plugins;
    expect(a!.version).toBe("1.2.3");
    expect(a!.apiVersion).toBe(1);
    expect(a!.entry).toBe(join(root, "node_modules", "tarve-plugin-a", "dist", "plugin.js"));
    expect(a!.native["win32-x64"]).toBe(join(root, "node_modules", "tarve-plugin-a", "native", "a.dll"));
    expect(a!.native["darwin-arm64"]).toBeUndefined();
    expect(b!.apiVersion).toBe(1);
    expect(b!.native).toEqual({});
  });

  test("the app's own package counts when it is a plugin (a plugin's demo app)", () => {
    const root = join(scratch, "self-plugin");
    writeJson(join(root, "package.json"), { name: "tarve-plugin-self", version: "0.1.0", tarve: { plugin: "./plugin.ts" } });
    expect(discoverPlugins({ root }).plugins.map(plugin => plugin.name)).toEqual(["tarve-plugin-self"]);
  });

  test("reports unusable manifests instead of throwing", () => {
    const root = appWith("bad-app", {
      "future-plugin": { tarvePluginApi: PLUGIN_API_VERSION + 1, plugin: "./p.js" },
      "bad-target": { plugin: "./p.js", native: { "win32-ia32": "./x.dll" } },
      "bad-entry": { plugin: 42 },
      "good": { plugin: "./p.js" },
    });
    const { plugins, problems } = discoverPlugins({ root });
    expect(plugins.map(plugin => plugin.name)).toEqual(["good"]);
    expect(problems.map(problem => problem.package)).toEqual(["future-plugin", "bad-target", "bad-entry"]);
    expect(problems[0]!.message).toContain(`needs Tarve plugin API ${PLUGIN_API_VERSION + 1}`);
    expect(problems[1]!.message).toContain("win32-ia32");
  });

  test("devDependencies only on request; a missing package.json is no plugin", () => {
    const root = appWith("dev-app", {}, { devDependencies: { "dev-plugin": "1.0.0" } });
    writeJson(join(root, "node_modules", "dev-plugin", "package.json"), { name: "dev-plugin", tarve: { plugin: "./p.js" } });
    expect(discoverPlugins({ root }).plugins).toEqual([]);
    expect(discoverPlugins({ root, includeDev: true }).plugins.map(plugin => plugin.name)).toEqual(["dev-plugin"]);
    expect(readPluginManifest(join(scratch, "nowhere"))).toBeUndefined();
  });
});

describe("definePlugin", () => {
  test("validates its definition", () => {
    expect(() => definePlugin({ name: "", version: "1.0.0", setup() {} })).toThrow("name");
    expect(() => definePlugin({ name: "p", version: "1.0", setup() {} })).toThrow("semver");
    expect(() => definePlugin({ name: "p", version: "1.0.0", namespace: "bad space", setup() {} })).toThrow("namespace");
    expect(() => definePlugin({ name: "p", version: "1.0.0", tarvePluginApi: 0, setup() {} })).toThrow("tarvePluginApi");
    const plugin = definePlugin({ name: "p", version: "1.0.0-beta.1", setup() {} });
    expect(plugin.namespace).toBe("p");
    expect(plugin.tarvePluginApi).toBe(1);
    expect(Object.isFrozen(plugin)).toBe(true);
  });

  test("createApp refuses duplicates and a newer plugin API", () => {
    const a = definePlugin({ name: "dup", version: "1.0.0", setup() {} });
    expect(() => createApp(View, { bridge: new FakeBridge(), plugins: [a, a] })).toThrow("installed twice");
    const future = definePlugin({ name: "future", version: "1.0.0", tarvePluginApi: PLUGIN_API_VERSION + 1, setup() {} });
    expect(() => createApp(View, { bridge: new FakeBridge(), plugins: [future] })).toThrow("Update @tarve/core");
    expect(() => createApp(View, { bridge: new FakeBridge(), plugins: [{ name: "fake" } as never] })).toThrow("definePlugin");
  });
});

describe("plugin lifecycle and commands", () => {
  test("setup runs before the window starts; ready and closed fire in order", async () => {
    const log: string[] = [];
    const bridge = new FakeBridge();
    const originalStart = bridge.start.bind(bridge);
    bridge.start = (document, onEvent) => { log.push("bridge.start"); originalStart(document, onEvent); };
    const plugin = definePlugin({
      name: "lifecycle",
      version: "1.0.0",
      setup(ctx) {
        log.push(`setup ${ctx.name}@${ctx.version} api ${ctx.apiVersion}`);
        ctx.onReady(() => { log.push("ready"); });
        ctx.onClosed(async () => { log.push("closed"); });
      },
    });
    const app = createApp(View, { bridge, plugins: [plugin] });
    await app.ready;
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(log).toEqual(["setup lifecycle@1.0.0 api 1", "bridge.start", "ready"]);
    app.close();
    await app.closed;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(log.at(-1)).toBe("closed");
  });

  test("returned and registered commands are invoked by id and through a typed client", async () => {
    let unregister!: () => void;
    const math = definePlugin({
      name: "tarve-plugin-math",
      version: "2.0.0",
      namespace: "math",
      async setup(ctx) {
        await Promise.resolve();
        unregister = ctx.registerCommand("negate", (value: number) => -value);
        expect(() => ctx.registerCommand("negate", () => 0)).toThrow("already registered");
        expect(() => ctx.registerCommand("bad name", () => 0)).toThrow("invalid command");
        return {
          add: (a: number, b: number) => a + b,
          slowDouble: async (value: number) => value * 2,
          fail: () => { throw new Error("boom"); },
        };
      },
    });
    const app = createApp(View, { bridge: new FakeBridge(), plugins: [math] });
    // Invoked before the async setup finished: waits for it.
    expect(await app.invoke<number>("math.add", 2, 3)).toBe(5);
    const client = math.client(app);
    const doubled: number = await client.slowDouble(21);
    expect(doubled).toBe(42);
    expect(await app.invoke<number>("math.negate", 4)).toBe(-4);
    await expect(client.fail()).rejects.toThrow("boom");
    await expect(app.invoke("math.missing")).rejects.toThrow("Unknown plugin command: math.missing");
    unregister();
    await expect(app.invoke("math.negate", 1)).rejects.toThrow("Unknown plugin command");
    // A window opened by the app shares its plugins.
    const child = app.openWindow(View);
    expect(await child.invoke<number>("math.add", 1, 1)).toBe(2);
  });

  test("an app without plugins rejects invoke", async () => {
    const app = createApp(View, { bridge: new FakeBridge() });
    await expect(app.invoke("x.y")).rejects.toThrow("no plugins");
  });

  test("a failing setup is reported and its commands explain why", async () => {
    const errors: AppErrorEvent[] = [];
    const broken = definePlugin({ name: "broken", version: "1.0.0", setup() { throw new Error("no device"); } });
    const fine = definePlugin({ name: "fine", version: "1.0.0", setup: () => ({ ping: () => "pong" }) });
    const app = createApp(View, { bridge: new FakeBridge(), plugins: [broken, fine], onError: event => errors.push(event) });
    expect(await app.invoke<string>("fine.ping")).toBe("pong");
    await expect(app.invoke("broken.anything")).rejects.toThrow("Plugin broken failed to set up: no device");
    expect(errors.map(event => [event.source, event.event, event.error.message])).toEqual([["plugin", "broken:setup", "no device"]]);
  });

  test("ctx.request goes through the app's request channel and checks the answer type", async () => {
    let captured!: PluginContext;
    const plugin = definePlugin({ name: "req", version: "1.0.0", setup(ctx) { captured = ctx; } });
    const bridge = new FakeBridge();
    const app = createApp(View, { bridge, plugins: [plugin] });
    await app.ready;
    const answer = await captured.request({ type: "permissions", action: "check", permissions: ["CAMERA"] }, { expect: "permissions" });
    expect(answer.results).toEqual({ CAMERA: "granted" });
    const sent = bridge.commands.find(command => command.type === "permissions") as NativeCommand & { requestId: string };
    expect(typeof sent.requestId).toBe("string");
    await expect(captured.request({ type: "permissions", action: "check", permissions: ["CAMERA"] }, { expect: "stats" })).rejects.toThrow("expected a stats answer");
    expect(captured.app).toBe(app);
  });
});

describe("plugin native libraries", () => {
  const target = hostPluginTarget()!;
  const host = (plugins: Parameters<typeof createPluginHost>[0], manifest?: () => ReturnType<typeof readPluginManifest>) => {
    const fakeApp = { ready: Promise.resolve(), closed: new Promise<void>(() => {}), onOpenUrl: () => () => {}, onOpenFiles: () => () => {} } as never;
    return createPluginHost(plugins, { app: fakeApp, request: () => Promise.reject(new Error("no")), report: () => {}, ...(manifest ? { manifest } : {}) });
  };

  test("resolveLibrary: per-target paths, package.json tarve.native, embedded libraries first", async () => {
    const root = join(scratch, "native-plugin");
    writeJson(join(root, "package.json"), { name: "native-plugin", version: "1.0.0", tarve: { plugin: "./p.js", native: { [target]: "./lib/from-manifest.bin" } } });
    writeFileSync(join(root, "p.js"), "");
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "lib", "from-manifest.bin"), "x");
    writeFileSync(join(root, "lib", "explicit.bin"), "x");
    let ctx!: PluginContext;
    const plugin = definePlugin({ name: "native-plugin", version: "1.0.0", root, setup(c) { ctx = c; } });
    await host([plugin]).ready;
    expect(ctx.target).toBe(target);
    expect(ctx.resolveLibrary()).toBe(join(root, "lib", "from-manifest.bin"));
    expect(ctx.resolveLibrary({ [target]: "lib/explicit.bin" })).toBe(join(root, "lib", "explicit.bin"));
    expect(ctx.resolveLibrary("lib/explicit.bin")).toBe(join(root, "lib", "explicit.bin"));
    const other = target === "win32-x64" ? "linux-x64" : "win32-x64";
    expect(() => ctx.resolveLibrary({ [other]: "x" })).toThrow(`no native library for ${target}`);
    expect(() => ctx.resolveLibrary("lib/missing.bin")).toThrow("native library not found");
    registerEmbeddedPluginNatives({ "native-plugin": { [target]: () => "/embedded/native-plugin.bin" } });
    try {
      expect(ctx.resolveLibrary()).toBe("/embedded/native-plugin.bin");
      expect(ctx.resolveLibrary({ [other]: "x" })).toBe("/embedded/native-plugin.bin");
    } finally {
      delete ((globalThis as Record<symbol, Record<string, unknown>>)[Symbol.for("tarve.pluginNatives")])!["native-plugin"];
    }
  });

  test("resolveLibrary without a manifest explains what to declare", async () => {
    let ctx!: PluginContext;
    await host([definePlugin({ name: "nowhere-plugin", version: "1.0.0", setup(c) { ctx = c; } })], () => undefined).ready;
    expect(() => ctx.resolveLibrary()).toThrow("tarve.native");
  });

  test("symbol declarations are validated before any FFI is touched", () => {
    expect(() => validateSymbols({})).toThrow("at least one");
    expect(() => validateSymbols({ "bad-name": { args: [] } })).toThrow("Invalid native symbol");
    expect(() => validateSymbols({ f: { args: ["void"] } })).toThrow("unsupported argument");
    expect(() => validateSymbols({ f: { args: [], returns: "buffer" } })).toThrow("unsupported return");
    expect(() => validateSymbols({ f: { args: ["i32", "buffer", "ptr", "f64", "bool", "u64"], returns: "i64" } })).not.toThrow();
  });
});

describe("tarve build plugin embedding", () => {
  test("plans the target's libraries and generates their registration", () => {
    const root = appWith("build-app", {
      "with-native": { plugin: "./p.js", native: { "win32-x64": "./hello.dll", "linux-x64": "./libhello.so" } },
      "other-targets": { plugin: "./p.js", native: { "darwin-arm64": "./libother.dylib" } },
      "js-only": { plugin: "./p.js" },
    });
    writeFileSync(join(root, "node_modules", "with-native", "hello.dll"), "dll-bytes");
    writeFileSync(join(root, "node_modules", "with-native", "libhello.so"), "so-bytes");
    const entry = join(root, "app.tsx");
    const plan = planPluginNatives(entry, "windows-x64");
    expect(plan.target).toBe("win32-x64");
    expect(plan.withoutTarget).toEqual(["other-targets"]);
    expect(plan.embeds).toHaveLength(1);
    expect(plan.embeds[0]).toMatchObject({ plugin: "with-native", target: "win32-x64", fileName: "hello.dll", size: 9 });
    expect(plan.embeds[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);

    const embedded = pluginNativeRuntimeLines(plan.embeds, "embedded").join("\n");
    expect(embedded).toContain(`with { type: "file" }`);
    expect(embedded).toContain(`materializeAsset(__tarvePluginLibrary0, "hello.dll"`);
    expect(embedded).toContain(`Symbol.for("tarve.pluginNatives")`);
    const bundle = pluginNativeRuntimeLines(planPluginNatives(entry, "linux-x64").embeds, "frameworks").join("\n");
    expect(bundle).toContain(`"Frameworks", "libhello.so"`);
    expect(pluginNativeRuntimeLines([], "embedded")).toEqual([]);
    expect(planPluginNatives(entry, "darwin-x64").withoutTarget).toEqual(["with-native", "other-targets"]);
  });

  test("a declared library that was not built fails the build", () => {
    const root = appWith("unbuilt-app", { unbuilt: { plugin: "./p.js", native: { "linux-x64": "./missing.so" } } });
    expect(() => planPluginNatives(join(root, "app.tsx"), "linux-x64")).toThrow("native library for linux-x64 is missing");
  });

  test("the generated registration is what loadLibrary reads", async () => {
    const root = appWith("registry-app", { reg: { plugin: "./p.js", native: { [hostPluginTarget()!]: "./reg.bin" } } });
    writeFileSync(join(root, "node_modules", "reg", "reg.bin"), "bytes");
    const [embed] = planPluginNatives(join(root, "app.tsx"), hostPluginTarget()!).embeds;
    const lines = pluginNativeRuntimeLines([embed!], "frameworks");
    // Run the generated statements with stand-ins for the module's imports.
    new Function("join", "dirname", "process", lines.join("\n"))((...parts: string[]) => parts.join("/"), () => "/App.app/Contents/MacOS", { execPath: "/App.app/Contents/MacOS/App" });
    let ctx!: PluginContext;
    const fakeApp = { ready: Promise.resolve(), closed: new Promise<void>(() => {}) } as never;
    await createPluginHost([definePlugin({ name: "reg", version: "1.0.0", setup(c) { ctx = c; } })], { app: fakeApp, request: () => Promise.reject(new Error("no")), report: () => {} }).ready;
    try {
      expect(ctx.resolveLibrary()).toBe("/App.app/Contents/MacOS/../Frameworks/reg.bin");
    } finally {
      delete ((globalThis as Record<symbol, Record<string, unknown>>)[Symbol.for("tarve.pluginNatives")])!["reg"];
    }
  });
});
