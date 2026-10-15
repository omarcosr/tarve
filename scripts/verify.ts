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
  "smoke:steady-frames",
  "smoke:devtools",
  "smoke:tray",
  "smoke:hidden",
  "smoke:glass",
  "smoke:studio",
  "test:css-layout",
  "test:canvas",
  "smoke:text",
  "smoke:html",
  "smoke:remote-image",
  ...(process.platform === "win32" ? ["smoke:app-icon"] : []),
  ...(process.platform === "win32" && process.arch === "x64" ? ["smoke:accessibility"] : []),
  "pack",
  "smoke:package",
  "smoke:exe",
  "smoke:txiki-shims",
  "smoke:runtime-parity",
  "test:visual",
];
const unknown = [...skipped].filter(step => !allSteps.includes(step));
if (unknown.length > 0) throw new Error(`TARVE_VERIFY_SKIP names unknown steps: ${unknown.join(", ")}`);
const steps = allSteps.filter(step => !skipped.has(step));
// Test windows open off screen without taking the foreground (someone may be
// working beside the run), and every D3D11 partial redraw is checked against a
// full one. Either can be turned off by setting it to 0.
const stepEnvironment = { TARVE_BACKGROUND: "1", TARVE_GPU_DAMAGE_CHECK: "1", ...process.env };
// Steps that need the keyboard focus (UI Automation focus checks): run only with TARVE_BACKGROUND=0.
const foregroundOnly = new Set(["smoke:accessibility"]);
const background = stepEnvironment.TARVE_BACKGROUND !== "0";
const deferred = background ? steps.filter(step => foregroundOnly.has(step)) : [];
for (const step of steps) {
  if (deferred.includes(step)) {
    console.log(`\n[tarve verify] ${step}: skipped, it takes the keyboard focus (run with TARVE_BACKGROUND=0)`);
    continue;
  }
  console.log(`\n[tarve verify] ${step}`);
  const process = Bun.spawn([Bun.which("bun") ?? "bun", "run", step], {
    cwd: root, stdout: "inherit", stderr: "inherit", env: stepEnvironment,
  });
  const code = await process.exited;
  if (code !== 0) throw new Error(`Verification failed at ${step} (exit ${code})`);
}
const notRun = [...skipped, ...deferred];
console.log(`\n[tarve verify] PASS${notRun.length > 0 ? ` (skipped: ${notRun.join(", ")})` : ""}`);
