import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const here = import.meta.dir;
const repo = resolve(here, "../..");
const cli = join(here, "index.js");
const VERSION = (JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as { version: string }).version;
const templates: string[] = ["basic", "tailwind", "svelte", "tray"];
const hasNode = spawnSync("node", ["--version"], { encoding: "utf8" }).status === 0;
let root = "";

beforeAll(() => { root = mkdtempSync(join(tmpdir(), "create-tarve-")); });
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function run(args: string[], options: { runtime?: string; input?: string; cwd?: string; env?: Record<string, string> } = {}) {
  const result = spawnSync(options.runtime ?? process.execPath, [cli, ...args], {
    cwd: options.cwd ?? root,
    input: options.input ?? "",
    encoding: "utf8",
    env: { ...process.env, npm_config_user_agent: "", ...options.env },
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

function files(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]).sort();
}

/** Points a scaffolded project at the workspace sources instead of a published @tarve/core. */
function linkToWorkspace(dir: string, template: string): void {
  const config = JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8"));
  const p = (path: string) => join(repo, path).replaceAll("\\", "/");
  config.compilerOptions.types = ["bun"];
  config.compilerOptions.typeRoots = [p("node_modules/@types")];
  config.compilerOptions.paths = {
    "@tarve/core": [p("packages/core/src/index.ts")],
    "@tarve/core/*": [p("packages/core/src/*")],
    "@tarve/protocol": [p("packages/protocol/src/index.ts")],
    "@tarve/svelte": [p("packages/svelte/src/index.ts")],
    "@tarve/svelte/*": [p("packages/svelte/src/*")],
  };
  config.include = [...config.include, p("packages/core/src/assets.d.ts"), ...(template === "svelte" ? [p("packages/svelte/src/elements.d.ts")] : [])];
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(config, null, 2));
}

describe.each(templates)("template %s", template => {
  const name = `My ${template} App`;
  let dir = "";

  test("scaffolds with flags", () => {
    dir = join(root, name);
    const result = run([name, "--template", template, "--runtime", "bun", "--yes"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Next steps:");
    expect(result.stdout).toContain(`cd "${name}"`);
    expect(result.stdout).toContain("bun install");
    expect(result.stdout).toContain("bun run dev");

    const list = files(dir);
    const entry = template === "svelte" ? "app.ts" : "app.tsx";
    for (const file of [".gitignore", "README.md", "package.json", "tsconfig.json", entry]) expect(list).toContain(file);
    if (template === "svelte") expect(list).toEqual(expect.arrayContaining(["App.svelte", "bunfig.toml"]));
    if (template === "tray") expect(list).toContain("assets/icon.png");
    for (const file of list.filter(file => !file.endsWith(".png"))) {
      expect(readFileSync(join(dir, file), "utf8")).not.toMatch(/__(APP_NAME|APP_TITLE|TARVE_VERSION|RUNTIME|ENTRY)__/);
    }

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe(`my-${template}-app`);
    expect(pkg.tarve.name).toBe(`My ${template[0].toUpperCase()}${template.slice(1)} App`);
    expect(pkg.dependencies["@tarve/core"]).toBe(`^${VERSION}`);
    expect(pkg.scripts).toMatchObject({
      dev: `tarve dev ${entry} --runtime bun`,
      start: `tarve run ${entry} --runtime bun`,
      build: `tarve build ${entry} --runtime bun`,
    });
    if (template === "svelte") expect(pkg.dependencies["@tarve/svelte"]).toBe(`^${VERSION}`);
    if (template === "tray") expect(pkg.tarve.icon).toBe("assets/icon.png");
    const tsconfig = JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8"));
    expect(tsconfig.compilerOptions).toMatchObject({ jsx: "react-jsx", jsxImportSource: "@tarve/core", moduleResolution: "Bundler", strict: true });
    expect(tsconfig.compilerOptions.types).toEqual(expect.arrayContaining(["bun", "@tarve/core/assets"]));
    expect(readFileSync(join(dir, template === "svelte" ? "App.svelte" : entry), "utf8")).toContain(pkg.tarve.name);
  });

  // `npx create-tarve` and `bunx create-tarve` must write byte-identical projects for either --runtime.
  test.skipIf(!hasNode)("Node.js and Bun write the same project", () => {
    const scaffoldWith = (launcher: string, runtime: string) => {
      const parent = join(root, `${launcher === "node" ? "node" : "bun"}-${runtime}-${template}`);
      mkdirSync(parent, { recursive: true });
      const result = run([name, "--template", template, "--runtime", runtime, "--yes"], { runtime: launcher, cwd: parent });
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      return join(parent, name);
    };
    for (const runtime of ["bun", "node"]) {
      const bun = runtime === "bun" ? dir : scaffoldWith(process.execPath, runtime);
      const node = scaffoldWith("node", runtime);
      expect(files(node)).toEqual(files(bun));
      for (const file of files(bun)) expect(readFileSync(join(node, file)).equals(readFileSync(join(bun, file)))).toBe(true);
      expect(JSON.parse(readFileSync(join(node, "package.json"), "utf8")).engines).toEqual(runtime === "bun" ? { bun: ">=1.4.0" } : { node: ">=26.10.0" });
    }
  });

  test("typechecks against the workspace (tsc --noEmit)", () => {
    linkToWorkspace(dir, template);
    const tsc = spawnSync(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", join(dir, "tsconfig.json")], { encoding: "utf8", timeout: 120_000 });
    expect(`${tsc.stdout}${tsc.stderr}`.trim()).toBe("");
    expect(tsc.status).toBe(0);
  }, 120_000);

  test("bundles the entry against the workspace (Bun.build)", async () => {
    const plugins = [];
    if (template === "svelte") {
      const { sveltePlugin } = await import("../svelte/src/plugin.ts");
      plugins.push(sveltePlugin());
    }
    const entry = join(dir, template === "svelte" ? "app.ts" : "app.tsx");
    const output = await Bun.build({ entrypoints: [entry], target: "bun", tsconfig: join(dir, "tsconfig.json"), plugins, throw: false } as Parameters<typeof Bun.build>[0]);
    expect(output.logs.filter(log => log.level === "error").map(String)).toEqual([]);
    expect(output.success).toBe(true);
  }, 120_000);
});

describe("cli", () => {
  test("refuses a non-empty directory without --force", () => {
    const dir = join(root, "busy");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "keep.txt"), "mine");
    const refused = run(["busy", "--template", "basic", "--yes"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("not empty");
    expect(existsSync(join(dir, "package.json"))).toBe(false);

    const forced = run(["busy", "--template", "basic", "--yes", "--force"]);
    expect(forced.code).toBe(0);
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("mine");
  });

  test("rejects unknown templates, runtimes and options", () => {
    expect(run(["x", "--template", "nope", "--yes"]).stderr).toContain("unknown template");
    expect(run(["x", "--runtime", "deno", "--yes"]).stderr).toContain("unknown runtime");
    expect(run(["x", "--wat"]).code).toBe(1);
    expect(existsSync(join(root, "x"))).toBe(false);
  });

  test("prompts for the missing answers (readline)", () => {
    const result = run([], { input: "prompted-app\n2\n2\n" });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Template:");
    expect(result.stdout).toContain("Runtime:");
    const pkg = JSON.parse(readFileSync(join(root, "prompted-app", "package.json"), "utf8"));
    expect(pkg.name).toBe("prompted-app");
    expect(pkg.scripts.dev).toBe("tarve dev app.tsx --runtime node");
    expect(readFileSync(join(root, "prompted-app", "app.tsx"), "utf8")).toContain('class="');
    expect(result.stdout).toContain("npm install");
  });

  test("--yes uses defaults and the launching package manager", () => {
    const result = run(["--yes"], { cwd: mkdtempSync(join(root, "defaults-")), env: { npm_config_user_agent: "bun/1.4.3 npm/? node/v24 win32 x64" } });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("(basic, bun)");
    expect(result.stdout).toContain("cd tarve-app");
  });

  test("help and version", () => {
    expect(run(["--help"]).stdout).toContain("--template");
    expect(run(["--version"]).stdout.trim()).toBe(VERSION);
  });

  const node = spawnSync("node", ["--version"], { encoding: "utf8" });
  test.skipIf(node.status !== 0)("runs under Node.js", () => {
    const result = run(["node-app", "--template", "tailwind", "--runtime", "node", "--yes"], { runtime: "node" });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("npm run dev");
    const pkg = JSON.parse(readFileSync(join(root, "node-app", "package.json"), "utf8"));
    expect(pkg.devDependencies["@types/node"]).toBeDefined();
    expect(pkg.engines.node).toBe(">=26.10.0");
    const tsconfig = JSON.parse(readFileSync(join(root, "node-app", "tsconfig.json"), "utf8"));
    expect(tsconfig.compilerOptions.types[0]).toBe("node");
  });
});
