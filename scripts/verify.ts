import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
// CI runs the packaging steps in a separate job once both native runtimes exist.
const skipped = new Set((process.env.TARVE_VERIFY_SKIP ?? "").split(",").map(step => step.trim()).filter(Boolean));
const allSteps = [
  // examples/ is type-checked by `check` and has its own lockfile (icon packages).
  "install:examples",
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
const unknown = [...skipped].filter(step => !allSteps.includes(step));
if (unknown.length > 0) throw new Error(`TARVE_VERIFY_SKIP names unknown steps: ${unknown.join(", ")}`);
const steps = allSteps.filter(step => !skipped.has(step));
for (const step of steps) {
  console.log(`\n[tarve verify] ${step}`);
  const process = Bun.spawn([Bun.which("bun") ?? "bun", "run", step], {
    cwd: root, stdout: "inherit", stderr: "inherit",
  });
  const code = await process.exited;
  if (code !== 0) throw new Error(`Verification failed at ${step} (exit ${code})`);
}
console.log(`\n[tarve verify] PASS${skipped.size > 0 ? ` (skipped: ${[...skipped].join(", ")})` : ""}`);
