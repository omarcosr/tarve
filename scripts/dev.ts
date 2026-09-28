import { resolve } from "node:path";
import { parseArgs } from "node:util";
const root = resolve(import.meta.dir, "..");
const { values } = parseArgs({ args: process.argv.slice(2), options: { entry: { type: "string" } } });
if (!values.entry) throw new Error("--entry is required.");
const install = Bun.spawn([process.execPath, "scripts/setup-examples.ts"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (await install.exited !== 0) process.exit(1);
// --hot keeps the process (and its native window) alive; TARVE_DEV makes render() remount in place.
const app = Bun.spawn([process.execPath, "--hot", resolve(process.cwd(), values.entry)], {
  cwd: root, stdout: "inherit", stderr: "inherit", env: { ...process.env, TARVE_DEV: process.env.TARVE_DEV ?? "1" },
});
process.on("SIGINT", () => app.kill());
process.exit(await app.exited);
