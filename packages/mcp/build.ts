// Bundles the package to plain JavaScript (dist/) for Node.js, which does not strip types under node_modules.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: { cli: "src/cli.ts", index: "src/index.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  logLevel: "warning",
});
