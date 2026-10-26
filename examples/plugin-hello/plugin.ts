// tarve-plugin-hello: the smallest native Tarve plugin. The Rust library in ./native exports
// `hello_add`; setup opens it with the runtime's FFI and returns typed commands.
//
//   import hello from "tarve-plugin-hello";
//   const app = createApp(View, { plugins: [hello] });
//   await hello.client(app).add(2, 3); // 5
import { definePlugin } from "@tarve/core";

/** C ABI of native/src/lib.rs. */
export const HELLO_SYMBOLS = {
  hello_abi_version: { args: [], returns: "u32" },
  hello_add: { args: ["i32", "i32"], returns: "i32" },
} as const;

const hello = definePlugin({
  name: "tarve-plugin-hello",
  version: "0.1.0",
  namespace: "hello",
  tarvePluginApi: 1,
  // Relative library paths and package.json `tarve.native` resolve against the package.
  root: import.meta.dirname,
  setup(ctx) {
    // No paths: the library `tarve build` embedded, else package.json tarve.native for ctx.target.
    const library = ctx.loadLibrary(HELLO_SYMBOLS);
    const abi = library.symbols.hello_abi_version();
    if (abi !== 1) throw new Error(`tarve-plugin-hello: native ABI ${abi}, expected 1`);
    let readyAt: number | undefined;
    ctx.onReady(() => { readyAt = Date.now(); });
    ctx.onClosed(() => { readyAt = undefined; });
    return {
      add: (a: number, b: number): number => {
        if (!Number.isInteger(a) || !Number.isInteger(b)) throw new TypeError("hello.add takes integers");
        return library.symbols.hello_add(a, b);
      },
      info: () => ({ target: ctx.target, ffi: library.ffi, library: library.path, ready: readyAt !== undefined }),
    };
  },
});

export default hello;
