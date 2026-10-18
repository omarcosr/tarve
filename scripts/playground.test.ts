// The docs playground runs @tarve/core in the browser with stand-ins for its Node/Bun-only
// imports (website/src/lib/playground). A core change those stand-ins do not cover (a new
// built-in, a new imported name, a stub called while modules load) stops every live example on
// the site, without failing anything that runs under Bun. This builds core and every
// documentation example the way the playground does and renders each one.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { NODE_BUILTINS, playgroundBunPlugin } from "../website/src/lib/playground/resolve";

const root = resolve(import.meta.dir, "..");
const docs = resolve(root, "website/src/lib/docs");
const out = resolve(root, "website/scripts/previews/.generated/playground-test");
const names = readdirSync(resolve(docs, "examples")).filter(file => file.endsWith(".tsx")).map(file => file.slice(0, -4));

afterAll(() => rmSync(out, { recursive: true, force: true }));

async function bundle(entry: string): Promise<Record<string, any>> {
  mkdirSync(out, { recursive: true });
  // Not entry.ts beside entry.js: Bun would import the .ts for a .js specifier.
  const source = resolve(out, "entry.src.ts");
  writeFileSync(source, entry);
  const result = await Bun.build({ entrypoints: [source], outdir: out, naming: "bundle.mjs", target: "browser", format: "esm", throw: false, plugins: [playgroundBunPlugin()] });
  if (!result.success) throw new Error(result.logs.map(log => log.message).join("\n"));
  return import(resolve(out, "bundle.mjs"));
}

class RecordingBridge {
  document: unknown;
  private onEvent?: (event: any) => void;
  start(document: unknown, onEvent: (event: any) => void): void {
    this.document = document;
    this.onEvent = onEvent;
    queueMicrotask(() => onEvent({ type: "ready" }));
  }
  send(command: { type: string }): void {
    if (command.type === "close") queueMicrotask(() => this.onEvent?.({ type: "closed" }));
  }
  join(): void {}
}

test("every Node built-in core imports has a playground stub", () => {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  const missing = new Set<string>();
  for (const file of glob.scanSync(resolve(root, "packages/core/src"))) {
    if (/\.test\.tsx?$/.test(file)) continue;
    const text = require("node:fs").readFileSync(resolve(root, "packages/core/src", file), "utf8") as string;
    for (const [, id] of text.matchAll(/^import(?!\s+type)[^;]*?from\s+"(node:[^"]+)"/gm)) if (!NODE_BUILTINS.has(id!)) missing.add(`${id} (${file})`);
  }
  expect([...missing]).toEqual([]);
});

test("@tarve/core and every documentation example build for the browser and render", async () => {
  const entry = [
    `import { Column, Window, createApp, darkTheme } from "@tarve/core";`,
    ...names.map((name, index) => `import * as e${index} from ${JSON.stringify(resolve(docs, "examples", name + ".tsx"))};`),
    `export const examples = { ${names.map((name, index) => `${JSON.stringify(name)}: e${index}`).join(", ")} };`,
    `export { Column, Window, createApp, darkTheme };`,
  ].join("\n");
  const built = await bundle(entry);
  const { createApp, Column, Window, darkTheme } = built;
  const failures: string[] = [];
  for (const name of names) {
    const example = built.examples[name];
    const bridge = new RecordingBridge();
    const errors: string[] = [];
    try {
      // As website/src/lib/playground/mount.tsx wraps it.
      const view = example.fullWindow
        ? () => { const root = example.preview(); return root.type === Window ? { ...root, props: { ...root.props, theme: darkTheme } } : root; }
        : () => ({ type: Window, props: { title: "Example", theme: darkTheme, children: { type: Column, props: { flex: 1, align: "center", justify: "center", padding: 40, children: example.preview() } } } });
      const app = createApp(view, { bridge, renderer: "cpu", onError: (event: { error: unknown }) => errors.push(String(event.error)) });
      await Promise.race([app.ready, Bun.sleep(5000).then(() => { throw new Error("app.ready timed out"); })]);
      if (!bridge.document) errors.push("no document sent to the bridge");
      app.close();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (errors.length) failures.push(`${name}: ${errors.join("; ")}`);
  }
  expect(failures).toEqual([]);
  expect(names.length).toBeGreaterThan(90);
}, 120_000);
