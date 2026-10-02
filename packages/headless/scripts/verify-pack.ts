// Packs @tarve/headless (or takes a packed tarball), checks its contents, then imports the packed
// sources and renders a Button with them: the tarball users install must work, not just the repo.
//   bun packages/headless/scripts/verify-pack.ts              pack and verify
//   bun packages/headless/scripts/verify-pack.ts <file.tgz>   verify an existing tarball
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const packageDir = resolve(import.meta.dir, "..");
// Extracted inside the repository so the packed sources resolve @tarve/core like the tests do.
const work = resolve(packageDir, ".pack-check");

const REQUIRED = [
  "package.json",
  "README.md",
  "src/index.ts",
  "src/bridge.ts",
  "src/runtime.ts",
  "src/png.ts",
  "wasm/tarve_web.js",
  "wasm/tarve_web_bg.wasm",
  "fonts/InterVariable.ttf",
  "fonts/JetBrainsMono.ttf",
  "fonts/OFL-Inter.txt",
  "fonts/OFL-JetBrainsMono.txt",
];
const FORBIDDEN = [/\.test\.tsx?$/, /^__snapshots__\//, /^scripts\//, /\.actual\.png$/];

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed:\n${result.stderr.toString()}`);
  return result.stdout.toString();
}

function files(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path, base) : [relative(base, path).replaceAll("\\", "/")];
  });
}

export async function verifyHeadlessPack(tarball?: string): Promise<{ tarball: string; files: string[] }> {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    let packed = tarball ? resolve(tarball) : "";
    if (!packed) {
      run([process.execPath, "pm", "pack", "--ignore-scripts", "--destination", work], packageDir);
      const name = readdirSync(work).find((file) => file.endsWith(".tgz"));
      if (!name) throw new Error("bun pm pack produced no tarball");
      packed = join(work, name);
    }
    run(["tar", "-xzf", packed, "-C", work], packageDir);
    const root = join(work, "package");
    const contents = files(root);
    const missing = REQUIRED.filter((file) => !contents.includes(file));
    if (missing.length) throw new Error(`@tarve/headless tarball is missing: ${missing.join(", ")}`);
    const extra = contents.filter((file) => FORBIDDEN.some((pattern) => pattern.test(file)));
    if (extra.length) throw new Error(`@tarve/headless tarball must not ship: ${extra.join(", ")}`);
    const manifest = (await Bun.file(join(root, "package.json")).json()) as { name: string; version: string };
    const expected = (await Bun.file(join(packageDir, "package.json")).json()) as { version: string };
    if (manifest.name !== "@tarve/headless" || manifest.version !== expected.version) {
      throw new Error(`Packed ${manifest.name}@${manifest.version}, expected @tarve/headless@${expected.version}`);
    }

    const [{ renderToRgba }, { Button }] = await Promise.all([
      import(join(root, "src/index.ts")) as Promise<typeof import("../src/index")>,
      import("@tarve/core"),
    ]);
    const image = await renderToRgba(Button({ children: "Save" }), { width: 160, height: 80 });
    const first = [image.rgba[0], image.rgba[1], image.rgba[2]];
    let ink = 0;
    for (let i = 0; i < image.rgba.length; i += 4) {
      if (Math.abs(image.rgba[i]! - first[0]!) + Math.abs(image.rgba[i + 1]! - first[1]!) + Math.abs(image.rgba[i + 2]! - first[2]!) > 48) ink++;
    }
    if (image.width !== 160 || image.height !== 80 || ink < 100) {
      throw new Error(`The packed runtime rendered ${image.width}x${image.height} with ${ink} painted pixels`);
    }
    return { tarball: packed, files: contents };
  } finally {
    if (!tarball || !existsSync(tarball)) rmSync(work, { recursive: true, force: true });
    else rmSync(join(work, "package"), { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await verifyHeadlessPack(process.argv[2]);
  console.log(`[verify-pack] @tarve/headless: ${result.files.length} files, renders with the packed runtime`);
}
