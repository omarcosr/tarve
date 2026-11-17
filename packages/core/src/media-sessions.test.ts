import { describe, expect, test } from "bun:test";
import { nativePath } from "./bridge/runtime";
import { controlSystemMediaSession, onSystemMediaSessionsChange, readMediaSessions, sendMediaSessionAction, systemMediaSessions, type ExternalMediaSession } from "./media-sessions";

const hasNative = (() => { try { nativePath(); return true; } catch { return false; } })();

// The native calls themselves are covered by native/src/media_sessions.rs; here a stand-in
// library checks the buffer protocol and the argument handling around them.
function fakeLibrary(sessions: ExternalMediaSession[], control: (action: number, appId: string) => number = () => 0) {
  const json = new TextEncoder().encode(JSON.stringify(sessions));
  const calls: string[] = [];
  const library = {
    symbols: {
      tarve_media_sessions(buffer: Uint8Array, capacity: number): number {
        calls.push(`list ${capacity}`);
        if (capacity < json.length) return -json.length;
        buffer.set(json);
        return json.length;
      },
      tarve_media_session_control(action: number, id: Uint8Array, length: number): number {
        return control(action, new TextDecoder().decode(id.subarray(0, length)));
      },
      tarve_last_error(buffer: Uint8Array): number {
        const message = new TextEncoder().encode("COM failed");
        buffer.set(message);
        return message.length;
      },
    },
    close() {},
  };
  return { library: library as never, calls };
}

const session = (index: number): ExternalMediaSession => ({ appId: `App.${index}`, title: "x".repeat(4096), playing: index === 0, current: index === 0 });

describe("system media sessions", () => {
  test("the list is read whole, asking again with the capacity native reports", () => {
    const sessions = Array.from({ length: 80 }, (_, index) => session(index));
    const { library, calls } = fakeLibrary(sessions);
    expect(readMediaSessions(library)).toEqual(sessions);
    expect(calls).toHaveLength(2);
    const small = fakeLibrary([session(0)]);
    expect(readMediaSessions(small.library)).toEqual([session(0)]);
    expect(small.calls).toHaveLength(1);
  });

  test("actions reach the app's session by id and code; a native error is thrown with its message", () => {
    const seen: string[] = [];
    const { library } = fakeLibrary([], (action, appId) => { seen.push(`${action} ${appId}`); return appId === "Known" ? 1 : appId === "Broken" ? -1 : 0; });
    expect(sendMediaSessionAction(library, "Known", "next")).toBe(true);
    expect(sendMediaSessionAction(library, "Other", "pause")).toBe(false);
    expect(() => sendMediaSessionAction(library, "Broken", "play")).toThrow("controlSystemMediaSession: COM failed");
    expect(seen).toEqual(["3 Known", "1 Other", "0 Broken"]);
  });

  test("an unknown action or empty app id is rejected", async () => {
    await expect(controlSystemMediaSession("x", "stop" as never)).rejects.toThrow(TypeError);
    await expect(controlSystemMediaSession("", "play")).rejects.toThrow(TypeError);
  });

  test.skipIf(process.platform !== "win32" || !hasNative)("onSystemMediaSessionsChange delivers the kept list, which systemMediaSessions then reads, until the last listener leaves", async () => {
    const first: ExternalMediaSession[][] = [];
    const second: ExternalMediaSession[][] = [];
    const stopFirst = onSystemMediaSessionsChange(sessions => first.push(sessions));
    const stopSecond = onSystemMediaSessionsChange(sessions => second.push(sessions));
    try {
      for (let tries = 0; tries < 100 && (!first.length || !second.length); tries++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(Array.isArray(first[0])).toBe(true);
      expect(second[0]).toEqual(first.at(-1)!);
      expect(await systemMediaSessions()).toEqual(first.at(-1)!);
    } finally {
      stopFirst();
      stopFirst();
      stopSecond();
    }
    // Listening again starts a new watch.
    const again: ExternalMediaSession[][] = [];
    const stopAgain = onSystemMediaSessionsChange(sessions => again.push(sessions));
    for (let tries = 0; tries < 100 && !again.length; tries++) await new Promise(resolve => setTimeout(resolve, 10));
    stopAgain();
    expect(again.length).toBeGreaterThan(0);
  });

  test.skipIf(process.platform === "win32")("other platforms have no sessions to read or control", async () => {
    expect(await systemMediaSessions()).toEqual([]);
    expect(await controlSystemMediaSession("App", "play")).toBe(false);
  });
});
