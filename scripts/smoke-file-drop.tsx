// Files dragged in from the system: a real OLE drag (a WinForms drag source driven
// by synthetic mouse input, as Explorer would start it) carries two files into the
// window, over one zone and onto another. The zones must see enter/leave and the
// drop with both paths. Windows only.
import { Column, createApp, Row, Text, View, Window } from "@tarve/core";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

if (process.platform !== "win32") {
  console.log("smoke:file-drop drives an OLE drag on Windows; skipped on", process.platform);
  process.exit(0);
}
const work = resolve("work/smoke-file-drop");
mkdirSync(work, { recursive: true });
const files = [resolve(work, "first.txt"), resolve(work, "second.png")];
for (const file of files) writeFileSync(file, "tarve");

const log: string[] = [];
let dropped: { paths: string[]; x: number; y: number } | undefined;
const app = createApp(() => (
  <Window title="File drop smoke" width={400} height={240} position={{ x: 200, y: 200 }} resizable={false}>
    <Row style={{ flex: 1, padding: 20, gap: 20 }}>
      <View id="left" style={{ flex: 1, background: "#e0e7ff" }} onFileDragEnter={() => log.push("enter left")} onFileDragLeave={() => log.push("leave left")}
        onFileDrop={() => log.push("drop left")}><Text>left</Text></View>
      <View id="right" style={{ flex: 1, background: "#dcfce7" }} onFileDragEnter={paths => log.push(`enter right ${paths.length}`)} onFileDragLeave={() => log.push("leave right")}
        onFileDrop={event => { dropped = event; log.push("drop right"); }}><Column><Text>right</Text></Column></View>
    </Row>
  </Window>
), { debug: true });
await app.ready;
const left = app.layout(["left", "right"])!;
const snapshot = await app.inspect();
const scale = snapshot.scale;

// Screen pixels of the client area: the window sits at 200,200 logical (its outer frame).
const client = await new Response(Bun.spawn(["powershell.exe", "-NoProfile", "-Command", `Add-Type @"
using System; using System.Runtime.InteropServices;
public static class C { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref P p); public struct P { public int X, Y; } }
"@
[C]::SetProcessDPIAware() | Out-Null
$h=(Get-Process -Id ${process.pid}).MainWindowHandle; $p=New-Object C+P; [C]::ClientToScreen($h,[ref]$p) | Out-Null; "$($p.X) $($p.Y)"`], { stdout: "pipe" }).stdout).text();
const [cx, cy] = client.trim().split(" ").map(Number) as [number, number];
const screen = (id: "left" | "right") => {
  const box = left[id]!;
  return [Math.round(cx + (box.x + box.width / 2) * scale), Math.round(cy + (box.y + box.height / 2) * scale)];
};
const [lx, ly] = screen("left");
const [rx, ry] = screen("right");

const source = resolve(work, "drag.ps1");
writeFileSync(source, `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing @"
using System; using System.Threading; using System.Runtime.InteropServices; using System.Windows.Forms;
public static class Drag {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(int f, int dx, int dy, int d, int e);
  static void Glide(int x0, int y0, int x1, int y1) { for (int i = 1; i <= 15; i++) { SetCursorPos(x0 + (x1 - x0) * i / 15, y0 + (y1 - y0) * i / 15); mouse_event(1, 0, 0, 0, 0); Thread.Sleep(25); } }
  public static void Run(string[] files, int lx, int ly, int rx, int ry) {
    SetProcessDPIAware();
    var form = new Form { FormBorderStyle = FormBorderStyle.None, StartPosition = FormStartPosition.Manual, Bounds = new System.Drawing.Rectangle(900, 600, 80, 80), TopMost = true, ShowInTaskbar = false };
    form.MouseDown += (s, e) => { var data = new DataObject(DataFormats.FileDrop, files); form.DoDragDrop(data, DragDropEffects.Copy); form.Close(); };
    form.Shown += (s, e) => new Thread(() => {
      Thread.Sleep(400); SetCursorPos(940, 640); Thread.Sleep(100); mouse_event(2, 0, 0, 0, 0); Thread.Sleep(150);
      Glide(940, 640, 940, 600); Glide(940, 600, lx, ly); Thread.Sleep(400); Glide(lx, ly, rx, ry); Thread.Sleep(400);
      mouse_event(4, 0, 0, 0, 0);
    }) { IsBackground = true }.Start();
    Application.Run(form);
  }
}
"@
[Drag]::Run(@(${files.map(file => `'${file}'`).join(",")}), ${lx}, ${ly}, ${rx}, ${ry})`);
const drag = Bun.spawn(["powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", source], { stdout: "pipe", stderr: "pipe" });
const timeout = setTimeout(() => { drag.kill(); console.error("smoke:file-drop timed out", log); process.exit(1); }, 20_000);
await drag.exited;
for (let i = 0; i < 20 && !dropped; i++) await sleep(50);
clearTimeout(timeout);
const errors = await new Response(drag.stderr).text();
assert.ok(!errors.trim(), `drag source failed: ${errors}`);
console.log(log.join(", "));
assert.deepEqual(log, ["enter left", "leave left", "enter right 2", "drop right"], "the drag crosses the left zone and drops on the right one");
assert.deepEqual(dropped?.paths, files, "the drop carries both files");
const right = left.right!;
assert.ok(dropped!.x >= right.x && dropped!.x <= right.x + right.width, `the drop is at the pointer (${dropped!.x})`);
app.close();
await app.closed;
console.log("smoke:file-drop passed");
process.exit(0);
