import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const build = Bun.spawn([process.execPath, "run", "pack"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (await build.exited !== 0) process.exit(1);
const install = Bun.spawn([process.execPath, "scripts/setup-examples.ts"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (await install.exited !== 0) process.exit(1);
const app = Bun.spawn([process.execPath, "--watch", "examples/basic.tsx"], { cwd: root, stdout: "inherit", stderr: "inherit" });
process.on("SIGINT", () => app.kill());
process.exit(await app.exited);
