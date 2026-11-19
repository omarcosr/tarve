import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nativePath } from "#tarve/runtime";
import { runtimeAppMetadata, type RuntimeAppMetadata } from "./app-metadata";
import { openLibrary } from "./bridge/binding";
import { appConfigDirectory } from "./window-state";

let reported = false;

/**
 * What a `tarve build` executable does with the error that ends `render()`: it has no console,
 * so the error goes to `<config>/logs/crash-<time>.log` and, unless `dialog` is false, to a
 * native error dialog that names the log. Once per process; a no-op under `tarve run`/`tarve dev`.
 * Returns the log's path when one was written.
 */
export function reportFatalError(error: Error, options: { dialog?: boolean } = {}): string | undefined {
  const metadata = runtimeAppMetadata();
  if (!metadata.packaged || reported) return undefined;
  reported = true;
  const now = new Date();
  let log: string | undefined;
  try {
    const directory = join(appConfigDirectory(), "logs");
    mkdirSync(directory, { recursive: true });
    log = join(directory, `crash-${now.toISOString().replace(/[:.]/g, "-")}.log`);
    writeFileSync(log, crashReport(error, metadata, now));
  } catch {
    log = undefined;
  }
  if (options.dialog !== false) {
    const { title, message } = fatalDialogText(error, metadata, log);
    showFatalDialog(title, message);
  }
  return log;
}

/** The crash log: when, which app and runtime, and the error with its stack and causes. */
export function crashReport(error: Error, metadata: RuntimeAppMetadata, now: Date): string {
  const lines = [
    `time: ${now.toISOString()}`,
    `app: ${metadata.name ?? "unknown"}${metadata.version ? ` ${metadata.version}` : ""}${metadata.appId ? ` (${metadata.appId})` : ""}`,
    `runtime: ${runtimeName()}`,
    `platform: ${process.platform}-${process.arch}`,
    "",
  ];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && depth < 8; depth++) {
    const value = current instanceof Error ? current : new Error(String(current));
    // V8 and JavaScriptCore start the stack with "Name: message"; QuickJS (txiki.js) has only the frames.
    const header = `${value.name}: ${value.message}`;
    const stack = value.stack?.trimEnd() ?? "";
    lines.push(depth === 0 ? "error:" : "caused by:", stack.startsWith(header) ? stack : [header, stack].filter(Boolean).join("\n"), "");
    current = value.cause;
  }
  return lines.join("\n");
}

/** The dialog's title and text: the app's name, the error's message and where the log is. */
export function fatalDialogText(error: Error, metadata: RuntimeAppMetadata, log: string | undefined): { title: string; message: string } {
  const name = metadata.name ?? "The app";
  const reason = error.message.trim() || error.name || "Unknown error";
  return {
    title: `${name} stopped because of an error`,
    message: log ? `${reason}\n\nDetails were saved to:\n${log}` : reason,
  };
}

function runtimeName(): string {
  const versions = process.versions as Record<string, string | undefined>;
  if (versions.bun) return `Bun ${versions.bun}`;
  const tjs = (globalThis as { tjs?: { version?: string } }).tjs;
  if (tjs) return `txiki.js ${tjs.version ?? ""}`.trim();
  return `Node.js ${versions.node ?? "unknown"}`;
}

/** Through the native library, so Bun, Node.js and txiki.js show the same dialog. */
function showFatalDialog(title: string, message: string): void {
  if (process.platform !== "win32" && process.platform !== "linux") return;
  try {
    const library = openLibrary(nativePath());
    try {
      const titleBytes = new Uint8Array(Buffer.from(title, "utf8"));
      const messageBytes = new Uint8Array(Buffer.from(message, "utf8"));
      library.symbols.tarve_fatal_dialog?.(titleBytes, titleBytes.byteLength, messageBytes, messageBytes.byteLength);
    } finally {
      library.close();
    }
  } catch {}
}
