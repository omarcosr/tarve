/**
 * The window and system the UI renders for: its content size and orientation, the pointer
 * (a finger or a mouse), the system text size and whether to animate. `viewport()` inside a
 * view re-renders it when any of them changes; the `portrait`/`landscape`,
 * `pointerCoarse`/`pointerFine` and `motionReduce`/`motionSafe` style variants fold the same values.
 */

export type ViewportOrientation = "portrait" | "landscape";
export type ViewportPointer = "coarse" | "fine";

export interface Viewport {
  /** The window's content width (CSS px) — on Android, the area between the system bars. */
  width: number;
  height: number;
  orientation: ViewportOrientation;
  /** `coarse` for a finger (Android), `fine` for a mouse: CSS `pointer`. */
  pointer: ViewportPointer;
  /** The system text size (Android's font size setting); the runtime already scales text by it. */
  fontScale: number;
  /** The system asks for no animation; the runtime already skips style transitions. */
  reducedMotion: boolean;
}

export interface ViewportEnvironment { fontScale: number; reducedMotion: boolean; pointer: ViewportPointer }

const android = typeof process !== "undefined" && (process.platform as string) === "android";
let environment: ViewportEnvironment = { fontScale: 1, reducedMotion: false, pointer: android ? "coarse" : "fine" };
let lastSize: { width: number; height: number } | undefined;

interface Reading { size: { width: number; height: number }; sizeRead: boolean; environmentRead: boolean }
let reading: Reading | undefined;
/** Set by the compile in progress: `viewport()` inside a memoized subtree keys it on the size. */
let hook: (() => void) | undefined;

/** Installs the compile's read hook; returns the one it replaces. */
export function setViewportHook(next: (() => void) | undefined): (() => void) | undefined {
  const previous = hook;
  hook = next;
  return previous;
}

/** The screen the native runtime reported before the first layout (Android: `TARVE_VIEWPORT`, `WxH` in dp). */
export function initialViewport(): { width: number; height: number } | undefined {
  const value = typeof process !== "undefined" ? process.env?.TARVE_VIEWPORT : undefined;
  const match = value ? /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(value) : null;
  return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined;
}

/** The current window and system. Inside a view, reading it re-renders the view when they change. */
export function viewport(): Viewport {
  const size = reading?.size ?? lastSize ?? initialViewport() ?? { width: 1120, height: 760 };
  if (reading) { reading.sizeRead = true; reading.environmentRead = true; }
  hook?.();
  return { width: size.width, height: size.height, orientation: size.height > size.width ? "portrait" : "landscape", ...environment };
}

/** The environment the variants fold against, noting that the render read it. */
export function readEnvironment(): ViewportEnvironment {
  if (reading) reading.environmentRead = true;
  return environment;
}

/** A key that changes whenever the environment does: the app re-renders views that read it. */
export function environmentKey(): string {
  return `${environment.fontScale}|${environment.reducedMotion}|${environment.pointer}`;
}

/** Applies a native `environment` event. */
export function setEnvironment(next: ViewportEnvironment): void {
  environment = { fontScale: next.fontScale, reducedMotion: next.reducedMotion, pointer: next.pointer === "coarse" ? "coarse" : "fine" };
}

/** Runs one render with `size` as the viewport and reports what it read. */
export function trackViewport<T>(size: { width: number; height: number }, render: () => T): { value: T; readSize: boolean; readEnvironment: boolean } {
  const outer = reading;
  const current: Reading = { size, sizeRead: false, environmentRead: false };
  reading = current;
  lastSize = size;
  try {
    const value = render();
    return { value, readSize: current.sizeRead, readEnvironment: current.environmentRead };
  } finally {
    reading = outer;
    if (outer) { outer.sizeRead ||= current.sizeRead; outer.environmentRead ||= current.environmentRead; }
  }
}
