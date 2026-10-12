// createApp({ icon }) sets the window's title-bar and taskbar icons (WM_GETICON
// ICON_SMALL / ICON_BIG) and package.json-style metadata names the app. Windows only.
import { createApp, Text, Window } from "@tarve/core";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePng } from "../packages/core/src/png";

if (process.platform !== "win32") {
  console.log("[tarve smoke:app-icon] SKIP (Windows only)");
  process.exit(0);
}
const directory = mkdtempSync(join(tmpdir(), "tarve-app-icon-"));
const icon = join(directory, "icon.png");
writeFileSync(icon, encodePng(new Uint8Array(128 * 128 * 4).map((_, i) => (i % 4 === 1 ? 0 : 220)), 128, 128));
const title = `tarve-icon-smoke-${process.pid}`;
const app = createApp(() => <Window title={title} width={240} height={120}><Text>Icon</Text></Window>, { icon, headless: true });
try {
  await app.ready;
  await app.inspect();
  const script = `
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
}
'@
$h = [W]::FindWindow([NullString]::Value, '${title}')
$out = @{ found = ($h -ne [IntPtr]::Zero) }
foreach ($kind in @(@('small', 0), @('big', 1))) {
  $i = [W]::SendMessage($h, 0x7F, [IntPtr]$kind[1], [IntPtr]::Zero)
  if ($i -ne [IntPtr]::Zero) {
    $b = [System.Drawing.Icon]::FromHandle($i).ToBitmap()
    $c = $b.GetPixel([int]($b.Width / 2), [int]($b.Height / 2))
    $out[$kind[0]] = @($b.Width, $c.R, $c.G, $c.B)
  }
}
$out | ConvertTo-Json -Compress`;
  let probe = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe" });
  let result = JSON.parse(probe.stdout.toString() || "{}") as { found?: boolean; small?: number[]; big?: number[] };
  for (let attempt = 0; attempt < 10 && !result.found; attempt++) {
    await Bun.sleep(300);
    probe = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe" });
    result = JSON.parse(probe.stdout.toString() || "{}");
  }
  assert.ok(result.found, `window not found: ${probe.stderr.toString()}`);
  for (const kind of ["small", "big"] as const) {
    const sample = result[kind];
    assert.ok(sample, `no ${kind} window icon`);
    assert.ok([220, 0, 220].every((value, index) => Math.abs(sample[index + 1]! - value) <= 3), `${kind} icon is not the app icon: ${sample}`);
  }
  console.log(`[tarve smoke:app-icon] PASS ${JSON.stringify(result)}`);
} finally {
  app.close();
  rmSync(directory, { recursive: true, force: true });
}
