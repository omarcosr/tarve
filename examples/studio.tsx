import { createApp } from "@tarve/core";
import { build } from "@tarve/core/build";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { App, connectStudio } from "./studio-view";

const MAX_OPEN_BYTES = 2 * 1024 * 1024;

const app = createApp(App);
connectStudio({
  refresh: () => app.update(),
  build: () => build({
    entrypoint: join(import.meta.dir, "studio.tsx"),
    outfile: join(import.meta.dir, "dist", process.platform === "win32" ? "Studio.exe" : "Studio"),
    name: "Tarve Studio",
  }),
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
