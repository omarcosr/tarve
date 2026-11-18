// Runs under Bun, as a Node.js executable and as a txiki.js executable (smoke-message-window.ts):
// messageWindow delivering posted and sent messages, copied lParam data and folder changes, the
// same answers everywhere, and the process exiting on its own once the window is disposed.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageWindow, type MessageWindowEvent } from "../packages/core/src/message-window";
import { openPluginLibrary } from "../packages/core/src/plugins/ffi";

const results: Record<string, unknown> = {};
const until = async (done: () => boolean) => {
  for (let tries = 0; tries < 300 && !done(); tries++) await new Promise(resolve => setTimeout(resolve, 10));
};
const show = (event: MessageWindowEvent) => JSON.parse(JSON.stringify(event, (_, value) => typeof value === "bigint" ? `${value}n` : value instanceof Uint8Array ? [...value] : value));

if (process.platform !== "win32") {
  try {
    messageWindow({ onMessage() {} });
  } catch (error) {
    results["unsupported"] = (error as Error).name;
  }
} else {
  const user32 = openPluginLibrary("user32.dll", {
    PostMessageW: { args: ["ptr", "u32", "u64", "i64"], returns: "i32" },
    SendMessageW: { args: ["ptr", "u32", "u64", "i64"], returns: "i64" },
    FindWindowExW: { args: ["ptr", "ptr", "buffer", "ptr"], returns: "ptr" },
  });
  // SendMessageW again, its lParam a buffer's address.
  const sendText = openPluginLibrary("user32.dll", {
    SendMessageW: { args: ["ptr", "u32", "u64", "buffer"], returns: "i64" },
  }).symbols.SendMessageW;
  const WM_APP = 0x8000, WM_SETTINGCHANGE = 0x1a;
  const folder = mkdtempSync(join(tmpdir(), "tarve-message-window-"));
  const events: MessageWindowEvent[] = [];
  const window = messageWindow({
    messages: [WM_APP + 1, WM_SETTINGCHANGE, "TarveMessageWindowSmoke"],
    replies: { [WM_APP + 2]: 41 },
    folders: [{ path: folder }],
    onMessage(event) { events.push(event); },
  });
  user32.symbols.PostMessageW(window.hwnd, WM_APP + 1, 7, -1);
  user32.symbols.PostMessageW(window.hwnd, window.messageIds.TarveMessageWindowSmoke!, 8, 9);
  await until(() => events.length >= 2);
  results["table reply"] = Number(user32.symbols.SendMessageW(window.hwnd, WM_APP + 2, 0, 0));
  const text = new Uint8Array(new Uint16Array([..."ImmersiveColorSet"].map(char => char.charCodeAt(0)).concat(0)).buffer);
  sendText(window.hwnd, WM_SETTINGCHANGE, 0, text);
  await until(() => events.filter(event => event.type === "message").length >= 3);
  writeFileSync(join(folder, "changed.txt"), "x");
  await until(() => events.some(event => event.type === "folder"));
  // In arrival order; the registered id and the string's address differ per run.
  results["events"] = events.filter(event => event.type === "message").slice(0, 3).map(show).map(event => ({
    ...event,
    window: event.window.className.startsWith("TarveMessageWindow-") ? "top" : event.window.className,
    ...(event.message === WM_APP + 1 || event.message === WM_SETTINGCHANGE ? {} : { message: "registered" }),
    ...(event.message === WM_SETTINGCHANGE ? { lParam: "address" } : {}),
  }));
  results["folder"] = events.filter(event => event.type === "folder").length > 0;
  window.dispose();
  rmSync(folder, { recursive: true, force: true });
  results["disposed"] = window.disposed;
  // A tray-like tree: children found by FindWindowEx, answered natively per window and by
  // (message, wParam) or WM_COPYDATA dwData, their messages delivered naming the window.
  const WM_COPYDATA = 0x4a;
  const wide = (value: string) => new Uint8Array(new Uint16Array([...value].map(char => char.charCodeAt(0)).concat(0)).buffer);
  const find = (parent: bigint, className: string) => BigInt(user32.symbols.FindWindowExW(parent, 0, wide(className), 0) as number | bigint);
  const treeEvents: MessageWindowEvent[] = [];
  const tray = messageWindow({
    className: "TarveSmokeTray",
    messageOnly: true,
    messages: [WM_COPYDATA, WM_APP + 1],
    keyedReplies: [{ message: WM_COPYDATA, dwData: 1, value: 1 }, { message: WM_APP + 2, wParam: 4, value: 3 }],
    children: [{ className: "TarveSmokeNotify", children: [{ className: "TarveSmokeToolbar", windowName: "Smoke", replies: { [WM_APP + 3]: 9 } }] }],
    onMessage(event) { treeEvents.push(event); },
  });
  const [notify, toolbar] = tray.children;
  tray.setReply(WM_APP + 4, 6, { hwnd: toolbar!.hwnd, wParam: 2 });
  const copy = new Uint8Array(24);
  copy[0] = 1;
  const nim = Number(sendText(tray.hwnd, WM_COPYDATA, 0, copy));
  user32.symbols.PostMessageW(toolbar!.hwnd, WM_APP + 1, 5, 6);
  await until(() => treeEvents.length >= 2);
  results["tree"] = {
    children: tray.children.map(child => [child.className, child.windowName, child.parent === tray.hwnd ? "top" : child.parent === notify!.hwnd ? "notify" : "other"]),
    found: find(tray.hwnd, "TarveSmokeNotify") === notify!.hwnd && find(notify!.hwnd, "TarveSmokeToolbar") === toolbar!.hwnd,
    replies: [
      Number(user32.symbols.SendMessageW(toolbar!.hwnd, WM_APP + 3, 0, 0)),
      Number(user32.symbols.SendMessageW(tray.hwnd, WM_APP + 3, 0, 0)),
      Number(user32.symbols.SendMessageW(tray.hwnd, WM_APP + 2, 4, 0)),
      Number(user32.symbols.SendMessageW(tray.hwnd, WM_APP + 2, 5, 0)),
      Number(user32.symbols.SendMessageW(toolbar!.hwnd, WM_APP + 4, 2, 0)),
      nim,
    ],
    events: treeEvents.map(event => event.type === "message" && [event.window.className, event.message, String(event.wParam), event.copyData ? "address" : String(event.lParam), event.copyData ? String(event.copyData.dwData) : null]),
  };
  tray.dispose();
}

writeFileSync(process.argv.at(-1)!, JSON.stringify(results));
