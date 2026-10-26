/**
 * Device services as plain functions: they act through the running app (the one rendering or
 * handling an event, else the last created), like `app.share(...)` and the others on
 * `AppHandle`. The same call and result shape on every OS: `{ supported: false }` where the
 * platform has none (Linux: all three; location and biometrics need a fix source / Hello).
 */
import type { AppHandle } from "./app";
import type { AuthenticateOptions, AuthenticateResult, PositionOptions, PositionResult, ShareOptions, ShareResult } from "./app/device";

export type { AuthenticateOptions, AuthenticateResult, AuthErrorCode, GeoErrorCode, GeoPosition, PositionOptions, PositionResult, ShareOptions, ShareResult } from "./app/device";

const ACTIVE_APP_KEY = Symbol.for("tarve.activeApp");

function activeApp(): AppHandle {
  const app = (globalThis as Record<symbol, AppHandle | undefined>)[ACTIVE_APP_KEY];
  if (!app) throw new Error("No Tarve app is running: create one with createApp before calling device APIs");
  return app;
}

/** The system share sheet: Android's chooser (files through a private content provider), the Windows share UI. */
export async function share(options: ShareOptions): Promise<ShareResult> {
  return activeApp().share(options);
}

/** One location fix; asks for the location permission first (Android). */
export async function getCurrentPosition(options?: PositionOptions): Promise<PositionResult> {
  return activeApp().getCurrentPosition(options);
}

/** Location fixes about every second until the returned function is called. */
export function watchPosition(callback: (result: PositionResult) => void, options?: Pick<PositionOptions, "highAccuracy">): () => void {
  return activeApp().watchPosition(callback, options);
}

/** A biometric (or device credential) check: Android BiometricPrompt, Windows Hello. */
export async function authenticate(options: AuthenticateOptions): Promise<AuthenticateResult> {
  return activeApp().authenticate(options);
}
