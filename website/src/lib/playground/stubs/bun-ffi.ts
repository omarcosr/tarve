// The browser playground talks to Tarve through WebAssembly, never through Bun's FFI.
function unavailable(): never {
  throw new Error("bun:ffi is not available in the browser");
}

export const FFIType = new Proxy({}, { get: () => 0 });
export const dlopen = unavailable;
export const ptr = unavailable;
export const toArrayBuffer = unavailable;
export const CString = class {
  constructor() {
    unavailable();
  }
};
export const JSCallback = class {
  constructor() {
    unavailable();
  }
};
export const suffix = "";
