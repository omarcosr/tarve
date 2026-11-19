import { expect, test } from "bun:test";
import { nativePath } from "./bridge/runtime";
import { messageWindow } from "./message-window";
import { peekWindow, setWindowPeek, windowThumbnail, WindowDwmUnsupportedError } from "./window-dwm";

const hasNative = (() => { try { nativePath(); return true; } catch { return false; } })();
const windows = process.platform === "win32";

test.skipIf(windows)("DWM calls throw a clear error off Windows", () => {
  expect(() => windowThumbnail(1, 2)).toThrow(WindowDwmUnsupportedError);
  expect(() => setWindowPeek(1, { excluded: true })).toThrow(WindowDwmUnsupportedError);
  expect(() => peekWindow(null)).toThrow(WindowDwmUnsupportedError);
});

test.skipIf(!windows || !hasNative)("thumbnails, peek exclusion and Aero Peek reach DWM", () => {
  // Two hidden top-level windows of this process stand in for the preview and the window it shows.
  const destination = messageWindow({ onMessage() {} });
  const source = messageWindow({ onMessage() {} });
  try {
    expect(() => windowThumbnail(0, source.hwnd)).toThrow("invalid window handle");
    const thumbnail = windowThumbnail(destination.hwnd, String(source.hwnd), { rect: { x: 0, y: 0, width: 160, height: 90 } });
    expect(thumbnail.sourceSize).toEqual({ width: expect.any(Number), height: expect.any(Number) });
    thumbnail.update({ source: { x: 0, y: 0, width: 10, height: 10 }, opacity: 0.5, clientAreaOnly: true });
    thumbnail.update({ source: null, visible: false });
    expect(() => thumbnail.update({ opacity: 2 })).toThrow(RangeError);
    expect(() => thumbnail.update({ rect: { x: 0, y: 0, width: -1, height: 1 } })).toThrow("invalid rectangle");
    thumbnail.dispose();
    expect(thumbnail.disposed).toBe(true);
    expect(() => thumbnail.update({ visible: true })).toThrow("disposed");
    thumbnail.dispose();
    setWindowPeek(destination.hwnd, { excluded: true, disallowed: true, transitions: false });
    setWindowPeek(destination.hwnd, { excluded: false, disallowed: false, transitions: true });
    // Ending a peek that never began does nothing visible.
    peekWindow(null);
  } finally {
    destination.dispose();
    source.dispose();
  }
});
