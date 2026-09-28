import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Column, Input, Window, createApp, type PastePayload } from "@tarve/core";

// Real-window editor smoke: native undo/redo, submit, file paste and the caret's
// zero-idle policy. On Windows keystrokes are injected through the OS
// (SendKeys) so the real winit shortcut path runs; elsewhere, or with
// TARVE_SMOKE_OS_INPUT=0, the debug input channel drives the same tree actions.
const TITLE = "Tarve Editor Smoke";
const osInput = process.platform === "win32" && process.env.TARVE_SMOKE_OS_INPUT !== "0";
let value = "";
const submitted: string[] = [];
const pasted: PastePayload[] = [];
const errors: string[] = [];

const app = createApp(() => (
  <Window title={TITLE} width={480} height={200}>
    <Column padding={24}>
      <Input
        id="field"
        value={value}
        onChange={next => { value = next; app.update(); }}
        onSubmit={next => submitted.push(next)}
        onPaste={payload => pasted.push(payload)}
      />
    </Column>
  </Window>
), { debug: true });
app.onEvent(event => { if (event.type === "error") errors.push(event.message); });

async function powershell(script: string): Promise<void> {
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe" });
  const code = await child.exited;
  assert.equal(code, 0, `powershell failed (${code}): ${await new Response(child.stderr).text()}`);
}
async function send(keys: string, fallback: () => void): Promise<void> {
  if (osInput) {
    await powershell(`Add-Type -AssemblyName System.Windows.Forms; $s = New-Object -ComObject WScript.Shell; if (-not $s.AppActivate('${TITLE}')) { exit 3 }; Start-Sleep -Milliseconds 150; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`);
  } else {
    fallback();
  }
  await Bun.sleep(250);
}
const key = (name: string) => () => app.debug({ type: "input", action: "key", text: name });
const text = (value: string) => () => app.debug({ type: "input", action: "text", text: value });

try {
  await app.ready;
  app.focus("field");
  await Bun.sleep(200);

  await send("hello", text("hello"));
  assert.equal(value, "hello", "typing reaches the controlled value");
  await send("^z", key("Undo"));
  assert.equal(value, "", "Ctrl+Z undoes the coalesced typing run");
  await send("^y", key("Redo"));
  assert.equal(value, "hello", "Ctrl+Y redoes");
  await send("{ENTER}", key("Enter"));
  assert.deepEqual(submitted, ["hello"], "Enter submits the input value");

  if (osInput) {
    await mkdir(resolve("work"), { recursive: true });
    const file = resolve("work/editor-smoke-paste.txt");
    await writeFile(file, "paste me");
    await powershell(`Set-Clipboard -Path '${file}'`);
    await send("^v", () => {});
    const files = pasted.find(item => item.kind === "files");
    assert(files && files.kind === "files" && files.files.some(path => path.toLowerCase() === file.toLowerCase()),
      `file paste reaches onPaste: ${JSON.stringify(pasted)}`);
    assert.equal(value, "hello", "file paste leaves the text untouched");
  }

  // Caret blink stops once the field is idle, so the window stops producing frames.
  await Bun.sleep(10_800);
  const before = (await app.inspect()).frames;
  await Bun.sleep(1_500);
  const after = (await app.inspect()).frames;
  assert.equal(after, before, `idle focused input must not keep presenting frames (${before} -> ${after})`);
  assert.deepEqual(errors, []);
  console.log(`[tarve smoke:editor] PASS (${osInput ? "os input" : "debug input"})`);
} finally {
  app.close();
  await app.closed;
}
