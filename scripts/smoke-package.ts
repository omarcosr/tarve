import { strict as assert } from "node:assert";
import { copyFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const metadata = await Bun.file(join(root, "package.json")).json();
const directory = await mkdtemp(join(tmpdir(), "tarve-npm-consumer-"));
await copyFile(join(root, `dist/tarve-${metadata.version}.tgz`), join(directory, "tarve.tgz"));
await copyFile(join(root, "tests/fixtures/consumer.tsx"), join(directory, "app.tsx"));
await copyFile(join(root, "examples/assets/studio.png"), join(directory, "fixture.png"));
const examples = join(directory, "examples");
await mkdir(join(examples, "assets"), { recursive: true });
for (const file of ["package.json", "tsconfig.json", "basic.tsx", "basic-view.tsx", "counter.tsx", "forms.tsx", "forms-view.tsx", "large-list.tsx", "large-list-view.tsx"]) {
  await copyFile(join(root, "examples", file), join(examples, file));
}
await copyFile(join(root, "examples/assets/studio.png"), join(examples, "assets/studio.png"));
await Bun.write(join(directory, "package.json"), JSON.stringify({ name: "tarve-consumer-test", private: true, type: "module" }));
await Bun.write(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: {
  target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true,
  jsx: "react-jsx", jsxImportSource: "tarve", types: ["bun", "tarve/assets"],
}, include: ["*.tsx", "*.ts"] }));
await Bun.write(join(directory, "types.test.ts"), [
  'import type { ButtonProps } from "tarve";',
  '// @ts-expect-error An invalid variant must be rejected by the installed declarations.',
  'const invalid: ButtonProps = { variant: "not-a-variant" };',
].join("\n"));
const env: NodeJS.ProcessEnv = { ...process.env };
delete env.TARVE_NATIVE;
delete env.TARVE_DEBUG;
delete env.BUN_BE_BUN;

async function run(command: string[], cwd = directory, runtimeEnv = env): Promise<void> {
  const child = Bun.spawn(command, { cwd, env: runtimeEnv, stdout: "inherit", stderr: "inherit" });
  const timer = setTimeout(() => child.kill(), 60_000);
  try { assert.equal(await child.exited, 0, `Failed: ${command.join(" ")}`); }
  finally { clearTimeout(timer); }
}
await run([process.execPath, "add", "./tarve.tgz"]);
const bunTypes = await Bun.file(join(root, "node_modules/@types/bun/package.json")).json();
const typescript = await Bun.file(join(root, "node_modules/typescript/package.json")).json();
await run([process.execPath, "add", "--dev", `@types/bun@${bunTypes.version}`, `typescript@${typescript.version}`]);
await run([process.execPath, join(directory, "node_modules/typescript/bin/tsc"), "--noEmit"]);
await run([process.execPath, join(directory, "node_modules/typescript/bin/tsc"), "-p", join(examples, "tsconfig.json"), "--noEmit"]);
const isolatedEnv = { ...env, PATH: join(process.env.SystemRoot ?? "C:/Windows", "System32") };
await run([process.execPath, "app.tsx"], directory, isolatedEnv);
const source = await Bun.file(join(directory, "result.json")).json();
assert.equal(source.result, "PASS");
assert.equal(source.executable, false);
assert.equal(source.nativeControls, true);
assert.equal(source.virtualList, true);
await run([process.execPath, "run", "tarve", "build", "app.tsx", "--outfile", "App.exe"]);
for (const [entry, outfile] of [["counter.tsx", "Counter.exe"], ["basic.tsx", "Basic.exe"], ["forms.tsx", "Forms.exe"], ["large-list.tsx", "LargeList.exe"]]) {
  await run([process.execPath, "run", "tarve", "build", entry, "--outfile", join(directory, "example-build", outfile)], examples);
}
const portable = join(directory, "portable");
await mkdir(portable);
await copyFile(join(directory, "App.exe"), join(portable, "App.exe"));
assert.deepEqual(await readdir(portable), ["App.exe"]);
const cache = join(portable, "cache");
await mkdir(cache);
await run([join(portable, "App.exe")], portable, { ...isolatedEnv, TEMP: cache, TMP: cache });
const executable = await Bun.file(join(portable, "result.json")).json();
assert.equal(executable.result, "PASS");
assert.equal(executable.executable, true);
assert.equal(executable.nativeControls, true);
assert.equal(executable.virtualList, true);
console.log(JSON.stringify({ result: "PASS", directory, checks: ["npm tarball install", "independent example TypeScript configuration", "all four examples compile from an external directory", "source execution without Rust", "installed tarve build CLI", "standalone EXE with empty cache", "native callbacks, controls, virtual list and local images", "zero idle frames"], source, executable }, null, 2));
