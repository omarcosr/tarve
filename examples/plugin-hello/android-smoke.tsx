// Android smoke for native plugins: the APK packs libtarve_plugin_hello.so and the QuickJS
// runtime's FFI opens it (native/src/android/qjs/ffi.rs). Build and run:
//   cargo ndk -t arm64-v8a -P 26 build --release --manifest-path native/Cargo.toml
//   bun ../../packages/core/cli.ts build android-smoke.tsx --target android-arm64 --name PluginSmoke --app-id dev.tarve.pluginsmoke --permission FOREGROUND_SERVICE_SPECIAL_USE --outfile ../../dist/PluginSmoke.apk
//   adb install -r ../../dist/PluginSmoke.apk && adb shell am start -n dev.tarve.pluginsmoke/dev.tarve.TarveActivity
// It logs one "tarve-plugin-smoke <json>" line (adb logcat -s tarve): each check `true` or what went wrong.
// Twice it logs "tarve-plugin-smoke-ready-back" and waits for a real Back (`adb shell input keyevent 4`):
// the first must close the open Modal, the second must reach app.onBack; the app stays open.
import { Column, Modal, Text, Window, clipboard, createApp, keepAlive, openPluginLibrary, store, toast } from "@tarve/core";
import hello from "./plugin";

const checks: Record<string, unknown> = {};
const caught: string[] = [];
const check = (name: string, run: () => unknown, expected: unknown) => {
  try {
    const actual = run();
    checks[name] = Object.is(actual, expected) || `${String(actual)} !== ${String(expected)}`;
  } catch (error) {
    checks[name] = `${(error as Error).name}: ${(error as Error).message}`;
  }
};

const ui = store({ dialog: false, phase: "checks" });
let dialogClosed!: () => void;
const app = createApp(() => (
  <Window title="Plugin smoke">
    <Column style={{ padding: 24, gap: 8 }}>
      <Text>{`Native plugin on Android: ${ui.phase}`}</Text>
      {Object.entries(checks).map(([name, ok]) => <Text key={name}>{`${ok === true ? "ok" : "FAIL"} ${name}${ok === true ? "" : `: ${ok}`}`}</Text>)}
      {ui.dialog ? <Modal id="dialog" open onOpenChange={open => { if (!open) { ui.dialog = false; dialogClosed(); } }}><Text>Press Back</Text></Modal> : null}
    </Column>
  </Window>
), { plugins: [hello], onError: event => { caught.push(`${event.source}:${event.event}:${event.error.message}`); } });

await app.ready;
const client = hello.client(app);
const add = await client.add(20, 22).catch((error: Error) => error.message);
checks["hello.add(20, 22)"] = add === 42 || String(add);
const wrapped = await client.add(2147483647, 1).catch((error: Error) => error.message);
checks["hello.add wraps"] = wrapped === -2147483648 || String(wrapped);
const info = await client.info();
checks["info.ffi"] = info.ffi === "txiki" || info.ffi;
checks["info.target"] = info.target === "android-arm64" || String(info.target);
checks["info.library"] = info.library === "libtarve_plugin_hello.so" || info.library;
// The library's own thread reports through tarve_plugin_emit (ctx.events).
const ticks = await Promise.race([client.ticks(3, 5), new Promise<string>(resolve => setTimeout(() => resolve("timeout"), 3000))]).catch((error: Error) => error.message);
checks["ctx.events from a native thread"] = JSON.stringify(ticks) === "[1,2,3]" || JSON.stringify(ticks);

// Every argument/return class through Bionic's libc, as a plugin would call its own library.
const libc = openPluginLibrary("libc.so", {
  strlen: { args: ["buffer"], returns: "u64" },
  abs: { args: ["i32"], returns: "i32" },
  labs: { args: ["i64"], returns: "i64" },
  memset: { args: ["buffer", "i32", "u64"], returns: "ptr" },
  strtol: { args: ["buffer", "ptr", "i32"], returns: "i64" },
  strchr: { args: ["ptr", "i32"], returns: "ptr" },
});
// Bionic keeps the math functions in libm.
const libm = openPluginLibrary("libm.so", {
  ldexp: { args: ["f64", "i32"], returns: "f64" },
  ldexpf: { args: ["f32", "i32"], returns: "f32" },
});
const text = new TextEncoder().encode("hello\0tail");
check("strlen(Uint8Array)", () => libc.symbols.strlen(text), 5);
check("strlen(subarray)", () => libc.symbols.strlen(text.subarray(2)), 3);
check("abs(i32)", () => libc.symbols.abs(-42), 42);
check("labs(i64 BigInt)", () => String(libc.symbols.labs(-(2n ** 60n))), String(2n ** 60n));
check("ldexp(f64, i32)", () => libm.symbols.ldexp(1.5, 4), 24);
check("ldexpf(f32, i32)", () => libm.symbols.ldexpf(0.75, 2), 3);
libm.close();
const bytes = new Uint8Array(6);
// Heap pointers carry a tag in their top byte on arm64 Android: past 2^53, so they come back as BigInt.
const pointer = libc.symbols.memset(bytes.subarray(1), 7, 3);
check("memset(buffer) returns ptr", () => typeof pointer === "number" || typeof pointer === "bigint", true);
check("ptr round-trips (tag kept)", () => libc.symbols.strchr(pointer, 7) === pointer, true);
check("memset wrote", () => bytes.join(","), "0,7,7,7,0,0");
check("strtol(buffer, null ptr, base)", () => libc.symbols.strtol(new TextEncoder().encode("-ff\0"), null, 16), -255);
libc.close();
check("closed library throws", () => { try { libc.symbols.abs(1); return "no error"; } catch (error) { return (error as Error).message; } }, "abs: the library was closed");
check("missing library throws", () => { try { openPluginLibrary("libdoes_not_exist.so", { f: { args: [] } }); return "no error"; } catch (error) { return (error as Error).message.includes("could not load native library"); } }, true);

// Nothing catches these: createApp's onError takes them instead of the engine's log.
void Promise.reject(new Error("lost promise"));
setTimeout(() => { throw new Error("thrown in a timer"); }, 0);
await new Promise(resolve => setTimeout(resolve, 100));
checks["onError: unhandled rejection"] = caught.includes("process:unhandledRejection:lost promise") || caught.join(" | ");
checks["onError: uncaught exception"] = caught.includes("process:uncaughtException:thrown in a timer") || caught.join(" | ");
// The system clipboard through the activity, restored afterwards.
const previous = await clipboard.readText().catch(() => undefined);
const written = `tarve smoke ${Date.now()}`;
checks["clipboard round trip"] = await clipboard.writeText(written).then(() => clipboard.readText()).then(read => read === written || String(read), (error: Error) => error.message);
if (previous !== undefined) await clipboard.writeText(previous).catch(() => undefined);

// A foreground service while held.
const hold = keepAlive({ title: "Plugin smoke", text: "keeping alive" });
checks["keepAlive"] = await hold.result.then(result => (result.supported && !result.error) || JSON.stringify(result), (error: Error) => error.message);
await hold.release();

toast("Checks done", { tone: "ok" });

// Back: the open Modal closes first, then app.onBack takes it; the app keeps running.
const backTimeout = (label: string) => new Promise<string>(resolve => setTimeout(() => resolve(`${label}: no Back within 30 s`), 30_000));
ui.dialog = true;
ui.phase = "press Back (dialog)";
const first = await Promise.race([new Promise<true>(resolve => { dialogClosed = () => resolve(true); }), (async () => { await new Promise(resolve => setTimeout(resolve, 300)); console.log("tarve-plugin-smoke-ready-back"); return backTimeout("dialog"); })()]);
checks["Back closes the open Modal"] = first;
ui.phase = "press Back (onBack)";
const second = await Promise.race([new Promise<true>(resolve => { const off = app.onBack(() => { off(); resolve(true); return true; }); setTimeout(() => console.log("tarve-plugin-smoke-ready-back"), 300); }), backTimeout("onBack")]);
checks["Back reaches app.onBack"] = second;
ui.phase = "done";
const failed = Object.entries(checks).filter(([, ok]) => ok !== true);
console.log(`tarve-plugin-smoke ${JSON.stringify({ ok: failed.length === 0, checks })}`);
app.update();
