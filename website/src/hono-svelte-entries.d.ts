// @generated - hono-svelte, do not edit.
// Entries: 404, docs/component, docs/desktop, docs/index, docs/platform, docs/plugins, docs/router, docs/runtimes, docs/shipping, docs/tailwind, docs/testing, docs/tooling, docs/updates, index

export type HonoSvelteEntries = "404" | "docs/component" | "docs/desktop" | "docs/index" | "docs/platform" | "docs/plugins" | "docs/router" | "docs/runtimes" | "docs/shipping" | "docs/tailwind" | "docs/testing" | "docs/tooling" | "docs/updates" | "index";

declare module "hono" {
  interface ContextRenderer {
    (entryName: HonoSvelteEntries, props?: import("hono-svelte").RenderProps): Response | Promise<Response>;
  }
}
