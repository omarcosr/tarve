// Device services with the same shape on every OS: the share sheet, location and the biometric
// check. Where a platform has none the answer is `{ supported: false }`, never an exception.
import { isAbsolute, resolve } from "node:path";
import type { AuthErrorCode, GeoErrorCode, GeoPosition, NativeCommand, NativeEvent, PermissionState, SpeechErrorCode } from "../protocol";

export type { AuthErrorCode, GeoErrorCode, GeoPosition, SpeechErrorCode } from "../protocol";

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

export interface SpeechOptions {
  /** BCP 47 tag such as `pt-BR`; the system language when omitted. */
  language?: string;
  /** The words so far, while the person speaks. Turns on partial results. */
  onPartial?: (text: string) => void;
  /** Microphone level, 0..1, about ten times a second. */
  onLevel?: (level: number) => void;
  /** The recogniser is listening. */
  onReady?: () => void;
  /** The person stopped speaking; the result follows. */
  onEnd?: () => void;
}
/** The recognised `text`, or why there is none (`code`). `supported: false` where the platform has no recogniser. */
export interface SpeechResult { supported: boolean; text?: string; code?: SpeechErrorCode | "canceled"; error?: string }
/** A running dictation. `stop()` ends listening and lets `result` resolve with what was heard; `cancel()` resolves it with `code: "canceled"` at once. */
export interface SpeechSession {
  readonly result: Promise<SpeechResult>;
  stop(): void;
  cancel(): void;
}

/** Android asks for this before dictation; desktops answer "granted" at once. */
export const SPEECH_PERMISSIONS = ["RECORD_AUDIO"] as const;

export interface DeviceRequests {
  share(options: ShareOptions): Promise<ShareResult>;
  getCurrentPosition(options?: PositionOptions): Promise<PositionResult>;
  watchPosition(callback: (result: PositionResult) => void, options?: Omit<PositionOptions, "timeoutMs" | "maximumAgeMs">): () => void;
  authenticate(options: AuthenticateOptions): Promise<AuthenticateResult>;
  recognizeSpeech(options?: SpeechOptions): SpeechSession;
  /** Routes a `speech` event to its session. */
  speech(event: NativeEvent): void;
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
  const sessions = new Map<string, { options: SpeechOptions; finish: (result: SpeechResult) => void }>();
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

    recognizeSpeech(options = {}) {
      if (options.language !== undefined && (typeof options.language !== "string" || !options.language.trim())) throw new TypeError("recognizeSpeech language must be a BCP 47 tag");
      const sessionId = crypto.randomUUID();
      let started = false;
      let finished = false;
      let finish!: (result: SpeechResult) => void;
      const result = new Promise<SpeechResult>(resolve => {
        finish = value => {
          if (finished) return;
          finished = true;
          sessions.delete(sessionId);
          resolve(value);
        };
      });
      sessions.set(sessionId, { options, finish });
      void permissions("request", SPEECH_PERMISSIONS).then(states => {
        if (finished) return;
        if (!Object.values(states).includes("granted")) {
          finish({ supported: true, code: "denied", error: "Microphone permission denied (Android: declare RECORD_AUDIO in package.json tarve.android.permissions)" });
          return;
        }
        started = true;
        send({ type: "speech", action: "start", sessionId, ...options.language ? { language: options.language } : {}, partialResults: !!options.onPartial });
      }).catch((error: unknown) => finish({ supported: true, code: "unavailable", error: error instanceof Error ? error.message : String(error) }));
      return {
        result,
        stop() {
          if (!finished && started) send({ type: "speech", action: "stop", sessionId });
        },
        cancel() {
          if (finished) return;
          if (started) {
            try { send({ type: "speech", action: "cancel", sessionId }); } catch { /* the app has closed */ }
          }
          finish({ supported: true, code: "canceled" });
        },
      };
    },

    speech(event) {
      if (event.type !== "speech") return;
      const session = sessions.get(event.sessionId);
      if (!session) return;
      const { options } = session;
      const call = (name: string, run: () => void) => { try { run(); } catch (error) { report(error, name); } };
      switch (event.phase) {
        case "ready": if (options.onReady) call("speechReady", options.onReady); break;
        case "partial": if (options.onPartial && event.text) call("speechPartial", () => options.onPartial!(event.text!)); break;
        case "level": if (options.onLevel && event.level !== undefined) call("speechLevel", () => options.onLevel!(event.level!)); break;
        case "end": if (options.onEnd) call("speechEnd", options.onEnd); break;
        case "result":
          session.finish({
            supported: event.supported ?? true,
            ...event.text ? { text: event.text } : {},
            ...event.code ? { code: event.code } : {},
            ...event.error ? { error: event.error } : {},
          });
          break;
      }
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
      for (const session of [...sessions.values()]) session.finish({ supported: true, code: "unavailable", error: "The app closed" });
    },
  };
}
