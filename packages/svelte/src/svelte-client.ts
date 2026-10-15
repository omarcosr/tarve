import { pathToFileURL } from "node:url";
import { resolveSvelte } from "./resolve";

// `svelte` resolves to its server build outside a browser: load the client build by path.
// Bundles replace this module with a plain re-export (see plugin.ts).
const client: typeof import("svelte") = await import(pathToFileURL(resolveSvelte("svelte")).href);

export const { mount, unmount, flushSync } = client;
