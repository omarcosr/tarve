// Browser replacement for packages/core/src/bridge: the playground passes its own
// `CanvasBridge`, so the Bun FFI bridge is never constructed, and external links open in a tab.
export type { NativeBridge, BunFfiBridgeOptions } from "../../../../../packages/core/src/bridge";

export class BunFfiBridge {
  constructor() {
    throw new Error("BunFfiBridge is not available in the browser; pass a bridge to createApp");
  }
}

export function openExternal(target: string): void {
  if (typeof target !== "string" || target.trim().length === 0) {
    throw new TypeError("openExternal target must be a non-empty absolute URI");
  }
  window.open(target, "_blank", "noopener,noreferrer");
}
