// See-through windows (Window `backdrop`), checked on the real desktop (Windows only):
// a window of red and blue stripes sits behind each backdrop window, the screen is
// captured and the window's pixels are sorted into sharp stripes, blurred stripes and
// solid. `transparent` must show them sharp, `blur` and `acrylic` blurred (while
// Windows "Transparency effects" is on), `mica` not at all (it tints the wallpaper), and
// a light window background must give a lighter material than a dark one.
// TARVE_SMOKE_TOGGLE_TRANSPARENCY=1 turns "Transparency effects" on for the run (and
// back), checking the `transparencyEffects` event both ways.
import { createApp, readPngRgba, View, Window, type WindowBackdrop } from "@tarve/core";

type NativeEvent = { type: string; enabled?: boolean };
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const work = resolve("work/smoke-translucent");

if (process.argv[2] === "--child") {
  const [, , , backdrop, background, framed] = process.argv as [string, string, string, WindowBackdrop, string, string];
  const app = createApp(() => (
    <Window title={`Translucent smoke ${process.pid}`} width={360} height={240} position={{ x: 160, y: 160 }}
      frameless={framed !== "framed"} resizable={false} backdrop={backdrop} style={{ background }}>
      <View style={{ flex: 1 }} />
    </Window>
  ));
  app.onEvent(event => {
    if (event.type === "transparencyEffects") console.log(JSON.stringify(event));
  });
  await app.ready;
  await sleep(600);
  const snapshot = await app.inspect();
  console.log(JSON.stringify({ type: "ready", windowAlpha: snapshot.windowAlpha, transparencyEffects: snapshot.transparencyEffects }));
  await app.closed;
  process.exit(0);
}

if (process.platform !== "win32") {
  console.log("smoke:translucent checks the Windows desktop compositor; skipped on", process.platform);
  process.exit(0);
}
mkdirSync(work, { recursive: true });

const ps = (script: string) => {
  const path = resolve(work, `script-${Math.random().toString(36).slice(2)}.ps1`);
  writeFileSync(path, script);
  return Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path], { stdout: "pipe", stderr: "pipe" });
};
const run = async (script: string) => {
  const child = ps(script);
  const [out, err] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
  if ((await child.exited) !== 0) throw new Error(`powershell failed: ${err || out}`);
  return out.trim();
};
const win32 = `Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W {
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
 [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, int f, int e);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);
 public struct RECT { public int L, T, R, B; } public struct POINT { public int X, Y; }
}
"@
[W]::SetProcessDPIAware() | Out-Null
function Front($h) { [W]::keybd_event(0x12,0,0,0); [W]::SetForegroundWindow($h) | Out-Null; [W]::keybd_event(0x12,0,2,0) }
`;

// Horizontal stripes 20 px tall under the whole capture area, behind every test window.
const plate = ps(`$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$f=New-Object System.Windows.Forms.Form; $f.FormBorderStyle='None'; $f.StartPosition='Manual'; $f.ShowInTaskbar=$false
$f.Bounds=New-Object System.Drawing.Rectangle 0,0,1400,1000; $f.Text='tarve smoke plate'
# A small window clear of the capture area takes the focus to make a test window inactive.
$focus=New-Object System.Windows.Forms.Form; $focus.FormBorderStyle='None'; $focus.StartPosition='Manual'; $focus.ShowInTaskbar=$false
$focus.Bounds=New-Object System.Drawing.Rectangle 1500,0,60,60; $focus.BackColor='Gray'
$f.Add_Shown({ $focus.Show(); Set-Content -Path '${resolve(work, "plate.txt")}' -Value ([int64]$focus.Handle) })
$f.Add_Paint({ param($o,$e) for($y=0;$y -lt 1000;$y+=40){ $e.Graphics.FillRectangle([System.Drawing.Brushes]::Red,0,$y,1400,20); $e.Graphics.FillRectangle([System.Drawing.Brushes]::Blue,0,($y+20),1400,20) } })
[System.Windows.Forms.Application]::Run($f)`);
const plateFile = resolve(work, "plate.txt");
rmSync(plateFile, { force: true });
const plateHandle = async () => {
  for (let i = 0; i < 60; i++) {
    if (existsSync(plateFile)) return readFileSync(plateFile, "utf8").trim();
    if (plate.exitCode !== null) throw new Error(`the stripes window exited: ${await new Response(plate.stderr).text()}`);
    await sleep(250);
  }
  throw new Error("the stripes window did not open");
};

interface Shot { crisp: number; blurred: number; solid: number; luminance: number }
interface Child { pid: number; ready: { windowAlpha?: boolean; transparencyEffects?: boolean }; events: NativeEvent[]; close(): Promise<void> }

async function open(backdrop: WindowBackdrop, background: string, framed = false): Promise<Child> {
  const child = Bun.spawn([process.execPath, import.meta.path, "--child", backdrop, background, framed ? "framed" : "frameless"], { stdout: "pipe", stderr: "inherit" });
  const events: NativeEvent[] = [];
  let ready: Child["ready"] | undefined;
  const reader = child.stdout.getReader();
  let buffer = "";
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += new TextDecoder().decode(value);
      let line: number;
      while ((line = buffer.indexOf("\n")) >= 0) {
        const text = buffer.slice(0, line).trim();
        buffer = buffer.slice(line + 1);
        if (!text.startsWith("{")) continue;
        const message = JSON.parse(text);
        if (message.type === "ready") ready = message;
        else events.push(message);
      }
    }
  })();
  for (let i = 0; i < 100 && !ready; i++) await sleep(100);
  if (!ready) { child.kill(); throw new Error(`${backdrop} window did not start`); }
  return { pid: child.pid, ready, events, close: async () => { child.kill(); await child.exited; } };
}

async function shoot(child: Child, name: string, active = true): Promise<Shot> {
  const path = resolve(work, `${name}.png`);
  await run(`${win32}
$h=(Get-Process -Id ${child.pid}).MainWindowHandle
if(${active ? 1 : 0}){ Front $h } else { Front ([IntPtr]${await plateHandle()}); [W]::SetWindowPos([IntPtr]${await plateHandle()},[IntPtr]0,1500,0,60,60,0x10) | Out-Null }
Start-Sleep -Milliseconds 900
$r=New-Object W+RECT; [W]::GetClientRect($h,[ref]$r) | Out-Null; $p=New-Object W+POINT; [W]::ClientToScreen($h,[ref]$p) | Out-Null
Add-Type -AssemblyName System.Drawing
$bmp=New-Object System.Drawing.Bitmap $r.R,$r.B; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($p.X,$p.Y,0,0,$bmp.Size); $bmp.Save('${path}')`);
  const image = await readPngRgba(path);
  let crisp = 0, blurred = 0, solid = 0, luminance = 0;
  const inset = Math.round(image.width * 0.05);
  for (let y = inset; y < image.height - inset; y += 2) {
    for (let x = inset; x < image.width - inset; x += 2) {
      const i = (y * image.width + x) * 4;
      const [r, g, b] = [image.rgba[i]!, image.rgba[i + 1]!, image.rgba[i + 2]!];
      luminance += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if ((r > 150 && b < 80) || (b > 150 && r < 80)) crisp++;
      else if (r > 40 && b > 40 && g < Math.min(r, b) * 0.6) blurred++;
      else solid++;
    }
  }
  const total = crisp + blurred + solid;
  return { crisp: crisp / total, blurred: blurred / total, solid: solid / total, luminance: luminance / total };
}

const setting = async (on: boolean) => run(`${win32}
Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' -Name EnableTransparency -Value ${on ? 1 : 0} -Type DWord
$r=[UIntPtr]::Zero; [W]::SendMessageTimeout([IntPtr]0xffff,0x1A,[UIntPtr]::Zero,'ImmersiveColorSet',2,3000,[ref]$r) | Out-Null`);

const results: string[] = [];
const report = (name: string, shot: Shot) =>
  results.push(`${name.padEnd(26)} sharp ${(shot.crisp * 100).toFixed(0).padStart(3)}%  blurred ${(shot.blurred * 100).toFixed(0).padStart(3)}%  solid ${(shot.solid * 100).toFixed(0).padStart(3)}%  luminance ${shot.luminance.toFixed(0)}`);
let restore: boolean | undefined;
let passed = false;
try {
  await plateHandle();
  const probe = await open("acrylic", "#00000000");
  let effects = probe.ready.transparencyEffects !== false;
  if (process.env.TARVE_SMOKE_TOGGLE_TRANSPARENCY === "1") {
    restore = effects;
    await setting(!effects);
    for (let i = 0; i < 30 && !probe.events.length; i++) await sleep(100);
    assert.deepEqual(probe.events.at(-1), { type: "transparencyEffects", enabled: !effects }, "a settings change reaches JS as a transparencyEffects event");
    if (!effects) effects = true;
    else { await setting(true); for (let i = 0; i < 30 && probe.events.length < 2; i++) await sleep(100); assert.deepEqual(probe.events.at(-1), { type: "transparencyEffects", enabled: true }); }
    results.push("transparencyEffects event fires on the settings change");
  }
  await probe.close();

  const check = async (backdrop: WindowBackdrop, background: string, framed = false, active = true) => {
    const child = await open(backdrop, background, framed);
    try {
      assert.equal(child.ready.windowAlpha, true, `${backdrop}: the window composes alpha`);
      const name = `${backdrop}${framed ? "-framed" : ""}${background.startsWith("#ff") ? "-light" : ""}${active ? "" : "-inactive"}`;
      const shot = await shoot(child, name, active);
      report(name, shot);
      return shot;
    } finally { await child.close(); }
  };
  for (const framed of [false, true]) {
    const transparent = await check("transparent", "#00000000", framed);
    assert.ok(transparent.crisp > 0.6, `transparent${framed ? " (framed)" : ""} shows the stripes sharp`);
    for (const backdrop of ["blur", "acrylic"] as const) {
      const shot = await check(backdrop, "#00000000", framed);
      if (effects) assert.ok(shot.blurred > 0.6 && shot.crisp < 0.05, `${backdrop}${framed ? " (framed)" : ""} shows the stripes blurred`);
      else assert.ok(shot.crisp < 0.05 && shot.blurred < 0.1, `${backdrop} is solid while transparency effects are off`);
    }
    const mica = await check("mica", "#00000000", framed);
    assert.ok(mica.crisp < 0.05 && mica.blurred < 0.3, "mica shows the wallpaper, not the windows behind");
  }
  if (effects) {
    const blur = await check("blur", "#00000000", false, false);
    assert.ok(blur.blurred > 0.6, "blur stays blurred while the window is inactive");
    const acrylic = await check("acrylic", "#00000000", false, false);
    assert.ok(acrylic.crisp < 0.05, "an inactive acrylic window shows no sharp stripes");
    const dark = await check("mica", "#00000000");
    const light = await check("mica", "#ffffff00");
    assert.ok(light.luminance > dark.luminance + 40, `a light window background gives a light material (${light.luminance.toFixed(0)} vs ${dark.luminance.toFixed(0)})`);
  } else {
    results.push("Transparency effects are off: blur/acrylic checked solid; run with TARVE_SMOKE_TOGGLE_TRANSPARENCY=1 for the full check");
  }
  passed = true;
} finally {
  console.log(results.join("\n"));
  if (passed) console.log("smoke:translucent passed");
  if (restore !== undefined) await setting(restore).catch(() => {});
  plate.kill();
}
process.exit(0);
