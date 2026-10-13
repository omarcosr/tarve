import type { FileDialogOptions, NativeCommand, NativeEvent } from "../protocol";

export type RequestSource = "request" | "file-dialog";
export type FileDialogMode = "openFile" | "openFiles" | "openFolder" | "saveFile";

export interface NativeRequests {
  /** Sends a command and resolves with the native event that answers its `requestId`. `null` timeout waits forever. */
  request(command: NativeCommand & { requestId: string }, timeoutMs?: number | null, source?: RequestSource): Promise<NativeEvent>;
  fileDialog(mode: FileDialogMode, options?: FileDialogOptions): Promise<string[]>;
  /** Settles the pending request a native response answers, if any. */
  settle(event: NativeEvent): void;
  /** Rejects every pending request (the window closed or failed to start). */
  rejectAll(error: Error): void;
}

export interface NativeRequestsOptions {
  send(command: NativeCommand): void;
  reportError(error: unknown, context: { source: RequestSource; event: string }): Error;
  /** The error a new request fails with once the app has ended; undefined while it runs. */
  closedError(): Error | undefined;
}

export function validateFileDialogOptions(options: FileDialogOptions): void {
  if ((options.title?.length ?? 0) > 4096 || (options.fileName?.length ?? 0) > 4096 || (options.directory?.length ?? 0) > 32_768) {
    throw new RangeError("File dialog text exceeds length limit");
  }
  const filters = options.filters ?? [];
  if (filters.length > 64) throw new RangeError("File dialog filter limit exceeded");
  for (const filter of filters) {
    if (!filter.name || filter.name.length > 256 || filter.extensions.length === 0 || filter.extensions.length > 64) {
      throw new TypeError("File dialog filters require a name and 1-64 extensions");
    }
    if (filter.extensions.some(extension => {
      const value = extension.trim().replace(/^\./, "");
      return !value || value.length > 32 || /[\\/*?]/.test(value);
    })) throw new TypeError("Invalid file dialog extension");
  }
}

export function createNativeRequests({ send, reportError, closedError }: NativeRequestsOptions): NativeRequests {
  const pending = new Map<string, {
    resolve: (event: NativeEvent) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }>();

  function request(command: NativeCommand & { requestId: string }, timeoutMs: number | null = 10_000, source: RequestSource = "request"): Promise<NativeEvent> {
    const closed = closedError();
    if (closed) return Promise.reject(closed);
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        pending.delete(command.requestId);
        reject(reportError(new Error(`Native request timed out: ${command.type}`), { source, event: command.type }));
      }, timeoutMs);
      pending.set(command.requestId, { resolve, reject, timer });
      try {
        send(command);
      } catch (value) {
        if (timer) clearTimeout(timer);
        pending.delete(command.requestId);
        reject(reportError(value, { source, event: command.type }));
      }
    });
  }

  async function fileDialog(mode: FileDialogMode, options: FileDialogOptions = {}): Promise<string[]> {
    validateFileDialogOptions(options);
    // A dialog waits for the user: no timeout.
    const event = await request({ type: "fileDialog", mode, options, requestId: crypto.randomUUID() }, null, "file-dialog");
    if (event.type !== "fileDialog") throw reportError(new Error("Unexpected native file dialog response"), { source: "file-dialog", event: mode });
    if (event.error) throw reportError(new Error(event.error), { source: "file-dialog", event: mode });
    return event.paths;
  }

  return {
    request,
    fileDialog,
    settle(event) {
      if (!("requestId" in event)) return;
      const item = pending.get(event.requestId);
      if (!item) return;
      if (item.timer) clearTimeout(item.timer);
      pending.delete(event.requestId);
      item.resolve(event);
    },
    rejectAll(error) {
      for (const item of pending.values()) {
        if (item.timer) clearTimeout(item.timer);
        item.reject(error);
      }
      pending.clear();
    },
  };
}
