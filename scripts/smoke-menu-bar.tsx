// Menu bars. Native (`{ native: true }`, Windows): a framed window gets a Win32 menu
// with the items' labels and accelerators; the keyboard (Alt, access keys) picks an
// item, which runs its onSelect and reaches onEvent; the accelerator runs it without the
// menu; the bar can be replaced and removed; a frameless window reports an error.
// Drawn (the default): the bar is in the window's tree, opens with the pointer, F10,
// Alt+<key> and arrows, and an editing chord in a text field stays with the field.
import { createApp, Input, Text, Window } from "@tarve/core";
import { strict as assert } from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";

if (process.platform !== "win32") {
  console.log("smoke:menu-bar checks the Win32 menu bar; skipped on", process.platform);
  process.exit(0);
}
const selected: string[] = [];
const events: string[] = [];
const errors: string[] = [];
const app = createApp(() => <Window title="Menu bar smoke" width={420} height={240}><Text>menu</Text></Window>, { onError: event => errors.push(event.error.message) });
await app.ready;
app.onEvent(event => { if (event.type === "menu") events.push(event.id); });
app.menuBar([
  { label: "&File", items: [
    { id: "new", label: "&New", onSelect: () => selected.push("new") },
    { type: "separator" },
    { id: "save", label: "&Save", accelerator: "Ctrl+S", onSelect: () => selected.push("save") },
  ] },
  { label: "&View", items: [{ id: "dark", label: "&Dark", checked: true, onSelect: () => selected.push("dark") }, { id: "off", label: "Off", disabled: true }] },
], { native: true });
await sleep(300);

const ps = (body: string) => new Response(Bun.spawn(["powershell.exe", "-NoProfile", "-Command", `Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class M {
 [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr h); [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr m);
 [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr m, int i); [DllImport("user32.dll")] public static extern uint GetMenuState(IntPtr m, uint i, uint f);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetMenuString(IntPtr m, uint i, StringBuilder s, int n, uint f);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, int f, int e);
 public static string Text(IntPtr m, uint i) { var s = new StringBuilder(256); GetMenuString(m, i, s, 256, 0x400); return s.ToString(); }
 public static void Key(byte k) { keybd_event(k, 0, 0, 0); System.Threading.Thread.Sleep(40); keybd_event(k, 0, 2, 0); System.Threading.Thread.Sleep(120); }
}
"@
$h=(Get-Process -Id ${process.pid}).MainWindowHandle; $m=[M]::GetMenu($h)
${body}`], { stdout: "pipe" }).stdout).text().then(text => text.trim());

const shape = await ps(`$f=[M]::GetSubMenu($m,0); $v=[M]::GetSubMenu($m,1)
"$([M]::GetMenuItemCount($m))|$([M]::Text($m,0))|$([M]::Text($f,2))|$([M]::GetMenuState($v,0,0x400) -band 8)|$([M]::GetMenuState($v,1,0x400) -band 1)"`);
assert.equal(shape, "2|&File|&Save\tCtrl+S|8|1", `the Win32 menu holds the items (${shape})`);

const focus = `[M]::keybd_event(0x12,0,0,0); [M]::SetForegroundWindow($h) | Out-Null; [M]::keybd_event(0x12,0,2,0); Start-Sleep -Milliseconds 300; [M]::Key(0x1B); Start-Sleep -Milliseconds 200`;
await ps(`${focus}; [M]::Key(0x12); Start-Sleep -Milliseconds 200; [M]::Key(0x46); Start-Sleep -Milliseconds 200; [M]::Key(0x4E)`);
for (let i = 0; i < 40 && !selected.length; i++) await sleep(50);
assert.deepEqual(selected, ["new"], "Alt, F, N picks File > New");
assert.deepEqual(events, ["new"], "onEvent sees the menu event");

await ps(`${focus}; [M]::keybd_event(0x11,0,0,0); Start-Sleep -Milliseconds 40; [M]::Key(0x53); [M]::keybd_event(0x11,0,2,0)`);
for (let i = 0; i < 40 && selected.length < 2; i++) await sleep(50);
assert.deepEqual(selected, ["new", "save"], "Ctrl+S runs Save through its accelerator");

app.menuBar([{ id: "only", label: "Only", onSelect: () => selected.push("only") }], { native: true });
await sleep(200);
assert.equal(await ps(`"$([M]::GetMenuItemCount($m))|$([M]::Text($m,0))"`), "1|Only", "a new bar replaces the old one");
app.menuBar(null, { native: true });
await sleep(200);
assert.equal(await ps(`"$([int64]$m)"`), "0", "null removes the bar");
assert.equal(errors.length, 0, errors.join("; "));

const frameless = app.openWindow(() => <Window title="Frameless menu" frameless width={200} height={120}><Text>x</Text></Window>, { onError: event => errors.push(event.error.message) });
await frameless.ready;
frameless.menuBar([{ id: "x", label: "X" }], { native: true });
for (let i = 0; i < 40 && !errors.length; i++) await sleep(50);
assert.match(errors[0] ?? "", /frameless/, "a frameless window reports that it has no menu bar");
frameless.close();
await frameless.closed;

// The drawn bar, in a window of its own with a text field.
let copied = 0;
const drawnSelected: string[] = [];
const drawn = app.openWindow(() => (
  <Window title="Drawn menu smoke" width={420} height={260}>
    <Input id="field" value="hello" />
  </Window>
), { id: "drawn", debug: true });
await drawn.ready;
drawn.menuBar([
  { label: "&File", items: [
    { id: "open", label: "&Open", onSelect: () => drawnSelected.push("open") },
    { id: "copy", label: "&Copy", accelerator: "Ctrl+C", onSelect: () => { copied++; } },
  ] },
  { label: "&View", items: [{ id: "zoom", label: "&Zoom", onSelect: () => drawnSelected.push("zoom") }] },
]);
await sleep(300);
const nodes = async () => (await drawn.inspect()).nodes.map(node => node.id);
assert.ok((await nodes()).includes("tarve-menubar-menu-0"), "the drawn bar is in the window");
const click = async (id: string) => {
  const box = drawn.layout([id])?.[id];
  assert.ok(box, `${id} is laid out`);
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  drawn.debug({ type: "input", action: "move", ...at });
  drawn.debug({ type: "input", action: "down", ...at } as never);
  drawn.debug({ type: "input", action: "up", ...at } as never);
  await sleep(250);
};
await click("tarve-menubar-menu-1");
assert.ok((await nodes()).includes("tarve-menubar-item-1-0"), "a click opens the View menu");
await click("tarve-menubar-item-1-0");
assert.deepEqual(drawnSelected, ["zoom"], "a click on an item runs it");
assert.ok(!(await nodes()).includes("tarve-menubar-item-1-0"), "choosing closes the menu");

const drawnPs = (body: string) => new Response(Bun.spawn(["powershell.exe", "-NoProfile", "-Command", `Add-Type @"
using System; using System.Runtime.InteropServices;
public static class K { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, int f, int e);
 public static void Key(byte k) { keybd_event(k, 0, 0, 0); System.Threading.Thread.Sleep(40); keybd_event(k, 0, 2, 0); System.Threading.Thread.Sleep(150); } }
"@
$h=(Get-Process -Id ${process.pid} | % { $_ }).MainWindowHandle
$w=[IntPtr]::Zero; Add-Type '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);' -Name F -Namespace Z; $w=[Z.F]::FindWindow($null,'Drawn menu smoke')
[K]::keybd_event(0x12,0,0,0); [K]::SetForegroundWindow($w) | Out-Null; [K]::keybd_event(0x12,0,2,0); Start-Sleep -Milliseconds 300
${body}`], { stdout: "pipe" }).stdout).text();
await drawnPs("[K]::keybd_event(0x12,0,0,0); Start-Sleep -Milliseconds 40; [K]::Key(0x46); [K]::keybd_event(0x12,0,2,0); Start-Sleep -Milliseconds 300");
await drawnPs("[K]::Key(0x0D)");
for (let i = 0; i < 40 && drawnSelected.length < 2; i++) await sleep(50);
assert.deepEqual(drawnSelected, ["zoom", "open"], "Alt+F opens File with its first item focused; Enter runs it");
await drawnPs("[K]::Key(0x79); [K]::Key(0x27); [K]::Key(0x28); Start-Sleep -Milliseconds 300; [K]::Key(0x0D)");
for (let i = 0; i < 40 && drawnSelected.length < 3; i++) await sleep(50);
assert.deepEqual(drawnSelected, ["zoom", "open", "zoom"], "F10, Right and Down reach View > Zoom");
await drawnPs("[K]::keybd_event(0x12,0,0,0); Start-Sleep -Milliseconds 40; [K]::Key(0x46); [K]::keybd_event(0x12,0,2,0); Start-Sleep -Milliseconds 300; [K]::Key(0x27); Start-Sleep -Milliseconds 300");
assert.equal((await drawn.inspect()).focused, "tarve-menubar-item-1-0", "Right in an open menu moves to the next menu");
await drawnPs("[K]::Key(0x1B)");
await sleep(300);
assert.ok(!(await nodes()).includes("tarve-menubar-item-1-0"), "Escape closes the menu");
await drawnPs("[K]::keybd_event(0x11,0,0,0); Start-Sleep -Milliseconds 40; [K]::Key(0x43); [K]::keybd_event(0x11,0,2,0)");
await sleep(300);
assert.equal(copied, 1, "Ctrl+C runs the Copy accelerator outside a text field");
drawn.focus("field");
await sleep(200);
await drawnPs("[K]::keybd_event(0x11,0,0,0); Start-Sleep -Milliseconds 40; [K]::Key(0x43); [K]::keybd_event(0x11,0,2,0)");
await sleep(300);
assert.equal(copied, 1, "Ctrl+C in a text field copies instead of running the accelerator");
drawn.close();
await drawn.closed;
app.close();
await app.closed;
console.log("smoke:menu-bar passed");
process.exit(0);
