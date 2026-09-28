import { createApp } from "@tarve/core";
import { basename } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { App, connectOpenPatch, connectRefresh, setPatchError, setPatchSource } from "./diff-view";
import { normalizePatch } from "./patch-file";

const app = createApp(App, { renderer: "gpu" });
connectRefresh(() => app.update());
connectOpenPatch(async () => {
  try {
    const path = await app.openFileDialog({
      title: "Open a Git patch or unified diff",
      filters: [{ name: "Patches", extensions: ["patch", "diff"] }],
    });
    if (!path) return;
    if ((await stat(path)).size > 8 * 1024 * 1024) throw new Error("The patch exceeds this example's 8 MB limit.");
    const source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
    setPatchSource(normalizePatch(source), basename(path));
  } catch (error) {
    setPatchError(`Could not open the patch: ${error instanceof Error ? error.message : String(error)}`);
  }
});
await app.ready;
await app.closed;
