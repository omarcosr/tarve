// Drives a real tray icon end to end: Windows posts the shell callback messages
// and keyboard input to the native popup menu; Linux calls the StatusNotifierItem
// and dbusmenu methods over the session bus, exactly as a panel host does.
// Linux: run under `dbus-run-session` with TARVE_TRAY_ASSUME_SNI=1 when no tray host is present.
import { Text, Window, createApp } from "@tarve/core";
import { strict as assert } from "node:assert";

const errors: string[] = [];
const seen: string[] = [];
const app = createApp(() => <Window title="tray smoke"><Text>tray</Text></Window>, {
  headless: true,
  onError: event => errors.push(event.error.message),
});
app.onEvent(event => { if (event.type === "error") errors.push(event.message); });
await app.ready;

const tray = app.tray({
  icon: new URL("../website/public/previews/Icon.png", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  tooltip: "Tarve smoke",
  onClick: () => seen.push("click"),
  onDoubleClick: () => seen.push("secondary"),
  onMenu: id => seen.push(`menu:${id}`),
  menu: [
    { id: "open", label: "Open" },
    { type: "separator" },
    { id: "more", label: "More", items: [{ id: "mute", label: "Mute", checked: false }] },
    { id: "quit", label: "Quit" },
  ],
});

async function until(label: string, predicate: () => boolean, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (errors.length) throw new Error(`${label}: ${errors.join(" | ")}`);
    if (Date.now() > end) throw new Error(`${label}: timed out; seen ${JSON.stringify(seen)}`);
    await Bun.sleep(20);
  }
}

if (process.platform === "win32") {
  const { dlopen, FFIType } = await import("bun:ffi");
  const user32 = dlopen("user32.dll", {
    FindWindowW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    PostMessageW: { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i32 },
    keybd_event: { args: [FFIType.u8, FFIType.u8, FFIType.u32, FFIType.u64], returns: FFIType.void },
  });
  const wide = (text: string) => Buffer.from(text + "\0", "utf16le");
  let hwnd = null as ReturnType<typeof user32.symbols.FindWindowW>;
  await until("tray window", () => (hwnd = user32.symbols.FindWindowW(wide("TarveTrayWindow"), null)) !== null);
  const CALLBACK = 0x8000 + 0x7a1;
  const post = (message: number) => assert.ok(user32.symbols.PostMessageW(hwnd, CALLBACK, 0, message));
  post(0x0202);
  await until("click", () => seen.includes("click"));
  post(0x0203);
  await until("double click", () => seen.includes("secondary"));
  // The menu runs a modal loop on the event-loop thread. Keystrokes go straight to
  // the popup menu window (class #32768): synthetic global input would need the
  // foreground lock that the shell grants a real tray click.
  const choose = async (keys: number[]) => {
    post(0x0205);
    let menu = null as ReturnType<typeof user32.symbols.FindWindowW>;
    await until("popup menu", () => (menu = user32.symbols.FindWindowW(wide("#32768"), null)) !== null);
    for (const vk of keys) assert.ok(user32.symbols.PostMessageW(menu, 0x0100, vk, 0));
  };
  await choose([0x28, 0x0d]);
  await until("menu item", () => seen.includes("menu:open"));
  await choose([0x26, 0x0d]);
  await until("last menu item", () => seen.includes("menu:quit"));
  // The balloon itself is shell UI; this checks the shell accepted it.
  app.notify({ title: "Tarve smoke", body: "notification" });
  await choose([0x1b]);
  await Bun.sleep(200);
  assert.ok(user32.symbols.FindWindowW(wide("#32768"), null) === null, "Escape dismisses the menu");
} else if (process.platform === "linux") {
  const gdbus = async (...args: string[]) => {
    const at = args.indexOf("--method") + 2;
    // "--" keeps negative method arguments such as -1 from parsing as options.
    const argv = [...args.slice(0, at), "--", ...args.slice(at)];
    const child = Bun.spawn(["gdbus", "call", "--session", ...argv], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = [await new Response(child.stdout).text(), await new Response(child.stderr).text(), await child.exited];
    if (code !== 0) throw new Error(`gdbus ${args.join(" ")}: ${err}`);
    return out;
  };
  let name = "";
  for (let i = 0; i < 100 && !name; i++) {
    const names = await gdbus("--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.ListNames");
    name = names.match(/'(org\.kde\.StatusNotifierItem-[^']+)'/)?.[1] ?? "";
    if (!name) await Bun.sleep(50);
  }
  assert.ok(name, "the tray registered a StatusNotifierItem bus name");
  const title = await gdbus("--dest", name, "--object-path", "/StatusNotifierItem", "--method", "org.freedesktop.DBus.Properties.Get", "org.kde.StatusNotifierItem", "Title");
  assert.match(title, /Tarve smoke/);
  const pixmap = await gdbus("--dest", name, "--object-path", "/StatusNotifierItem", "--method", "org.freedesktop.DBus.Properties.Get", "org.kde.StatusNotifierItem", "IconPixmap");
  assert.match(pixmap, /\(16, 16,/, "the icon is published as pixmaps");
  await gdbus("--dest", name, "--object-path", "/StatusNotifierItem", "--method", "org.kde.StatusNotifierItem.Activate", "0", "0");
  await until("activate", () => seen.includes("click"));
  const layout = await gdbus("--dest", name, "--object-path", "/MenuBar", "--method", "com.canonical.dbusmenu.GetLayout", "0", "-1", "[]");
  const idOf = (label: string) => Number(layout.match(new RegExp(`\\((\\d+), \\{[^}]*'label': <'${label}'>`))?.[1]);
  for (const [label, expected] of [["Open", "menu:open"], ["Mute", "menu:mute"]] as const) {
    const id = idOf(label);
    assert.ok(Number.isInteger(id), `menu layout has ${label}: ${layout}`);
    await gdbus("--dest", name, "--object-path", "/MenuBar", "--method", "com.canonical.dbusmenu.Event", String(id), "clicked", "<0>", "0");
    await until(label, () => seen.includes(expected));
  }
  if (process.env.TARVE_SMOKE_NOTIFY === "1") {
    // Needs a notification server; CI starts scripts/fake-notification-server.py.
    app.notify({ title: "Tarve smoke", body: "notification", onClick: () => seen.push("notificationClick") });
    await until("notification click", () => seen.includes("notificationClick"));
  }
  tray.update({ tooltip: "Tarve smoke 2" });
  await Bun.sleep(300);
  const updated = await gdbus("--dest", name, "--object-path", "/StatusNotifierItem", "--method", "org.freedesktop.DBus.Properties.Get", "org.kde.StatusNotifierItem", "Title");
  assert.match(updated, /Tarve smoke 2/);
}

app.hide();
app.show();
app.minimize();
tray.remove();
await Bun.sleep(150);
app.close();
await app.closed;
assert.deepEqual(errors, []);
console.log(`tray smoke OK (${process.platform}): ${seen.join(", ")}`);
