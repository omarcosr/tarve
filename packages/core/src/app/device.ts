// Device services with the same shape on every OS: the share sheet, location and the biometric
// check. Where a platform has none the answer is `{ supported: false }`, never an exception.
import { isAbsolute, resolve } from "node:path";
import type { AuthErrorCode, GeoErrorCode, GeoPosition, NativeCommand, NativeEvent, PermissionState } from "../protocol";

export type { AuthErrorCode, GeoErrorCode, GeoPosition } from "../protocol";

export interface ShareOptions {
  /** The sheet's title and the message subject. */
  title?: string;
  text?: string;
  url?: string;
  /** Paths of files to share (relative ones resolve against the working directory). */
  files?: readonly string[];
}
/** `supported: false` where the OS has no share sheet (Linux); `error` when it could not open. Resolves once the sheet is shown. */
export interface ShareResult { supported: boolean; error?: string }

export interface PositionOptions {
  /** GPS-grade accuracy (Android: GPS beside network; Windows: `PositionAccuracy.High`). */
  highAccuracy?: boolean;
  /** How long to wait for a fix; default 30 000 ms, then `code: "timeout"`. */
  timeoutMs?: number;
  /** Accept a cached fix this recent; default 0 (a fresh one). */
  maximumAgeMs?: number;
}
/**
 * A fix (`position`), or why not (`code`): "unsupported" (`supported: false`: Linux), "denied"
 * (permission or OS setting), "unavailable" (location off, no provider) or "timeout".
 */
export interface PositionResult { supported: boolean; position?: GeoPosition; code?: GeoErrorCode; error?: string }

export interface AuthenticateOptions {
  /** Why the app asks: the prompt's title (Android) or message (Windows Hello). */
  reason: string;
}
/** `success`, or `code`: "unsupported" (`supported: false`), "not-enrolled", "canceled", "failed", "lockout", "busy". */
export interface AuthenticateResult { supported: boolean; success: boolean; code?: AuthErrorCode; error?: string }

export interface DeviceRequests {
  share(options: ShareOptions): Promise<ShareResult>;
  getCurrentPosition(options?: PositionOptions): Promise<PositionResult>;
  watchPosition(callback: (result: PositionResult) => void, options?: Omit<PositionOptions, "timeoutMs" | "maximumAgeMs">): () => void;
  authenticate(options: AuthenticateOptions): Promise<AuthenticateResult>;
  /** Routes a `position` event to its watch. */
  position(event: NativeEvent): void;
  /** Stops every watch (the app closed). */
  dispose(): void;
}

export interface DeviceRequestsOptions {
  request(command: NativeCommand & { requestId: string }, timeoutMs: number | null): Promise<NativeEvent>;
  permissions(action: "request", names: readonly string[]): Promise<Record<string, PermissionState>>;
  send(command: NativeCommand): void;
  report(error: unknown, event: string): void;
}

/** Android asks for these before the first fix; desktops answer "granted" at once. */
export const LOCATION_PERMISSIONS = ["ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION"] as const;

function finiteMs(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite number of milliseconds >= 0`);
  return Math.min(value, 3_600_000);
}

function result<T extends { type: string }>(event: NativeEvent, type: T["type"]): T {
  if (event.type !== type) throw new Error(`Unexpected native ${type} response`);
  return event as unknown as T;
}

export function createDeviceRequests({ request, permissions, send, report }: DeviceRequestsOptions): DeviceRequests {
  const watches = new Map<string, (result: PositionResult) => void>();
  const call = (callback: (result: PositionResult) => void, value: PositionResult) => {
    try { callback(value); } catch (error) { report(error, "position"); }
  };

  async function locationDenied(): Promise<PositionResult | undefined> {
    const states = await permissions("request", LOCATION_PERMISSIONS);
    if (Object.values(states).includes("granted")) return undefined;
    return { supported: true, code: "denied", error: "Location permission denied (Android: declare ACCESS_FINE_LOCATION or ACCESS_COARSE_LOCATION in package.json tarve.android.permissions)" };
  }

  const positionOf = (event: { supported: boolean; position?: GeoPosition; code?: GeoErrorCode; error?: string }): PositionResult => ({
    supported: event.supported,
    ...event.position ? { position: event.position } : {},
    ...event.code ? { code: event.code } : {},
    ...event.error ? { error: event.error } : {},
  });

  return {
    async share({ title, text, url, files }) {
      if (text === undefined && url === undefined && !files?.length) throw new TypeError("share needs text, a url or files");
      for (const [name, value] of [["title", title], ["text", text], ["url", url]] as const) {
        if (value !== undefined && typeof value !== "string") throw new TypeError(`share ${name} must be a string`);
      }
      if (files !== undefined && (!Array.isArray(files) || files.some(file => typeof file !== "string" || !file))) throw new TypeError("share files must be paths");
      const command: NativeCommand & { requestId: string } = {
        type: "share", requestId: crypto.randomUUID(),
        ...title !== undefined ? { title } : {}, ...text !== undefined ? { text } : {}, ...url !== undefined ? { url } : {},
        ...files?.length ? { files: files.map(file => isAbsolute(file) ? file : resolve(file)) } : {},
      };
      // The Windows share UI asks for its data after it opens: no timeout on the user.
      const event = result<Extract<NativeEvent, { type: "share" }>>(await request(command, null), "share");
      return { supported: event.supported, ...event.error ? { error: event.error } : {} };
    },

    async getCurrentPosition(options = {}) {
      const timeoutMs = finiteMs(options.timeoutMs, "timeoutMs") ?? 30_000;
      const maximumAgeMs = finiteMs(options.maximumAgeMs, "maximumAgeMs") ?? 0;
      const denied = await locationDenied();
      if (denied) return denied;
      const event = await request({ type: "location", action: "get", requestId: crypto.randomUUID(), highAccuracy: !!options.highAccuracy, timeoutMs, maximumAgeMs }, timeoutMs + 10_000);
      return positionOf(result<Extract<NativeEvent, { type: "location" }>>(event, "location"));
    },

    watchPosition(callback, options = {}) {
      if (typeof callback !== "function") throw new TypeError("watchPosition needs a callback");
      const id = crypto.randomUUID();
      let stopped = false;
      let started = false;
      watches.set(id, callback);
      void locationDenied().then(denied => {
        if (stopped) return;
        if (denied) {
          watches.delete(id);
          call(callback, denied);
          return;
        }
        started = true;
        send({ type: "location", action: "watch", requestId: id, highAccuracy: !!options.highAccuracy });
      }).catch((error: unknown) => {
        watches.delete(id);
        if (!stopped) call(callback, { supported: true, code: "unavailable", error: error instanceof Error ? error.message : String(error) });
      });
      return () => {
        if (stopped) return;
        stopped = true;
        watches.delete(id);
        if (started) {
          try { send({ type: "location", action: "clear", requestId: id }); } catch { /* the app has closed */ }
        }
      };
    },

    async authenticate(options) {
      const reason = options?.reason;
      if (typeof reason !== "string" || !reason.trim()) throw new TypeError("authenticate needs a reason");
      // The user answers the prompt at their own pace: no timeout.
      const event = result<Extract<NativeEvent, { type: "authenticate" }>>(await request({ type: "authenticate", requestId: crypto.randomUUID(), reason }, null), "authenticate");
      return { supported: event.supported, success: event.success, ...event.code ? { code: event.code } : {}, ...event.error ? { error: event.error } : {} };
    },

    position(event) {
      if (event.type !== "position") return;
      const callback = watches.get(event.watchId);
      if (!callback) return;
      // A watch that cannot start ends there.
      if (!event.position && (event.code === "unsupported" || event.code === "denied")) watches.delete(event.watchId);
      call(callback, positionOf(event));
    },

    dispose() {
      watches.clear();
    },
  };
}
