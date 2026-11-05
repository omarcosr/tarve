import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aliasFilter, aliasModules, appAliases, parseAliases, resolveAlias } from "./app-aliases";
import { frameworkPlugins, frameworkPreloads } from "./framework-plugins";

describe("tarve.alias", () => {
  test("exact and wildcard keys resolve against the package.json, the longest key first", () => {
    const aliases = parseAliases({ "$app/navigation": "./shims/nav.ts", "~icons/*": "./icons/*.ts", "~icons/mdi/*": "./mdi/*.ts" }, "/app");
    expect(resolveAlias("$app/navigation", aliases)).toBe(join("/app", "shims/nav.ts"));
    expect(resolveAlias("~icons/mdi/play", aliases)).toBe(join("/app", "mdi/play.ts"));
    expect(resolveAlias("~icons/lucide/x", aliases)).toBe(join("/app", "icons/lucide/x.ts"));
    expect(resolveAlias("$app/navigation/x", aliases)).toBeUndefined();
    expect(resolveAlias("~icons/", aliases)).toBeUndefined();
    expect(aliasFilter(aliases).test("~icons/mdi/play")).toBe(true);
    expect(aliasFilter(aliases).test("react")).toBe(false);
  });

  test("malformed fields are rejected", () => {
    expect(() => parseAliases([], "/app")).toThrow(TypeError);
    expect(() => parseAliases({ a: 1 }, "/app")).toThrow(TypeError);
    expect(() => parseAliases({ "a/*": "./a.ts" }, "/app")).toThrow(TypeError);
    expect(() => parseAliases({ a: "./a/*.ts" }, "/app")).toThrow(TypeError);
  });

  test("every build resolves the aliases, also in files outside the app it imports", async () => {
    const root = mkdtempSync(join(tmpdir(), "tarve-alias-"));
    const app = join(root, "app"), shared = join(root, "shared");
    mkdirSync(join(app, "shims"), { recursive: true });
    mkdirSync(shared);
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "a", tarve: { alias: { "virtual:greeting": "./shims/greeting.ts", "~num/*": "./shims/num-*.ts" } } }));
    writeFileSync(join(app, "shims", "greeting.ts"), 'export const greeting = "hello";');
    writeFileSync(join(app, "shims", "num-two.ts"), "export default 2;");
    writeFileSync(join(shared, "lib.ts"), 'import { greeting } from "virtual:greeting"; import two from "~num/two"; export const out = greeting + two;');
    writeFileSync(join(app, "main.ts"), 'import { out } from "../shared/lib.ts"; console.log(out);');
    expect(appAliases(join(app, "main.ts"))).toHaveLength(2);
    expect(aliasModules(appAliases(join(app, "main.ts"))).map(([specifier]) => specifier).sort()).toEqual(["virtual:greeting", "~num/two"]);
    const { build } = await import("esbuild");
    const result = await build({ entryPoints: [join(app, "main.ts")], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", plugins: await frameworkPlugins(join(app, "main.ts")) });
    const code = result.outputFiles[0]!.text;
    expect(code).toContain('"hello"');
    expect(code).toContain("= 2");
    // `tarve run`: Bun's runtime gets the alias preload before the app.
    const preloads = frameworkPreloads(join(app, "main.ts"));
    expect(preloads.some(path => path.endsWith("alias-preload.ts"))).toBe(true);
    const run = Bun.spawnSync([process.execPath, ...preloads, join(app, "main.ts")], { cwd: app });
    expect(run.stderr.toString() + run.stdout.toString().trim() + run.exitCode).toBe("hello20");
  });

  test("apps without the field keep their plugins and preloads", async () => {
    const root = mkdtempSync(join(tmpdir(), "tarve-alias-none-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "b" }));
    writeFileSync(join(root, "main.ts"), "");
    expect(appAliases(join(root, "main.ts"))).toEqual([]);
    expect((await frameworkPlugins(join(root, "main.ts"))).some(plugin => plugin.name === "tarve-alias")).toBe(false);
    expect(frameworkPreloads(join(root, "main.ts")).some(path => path.includes("alias-preload"))).toBe(false);
  });
});
