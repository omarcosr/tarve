import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const steps = ["check", "lint", "test", "smoke", "smoke:controls", "smoke:virtual-list", "pack", "smoke:package", "smoke:exe"];
for (const step of steps) {
  console.log(`\n[tarve verify] ${step}`);
  const process = Bun.spawn([Bun.which("bun") ?? "bun", "run", step], {
    cwd: root, stdout: "inherit", stderr: "inherit",
  });
  const code = await process.exited;
  if (code !== 0) throw new Error(`Verification failed at ${step} (exit ${code})`);
}
console.log("\n[tarve verify] PASS");
