/**
 * The entries scripts/smoke-runtime-parity.ts runs on Bun and in every executable variant.
 * PROLOGUE is shared: `settle` waits for the first frames, `stage` records the window's node
 * tree and a capture, `parity` writes the report ({ errors, stages, result }) and closes the
 * app. viewEntry() is the generic pass over an example view (hover, clicks, typing, Tab, a
 * wheel scroll); SCENARIOS drive one feature each and also return a `result` that must
 * equal Bun's. `result.runtime`, when present, is what legitimately differs per runtime
 * (which FFI opened a library…) and is checked against `Scenario.runtime(variant)` instead.
 *
 * The entries are written under examples/ (they resolve @tarve/core like the examples) and
 * run with the report path as their last argument.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export interface Scenario {
  /** Directory under examples/ the entry is written to. Default `_runtime-parity`. */
  dir?: string;
  /** Arguments the app is launched with, before the report path. */
  args?: string[];
  /** Extra environment of every run (reference and executables). */
  env?: Record<string, string>;
  /** Runs once before the first build (`root`: the repository). */
  prepare?: (root: string) => void;
  /** The entry, after PROLOGUE. */
  source: string;
  /** What `result.runtime` must be for a variant (`bun`: the reference run). */
  runtime?: (variant: string) => Record<string, unknown>;
}

export const PROLOGUE = String.raw`import { writeFileSync as writeReport } from "node:fs";
const out = process.argv[process.argv.length - 1]!;
const errors: string[] = [];
const stages: Record<string, unknown[][]> = {};
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const nodes = (snapshot: any) => snapshot.nodes.map((n: any) => [n.id, Math.round(n.x), Math.round(n.y), Math.round(n.width), Math.round(n.height), n.text ?? ""]);
const centre = (n: any) => ({ x: n.x + n.width / 2, y: n.y + n.height / 2 });
const visible = (snapshot: any, kinds: string[]) => snapshot.nodes.filter((n: any) => kinds.includes(n.kind) && n.width > 0 && n.height > 0 && n.y >= 0 && n.y + n.height <= snapshot.height);
/** The window's first frames, then time for fonts, images and entry animations (the
 * longest, the motion example's 650 ms enter, must have ended: a capture inside it races). */
async function settle(window: any) {
  await window.ready;
  let snapshot = await window.inspect();
  for (let i = 0; i < 100 && snapshot.frames === 0; i++) { await wait(20); snapshot = await window.inspect(); }
  await wait(1000);
  return window.inspect();
}
/** One stage of the report: the window's node tree and a capture. */
async function stage(window: any, name: string) {
  const snapshot = await window.inspect();
  stages[name] = nodes(snapshot);
  await window.capture(out + "-" + name + ".png");
  return snapshot;
}
function click(app: any, node: any) {
  app.debug({ type: "input", action: "move", ...centre(node) });
  app.debug({ type: "input", action: "down" });
  app.debug({ type: "input", action: "up" });
}
/** The first laid-out node whose text is (or, with a RegExp, matches) the given text. */
async function byText(app: any, text: string | RegExp) {
  for (let i = 0; i < 50; i++) {
    const node = (await app.inspect()).nodes.find((n: any) => n.width > 0 && typeof n.text === "string" && (typeof text === "string" ? n.text === text : text.test(n.text)));
    if (node) return node;
    await wait(40);
  }
  throw new Error("No node shows " + String(text));
}
/** Runs a scenario against the app, writes the report and exits. */
async function parity(app: any, drive: () => Promise<unknown>) {
  app.onEvent((event: any) => { if (event.type === "error") errors.push(event.message); });
  let code = 0;
  try {
    const result = await drive();
    writeReport(out + ".json", JSON.stringify({ errors, stages, result: result ?? null }));
  } catch (error) {
    code = 1;
    writeReport(out + ".json", JSON.stringify({ crash: String((error as Error)?.stack ?? error), errors }));
  }
  app.close();
  await app.closed;
  process.exit(code);
}
`;

/** The generic pass over `examples/<view>/<view>-view.tsx`. */
export const viewEntry = (view: string) => `import { createApp } from "@tarve/core";
import { lucideReactAdapter, phosphorReactAdapter, reactSvgAdapter } from "@tarve/react-icons";
import { App } from "../${view}/${view}-view";
const app = createApp(App as any, { renderer: "cpu", debug: true, componentAdapters: [reactSvgAdapter, lucideReactAdapter, phosphorReactAdapter] });
await parity(app, async () => {
  const snapshot = await settle(app);
  await stage(app, "initial");
  const buttons = visible(snapshot, ["button", "pressable"]).slice(0, 3);
  if (buttons[0]) { app.debug({ type: "input", action: "move", ...centre(buttons[0]) }); await wait(250); }
  await stage(app, "hover");
  for (const button of buttons) { click(app, button); await wait(150); }
  const input = visible(await app.inspect(), ["input", "textarea"])[0];
  if (input) {
    click(app, input);
    await wait(100);
    app.debug({ type: "input", action: "text", text: "tarve 123" });
    app.debug({ type: "input", action: "key", text: "Tab" });
    await wait(150);
  }
  app.debug({ type: "input", action: "move", x: snapshot.width / 2, y: snapshot.height / 2 });
  app.debug({ type: "input", action: "wheel", deltaX: 0, deltaY: 240 });
  await wait(300);
  app.debug({ type: "input", action: "move", x: -1, y: -1 });
  await wait(400);
  await stage(app, "after");
  return { buttons: buttons.length, input: !!input };
});
`;

const FFI: Record<string, string> = { bun: "bun", node: "node", txiki: "txiki" };

export const SCENARIOS: Record<string, Scenario> = {
  // @tarve/router: <Link> pushes, a button pushes, Escape goes back, a button pops to the root,
  // a tab switch keeps each stack, and router.back() from code.
  router: {
    source: String.raw`import { createApp } from "@tarve/core";
import { App, tabs } from "../router/router-view";
const app = createApp(App, { renderer: "cpu", debug: true, pointerEvents: true });
tabs.attach(app);
const steps: unknown[] = [];
const step = async (name: string) => {
  await wait(800);
  steps.push([name, tabs.active, tabs.route.path, tabs.canGoBack()]);
  await stage(app, name);
};
await parity(app, async () => {
  await settle(app);
  await step("people");
  click(app, await byText(app, "Ada Lovelace"));
  await step("person");
  click(app, await byText(app, /^Next: ?(Alan Turing)?$/));
  await step("next");
  app.debug({ type: "input", action: "key", text: "Escape" });
  await step("escape");
  click(app, await byText(app, "All people"));
  await step("root");
  click(app, await byText(app, "Settings"));
  await step("settings");
  click(app, await byText(app, "About this example"));
  await step("about");
  tabs.back();
  await step("back");
  return { steps };
});
`,
  },

  // Deep links and file associations: the launch's own link and file reach onOpenUrl and
  // onOpenFiles, then a second launch hands its link and file to this (single) instance.
  // Windows: registerProtocol/registerFileType write HKCU (a throwaway scheme and type,
  // removed again), read back with reg.exe. Linux: the same into a throwaway XDG data and
  // config home (desktop entries, shared-mime-info through update-mime-database, xdg-mime
  // defaults), read back with xdg-mime: every runtime runs those tools with spawnSync.
  "deep-link": {
    args: ["tarvedemo://hello/world?x=1", "note.tarvedemo"],
    source: String.raw`import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { Column, Text, Window, createApp, registerFileType, registerProtocol, requestSingleInstance, unregisterFileType, unregisterProtocol } from "@tarve/core";
const instance = await requestSingleInstance({ id: "dev.tarve.runtime-parity.deep-link", schemes: ["tarvedemo"] });
if (!instance.primary) process.exit(0);
const opened: string[] = [];
const forwarded: unknown[] = [];
function View() {
  return (
    <Window title="Deep links" width={560} height={320}>
      <Column padding={20} gap={8}>
        {opened.length ? opened.map(line => <Text size={13}>{line}</Text>) : <Text size={13}>Nothing yet.</Text>}
      </Column>
    </Window>
  );
}
const app = createApp(View, { renderer: "cpu", debug: true, protocols: ["tarvedemo"], fileTypes: [{ ext: "tarvedemo", name: "Parity" }] });
instance.onSecondInstance(launch => { forwarded.push(launch.urls); });
app.onOpenUrl((url, event) => { opened.push((event.initial ? "launch" : "forwarded") + " link " + url); app.update(); });
app.onOpenFiles((files, event) => {
  for (const file of files) opened.push((event.initial ? "launch" : "forwarded") + " file " + relative(event.cwd, file));
  app.update();
});
await parity(app, async () => {
  await settle(app);
  await stage(app, "launch");
  // The same app again: a runtime runs its script, an executable is the app.
  const script = /^(bun|node|tjs|txiki)(\.exe)?$/i.test(basename(process.execPath)) ? [process.argv[1]!] : [];
  const second = spawn(process.execPath, [...script, "tarvedemo://second/launch?y=2", "second.tarvedemo"], { stdio: "ignore" });
  const secondExit = await new Promise(resolve => { second.on("exit", code => resolve(code)); second.on("error", error => resolve(String(error))); });
  for (let i = 0; i < 100 && opened.length < 4; i++) await wait(50);
  await wait(300);
  await stage(app, "forwarded");
  let registry: unknown = process.platform;
  if (process.platform === "win32") {
    const query = (key: string) => {
      const answer = spawnSync("reg.exe", ["query", "HKCU\\Software\\Classes\\" + key, "/ve"], { encoding: "utf8", windowsHide: true });
      return answer.status === 0 ? String(answer.stdout).trim().split(/\r?\n/).pop()!.trim().replace(/\s+/g, " ") : "absent";
    };
    const command = ["C:\\Tarve Parity\\parity.exe", "--from-shell"];
    const type = { ext: "tarveparity", name: "Tarve parity file" };
    registerProtocol("tarveparity", { name: "Tarve parity", command });
    registerFileType(type, { progId: "Tarve.Parity.tarveparity", command });
    const registered = [query("tarveparity"), query("tarveparity\\shell\\open\\command"), query(".tarveparity"), query("Tarve.Parity.tarveparity\\shell\\open\\command")];
    unregisterProtocol("tarveparity");
    unregisterFileType(type, { progId: "Tarve.Parity.tarveparity" });
    registry = { registered, removed: [query("tarveparity"), query("Tarve.Parity.tarveparity")] };
  } else if (process.platform === "linux") {
    const home = mkdtempSync(join(tmpdir(), "tarve-parity-xdg-"));
    process.env.XDG_DATA_HOME = join(home, "data");
    process.env.XDG_CONFIG_HOME = join(home, "config");
    mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
    const applications = join(home, "data", "applications");
    const globs = () => existsSync(join(home, "data", "mime", "globs2")) && readFileSync(join(home, "data", "mime", "globs2"), "utf8").includes("*.tarveparity");
    const query = (mime: string) => {
      const answer = spawnSync("xdg-mime", ["query", "default", mime], { encoding: "utf8" });
      return answer.status === 0 ? String(answer.stdout).trim() || "none" : "exit " + answer.status;
    };
    const command = ["/opt/Tarve Parity/parity", "--from-shell"];
    const type = { ext: "tarveparity", name: "Tarve parity file" };
    try {
      registerProtocol("tarveparity", { name: "Tarve parity", command });
      registerFileType(type, { command });
      const entries = readdirSync(applications).sort();
      const line = (file: string, key: string) => readFileSync(join(applications, file), "utf8").split("\n").find(text => text.startsWith(key + "="));
      const mime = line("tarve-file-tarveparity-handler.desktop", "MimeType")!.slice(9, -1);
      const registered = { entries, exec: entries.map(file => line(file, "Exec")), mime, scheme: query("x-scheme-handler/tarveparity"), file: query(mime), globs: globs() };
      unregisterProtocol("tarveparity");
      unregisterFileType(type);
      registry = { registered, removed: { entries: readdirSync(applications), scheme: query("x-scheme-handler/tarveparity"), file: query(mime), globs: globs() } };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  return { args: instance.launch.args.slice(0, -1), urls: instance.launch.urls, opened, forwarded, secondExit, registry };
});
`,
  },

  // share / getCurrentPosition / watchPosition / authenticate: argument checks, then the real
  // requests. The answers' shapes must match (a fix's coordinates and the OS's wording vary).
  device: {
    source: String.raw`import { Column, Text, Window, authenticate, createApp, getCurrentPosition, share, watchPosition } from "@tarve/core";
const lines: string[] = [];
function View() {
  return (
    <Window title="Device APIs" width={640} height={360}>
      <Column padding={16} gap={6}>
        <Text size={15}>Device APIs</Text>
        {lines.map(line => <Text size={12}>{line}</Text>)}
      </Column>
    </Window>
  );
}
const app = createApp(View, { renderer: "cpu", debug: true });
const shape = (value: any): unknown => value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).map(([key, field]) => [key, key === "position" ? Object.keys(field as object).sort() : key === "error" ? typeof field : field]))
  : value;
const rejected = (error: Error) => "rejects " + error.name + ": " + error.message;
/** The answer's shape, or "pending" when it takes longer than ms (a prompt waits for the user). */
const within = (promise: Promise<unknown>, ms: number) => Promise.race([promise.then(shape, rejected), wait(ms).then(() => "pending")]);
await parity(app, async () => {
  await settle(app);
  await stage(app, "initial");
  const result: Record<string, unknown> = {};
  result.shareInvalid = await share({} as any).then(shape, rejected);
  result.authenticateInvalid = await authenticate({ reason: " " }).then(shape, rejected);
  result.positionInvalid = await getCurrentPosition({ timeoutMs: -1 }).then(shape, rejected);
  result.share = await within(share({ title: "Tarve parity", text: "Tarve runtime parity" }), 10_000);
  result.position = await within(getCurrentPosition({ timeoutMs: 3000 }), 15_000);
  result.watch = await new Promise(resolve => {
    let stop = () => {};
    const timer = setTimeout(() => { stop(); resolve("no answer in 5 s"); }, 5000);
    stop = watchPosition(answer => { clearTimeout(timer); stop(); resolve(shape(answer)); });
  });
  result.authenticate = await within(authenticate({ reason: "Tarve runtime parity" }), 3000);
  for (const [name, value] of Object.entries(result)) lines.push(name + ": " + JSON.stringify(value));
  app.update();
  await wait(300);
  await stage(app, "results");
  return result;
});
`,
  },

  // examples/plugin-hello: the Rust cdylib's hello_add through the runtime's FFI. Executables
  // must carry the library (`tarve build` embeds it for every runtime).
  "plugin-hello": {
    dir: "plugin-hello/_runtime-parity",
    prepare: root => {
      execFileSync("cargo", ["build", "--release", "--manifest-path", join(root, "examples/plugin-hello/native/Cargo.toml")], { stdio: "inherit" });
    },
    source: String.raw`import { basename } from "node:path";
import { Column, Text, Window, createApp } from "@tarve/core";
import hello from "../plugin";
let shown = "Calling hello_add";
function View() {
  return (
    <Window title="Plugin hello" width={420} height={200}>
      <Column padding={24} gap={10}><Text size={18}>{shown}</Text></Column>
    </Window>
  );
}
const app = createApp(View, { renderer: "cpu", debug: true, plugins: [hello] });
await parity(app, async () => {
  await settle(app);
  await stage(app, "initial");
  const sum = await hello.client(app).add(40, 2);
  const wrapped = await hello.client(app).add(2147483647, 1);
  const info = await hello.client(app).info();
  shown = "40 + 2 = " + sum + ", i32 max + 1 = " + wrapped;
  app.update();
  await wait(300);
  await stage(app, "called");
  const embedded = (globalThis as any)[Symbol.for("tarve.pluginNatives")]?.["tarve-plugin-hello"];
  return { sum, wrapped, target: info.target, ready: info.ready, library: basename(info.library), runtime: { ffi: info.ffi, embedded: !!embedded } };
});
`,
    runtime: variant => ({ ffi: FFI[variant.split("-")[0]!], embedded: variant !== "bun" }),
  },

  // TARVE_INSPECTOR=1 (what `tarve dev --inspect` sets): the inspector window opens beside the
  // app with its component tree, render counts and the selected node's details.
  inspector: {
    env: { TARVE_INSPECTOR: "1" },
    source: String.raw`import { Button, Column, Text, Window, createApp } from "@tarve/core";
let count = 0;
function Counter(props: { value: number }) {
  return <Text id="count">{"count " + props.value}</Text>;
}
function View() {
  return (
    <Window title="Inspector parity" width={480} height={300}>
      <Column padding={16} gap={8}>
        <Counter value={count} />
        <Button id="bump" onClick={() => { count++; }}>Bump</Button>
      </Column>
    </Window>
  );
}
const app = createApp(View, { renderer: "cpu", debug: true });
await parity(app, async () => {
  await settle(app);
  const inspector = (app as any)[Symbol.for("tarve.inspector")];
  if (!inspector) throw new Error("TARVE_INSPECTOR=1 created no inspector");
  for (let i = 0; i < 250 && !inspector.window; i++) await wait(40);
  const panel = inspector.window;
  if (!panel) throw new Error("The inspector window did not open");
  await settle(panel);
  count++;
  app.update();
  await wait(300);
  inspector.select("h:bump");
  await inspector.refreshBoxes();
  // The event log shows wall-clock times: compare its count, not its rows.
  const events = inspector.state.eventsTotal;
  inspector.state.events = [];
  panel.update();
  await wait(500);
  await stage(app, "app");
  await stage(panel, "inspector");
  const texts = (await panel.inspect()).nodes.map((n: any) => n.text).filter(Boolean).join("\n");
  return {
    tree: /<Counter>/.test(texts), renders: /×2/.test(texts), style: /Style \(resolved\)/.test(texts),
    selected: inspector.state.selected, layout: !!inspector.state.layout, events,
  };
});
`,
  },
};
