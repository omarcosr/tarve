// Remembered window state: an app with `rememberWindow` is moved, resized and closed,
// then reopens with those bounds; maximized reopens maximized and restores to its
// bounds; a saved position off every monitor reopens centred. Windows (Win32 moves).
import { createApp, Text, Window } from "@tarve/core";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

if (process.argv[2] === "--child") {
  const app = createApp(() => <Window title="Window state smoke" width={420} height={260} minWidth={300} minHeight={200}><Text>state</Text></Window>, { rememberWindow: true });
  await app.ready;
  const s = await app.inspect();
  console.log(JSON.stringify({ type: "ready", width: s.width, height: s.height, scale: s.scale }));
  for await (const line of console) if (line.trim() === "close") break;
  app.close();
  await app.closed;
  process.exit(0);
}
if (process.platform !== "win32") {
  console.log("smoke:window-state moves windows through Win32; skipped on", process.platform);
  process.exit(0);
}

const config = mkdtempSync(join(tmpdir(), "tarve-window-state-"));
const env = { ...process.env, APPDATA: config, TARVE_APP_METADATA: JSON.stringify({ appId: "window-state-smoke" }) };
const statePath = join(config, "window-state-smoke", "window-state.json");
const win32 = (pid: number, action: string) => new Response(Bun.spawn(["powershell.exe", "-NoProfile", "-Command", `Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
 [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h); public struct R { public int L, T, Rt, B; } }
"@
[W]::SetProcessDPIAware() | Out-Null
$h=(Get-Process -Id ${pid}).MainWindowHandle; ${action}
$r=New-Object W+R; [W]::GetWindowRect($h,[ref]$r) | Out-Null; "$($r.L) $($r.T) $($r.Rt-$r.L) $($r.B-$r.T) $([W]::IsZoomed($h))"`], { stdout: "pipe" }).stdout).text();

async function open() {
  const child = Bun.spawn([process.execPath, import.meta.path, "--child"], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env });
  const reader = child.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("the app did not start");
    text += new TextDecoder().decode(value);
  }
  const ready = JSON.parse(text.slice(0, text.indexOf("\n"))) as { width: number; height: number; scale: number };
  return {
    ready,
    rect: async (action = "") => { const [x, y, w, h, zoomed] = (await win32(child.pid, action)).trim().split(" "); return { x: Number(x), y: Number(y), w: Number(w), h: Number(h), zoomed: zoomed === "True" }; },
    close: async () => { child.stdin.write("close\n"); child.stdin.end(); await child.exited; },
  };
}

const first = await open();
assert.deepEqual([first.ready.width, first.ready.height], [420, 260], "the first run opens at the default size");
const moved = await first.rect("[W]::SetWindowPos($h,[IntPtr]0,150,140,700,500,0x14) | Out-Null; Start-Sleep -Milliseconds 300");
await sleep(200);
await first.close();
const saved = JSON.parse(readFileSync(statePath, "utf8")).main;
assert.equal(saved.maximized, false);

const second = await open();
const reopened = await second.rect();
assert.deepEqual([reopened.x, reopened.y, reopened.w, reopened.h], [moved.x, moved.y, moved.w, moved.h], "the window reopens where and as large as it was left");
assert.ok(Math.abs(second.ready.width - saved.width) < 1 && Math.abs(second.ready.height - saved.height) < 1, "the client size is the saved one");
await second.rect("[W]::ShowWindow($h,3) | Out-Null; Start-Sleep -Milliseconds 400");
await sleep(200);
await second.close();
assert.equal(JSON.parse(readFileSync(statePath, "utf8")).main.maximized, true, "maximized is saved");

const third = await open();
const zoomed = await third.rect();
assert.ok(zoomed.zoomed, "the window reopens maximized");
const restored = await third.rect("[W]::ShowWindow($h,9) | Out-Null; Start-Sleep -Milliseconds 400");
assert.deepEqual([restored.x, restored.y, restored.w, restored.h], [moved.x, moved.y, moved.w, moved.h], "restoring goes back to the saved bounds");
await third.close();

const state = JSON.parse(readFileSync(statePath, "utf8"));
writeFileSync(statePath, JSON.stringify({ main: { ...state.main, x: -30000, y: -30000, maximized: false } }));
const fourth = await open();
const centred = await fourth.rect();
assert.ok(centred.x > -1000 && centred.y > -1000, `a position off every monitor reopens on screen (${centred.x}, ${centred.y})`);
await fourth.close();
console.log("smoke:window-state passed");
process.exit(0);
