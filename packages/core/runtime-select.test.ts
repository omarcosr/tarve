import { expect, test } from "bun:test";
import { selectRuntime } from "./runtime-select";

const node = { node: "26.10.0" } as NodeJS.ProcessVersions;
const bun = { node: "24.3.0", bun: "1.4.2" } as NodeJS.ProcessVersions;
// "" rather than undefined: undefined would fall back to this test process's own user agent.
const none = "";

test("the runtime that launched tarve is the default", () => {
  expect(selectRuntime(undefined, node, none)).toBe("node");
  expect(selectRuntime(undefined, node, "npm/11.19.1 node/v26.10.0 win32 x64")).toBe("node");
  expect(selectRuntime(undefined, bun, none)).toBe("bun");
  // bunx/`bun run` may start the node-shebang CLI with Node, but say so in the user agent.
  expect(selectRuntime(undefined, node, "bun/1.4.2 npm/? node/v24.3.0 win32 x64")).toBe("bun");
});

test("npm, pnpm and yarn pick Node even through a Bun-written .bin shim", () => {
  expect(selectRuntime(undefined, bun, "npm/11.19.1 node/v26.10.0 win32 x64 workspaces/false")).toBe("node");
  expect(selectRuntime(undefined, bun, "pnpm/10.0.0 npm/? node/v27.1.0 linux x64")).toBe("node");
  expect(selectRuntime(undefined, bun, "npm/10.9.0 node/v22.12.0 win32 x64")).toBe("bun");
});

test("Node before 26.10 keeps the Bun default it had before Node support", () => {
  expect(selectRuntime(undefined, { node: "22.12.0" } as NodeJS.ProcessVersions, none)).toBe("bun");
  expect(selectRuntime(undefined, { node: "26.9.1" } as NodeJS.ProcessVersions, none)).toBe("bun");
  expect(selectRuntime(undefined, { node: "27.0.0" } as NodeJS.ProcessVersions, none)).toBe("node");
  expect(selectRuntime("node", { node: "22.12.0" } as NodeJS.ProcessVersions, none)).toBe("node");
});

test("--runtime overrides the launcher and rejects unknown values", () => {
  expect(selectRuntime("node", bun, "bun/1.4.2")).toBe("node");
  expect(selectRuntime("bun", node, none)).toBe("bun");
  expect(() => selectRuntime("deno", node, none)).toThrow("Unsupported runtime: deno");
});
