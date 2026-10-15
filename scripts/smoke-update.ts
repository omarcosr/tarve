import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "../packages/core/build";
import { hostBuildTarget, targetConfig } from "../packages/core/targets";
import { generateUpdateKeys, release } from "../packages/core/updates-build";
import { updatePlatform } from "../packages/core/src/updates";
import { buildNative } from "./native";

// A built v1.0.0 checks a local server, downloads the signed v1.0.1, swaps itself and restarts as v1.0.1.
const root = resolve(import.meta.dir, "..");
const target = hostBuildTarget();
if (!target) throw new Error(`Update smoke is not supported for ${process.platform}-${process.arch}`);
const suffix = targetConfig(target).executableSuffix;
mkdirSync(join(root, "work"), { recursive: true });
const directory = mkdtempSync(join(root, "work/update smoke "));
const out = join(directory, "out");
const keys = generateUpdateKeys();
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const file = join(out, decodeURIComponent(new URL(request.url).pathname.slice(1)));
    return file.startsWith(out) && existsSync(file) ? new Response(Bun.file(file)) : new Response("missing", { status: 404 });
  },
});
const entry = join(directory, "app.ts");
const source = (path: string) => JSON.stringify(join(root, path).replaceAll("\\", "/"));
writeFileSync(entry, [
  `import { appendFileSync } from "node:fs";`,
  `import { checkForUpdate, downloadUpdate, installUpdate } from ${source("packages/core/src/updates.ts")};`,
  `import { runtimeAppMetadata } from ${source("packages/core/src/app-metadata.ts")};`,
  `const log = process.argv[2]!;`,
  `appendFileSync(log, runtimeAppMetadata().version + "\\n");`,
  `const update = await checkForUpdate({ url: ${JSON.stringify(`http://127.0.0.1:${server.port}/latest.json`)}, publicKey: ${JSON.stringify(keys.publicKey)} });`,
  `if (update) installUpdate(await downloadUpdate(update));`,
  `else appendFileSync(log, "current\\n");`,
].join("\n"));

const nativeLibrary = await buildNative(true);
const executable = (version: string) => join(directory, version, `App${suffix}`);
for (const version of ["1.0.0", "1.0.1"]) {
  await build({ entrypoint: entry, outfile: executable(version), nativeLibrary, name: "App", version, runtime: "bun" });
}
release({ version: "1.0.1", artifacts: [`${updatePlatform()}=${executable("1.0.1")}`], privateKey: keys.privateKey, publicKey: keys.publicKey, outDir: out });

const installed = join(directory, "install", `App${suffix}`);
mkdirSync(join(directory, "install"));
copyFileSync(executable("1.0.0"), installed);
const log = join(directory, "log.txt");
writeFileSync(log, "");
spawn(installed, [log], { stdio: "inherit" });
const deadline = Date.now() + 60_000;
while (!readFileSync(log, "utf8").includes("current") && Date.now() < deadline) await Bun.sleep(100);
server.stop(true);
assert.equal(readFileSync(log, "utf8"), "1.0.0\n1.0.1\ncurrent\n", "v1.0.0 must update itself and restart as v1.0.1");
assert.ok(readFileSync(installed).equals(readFileSync(executable("1.0.1"))), "The installed executable must be the v1.0.1 build");
console.log(`update smoke ok: ${directory}`);
