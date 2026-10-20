import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// Every example runs under `tarve run --runtime node` as under Bun, so app code
// (not tests or scratch files) must not reach for Bun's globals.
const examples = resolve(import.meta.dirname, "../../examples");

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    // Dot directories are local checkouts and caches (microts-prototype/.pocketjs), not example code.
    if (name === "node_modules" || name === "dist" || name.startsWith(".") || name.startsWith("_") || name.startsWith("work-")) return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(?:ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

test("examples use only Node-compatible APIs", () => {
  const offenders = sources(examples).flatMap(file => readFileSync(file, "utf8").split(/\r?\n/)
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /\bBun\.|from "bun"|import\.meta\.dir\b/.test(line) && !/^\s*(?:\/\/|\*)/.test(line))
    .map(({ index }) => `${relative(examples, file)}:${index + 1}`));
  expect(offenders).toEqual([]);
});
