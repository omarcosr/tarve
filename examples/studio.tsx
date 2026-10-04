import { createApp } from "@tarve/core";
import { build } from "@tarve/core/build";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { App, connectStudio } from "./studio-view";

const MAX_OPEN_BYTES = 2 * 1024 * 1024;

const runtime = process.versions.bun ? "bun" : "node";
// A compiled Studio runs from dist/; its bundled code cannot rebuild itself, so it
// hands the build to the tarve CLI installed next to the sources.
const compiled = !/^(node|bun)(\.exe)?$/i.test(basename(process.execPath));
// `tarve run` bundles this file under Node, so import.meta points at a temp
// bundle there; scripts run from examples/, so also try the working directory.
const sourceDirectory = [import.meta.dirname, process.cwd(), dirname(dirname(process.execPath))]
  .find(dir => dir && existsSync(join(dir, "studio.tsx")));
const exe = process.platform === "win32" ? ".exe" : "";
let outfile = join(sourceDirectory ?? ".", "dist", `Studio-${runtime}${exe}`);
// Windows cannot overwrite a running executable.
if (compiled && outfile.toLowerCase() === process.execPath.toLowerCase()) outfile = outfile.slice(0, outfile.length - exe.length) + `-next${exe}`;
const cli = sourceDirectory && join(sourceDirectory, "node_modules", "@tarve", "core", "dist", "npm", "cli.js");
const args = ["build", "studio.tsx", "--runtime", runtime, "--outfile", join("dist", basename(outfile)), "--name", "Tarve Studio"];

function runCli(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cli!, ...args], { cwd: sourceDirectory, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", error => reject(new Error(`could not start node: ${error.message}`)));
    child.once("close", code => code === 0
      ? resolve(output.trim().split(/\r?\n/).at(-1) ?? outfile)
      : reject(new Error(output.trim().split(/\r?\n/).slice(-3).join("\n") || `tarve build exited with ${code}`)));
  });
}

const app = createApp(App);
connectStudio({
  refresh: () => app.update(),
  build: !sourceDirectory
    ? { unavailable: "Studio's sources (studio.tsx) were not found next to this executable." }
    : compiled && !existsSync(cli!)
      ? { unavailable: "Install the example dependencies (npm install in examples/) to build from here." }
      : {
        runtime,
        command: `tarve ${args.map(arg => arg.includes(" ") ? `"${arg}"` : arg).join(" ")}`,
        run: compiled
          ? runCli
          : () => build({ entrypoint: join(sourceDirectory, "studio.tsx"), outfile, name: "Tarve Studio", runtime }),
      },
  openFile: async () => {
    const path = await app.openFileDialog({
      title: "Open a source file",
      filters: [{ name: "Source", extensions: ["tsx", "ts", "js", "json", "md", "rs", "toml", "css"] }],
    });
    if (!path) return undefined;
    if ((await stat(path)).size > MAX_OPEN_BYTES) throw new Error("the file is larger than 2 MB");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
    return { name: basename(path), path, text };
  },
});
await app.ready;
await app.closed;
