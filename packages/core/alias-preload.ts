import { aliasModules, appAliases } from "./app-aliases";

// `tarve run|dev` preloads this for apps with a `tarve.alias` field. Bun's runtime does not hand
// bare specifiers to plugin resolvers: each aliased specifier becomes a module re-exporting its file.
const modules = aliasModules(appAliases(Bun.main));
Bun.plugin({
  name: "tarve-alias",
  setup(build) {
    for (const [specifier, path] of modules) {
      const target = JSON.stringify(path.replace(/\\/g, "/"));
      build.module(specifier, () => ({
        contents: `export * from ${target}; import * as module from ${target}; export default (module as { default?: unknown }).default;`,
        loader: "ts",
      }));
    }
  },
});
