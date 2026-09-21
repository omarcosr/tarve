import { workerData, parentPort } from "node:worker_threads";
import { openLibrary } from "./binding";

const library = openLibrary(workerData.path);
let buffer = new Uint8Array(64 * 1024);
const decoder = new TextDecoder();
for (;;) {
  const length = library.symbols.tarve_wait_event(buffer, buffer.length);
  if (length < -1) { buffer = new Uint8Array(-length); continue; }
  if (length <= 0) {
    const close = new TextEncoder().encode(JSON.stringify({ type: "close" }));
    library.symbols.tarve_send(close, close.length);
    parentPort!.postMessage({ type: "error", message: "Native event channel failed" });
    parentPort!.postMessage({ type: "closed" });
    break;
  }
  const event = JSON.parse(decoder.decode(buffer.subarray(0, length)));
  parentPort!.postMessage(event);
  if (event.type === "closed") break;
}
parentPort!.close();
// The main thread holds the DLL until process exit; no live Rust thread is unloaded.
