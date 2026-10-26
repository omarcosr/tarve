// `app.onOpenUrl` / `app.onOpenFiles`: the links and files the app was launched with,
// then those of every later launch that `requestSingleInstance` forwards to this one.
import { parseOpenArgs, type FileTypeAssociation } from "../associations";
import { onForwardedLaunch, releaseSingleInstance, type InstanceLaunch } from "../instance";

/** Where an opened link or file came from. */
export interface OpenEvent {
  /** True for this process's own launch; false for a later launch handed over by `requestSingleInstance`. */
  initial: boolean;
  /** The launch's arguments and working directory. */
  args: string[];
  cwd: string;
}

export type OpenUrlListener = (url: string, event: OpenEvent) => void;
export type OpenFilesListener = (files: string[], event: OpenEvent) => void;

export interface OpenRequestsOptions {
  protocols?: readonly string[];
  fileTypes?: readonly FileTypeAssociation[];
  /** This process's launch (default: `process.argv` after the script, `process.cwd()`). */
  launch?: Pick<InstanceLaunch, "args" | "cwd">;
  exists?: (path: string) => boolean;
  report(error: unknown): void;
}

export interface OpenRequests {
  onOpenUrl(listener: OpenUrlListener): () => void;
  onOpenFiles(listener: OpenFilesListener): () => void;
  /** Handles a launch (what a forwarded one goes through). */
  dispatch(launch: Pick<InstanceLaunch, "args" | "cwd">, initial: boolean): void;
  /**
   * Links and files the OS already picked for the app (Android VIEW intents: the manifest's
   * filters chose them, so no argv parsing). `initial` ones also reach listeners added later.
   */
  deliver(opened: { urls: readonly string[]; files: readonly string[] }, initial: boolean): void;
  /** Stops listening; `appClosed` (the app itself, not a window it opened) also releases `requestSingleInstance`. */
  dispose(options?: { appClosed?: boolean }): void;
}

export function createOpenRequests(options: OpenRequestsOptions): OpenRequests {
  const urlListeners = new Set<OpenUrlListener>();
  const fileListeners = new Set<OpenFilesListener>();
  // No `process` in a browser (the WebAssembly playground): nothing was opened with the app.
  const host = (globalThis as { process?: NodeJS.Process }).process;
  const initial = options.launch ?? { args: host?.argv?.slice(2) ?? [], cwd: host?.cwd?.() ?? "" };
  let unsubscribe: (() => void) | undefined;
  let disposed = false;
  /** The launch's own opens that came as events (Android), replayed like the argv ones. */
  const delivered = { urls: [] as string[], files: [] as string[] };
  const parse = (launch: Pick<InstanceLaunch, "args" | "cwd">) =>
    parseOpenArgs(launch.args, { protocols: options.protocols, fileTypes: options.fileTypes, cwd: launch.cwd, exists: options.exists });
  const call = (run: () => void) => { try { run(); } catch (error) { options.report(error); } };
  const follow = () => {
    if (!unsubscribe && !disposed) unsubscribe = onForwardedLaunch(launch => requests.dispatch(launch, false));
  };
  /** The initial launch reaches each listener once, after the call that added it. */
  const replay = (deliver: (opened: ReturnType<typeof parse>, event: OpenEvent) => void) => {
    // Those delivered so far: a later delivery reaches this listener through `deliver` itself.
    const urls = [...delivered.urls];
    const files = [...delivered.files];
    queueMicrotask(() => {
      if (disposed) return;
      const parsed = parse(initial);
      const opened = { ...parsed, urls: [...parsed.urls, ...urls], files: [...parsed.files, ...files] };
      deliver(opened, { initial: true, args: [...initial.args, ...urls, ...files], cwd: initial.cwd });
    });
  };
  const requests: OpenRequests = {
    onOpenUrl(listener) {
      urlListeners.add(listener);
      follow();
      replay((opened, event) => {
        for (const url of opened.urls) if (urlListeners.has(listener)) call(() => listener(url, event));
      });
      return () => { urlListeners.delete(listener); };
    },
    onOpenFiles(listener) {
      fileListeners.add(listener);
      follow();
      replay((opened, event) => {
        if (opened.files.length && fileListeners.has(listener)) call(() => listener(opened.files, event));
      });
      return () => { fileListeners.delete(listener); };
    },
    dispatch(launch, isInitial) {
      if (disposed) return;
      const opened = parse(launch);
      const event: OpenEvent = { initial: isInitial, args: [...launch.args], cwd: launch.cwd };
      for (const url of opened.urls) for (const listener of [...urlListeners]) call(() => listener(url, event));
      if (opened.files.length) for (const listener of [...fileListeners]) call(() => listener([...opened.files], event));
    },
    deliver(opened, isInitial) {
      if (disposed || (!opened.urls.length && !opened.files.length)) return;
      if (isInitial) {
        delivered.urls.push(...opened.urls);
        delivered.files.push(...opened.files);
      }
      const event: OpenEvent = { initial: isInitial, args: [...opened.urls, ...opened.files], cwd: initial.cwd };
      for (const url of opened.urls) for (const listener of [...urlListeners]) call(() => listener(url, event));
      if (opened.files.length) for (const listener of [...fileListeners]) call(() => listener([...opened.files], event));
    },
    dispose(disposal) {
      disposed = true;
      unsubscribe?.();
      urlListeners.clear();
      fileListeners.clear();
      if (disposal?.appClosed) releaseSingleInstance();
    },
  };
  return requests;
}
