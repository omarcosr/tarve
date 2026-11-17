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
});
