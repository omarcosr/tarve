import { createApp } from "tarve";
import { basename } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { App, connectOpenPatch, connectRefresh, setPatchError, setPatchSource } from "./diff-view";
import { normalizePatch } from "./patch-file";

const app = createApp(App, { renderer: "gpu" });
connectRefresh(() => app.update());
connectOpenPatch(async () => {
  try {
    const path = await app.openFileDialog({
      title: "Abrir patch Git ou unified diff",
      filters: [{ name: "Patches", extensions: ["patch", "diff"] }],
    });
    if (!path) return;
    if ((await stat(path)).size > 8 * 1024 * 1024) throw new Error("O patch excede o limite de 8 MB deste exemplo.");
    const source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
    setPatchSource(normalizePatch(source), basename(path));
  } catch (error) {
    setPatchError(`Não foi possível abrir o patch: ${error instanceof Error ? error.message : String(error)}`);
  }
});
await app.ready;
await app.closed;
