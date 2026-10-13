import { describe, expect, test } from "bun:test";
import type { NativeCommand, NativeEvent } from "../protocol";
import { createNativeRequests, validateFileDialogOptions } from "./requests";

function harness(options: { ended?: () => Error | undefined; send?: (command: NativeCommand) => void } = {}) {
  const sent: NativeCommand[] = [];
  const reported: string[] = [];
  const requests = createNativeRequests({
    send: command => { sent.push(command); options.send?.(command); },
    reportError: (error, context) => { reported.push(`${context.source}:${context.event}`); return error instanceof Error ? error : new Error(String(error)); },
    closedError: options.ended ?? (() => undefined),
  });
  return { requests, sent, reported };
}

describe("createNativeRequests", () => {
  test("resolves a request with the event carrying its requestId", async () => {
    const { requests, sent } = harness();
    const pending = requests.request({ type: "inspect", requestId: "r1" });
    expect(sent).toHaveLength(1);
    requests.settle({ type: "inspect", requestId: "other", snapshot: {} as never } as NativeEvent);
    requests.settle({ type: "inspect", requestId: "r1", snapshot: {} as never } as NativeEvent);
    await expect(pending).resolves.toMatchObject({ requestId: "r1" });
  });

  test("times out and reports when native never answers", async () => {
    const { requests, reported } = harness();
    await expect(requests.request({ type: "inspect", requestId: "r2" }, 1)).rejects.toThrow("Native request timed out: inspect");
    expect(reported).toEqual(["request:inspect"]);
  });

  test("a file dialog waits without a timeout", async () => {
    const { requests, sent } = harness();
    const opening = requests.fileDialog("openFile");
    const command = sent[0];
    if (command?.type !== "fileDialog") throw new Error("expected fileDialog");
    await new Promise(resolve => setTimeout(resolve, 20));
    requests.settle({ type: "fileDialog", requestId: command.requestId, paths: ["a.txt"] });
    await expect(opening).resolves.toEqual(["a.txt"]);
  });

  test("rejects immediately once the app ended", async () => {
    const closed = new Error("gone");
    const { requests, sent } = harness({ ended: () => closed });
    await expect(requests.request({ type: "inspect", requestId: "r3" })).rejects.toBe(closed);
    expect(sent).toHaveLength(0);
  });

  test("a failing bridge send rejects and reports", async () => {
    const { requests, reported } = harness({ send: () => { throw new Error("bridge down"); } });
    await expect(requests.request({ type: "inspect", requestId: "r4" })).rejects.toThrow("bridge down");
    expect(reported).toEqual(["request:inspect"]);
  });

  test("rejectAll settles every pending request", async () => {
    const { requests } = harness();
    const a = requests.request({ type: "inspect", requestId: "a" });
    const b = requests.request({ type: "inspect", requestId: "b" });
    requests.rejectAll(new Error("closed"));
    await expect(a).rejects.toThrow("closed");
    await expect(b).rejects.toThrow("closed");
  });
});

describe("validateFileDialogOptions", () => {
  test("accepts well-formed filters", () => {
    expect(() => validateFileDialogOptions({ filters: [{ name: "Images", extensions: ["png", ".jpg"] }] })).not.toThrow();
  });
  test("rejects wildcard extensions and empty filters", () => {
    expect(() => validateFileDialogOptions({ filters: [{ name: "Bad", extensions: ["*.exe"] }] })).toThrow(TypeError);
    expect(() => validateFileDialogOptions({ filters: [{ name: "", extensions: ["txt"] }] })).toThrow(TypeError);
  });
  test("rejects oversized text", () => {
    expect(() => validateFileDialogOptions({ title: "x".repeat(5000) })).toThrow(RangeError);
  });
});
