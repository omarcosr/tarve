/** @jsxImportSource ../packages/core/src */
/**
 * Manual smoke of the REAL device services (not in `verify`, not in CI): the OS share UI, a
 * location fix and a watch from the platform's source, and the biometric prompt (Windows
 * Hello, Android BiometricPrompt). It needs a person: close the share UI, answer the prompt.
 * Automated runs use the deterministic native fake provider instead (`TARVE_DEVICE=fake`,
 * native/src/device/fake.rs; `smoke:runtime-parity device`, packages/core/src/device-fake.test.ts).
 *
 *   bun scripts/smoke-device-real.tsx
 *
 * Prints every answer; exits 1 if one does not have the documented shape.
 */
import { Column, Text, Window, authenticate, createApp, getCurrentPosition, share, watchPosition } from "../packages/core/src/index";

if (process.env.TARVE_DEVICE?.trim() === "fake") {
  console.error("smoke-device-real: TARVE_DEVICE=fake selects the fake provider; unset it to test the real services");
  process.exit(2);
}

let step = "Starting";
function View() {
  return (
    <Window title="Tarve device services (real)" width={560} height={200}>
      <Column padding={16} gap={8}>
        <Text size={15}>Real device services</Text>
        <Text size={13}>{step}</Text>
      </Column>
    </Window>
  );
}
const app = createApp(View);
const problems: string[] = [];
const show = (text: string) => {
  step = text;
  console.log(`\n> ${text}`);
  app.update();
};
const check = (name: string, value: Record<string, unknown>, valid: boolean) => {
  console.log(`${name}:`, JSON.stringify(value));
  if (!valid) problems.push(`${name}: unexpected answer ${JSON.stringify(value)}`);
};

await app.ready;
show("Share: the system share UI opens (Linux: supported false). Close it to go on.");
const shared = await share({ title: "Tarve", text: "Tarve device smoke", url: "https://tarve.dev" });
check("share", { ...shared }, typeof shared.supported === "boolean");

show("Location: one fix (may ask for the location permission).");
const fix = await getCurrentPosition({ highAccuracy: true, timeoutMs: 15_000 });
check("getCurrentPosition", { ...fix }, !!fix.position || !!fix.code);

show("Watch: the first answer.");
const watched = await new Promise<Record<string, unknown>>(resolve => {
  let stop = () => {};
  const timer = setTimeout(() => { stop(); resolve({ pending: "no answer in 30 s" }); }, 30_000);
  stop = watchPosition(answer => { clearTimeout(timer); stop(); resolve({ ...answer }); });
});
check("watchPosition", watched, !("pending" in watched));

show("Authenticate: answer the biometric prompt (or cancel it).");
const verified = await authenticate({ reason: "Tarve device smoke" });
check("authenticate", { ...verified }, verified.success || !!verified.code);

show(problems.length ? `Done with ${problems.length} problem(s)` : "Done");
for (const problem of problems) console.error(problem);
app.close();
await app.closed;
process.exit(problems.length ? 1 : 0);
