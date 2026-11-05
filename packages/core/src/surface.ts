import { jsx, type BaseProps, type VNode } from "./jsx-runtime";
import type { NativeCommand, NativeSurfaceEvent } from "./protocol";
import { surfaceGlSymbols, surfacePresentSymbol } from "./bridge/binding";

/**
 * `<surface>`: a box another renderer presents into, as WinUI's `SwapChainPanel` or Android's
 * `SurfaceView` — libmpv, a game engine, a plugin's GPU code. `ready` gives the handle a producer
 * of this process presents through (`handleType`); render at `event.width` × `event.height` (device
 * pixels) and follow `resize`. A surface whose way of presenting changes is `ready` again.
 *
 * - `ISwapChainPanelNative` (Windows, D3D11 renderer): a DirectComposition swap chain under the UI,
 *   presented by its producer on its own thread. The producer calls `SetSwapChain` on the handle, or
 *   `app.surface(id).attach(pointer)` shows an `IDXGISwapChain*` it exposes (libmpv's
 *   `display-swapchain` with `--d3d11-output-mode=composition`).
 * - `TarveGL` (Linux, Vulkan renderer: X11 and Wayland): the producer renders with OpenGL straight into
 *   GPU images the UI composes in its frame — zero copies, controls and clips on top. On its rendering
 *   thread: `gl.makeCurrent()` before creating its GL resources (libmpv: `mpv_render_context_create` with
 *   `gl.procAddress()` as `get_proc_address`), then per picture `gl.begin()` → render into the FBO
 *   (`MPV_RENDER_PARAM_OPENGL_FBO`) → `gl.end()`. Never blocks: the newest finished picture shows.
 * - `TarveFrames` (wherever GL interop is unavailable: CPU renderer, GL and Vulkan on different GPUs): pictures
 *   the UI composes in its frame — `app.surface(id).present(pixels, width, height)`, or a native
 *   producer's `tarve_surface_present(handle, pixels, width, height, stride, format)` from any thread
 *   (libmpv's software render API: `MPV_RENDER_PARAM_SW_*` with `bgr0`).
 * - `X11Window` (Linux on X11 with `native`): a child window the producer draws into (libmpv's `wid`),
 *   GPU all the way, but above the UI: nothing draws over its box.
 *
 * Children (controls, subtitles) and anything above it draw on top, except over an `X11Window`.
 */
export interface SurfaceEvent {
  type: NativeSurfaceEvent["event"];
  /** Device pixels: the size to render at. */
  width: number;
  height: number;
  /** Device pixels per layout pixel. */
  scale: number;
  /**
   * `ready`, decimal: the `ISwapChainPanelNative*` producers call `SetSwapChain` on, the frames handle
   * `tarve_surface_present` takes, or the X11 child window the producer draws into.
   */
  handle?: string;
  handleType?: NonNullable<NativeSurfaceEvent["handleType"]>;
  /** `ready`: why the native view asked for could not be made (frames instead). */
  message?: string;
}

export interface SurfaceProps extends BaseProps {
  onSurface?: (event: SurfaceEvent) => void;
  /** Linux on X11: an `X11Window` child the producer draws into instead of frames (faster; above the UI). */
  native?: boolean;
}

/** `<surface>` as a component. */
export function Surface(props: SurfaceProps): VNode {
  return jsx("surface", props);
}

export type SurfacePixelFormat = "rgba" | "bgra" | "rgbx" | "bgrx";
const FORMATS: Record<SurfacePixelFormat, number> = { rgba: 0, bgra: 1, rgbx: 2, bgrx: 3 };

/** `app.surface(id)`: hands a producer's pictures or swap chain to a `<surface>`. */
export interface SurfaceController {
  /** Shows the composition `IDXGISwapChain*` (a pointer of this process, decimal or 0x hex, or a bigint). */
  attach(swapChain: string | number | bigint): void;
  /** Stops showing it. */
  detach(): void;
  /**
   * `TarveFrames` surfaces: shows one picture (copied before it returns). `stride` is bytes per row
   * (packed by default); `rgbx`/`bgrx` show opaque. False once the surface is gone.
   */
  present(pixels: Uint8Array, width: number, height: number, options?: { stride?: number; format?: SurfacePixelFormat }): boolean;
  /** `TarveGL` surfaces: OpenGL rendering on the calling thread (see `SurfaceEvent`). */
  gl: SurfaceGl;
}

export interface SurfaceGl {
  /** Makes Tarve's GL context current on this thread. False when none can be made. */
  makeCurrent(): boolean;
  /** `eglGetProcAddress` as a `void *(*)(void *ctx, const char *name)` pointer (libmpv's `get_proc_address`). */
  procAddress(): bigint;
  /**
   * Binds an FBO over a free image: render all of `width`×`height`. Its first row is the top (libmpv: `FLIP_Y` 0;
   * a y-up GL scene flips its projection). Null when no image is free yet (try again in a few
   * milliseconds) or the surface is gone.
   */
  begin(): { fbo: number; width: number; height: number } | null;
  /** Hands the picture to the UI once the GPU has drawn it (returns at once). */
  end(): boolean;
}

export function surfaceEvent(event: NativeSurfaceEvent): SurfaceEvent {
  return { type: event.event, width: event.width, height: event.height, scale: event.scale, ...(event.handle !== undefined ? { handle: event.handle } : {}),
    ...(event.handleType !== undefined ? { handleType: event.handleType } : {}), ...(event.message !== undefined ? { message: event.message } : {}) };
}

/** Frames handles of the live surfaces, by id, from their events. */
export function trackSurfaceHandles(handles: Map<string, bigint>, event: NativeSurfaceEvent, kinds: Map<string, string> = new Map()): void {
  if (event.event === "ready" && (event.handleType === "TarveFrames" || event.handleType === "TarveGL") && event.handle) {
    handles.set(event.id, BigInt(event.handle));
    kinds.set(event.id, event.handleType);
  } else if (event.event === "ready" || event.event === "destroyed") {
    handles.delete(event.id);
    kinds.delete(event.id);
  }
}

export function surfaceController(id: string, send: (command: NativeCommand) => void, framesHandle: (id: string) => bigint | undefined = () => undefined): SurfaceController {
  return {
    attach(swapChain) {
      if (typeof swapChain === "number" && !Number.isSafeInteger(swapChain)) throw new Error("surface attach: pass the pointer as a bigint or string");
      send({ type: "surface", id, action: "attach", swapChain: typeof swapChain === "string" ? swapChain : swapChain.toString() });
    },
    detach() {
      send({ type: "surface", id, action: "detach" });
    },
    gl: {
      makeCurrent: () => surfaceGlSymbols().tarve_surface_gl_make_current() === 0,
      procAddress: () => BigInt(surfaceGlSymbols().tarve_surface_gl_proc_address_fn()),
      begin() {
        const handle = framesHandle(id);
        if (handle === undefined) return null;
        const out = new Uint32Array(3);
        const code = surfaceGlSymbols().tarve_surface_gl_begin(handle, out.subarray(0, 1), out.subarray(1, 2), out.subarray(2, 3));
        return code === 0 ? { fbo: out[0]!, width: out[1]!, height: out[2]! } : null;
      },
      end() {
        const handle = framesHandle(id);
        return handle !== undefined && surfaceGlSymbols().tarve_surface_gl_end(handle) === 0;
      },
    },
    present(pixels, width, height, options = {}) {
      const handle = framesHandle(id);
      if (handle === undefined) return false;
      const stride = options.stride ?? width * 4;
      if (pixels.byteLength < stride * (height - 1) + width * 4) throw new RangeError(`surface present: ${pixels.byteLength} bytes for ${width}×${height} at stride ${stride}`);
      const code = surfacePresentSymbol()(handle, pixels, width, height, stride, FORMATS[options.format ?? "rgba"]);
      if (code === -2) throw new RangeError("surface present: invalid size, stride or format");
      return code === 0;
    },
  };
}
