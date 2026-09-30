import { strict as assert } from "node:assert";
import { copyFile, cp, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { hostBuildTarget, targetConfig } from "../packages/core/targets";

const root = resolve(import.meta.dir, "..");
const hostTarget = hostBuildTarget();
if (!hostTarget) throw new Error(`Package smoke is not supported for ${process.platform}-${process.arch}`);
const hostConfig = targetConfig(hostTarget);
const metadata = await Bun.file(join(root, "package.json")).json();
const directory = await mkdtemp(join(tmpdir(), "tarve-npm-consumer-"));
await copyFile(join(root, `dist/tarve-core-${metadata.version}.tgz`), join(directory, "tarve.tgz"));
await copyFile(join(root, "tests/fixtures/consumer.tsx"), join(directory, "app.tsx"));
await copyFile(join(root, "examples/assets/studio.png"), join(directory, "fixture.png"));
const examples = join(directory, "examples");
const sourceExamples = join(root, "examples");
await cp(sourceExamples, examples, {
  recursive: true,
  filter(source) {
    const path = relative(sourceExamples, source);
    const first = path.split(/[\\/]/)[0];
    if (["node_modules", "dist", ".bun-cache"].includes(first)) return false;
    return !/\.(?:exe|dll|so)$/i.test(path);
  },
});
await Bun.write(join(directory, "package.json"), JSON.stringify({ name: "tarve-consumer-test", private: true, type: "module" }));
await Bun.write(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: {
  target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true,
  jsx: "react-jsx", jsxImportSource: "@tarve/core", types: ["bun", "@tarve/core/assets"],
}, include: ["*.tsx", "*.ts"] }));
await Bun.write(join(directory, "types.test.ts"), [
  'import type { AppErrorEvent, AppHandle, AppOptions, ButtonProps, CodeProps, DataGridProps, DiffProps, FileDialogOptions, MarkdownProps, ScrollProps, TreeViewProps } from "@tarve/core";',
  'import type { NativeNode } from "@tarve/core/protocol";',
  '// @ts-expect-error An invalid variant must be rejected by the installed declarations.',
  'const invalid: ButtonProps = { variant: "not-a-variant" };',
  'const scroll: ScrollProps = { speed: 1.5 };',
  'const nativeScrollSpeed: NativeNode["scrollSpeed"] = scroll.speed;',
  'const dialog: FileDialogOptions = { filters: [{ name: "Text", extensions: ["txt"] }] };',
  'declare const app: AppHandle;',
  'const appOptions: AppOptions = { onError: (event: AppErrorEvent) => { const source: string = event.source; void source; } };',
  'const unregister: () => void = app.registerHotkey("Ctrl+S", () => {});',
  'const opened: Promise<string | undefined> = app.openFileDialog(dialog);',
  'const grid: DataGridProps<{ id: number; name: string }> = { columns: [{ key: "name", header: "Name", sortable: true }], rows: [], rowKey: row => row.id };',
  'const tree: TreeViewProps = { nodes: [{ id: "root", label: "Root" }] };',
  'const markdown: MarkdownProps = { source: "# Heading", onLinkClick: href => { const url: string = href; void url; } };',
  'const code: CodeProps = { code: "const n = 1", language: "js" };',
  'const diff: DiffProps = { oldText: "before", newText: "after" };',
  'const nativeMarkdown: NativeNode["source"] = markdown.source;',
  'const nativeCode: NativeNode["language"] = code.language;',
  'const nativeDiff: NativeNode["newText"] = diff.newText;',
  '// @ts-expect-error Scroll speed must remain numeric in the installed declarations.',
  'const invalidScroll: ScrollProps = { speed: "fast" };',
].join("\n"));
const env: NodeJS.ProcessEnv = { ...process.env };
delete env.TARVE_NATIVE;
delete env.TARVE_DEBUG;
delete env.BUN_BE_BUN;

// Registry installs depend on the network, so they get a longer budget than
// the app runs, and a timeout says so instead of surfacing as exit 143.
async function run(command: string[], cwd = directory, runtimeEnv = env, timeoutMs = 60_000): Promise<void> {
  const child = Bun.spawn(command, { cwd, env: runtimeEnv, stdout: "inherit", stderr: "inherit" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  try {
    const code = await child.exited;
    assert(!timedOut, `Timed out after ${timeoutMs / 1000} s: ${command.join(" ")}`);
    assert.equal(code, 0, `Failed: ${command.join(" ")}`);
  } finally { clearTimeout(timer); }
}
const INSTALL_TIMEOUT_MS = 240_000;
await run([process.execPath, "add", "./tarve.tgz"]);
const reactIconsPackage = await Bun.file(join(root, "packages/react-icons/package.json")).json() as { version: string };
await run([process.execPath, "pm", "pack", "--ignore-scripts", "--destination", directory], join(root, "packages/react-icons"));
await run([process.execPath, "add", `./tarve-react-icons-${reactIconsPackage.version}.tgz`]);
const bunTypes = await Bun.file(join(root, "node_modules/@types/bun/package.json")).json();
const typescript = await Bun.file(join(root, "node_modules/typescript/package.json")).json();
const examplePackage = await Bun.file(join(root, "examples/package.json")).json() as {
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};
const exampleEntrypoints = Object.values(examplePackage.scripts ?? {}).flatMap(command => {
  const match = command.match(/^bun\s+([\w-]+\.tsx)$/);
  return match ? [match[1]] : [];
});
assert(exampleEntrypoints.length > 0, "Example package must expose runnable TSX examples");
const externalPackages: string[] = [];
for (const name of Object.keys(examplePackage.dependencies ?? {})) {
  if (name.startsWith("@tarve/")) continue;
  const installed = await Bun.file(join(root, "examples/node_modules", ...name.split("/"), "package.json")).json() as { version: string };
  externalPackages.push(`${name}@${installed.version}`);
}
if (externalPackages.length) await run([process.execPath, "add", ...externalPackages], directory, env, INSTALL_TIMEOUT_MS);
await run([process.execPath, "add", "--dev", `@types/bun@${bunTypes.version}`, `typescript@${typescript.version}`], directory, env, INSTALL_TIMEOUT_MS);
await run([process.execPath, join(directory, "node_modules/typescript/bin/tsc"), "--noEmit"]);
await run([process.execPath, join(directory, "node_modules/typescript/bin/tsc"), "-p", join(examples, "tsconfig.json"), "--noEmit"]);
const isolatedEnv = process.platform === "win32"
  ? { ...env, PATH: join(process.env.SystemRoot ?? "C:/Windows", "System32") }
  : { ...env };
await run([process.execPath, "app.tsx"], directory, isolatedEnv);
const source = await Bun.file(join(directory, "result.json")).json();
assert.equal(source.result, "PASS");
assert.equal(source.executable, false);
assert.equal(source.nativeControls, true);
assert.equal(source.virtualList, true);
const appExecutableName = `App${hostConfig.executableSuffix}`;
await run([process.execPath, "run", "tarve", "build", "app.tsx", "--outfile", appExecutableName]);
for (const entry of exampleEntrypoints) {
  const base = entry.replace(/\.tsx$/, "");
  await run([process.execPath, "run", "tarve", "build", entry, "--outfile", join(directory, "example-build", `${base}${hostConfig.executableSuffix}`)], examples);
}
const portable = join(directory, "portable");
await mkdir(portable);
await copyFile(join(directory, appExecutableName), join(portable, appExecutableName));
assert.deepEqual(await readdir(portable), [appExecutableName]);
const cache = join(portable, "cache");
await mkdir(cache);
await run([join(portable, appExecutableName)], portable, { ...isolatedEnv, TEMP: cache, TMP: cache });
const executable = await Bun.file(join(portable, "result.json")).json();
assert.equal(executable.result, "PASS");
assert.equal(executable.executable, true);
assert.equal(executable.nativeControls, true);
assert.equal(executable.virtualList, true);
console.log(JSON.stringify({ result: "PASS", directory, checks: ["npm tarball install", "independent example TypeScript configuration", `${exampleEntrypoints.length} examples compile from an external directory`, "source execution without Rust", "installed tarve build CLI", "standalone executable with empty cache", "native events, controls, virtual list, rich content and local images", "zero idle frames"], source, executable }, null, 2));
