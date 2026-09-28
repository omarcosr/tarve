import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const steps = [
  "release:policy",
  "check",
  "lint",
  "test",
  "test:package-clean",
  "test:release-policy",
  "smoke",
  "smoke:controls",
  "smoke:virtual-list",
  "smoke:rich-content",
  "smoke:motion",
  "smoke:editor",
  "smoke:devtools",
  ...(process.platform === "win32" && process.arch === "x64" ? ["smoke:accessibility"] : []),
  "pack",
  "smoke:package",
  "smoke:exe",
  "test:visual",
];
for (const step of steps) {
  console.log(`\n[tarve verify] ${step}`);
  const process = Bun.spawn([Bun.which("bun") ?? "bun", "run", step], {
    cwd: root, stdout: "inherit", stderr: "inherit",
  });
  const code = await process.exited;
  if (code !== 0) throw new Error(`Verification failed at ${step} (exit ${code})`);
}
console.log("\n[tarve verify] PASS");
