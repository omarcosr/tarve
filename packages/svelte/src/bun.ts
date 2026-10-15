import { sveltePlugin, type SveltePluginOptions } from "./plugin";

let registered = false;

/**
 * Lets Bun import `.svelte` files at runtime. Register before the first `.svelte`
 * import: from a `bunfig.toml` `preload`, or before a dynamic `import()`.
 */
export function registerSvelte(options?: SveltePluginOptions): void {
  if (registered) return;
  registered = true;
  Bun.plugin(sveltePlugin(options) as unknown as Parameters<typeof Bun.plugin>[0]);
}
