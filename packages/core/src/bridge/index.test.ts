import { describe, expect, test } from "bun:test";
import { NATIVE_ABI_VERSION, PROTOCOL_VERSION } from "../../../protocol/src/index";
import { assertNativeAbiVersion, drainNativeEvents, pollNativeEvent } from "./index";

describe("native ABI compatibility", () => {
  test("is versioned independently from the JSON protocol", () => {
    expect(NATIVE_ABI_VERSION).not.toBe(PROTOCOL_VERSION);
    expect(() => assertNativeAbiVersion(NATIVE_ABI_VERSION)).not.toThrow();
    expect(() => assertNativeAbiVersion(NATIVE_ABI_VERSION + 1)).toThrow(
      `Native ABI mismatch; expected ${NATIVE_ABI_VERSION}, got ${NATIVE_ABI_VERSION + 1}. Rebuild the library.`,
    );
  });

  test("drains a queued burst in FIFO order and grows the event buffer", () => {
    const encoded = [
      { type: "ready" },
      { type: "error", message: "second" },
      { type: "closed" },
    ].map(event => new TextEncoder().encode(JSON.stringify(event)));
    const received: string[] = [];
    let polls = 0;
    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(4);
    const poll = (target: Uint8Array<ArrayBufferLike>, capacity: number) => {
        polls += 1;
        const event = encoded[0];
        if (!event) return 0;
        if (event.length > capacity) return -event.length;
        target.set(event);
        encoded.shift();
        return event.length;
    };
    buffer = drainNativeEvents(buffer, poll, () => new Error("poll failed"), event => received.push(event.type));
    expect(received).toEqual(["ready", "error", "closed"]);
    expect(buffer.length).toBeGreaterThan(4);
    expect(polls).toBe(6);
  });

  test("empty polling returns immediately and native poll errors propagate", () => {
    let polls = 0;
    const buffer = new Uint8Array(16);
    expect(pollNativeEvent(buffer, () => { polls += 1; return 0; }, () => new Error("poll failed"))).toEqual({ buffer });
    expect(polls).toBe(1);
    expect(() => pollNativeEvent(buffer, () => -1, () => new Error("poll failed"))).toThrow("poll failed");
  });
});
