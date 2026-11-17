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
    ...(event.message === WM_APP + 1 || event.message === WM_SETTINGCHANGE ? {} : { message: "registered" }),
    ...(event.message === WM_SETTINGCHANGE ? { lParam: "address" } : {}),
  }));
  results["folder"] = events.filter(event => event.type === "folder").length > 0;
  window.dispose();
  rmSync(folder, { recursive: true, force: true });
  results["disposed"] = window.disposed;
}

writeFileSync(process.argv.at(-1)!, JSON.stringify(results));
