import { Worker } from "node:worker_threads";
import { NATIVE_ABI_VERSION, type SceneDocument, type NativeCommand, type NativeEvent } from "../../../protocol/src/index";
import { openLibrary } from "./binding";
import { nativePath, workerPath } from "#tarve/runtime";

export interface NativeBridge { start(document: SceneDocument, onEvent: (event: NativeEvent) => void): void; send(command: NativeCommand): void; join(): void }
export interface BunFfiBridgeOptions { libraryPath?: string; workerPath?: string | URL }
export function assertNativeAbiVersion(actual: number): void {
  if (actual !== NATIVE_ABI_VERSION) {
    throw new Error(`Native ABI mismatch; expected ${NATIVE_ABI_VERSION}, got ${actual}. Rebuild the library.`);
  }
}
export class BunFfiBridge implements NativeBridge {
  private library?: ReturnType<typeof openLibrary>;
  private worker?: Worker;
  private closed = false;
  constructor(private readonly options: BunFfiBridgeOptions = {}) {}
  private error(): Error {
    const bytes = new Uint8Array(4096);
    const length = this.library!.symbols.tarve_last_error(bytes, bytes.length);
    return new Error(new TextDecoder().decode(bytes.subarray(0, Math.max(0, length))));
  }
  start(document: SceneDocument, onEvent: (event: NativeEvent) => void): void {
    if (this.library) throw new Error("Bridge already started");
    const path = this.options.libraryPath ?? nativePath();
    this.library = openLibrary(path);
    assertNativeAbiVersion(this.library.symbols.tarve_abi_version());
    const payload = new TextEncoder().encode(JSON.stringify(document));
    if (this.library.symbols.tarve_start(payload, payload.length) !== 0) throw this.error();
    try {
      this.worker = new Worker(this.options.workerPath ?? workerPath(), { workerData: { path } });
    } catch (error) {
      try { this.send({ type: "close" }); } catch {}
      try { this.join(); } catch {}
      this.closed = true;
      throw error;
    }
    this.worker.on("message", (event: NativeEvent) => {
      if (event.type === "closed") this.closed = true;
      onEvent(event);
    });
    this.worker.on("error", (error) => {
      if (!this.closed) {
        const cleanupErrors: Error[] = [];
        try { this.send({ type: "close" }); } catch (value) { cleanupErrors.push(value instanceof Error ? value : new Error(String(value))); }
        try { this.join(); } catch (value) { cleanupErrors.push(value instanceof Error ? value : new Error(String(value))); }
        this.closed = true;
        onEvent({ type: "error", message: String(error) });
        for (const cleanupError of cleanupErrors) onEvent({ type: "error", message: `Bridge cleanup failed: ${cleanupError.message}` });
        onEvent({ type: "closed" });
      }
    });
    this.worker.on("exit", (code) => {
      if (!this.closed) {
        const cleanupErrors: Error[] = [];
        try { this.send({ type: "close" }); } catch (value) { cleanupErrors.push(value instanceof Error ? value : new Error(String(value))); }
        try { this.join(); } catch (value) { cleanupErrors.push(value instanceof Error ? value : new Error(String(value))); }
        this.closed = true;
        onEvent({ type: "error", message: `Native event worker exited unexpectedly${code === 0 ? "" : ` with code ${code}`}` });
        for (const cleanupError of cleanupErrors) onEvent({ type: "error", message: `Bridge cleanup failed: ${cleanupError.message}` });
        onEvent({ type: "closed" });
      }
    });
  }
  send(command: NativeCommand): void {
    if (this.closed) throw new Error("Native window is closed");
    if (!this.library) throw new Error("Bridge not started");
    const payload = new TextEncoder().encode(JSON.stringify(command));
    if (this.library.symbols.tarve_send(payload, payload.length) !== 0) throw this.error();
  }
  join(): void { if (this.library && this.library.symbols.tarve_join() !== 0) throw this.error(); }
}
