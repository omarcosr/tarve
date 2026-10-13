/**
 * The wire protocol shared with the native runtime. Imported by path, not as
 * `@tarve/protocol`: the published `dist/types` keep this relative import so
 * consumers resolve the bundled `protocol/src/index.d.ts` without a second package.
 */
export * from "../../protocol/src/index";
