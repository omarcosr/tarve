import { describe, expect, test } from "bun:test";
import { nativePath } from "./bridge/runtime";
import { messageWindow, MessageWindowUnsupportedError, type MessageWindowEvent } from "./message-window";
import { openPluginLibrary } from "./plugins/ffi";

// Through Tarve's native library (native/src/message_window.rs): skipped before a native build.
const hasNative = (() => { try { nativePath(); return true; } catch { return false; } })();
const windows = process.platform === "win32";

const until = async (done: () => boolean) => {
  for (let tries = 0; tries < 300 && !done(); tries++) await new Promise(resolve => setTimeout(resolve, 10));
};

describe("messageWindow", () => {
  test.skipIf(windows)("throws a clear error off Windows", () => {
    expect(() => messageWindow({ onMessage() {} })).toThrow(MessageWindowUnsupportedError);
    expect(() => messageWindow({ onMessage() {} })).toThrow("only available on Windows");
  });

  test.skipIf(!windows || !hasNative)("checks its options before opening anything", () => {
    expect(() => messageWindow({} as never)).toThrow("onMessage");
    expect(() => messageWindow({ replyTimeout: 9000, onMessage() {} })).toThrow(RangeError);
    expect(() => messageWindow({ messages: [1.5], onMessage() {} })).toThrow("invalid message");
    expect(() => messageWindow({ registry: [{ key: "NOPE\\x" }], onMessage() {} })).toThrow("HKCU");
  });

  test.skipIf(!windows || !hasNative)("delivers posted messages in order and answers sent ones from its table", async () => {
    const user32 = openPluginLibrary("user32.dll", {
      PostMessageW: { args: ["ptr", "u32", "u64", "i64"], returns: "i32" },
      SendMessageW: { args: ["ptr", "u32", "u64", "i64"], returns: "i64" },
    });
    const WM_APP = 0x8000;
    const events: MessageWindowEvent[] = [];
    const window = messageWindow({
      messageOnly: true,
      messages: [WM_APP + 1, WM_APP + 2, "TarveMessageWindowJsTest"],
      waitReplies: [WM_APP + 2],
      replyTimeout: 20,
      replies: { [WM_APP + 3]: 77, TarveMessageWindowJsTest: true },
      onMessage(event) { events.push(event); return 5; },
    });
    try {
      expect(window.hwnd).toBeGreaterThan(0n);
      const named = window.messageIds.TarveMessageWindowJsTest!;
      expect(named).toBeGreaterThanOrEqual(0xc000);
      user32.symbols.PostMessageW(window.hwnd, WM_APP + 1, 1, -2);
      user32.symbols.PostMessageW(window.hwnd, named, 3, 4);
      await until(() => events.length >= 2);
      expect(events.map(event => event.type === "message" && [event.message, event.wParam, event.lParam, event.waiting])).toEqual([
        [WM_APP + 1, 1n, -2n, false],
        [named, 3n, 4n, false],
      ]);
      // Not delivered: answered from the table at once, on the window's thread.
      expect(Number(user32.symbols.SendMessageW(window.hwnd, WM_APP + 3, 0, 0))).toBe(77);
      window.setReply(WM_APP + 3, -1);
      expect(Number(user32.symbols.SendMessageW(window.hwnd, WM_APP + 3, 0, 0))).toBe(-1);
      // Sent from the JavaScript thread itself: onMessage cannot run meanwhile, the fallback answers after the timeout.
      expect(Number(user32.symbols.SendMessageW(window.hwnd, WM_APP + 2, 0, 0))).toBe(0);
      await until(() => events.length >= 3);
      expect(events[2]).toMatchObject({ type: "message", message: WM_APP + 2, waiting: true });
    } finally {
      window.dispose();
    }
    expect(window.disposed).toBe(true);
    expect(() => window.setReply(1, 1)).toThrow("disposed");
    window.dispose();
  });

  test.skipIf(!windows || !hasNative)("hosts a tree of child windows with keyed native replies", async () => {
    const user32 = openPluginLibrary("user32.dll", {
      PostMessageW: { args: ["ptr", "u32", "u64", "i64"], returns: "i32" },
      SendMessageW: { args: ["ptr", "u32", "u64", "i64"], returns: "i64" },
      FindWindowExW: { args: ["ptr", "ptr", "buffer", "ptr"], returns: "ptr" },
    });
    const sendCopy = openPluginLibrary("user32.dll", { SendMessageW: { args: ["ptr", "u32", "u64", "buffer"], returns: "i64" } }).symbols.SendMessageW;
    const wide = (text: string) => new Uint8Array(new Uint16Array([...text].map(char => char.charCodeAt(0)).concat(0)).buffer);
    const find = (parent: bigint, className: string) => BigInt(user32.symbols.FindWindowExW(parent, 0, wide(className), 0) as number | bigint);
    const WM_APP = 0x8000, WM_COPYDATA = 0x4a;
    expect(() => messageWindow({ children: [{} as never], onMessage() {} })).toThrow("className");
    expect(() => messageWindow({ keyedReplies: [{ message: 1, wParam: 1, dwData: 1, value: 0 }], onMessage() {} })).toThrow("not both");
    const events: MessageWindowEvent[] = [];
    const window = messageWindow({
      className: "TarveJsTreeTray",
      messageOnly: true,
      messages: [WM_COPYDATA, WM_APP + 1],
      keyedReplies: [{ message: WM_COPYDATA, dwData: 1, value: true }, { message: WM_APP + 2, wParam: 4, value: 3 }],
      children: [{ className: "TarveJsTreeNotify", children: [{ className: "TarveJsTreeToolbar", replies: { [WM_APP + 3]: 9 } }] }],
      onMessage(event) { events.push(event); },
    });
    try {
      expect(window.className).toBe("TarveJsTreeTray");
      const [notify, toolbar] = window.children;
      expect(window.children.map(child => [child.className, child.parent])).toEqual([["TarveJsTreeNotify", window.hwnd], ["TarveJsTreeToolbar", notify!.hwnd]]);
      expect(find(window.hwnd, "TarveJsTreeNotify")).toBe(notify!.hwnd);
      expect(find(notify!.hwnd, "TarveJsTreeToolbar")).toBe(toolbar!.hwnd);
      expect(Number(user32.symbols.SendMessageW(toolbar!.hwnd, WM_APP + 3, 0, 0))).toBe(9);
      expect(Number(user32.symbols.SendMessageW(window.hwnd, WM_APP + 2, 4, 0))).toBe(3);
      expect(Number(user32.symbols.SendMessageW(window.hwnd, WM_APP + 2, 5, 0))).toBe(0);
      window.setReply(WM_APP + 4, 6, { hwnd: toolbar!.hwnd, wParam: 2n });
      expect(Number(user32.symbols.SendMessageW(toolbar!.hwnd, WM_APP + 4, 2, 0))).toBe(6);
      window.setReply(WM_APP + 4, null, { hwnd: toolbar!.hwnd, wParam: 2 });
      expect(Number(user32.symbols.SendMessageW(toolbar!.hwnd, WM_APP + 4, 2, 0))).toBe(0);
      expect(() => window.setReply(1, 1, 12345n)).toThrow("not a window");
      // COPYDATASTRUCT { dwData = 1, cbData = 0, lpData = null } answered 1 natively, still delivered.
      const copy = new Uint8Array(24);
      copy[0] = 1;
      expect(Number(sendCopy(window.hwnd, WM_COPYDATA, 0, copy))).toBe(1);
      copy[0] = 3;
      expect(Number(sendCopy(window.hwnd, WM_COPYDATA, 0, copy))).toBe(0);
      user32.symbols.PostMessageW(toolbar!.hwnd, WM_APP + 1, 1, 2);
      await until(() => events.length >= 3);
      expect(events[0]).toMatchObject({ type: "message", window: { hwnd: window.hwnd, className: "TarveJsTreeTray" }, copyData: { dwData: 1n } });
      expect(events[1]).toMatchObject({ copyData: { dwData: 3n } });
      expect(events[2]).toMatchObject({ type: "message", message: WM_APP + 1, window: { hwnd: toolbar!.hwnd, className: "TarveJsTreeToolbar" } });
    } finally {
      window.dispose();
    }
  });
});
