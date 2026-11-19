import { createApp } from "../app";
import { reportFatalError } from "../fatal";
import type { VNode } from "../jsx-runtime";
import type { AppHandle, AppOptions } from "./types";

const DEV_APP_KEY = Symbol.for("tarve.devApp");

/**
 * Renders the app until its window closes. A second call in the same
 * process (e.g. a `bun --hot` reload) remounts into the already open window.
 */
export async function render(view: () => VNode, options?: AppOptions): Promise<void> {
  // Only one native app can run per process, so a second render() (e.g. a
  // `bun --hot` reload re-evaluating the entry) remounts into the open window.
  // Bun defers hot reloads while a top-level await is pending, so under --hot
  // render() resolves once the window is ready and the process exits on close.
  const hot = process.execArgv.includes("--hot") || process.env.TARVE_HOT === "1";
  const registry = globalThis as { [DEV_APP_KEY]?: AppHandle };
  // A built executable has no console: the error that ends render() also goes to a crash
  // log and a native dialog (fatal.ts) before it is thrown.
  const fatal = (error: unknown): unknown => {
    reportFatalError(error instanceof Error ? error : new Error(String(error)), { dialog: options?.fatalDialog });
    return error;
  };
  const existing = registry[DEV_APP_KEY];
  if (existing) {
    existing.remount(view);
    if (hot) return;
    await existing.closed;
    if (existing.error) throw fatal(existing.error);
    return;
  }
  const app = createApp(view, options);
  registry[DEV_APP_KEY] = app;
  void app.closed.then(() => {
    if (registry[DEV_APP_KEY] === app) delete registry[DEV_APP_KEY];
    if (!hot) return;
    if (app.error) console.error("[tarve] the app ended with an error:", app.error);
    process.exit(app.error ? 1 : 0);
  });
  try {
    await app.ready;
  } catch (error) {
    if (registry[DEV_APP_KEY] === app) delete registry[DEV_APP_KEY];
    throw fatal(error);
  }
  if (hot) return;
  await app.closed;
  // A native failure after ready closes the window like a normal close; fail the
  // caller (and the process exit code) instead of returning as if all went well.
  if (app.error) throw fatal(app.error);
}
