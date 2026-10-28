/**
 * Device services as plain functions: they act through the running app (the one rendering or
 * handling an event, else the last created), like `app.share(...)` and the others on
 * `AppHandle`. The same call and result shape on every OS: `{ supported: false }` where the
 * platform has none (Linux: all three; location and biometrics need a fix source / Hello).
 *
 * Tests and CI: start the app with `TARVE_DEVICE=fake` in its environment and the native
 * library answers every request deterministically (same on Bun, Node and txiki) instead of
 * opening the share UI, a location source or a biometric prompt: `share` is shown (a missing
 * file is an error); fixes at -23.5505, -46.6333 (accuracy 5 m with `highAccuracy`, else 50 m),
 * a watch sends three fixes 50 ms apart; `timeoutMs: 0` times out; `authenticate` succeeds
 * unless the reason contains `[fake:<code>]` (e.g. `[fake:canceled]`); `recognizeSpeech` hears
 * "comprar pão amanhã" (partials word by word) and answers once stopped. See native/src/device/fake.rs.
 */
import type { AppHandle } from "./app";
import type { AuthenticateOptions, AuthenticateResult, PositionOptions, PositionResult, ShareOptions, ShareResult, SpeechOptions, SpeechSession } from "./app/device";

export type { AuthenticateOptions, AuthenticateResult, AuthErrorCode, GeoErrorCode, GeoPosition, PositionOptions, PositionResult, ShareOptions, ShareResult, SpeechErrorCode, SpeechOptions, SpeechResult, SpeechSession } from "./app/device";

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

/** Dictation: Android's SpeechRecognizer, with partial results and the microphone level. */
export function recognizeSpeech(options?: SpeechOptions): SpeechSession {
  return activeApp().recognizeSpeech(options);
}

/** A biometric (or device credential) check: Android BiometricPrompt, Windows Hello. */
export async function authenticate(options: AuthenticateOptions): Promise<AuthenticateResult> {
  return activeApp().authenticate(options);
}
