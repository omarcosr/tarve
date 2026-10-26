// The wasm-bindgen output in ../wasm is built (`bun run build:wasm`), not committed: these keep the
// package type-checking before it exists. Once built, its own .d.ts files take precedence.
declare module "*/tarve_web.js";
declare module "*/tarve_web_bg.wasm";
