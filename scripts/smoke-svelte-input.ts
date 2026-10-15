// Drives a built Svelte executable with real Windows input (cursor, clicks, wheel, keys)
// and checks what the components saw. It moves the real mouse: leave the machine alone while it runs.
// bun scripts/smoke-svelte-input.ts [--runtime bun|node|txiki]
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "../packages/core/build";
import { hostBuildTarget, targetConfig } from "../packages/core/targets";
import { buildNative } from "./native";

if (process.platform !== "win32") throw new Error("The physical input smoke drives Windows input (SendInput).");
const root = resolve(import.meta.dir, "..");
const { values } = parseArgs({ args: process.argv.slice(2), options: { runtime: { type: "string", default: "bun" } } });
const runtime = values.runtime as "bun" | "node" | "txiki";
const target = hostBuildTarget()!;
await mkdir(join(root, "work"), { recursive: true });
const nativeLibrary = await buildNative(true);
const directory = await mkdtemp(join(root, `work/svelte input ${runtime} `));
const executable = join(directory, `SvelteInput${targetConfig(target).executableSuffix}`);
await build({ entrypoint: join(root, "scripts/svelte-input/entry.ts"), outfile: executable, runtime, name: "Svelte input", nativeLibrary });
const child = Bun.spawn([executable, "--input-dir", directory], { cwd: directory, stdout: "inherit", stderr: "inherit" });
const kill = setTimeout(() => child.kill(), 60_000);
const wait = async (file: string) => { for (let index = 0; index < 200 && !existsSync(file); index++) await Bun.sleep(100); };
await wait(join(directory, "targets.json"));
const { scale, rects } = JSON.parse(readFileSync(join(directory, "targets.json"), "utf8")) as { scale: number; rects: Record<string, { x: number; y: number; width: number; height: number }> };
// Client coordinates in physical pixels: logical layout times the window's scale.
const at = (id: string, dx = 0.5, dy = 0.5) => ({ x: Math.round((rects[id]!.x + rects[id]!.width * dx) * scale), y: Math.round((rects[id]!.y + rects[id]!.height * dy) * scale) });
const VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_END = 0x23, VK_HOME = 0x24, VK_B = 0x42;
const steps = [
  { op: "click", ...at("button") },
  { op: "click", ...at("button") },
  { op: "click", ...at("field") },
  { op: "type", text: "hi!" },
  { op: "click", ...at("rich", 0.9, 0.5) },
  { op: "key", vk: VK_END },
  { op: "type", text: " typed" },
  // Select the line, then Ctrl+B: the part that was not bold becomes bold.
  { op: "chord", modifier: VK_SHIFT, vk: VK_HOME },
  { op: "chord", modifier: VK_CONTROL, vk: VK_B },
  { op: "move", ...at("pane") },
  { op: "wheel", delta: -240 },
];
const driver = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts/svelte-input/driver.ps1"), "-ProcessId", String(child.pid), "-Steps", JSON.stringify(steps)], { stdout: "inherit", stderr: "inherit" });
assert.equal(await driver.exited, 0, "the input driver failed");
await Bun.sleep(600);
const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
writeFileSync(join(directory, "quit"), "");
await child.exited;
clearTimeout(kill);
console.log(JSON.stringify({ runtime, scale, ...state }));
assert.equal(state.clicks, 2, "two real clicks on the button");
assert.equal(state.text, "hi!", "typed into the input");
assert.equal(state.keys, "h i !", "keydown names the typed characters");
// Text typed after "bold" stayed bold; Ctrl+B over the line bolds the rest and joins the tags.
assert.equal(state.html, "<b>Hello bold typed</b>", "typing and Ctrl+B in the contenteditable");
assert.ok(state.wheel > 0, "wheel events reached the pane");
assert.ok(state.scrolled > 0, "the pane scrolled");
console.log("PASS");
