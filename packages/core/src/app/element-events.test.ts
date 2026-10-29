import { describe, expect, test } from "bun:test";
import type { Handlers } from "../reconciler";
import { createElementDispatcher, type ElementEvent, type InvokeHandler } from "./element-events";

function harness(table: Record<string, Handlers>) {
  const calls: string[] = [];
  const invoke: InvokeHandler = (event, targetId, handler, ...args) => {
    calls.push(`${event}@${targetId}`);
    try { handler(...args); return true; } catch { return false; }
  };
  const dispatch = createElementDispatcher(invoke, id => table[id]);
  return { calls, dispatch: (event: ElementEvent) => dispatch(event, table[event.id]) };
}

describe("createElementDispatcher", () => {
  test("routes an event to the node's handler with its payload", () => {
    const seen: unknown[] = [];
    const { dispatch, calls } = harness({ box: { onContextMenu: position => { seen.push(position); } } });
    expect(dispatch({ type: "context", id: "box", x: 3, y: 4 })).toEqual({ handled: true, succeeded: true });
    expect(seen).toEqual([{ x: 3, y: 4 }]);
    expect(calls).toEqual(["context@box"]);
  });

  test("longPress runs onLongPress", () => {
    let held = 0;
    const { dispatch, calls } = harness({ mic: { onLongPress: () => { held++; } } });
    expect(dispatch({ type: "longPress", id: "mic" })).toEqual({ handled: true, succeeded: true });
    expect(held).toBe(1);
    expect(calls).toEqual(["longPress@mic"]);
  });


  test("pinch runs onPinch with its phase, scale and midpoint", () => {
    const seen: unknown[] = [];
    const { dispatch } = harness({ map: { onPinch: event => { seen.push(event); } } });
    expect(dispatch({ type: "pinch", id: "map", phase: "move", scale: 1.5, x: 10, y: 20 })).toEqual({ handled: true, succeeded: true });
    expect(seen).toEqual([{ phase: "move", scale: 1.5, x: 10, y: 20 }]);
  });

  test("imageError runs onError with the source and message", () => {
    const seen: unknown[] = [];
    const { dispatch, calls } = harness({ img: { onError: event => { seen.push(event); } } });
    expect(dispatch({ type: "imageError", id: "img", src: "a.png", message: "missing" })).toEqual({ handled: true, succeeded: true });
    expect(calls).toEqual(["imageError@img"]);
    expect(seen).toEqual([{ src: "a.png", message: "missing" }]);
  });

  test("an event without a handler is not handled", () => {
    const { dispatch } = harness({ box: {} });
    expect(dispatch({ type: "click", id: "box" })).toEqual({ handled: false, succeeded: true });
  });

  test("a throwing handler fails the dispatch", () => {
    const { dispatch } = harness({ box: { onClick: () => { throw new Error("boom"); } } });
    expect(dispatch({ type: "click", id: "box" })).toEqual({ handled: true, succeeded: false });
  });

  test("scroll feeds both onScroll and onScrollPosition", () => {
    const seen: unknown[] = [];
    const { dispatch } = harness({ list: {
      onScroll: (offset, max, info) => { seen.push(["scroll", offset, max, info.source]); },
      onScrollPosition: position => { seen.push(["position", position.y, position.maxY]); },
    } });
    dispatch({ type: "scroll", id: "list", offset: 10, max: 100 } as ElementEvent);
    expect(seen).toEqual([["scroll", 10, 100, "user"], ["position", 10, 100]]);
  });

  test("a drag enters and leaves drop targets as the pointer moves", () => {
    const log: string[] = [];
    const { dispatch } = harness({
      card: { onDragStart: () => { log.push("start"); }, onDragEnd: event => { log.push(`end:${event.target}:${event.cancelled}`); } },
      a: { onDragEnter: source => { log.push(`enter a from ${source}`); }, onDragLeave: () => { log.push("leave a"); } },
      b: { onDrop: event => { log.push(`drop b at ${event.x},${event.y}`); } },
    });
    dispatch({ type: "dragStart", id: "card", x: 0, y: 0 });
    dispatch({ type: "dragMove", id: "card", x: 1, y: 1, over: "a" });
    dispatch({ type: "dragMove", id: "card", x: 2, y: 2, over: "b" });
    dispatch({ type: "drop", id: "card", target: "b", x: 3, y: 3 });
    expect(log).toEqual(["start", "enter a from card", "leave a", "drop b at 3,3", "end:b:false"]);
  });

  test("a cancelled drag leaves the hovered target and ends cancelled", () => {
    const log: string[] = [];
    const { dispatch } = harness({
      card: { onDragEnd: event => { log.push(`end:${event.target}:${event.cancelled}`); } },
      a: { onDragLeave: () => { log.push("leave a"); } },
    });
    dispatch({ type: "dragStart", id: "card", x: 0, y: 0 });
    dispatch({ type: "dragMove", id: "card", x: 1, y: 1, over: "a" });
    dispatch({ type: "dragCancel", id: "card" } as ElementEvent);
    expect(log).toEqual(["leave a", "end:null:true"]);
  });
});
