// The device services through the real native library with the fake provider
// (`TARVE_DEVICE=fake`, native/src/device/fake.rs): TS → protocol → native → event back,
// with deterministic answers instead of the share UI, a location source and Windows Hello.
// The same entry runs on Node and txiki in `smoke:runtime-parity device`.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nativePath } from "./bridge/runtime";

const root = resolve(import.meta.dirname, "../../..");
// Unit-test jobs run before `build:native`; this test needs the built library.
const hasNative = (() => { try { return existsSync(nativePath()); } catch { return false; } })();

const entry = (core: string, missing: string) => `import { authenticate, createApp, getCurrentPosition, share, watchPosition, Window } from "${core}/index.ts";
import { jsx } from "${core}/jsx-runtime.ts";
const app = createApp(() => jsx(Window, {}), { headless: true, renderer: "cpu" });
await app.ready;
const result: Record<string, unknown> = {};
const fixes = (count: number, highAccuracy: boolean) => new Promise<unknown[]>((done, fail) => {
  const answers: unknown[] = [];
  const timer = setTimeout(() => fail(new Error("watch: " + answers.length + " answers in 5 s")), 5000);
  const stop = watchPosition(answer => {
    answers.push(answer);
    if (answers.length === count) { clearTimeout(timer); stop(); setTimeout(() => done(answers), 300); }
  }, { highAccuracy });
});
// First a request that cannot open anything: a native without the fake provider stops here.
result.timeout = await getCurrentPosition({ timeoutMs: 0 });
if ((result.timeout as { error?: string }).error === "no fix within 0 ms") {
  result.share = await share({ title: "T", text: "x" });
  result.shareMissing = await share({ files: [${JSON.stringify(missing)}] });
  result.position = await getCurrentPosition({ highAccuracy: true, timeoutMs: 3000 });
  result.positionLow = await getCurrentPosition();
  result.watch = await fixes(3, true);
  result.cleared = await fixes(1, false);
  result.authenticate = await authenticate({ reason: "Unlock" });
  result.canceled = await authenticate({ reason: "Unlock [fake:canceled]" });
  result.unsupported = await authenticate({ reason: "[fake:unsupported]" });
}
console.log("RESULT " + JSON.stringify(result));
app.close();
await app.closed;
process.exit(0);
`;

const fix = (index: number, accuracy: number) => ({
  latitude: [-23.5505, -23.5506, -23.5507][index], longitude: [-46.6333, -46.6332, -46.6331][index],
  accuracy, altitude: index === 2 ? 761 : 760, altitudeAccuracy: 4,
  heading: index === 0 ? null : 45, speed: index === 0 ? null : 1.5, timestamp: 1_700_000_000_000 + index * 1000,
});

test.skipIf(!hasNative)("TARVE_DEVICE=fake answers every device request deterministically through the native library", async () => {
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  const directory = mkdtempSync(join(work, "device-fake-"));
  try {
    const missing = join(directory, "missing.txt");
    const file = join(directory, "device-fake.ts");
    writeFileSync(file, entry(resolve(import.meta.dirname).replaceAll("\\", "/"), missing));
    const child = Bun.spawn([process.execPath, file], {
      cwd: root, env: { ...process.env, TARVE_DEVICE: "fake" }, stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 30_000);
    const [output, errors] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    clearTimeout(timer);
    const line = output.split("\n").find(text => text.startsWith("RESULT "));
    expect(line, errors).toBeDefined();
    const result = JSON.parse(line!.slice(7));
    expect(result.timeout, "the native library predates the fake provider: run `bun run build:native`").toEqual({ supported: true, code: "timeout", error: "no fix within 0 ms" });
    expect(result).toEqual({
      timeout: { supported: true, code: "timeout", error: "no fix within 0 ms" },
      share: { supported: true },
      shareMissing: { supported: true, error: `cannot share ${missing}: no such file` },
      position: { supported: true, position: fix(0, 5) },
      positionLow: { supported: true, position: fix(0, 50) },
      watch: [0, 1, 2].map(index => ({ supported: true, position: fix(index, 5) })),
      // Stopped after the first fix: nothing follows `clear`.
      cleared: [{ supported: true, position: fix(0, 50) }],
      authenticate: { supported: true, success: true },
      canceled: { supported: true, success: false, code: "canceled", error: "fake authentication: canceled" },
      unsupported: { supported: false, success: false, code: "unsupported", error: "fake authentication: unsupported" },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
