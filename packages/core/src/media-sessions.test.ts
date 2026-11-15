import { describe, expect, test } from "bun:test";
import { controlSystemMediaSession, systemMediaSessions } from "./media-sessions";

describe("system media sessions", () => {
  test("listing other apps' sessions succeeds", async () => {
    const sessions = await systemMediaSessions();
    expect(Array.isArray(sessions)).toBe(true);
    if (process.platform !== "win32") expect(sessions).toEqual([]);
    expect(sessions.filter(session => session.current).length).toBeLessThanOrEqual(1);
    for (const session of sessions) {
      expect(typeof session.appId).toBe("string");
      expect(session.appId.length).toBeGreaterThan(0);
      expect(typeof session.title).toBe("string");
      expect(typeof session.playing).toBe("boolean");
      if (session.artwork !== undefined) expect(session.artwork).toMatch(/^[A-Za-z0-9+/]+=*$/);
    }
  });

  test("an app without a session is not controlled", async () => {
    expect(await controlSystemMediaSession("Tarve.NoSuchApp.MediaSessionTest", "toggle")).toBe(false);
  });

  test("an unknown action or empty app id is rejected", async () => {
    await expect(controlSystemMediaSession("x", "stop" as never)).rejects.toThrow(TypeError);
    await expect(controlSystemMediaSession("", "play")).rejects.toThrow(TypeError);
  });
});
