import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "../packages/core/build";
import { buildPack } from "../packages/core/pack-build";
import { hostBuildTarget, targetConfig } from "../packages/core/targets";
import { generateUpdateKeys, release } from "../packages/core/updates-build";
import { buildNative } from "./native";

// An executable v1.0.0 built with --packs finds the signed v1.0.1 app pack, installs it in its
// pack folder and restarts on it; the executable itself is left untouched. Then a broken v1.0.2
// pack is rolled back to v1.0.1 on its own. Per runtime: --runtime bun,node,txiki (default: bun,node).
const { values } = parseArgs({ options: { runtime: { type: "string" } } });
const runtimes = (values.runtime ?? "bun,node").split(",") as ("bun" | "node" | "txiki")[];
const root = resolve(import.meta.dir, "..");
const target = hostBuildTarget();
if (!target) throw new Error(`Pack smoke is not supported for ${process.platform}-${process.arch}`);
const suffix = targetConfig(target).executableSuffix;
mkdirSync(join(root, "work"), { recursive: true });
const nativeLibrary = await buildNative(true);
const source = (path: string) => JSON.stringify(join(root, path).replaceAll("\\", "/"));

for (const runtime of runtimes) {
  if (runtime === "txiki" && spawnSync(process.env.TARVE_TXIKI ?? "tjs", ["--version"]).status !== 0) {
    console.log("txiki.js is not installed: skipping its pack smoke");
    continue;
  }
  const directory = mkdtempSync(join(root, `work/pack smoke ${runtime} `));
  const out = join(directory, "out");
  const keys = generateUpdateKeys();
  const keyFile = join(directory, "update.key");
  writeFileSync(keyFile, keys.privateKey);
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const file = join(out, decodeURIComponent(new URL(request.url).pathname.slice(1)));
      return file.startsWith(out) && existsSync(file) ? new Response(Bun.file(file)) : new Response("missing", { status: 404 });
    },
  });
  const entry = join(directory, "app.ts");
  const app = (broken: boolean) => [
    `import { readFileSync, writeFileSync } from "node:fs";`,
    `import { checkForUpdate, downloadUpdate, installUpdate } from ${source("packages/core/src/updates.ts")};`,
    `import { runtimeAppMetadata } from ${source("packages/core/src/app-metadata.ts")};`,
    `const log = process.argv[2]!;`,
    // txiki.js has no appendFileSync.
    `const appendFileSync = (file: string, text: string) => writeFileSync(file, readFileSync(file, "utf8") + text);`,
    ...broken ? [`throw new Error("broken release");`] : [],
    `appendFileSync(log, runtimeAppMetadata().version + "\\n");`,
    `const update = await checkForUpdate({ url: ${JSON.stringify(`http://127.0.0.1:${server.port}/latest.json`)}, publicKey: ${JSON.stringify(keys.publicKey)} });`,
    `if (update) { appendFileSync(log, update.kind + "\\n"); installUpdate(await downloadUpdate(update)); }`,
    `else appendFileSync(log, "current\\n");`,
  ].join("\n");
  writeFileSync(entry, app(false));
  const common = { entrypoint: entry, nativeLibrary, name: "PackSmoke", runtime, updateKey: keyFile };
  const installed = join(directory, "install", `PackSmoke${suffix}`);
  await build({ ...common, version: "1.0.0", outfile: installed });
  const original = readFileSync(installed);
  const pack = await buildPack({ ...common, version: "1.0.1", outfile: join(directory, "PackSmoke.tarve") });
  release({ version: "1.0.1", artifacts: [], packs: [pack], privateKey: keys.privateKey, outDir: out });

  const packs = join(directory, "packs");
  const env = { ...process.env, TARVE_PACK_DIRECTORY: packs };
  const log = join(directory, "log.txt");
  const run = async (until: string) => {
    writeFileSync(log, "");
    spawn(installed, [log], { stdio: "inherit", env });
    const deadline = Date.now() + 60_000;
    while (!readFileSync(log, "utf8").includes(until) && Date.now() < deadline) await Bun.sleep(100);
    return readFileSync(log, "utf8");
  };
  assert.equal(await run("current"), "1.0.0\npack\n1.0.1\ncurrent\n", `${runtime}: v1.0.0 must install the v1.0.1 pack and restart on it`);
  assert.ok(readFileSync(installed).equals(original), `${runtime}: the executable must stay as built`);
  assert.deepEqual(readdirSync(packs).sort(), ["1.0.1.tarve"]);

  // A release that throws while starting: v1.0.2 installs, fails, is marked bad, and v1.0.1 runs again.
  writeFileSync(entry, app(true));
  const broken = await buildPack({ ...common, version: "1.0.2", outfile: join(directory, "Broken.tarve") });
  copyFileSync(broken, join(packs, "1.0.2.tarve"));
  const rolledBack = await run("current");
  server.stop(true);
  assert.equal(rolledBack, "1.0.1\ncurrent\n", `${runtime}: a broken pack must roll back to v1.0.1`);
  assert.ok(existsSync(join(packs, "1.0.2.bad")), `${runtime}: the broken pack must be marked bad`);
  console.log(`pack smoke ok (${runtime}): ${directory}`);
}
