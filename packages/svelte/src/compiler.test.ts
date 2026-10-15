import { expect, test } from "bun:test";
import { build } from "esbuild";
import { join } from "node:path";
import { compileSvelte } from "./compiler";
import { sveltePlugin } from "./plugin";

test("compiles to the client runtime with resolved imports and build-time CSS", () => {
  const { code } = compileSvelte(
    '<script>import { onMount } from "svelte"; import Child from "./Child.svelte"; let n = $state(0); onMount(() => {});</script><p class="a">{n}</p><style>.a { gap: 2px }</style>',
    "App.svelte", {}, { resolve: specifier => specifier.startsWith(".") ? "/abs/" + specifier.slice(2) : "@resolved/" + specifier },
  );
  expect(code).toContain('"@resolved/@tarve/svelte/install"');
  expect(code).toContain('"@resolved/svelte"');
  expect(code).toContain("@resolved/svelte/internal/client'");
  expect(code).toContain('"/abs/Child.svelte"');
  expect(code).toContain('"declarations":[["gap","2px"]]');
  expect(code).not.toContain("innerHTML");
});

test("esbuild bundles components with Svelte's client runtime (Node.js and txiki builds)", async () => {
  const result = await build({
    stdin: { contents: 'import App from "./fixtures/Todos.svelte"; import { mount } from "./index.ts"; export { App, mount };', resolveDir: import.meta.dir, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent",
    external: ["@tarve/core", "@tarve/core/*"],
    plugins: [sveltePlugin({ onWarning: () => {} }) as never],
  });
  const code = result.outputFiles[0]!.text;
  expect(code).toContain("from_tree");
  expect(code).not.toContain("index-server.js");
  expect(code).not.toContain("is not available on the server");
  expect(code).not.toContain(join("src", "resolve.ts"));
});
