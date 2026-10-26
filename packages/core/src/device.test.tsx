import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { NativeCommand, NativeEvent, PermissionState, SceneDocument } from "./protocol";
import { createApp } from "./app";
import type { NativeBridge } from "./bridge";
import { Window } from "./components";
import { authenticate, getCurrentPosition, share, watchPosition } from "./device";
import type { OpenEvent } from "./app/open-requests";

/** Answers `permissions` with `permission`; everything else waits for the test. */
class DeviceBridge implements NativeBridge {
  commands: NativeCommand[] = [];
  permission: PermissionState = "granted";
  private listener?: (event: NativeEvent) => void;
  start(_document: SceneDocument, onEvent: (event: NativeEvent) => void): void {
    this.listener = onEvent;
    onEvent({ type: "ready" });
  }
  send(command: NativeCommand): void {
    this.commands.push(command);
    if (command.type === "permissions") {
      const results = Object.fromEntries(command.permissions.map(name => [name, this.permission]));
      queueMicrotask(() => this.emit({ type: "permissions", requestId: command.requestId, results }));
    }
  }
  join(): void {}
  emit(event: NativeEvent): void { this.listener?.(event); }
  last<T extends NativeCommand["type"]>(type: T): Extract<NativeCommand, { type: T }> {
    const command = this.commands.findLast(item => item.type === type);
    if (!command) throw new Error(`no ${type} command`);
    return command as Extract<NativeCommand, { type: T }>;
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("device services", () => {
  test("share sends text, url and absolute file paths and resolves with the platform's answer", async () => {
    const bridge = new DeviceBridge();
    const app = createApp(() => <Window />, { bridge });
    await app.ready;
    const shown = app.share({ title: "Hi", text: "Look", url: "https://tarve.dev", files: ["notes/a.txt"] });
    const command = bridge.last("share");
    expect(command).toEqual({ type: "share", requestId: command.requestId, title: "Hi", text: "Look", url: "https://tarve.dev", files: [resolve("notes/a.txt")] });
    bridge.emit({ type: "share", requestId: command.requestId, supported: true });
    expect(await shown).toEqual({ supported: true });
    // Linux: the same call, `supported: false`, no exception.
    const linux = share({ text: "x" });
    await tick();
    bridge.emit({ type: "share", requestId: bridge.last("share").requestId, supported: false });
    expect(await linux).toEqual({ supported: false });
    await expect(app.share({})).rejects.toThrow(TypeError);
    app.close();
  });

  test("getCurrentPosition asks for the location permission, then for a fix", async () => {
    const bridge = new DeviceBridge();
    const app = createApp(() => <Window />, { bridge });
    await app.ready;
    const position = { latitude: -23.5, longitude: -46.6, accuracy: 12, altitude: null, altitudeAccuracy: null, heading: null, speed: null, timestamp: 1 };
    const fix = app.getCurrentPosition({ highAccuracy: true, timeoutMs: 5000 });
    await tick();
    expect(bridge.last("permissions").permissions).toEqual(["ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION"]);
    const command = bridge.last("location");
    expect(command).toEqual({ type: "location", action: "get", requestId: command.requestId, highAccuracy: true, timeoutMs: 5000, maximumAgeMs: 0 });
    bridge.emit({ type: "location", requestId: command.requestId, supported: true, position });
    expect(await fix).toEqual({ supported: true, position });

    const timedOut = getCurrentPosition();
    await tick();
    bridge.emit({ type: "location", requestId: bridge.last("location").requestId, supported: true, code: "timeout", error: "No fix" });
    expect(await timedOut).toEqual({ supported: true, code: "timeout", error: "No fix" });

    // Denied: no location command at all.
    bridge.permission = "denied";
    const before = bridge.commands.filter(item => item.type === "location").length;
    const denied = await app.getCurrentPosition();
    expect(denied.code).toBe("denied");
    expect(denied.supported).toBe(true);
    expect(bridge.commands.filter(item => item.type === "location").length).toBe(before);
    await expect(app.getCurrentPosition({ timeoutMs: -1 })).rejects.toThrow(RangeError);
    app.close();
  });

  test("watchPosition streams position events until stopped", async () => {
    const bridge = new DeviceBridge();
    const app = createApp(() => <Window />, { bridge });
    await app.ready;
    const seen: unknown[] = [];
    const stop = watchPosition(result => seen.push(result.position?.latitude ?? result.code));
    await tick();
    const command = bridge.last("location");
    expect([command.action, command.highAccuracy]).toEqual(["watch", false]);
    const at = (latitude: number) => ({ latitude, longitude: 0, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null, timestamp: 0 });
    bridge.emit({ type: "position", watchId: command.requestId, supported: true, position: at(1) });
    bridge.emit({ type: "position", watchId: "someone-else", supported: true, position: at(9) });
    bridge.emit({ type: "position", watchId: command.requestId, supported: true, position: at(2) });
    stop();
    expect(bridge.commands.at(-1)).toEqual({ type: "location", action: "clear", requestId: command.requestId });
    bridge.emit({ type: "position", watchId: command.requestId, supported: true, position: at(3) });
    expect(seen).toEqual([1, 2]);

    // Unsupported (Linux) ends the watch with one answer.
    const unsupported: unknown[] = [];
    app.watchPosition(result => unsupported.push(result));
    await tick();
    const id = bridge.last("location").requestId;
    bridge.emit({ type: "position", watchId: id, supported: false, code: "unsupported" });
    bridge.emit({ type: "position", watchId: id, supported: false, code: "unsupported" });
    expect(unsupported).toEqual([{ supported: false, code: "unsupported" }]);
    app.close();
  });

  test("authenticate passes the reason and reports success or why not", async () => {
    const bridge = new DeviceBridge();
    const app = createApp(() => <Window />, { bridge });
    await app.ready;
    const verified = authenticate({ reason: "Unlock notes" });
    const command = bridge.last("authenticate");
    expect(command.reason).toBe("Unlock notes");
    bridge.emit({ type: "authenticate", requestId: command.requestId, supported: true, success: true });
    expect(await verified).toEqual({ supported: true, success: true });
    const canceled = app.authenticate({ reason: "Again" });
    bridge.emit({ type: "authenticate", requestId: bridge.last("authenticate").requestId, supported: true, success: false, code: "canceled", error: "Canceled" });
    expect(await canceled).toEqual({ supported: true, success: false, code: "canceled", error: "Canceled" });
    await expect(app.authenticate({ reason: " " })).rejects.toThrow(TypeError);
    app.close();
  });

  test("Android open events reach onOpenUrl / onOpenFiles, the launch's own replayed to later listeners", async () => {
    const bridge = new DeviceBridge();
    const app = createApp(() => <Window />, { bridge, protocols: ["myapp"], fileTypes: [{ ext: "note", name: "Note" }] });
    await app.ready;
    const early: [string, OpenEvent][] = [];
    app.onOpenUrl((url, event) => early.push([url, event]));
    await tick();
    bridge.emit({ type: "open", urls: ["myapp://first"], files: [], initial: true });
    expect(early.map(([url, event]) => [url, event.initial])).toEqual([["myapp://first", true]]);

    // Registered after the launch's link arrived: it still gets it, once.
    const late: string[] = [];
    app.onOpenUrl(url => late.push(url));
    await tick();
    expect(late).toEqual(["myapp://first"]);

    const files: string[][] = [];
    app.onOpenFiles(paths => files.push(paths));
    await tick();
    bridge.emit({ type: "open", urls: ["myapp://second"], files: ["/data/cache/opened/1/a.note"], initial: false });
    expect(early.map(([url, event]) => [url, event.initial])).toEqual([["myapp://first", true], ["myapp://second", false]]);
    expect(late).toEqual(["myapp://first", "myapp://second"]);
    expect(files).toEqual([["/data/cache/opened/1/a.note"]]);
    app.close();
  });
});
