// Needs the host library: cargo build --release --manifest-path examples/plugin-hello/native/Cargo.toml
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { Text, Window, createApp, hostPluginTarget, readPluginManifest, type NativeBridge } from "@tarve/core";
import { openPluginLibrary } from "@tarve/core/plugins/ffi";
import hello, { HELLO_SYMBOLS } from "./plugin";

const manifest = readPluginManifest(import.meta.dirname)!;
const target = hostPluginTarget();
const library = target ? manifest.native[target] : undefined;
const built = !!library && existsSync(library);

const bridge: NativeBridge = {
  start(_document, onEvent) { onEvent({ type: "ready" }); },
  send() {},
  join() {},
};

describe.skipIf(!built)("tarve-plugin-hello (host library built)", () => {
  test("package.json declares the plugin and its libraries", () => {
    expect(manifest.name).toBe("tarve-plugin-hello");
    expect(manifest.apiVersion).toBe(1);
    expect(Object.keys(manifest.native)).toEqual(["win32-x64", "linux-x64", "darwin-arm64", "android-arm64"]);
  });

  test("bun:ffi opens the Rust cdylib and calls hello_add", () => {
    const lib = openPluginLibrary(library!, HELLO_SYMBOLS);
    try {
      expect(lib.ffi).toBe("bun");
      expect(lib.symbols.hello_abi_version()).toBe(1);
      expect(lib.symbols.hello_add(2, 3)).toBe(5);
      expect(lib.symbols.hello_add(2147483647, 1)).toBe(-2147483648);
    } finally {
      lib.close();
    }
  });

  test("an app with the plugin invokes its typed commands", async () => {
    const app = createApp(() => <Window title="hello"><Text>hello</Text></Window>, { bridge, plugins: [hello] });
    await app.ready;
    expect(await app.invoke<number>("hello.add", 20, 22)).toBe(42);
    const client = hello.client(app);
    expect(await client.add(-1, 1)).toBe(0);
    const info = await client.info();
    expect(info.ffi).toBe("bun");
    expect(info.target).toBe(target!);
    expect(info.ready).toBe(true);
    await expect(client.add(1.5, 1)).rejects.toThrow("integers");
  });
});
