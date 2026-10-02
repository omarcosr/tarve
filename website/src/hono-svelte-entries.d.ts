// @generated - hono-svelte, do not edit.
// Entries: 404, docs/component, docs/index, index

export type HonoSvelteEntries = "404" | "docs/component" | "docs/index" | "index";

declare module "hono" {
  interface ContextRenderer {
    (entryName: HonoSvelteEntries, props?: import("hono-svelte").RenderProps): Response | Promise<Response>;
  }
}
