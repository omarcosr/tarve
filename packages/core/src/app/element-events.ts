import type { NativeEvent } from "../protocol";
import type { PastePayload } from "../jsx-runtime";
import type { Handlers } from "../reconciler";

/** Runs one user handler, reporting a throw; true when it returned normally. */
export type InvokeHandler = (event: string, targetId: string | undefined, handler: (...args: never[]) => void, ...args: never[]) => boolean;
export type ElementEvent = NativeEvent & { id: string };
export interface DispatchResult {
  /** A handler existed for the event. */
  handled: boolean;
  /** Every handler that ran returned normally. */
  succeeded: boolean;
}

function pastePayload(event: Extract<NativeEvent, { type: "paste" }>): PastePayload | undefined {
  if (event.files?.length) return { kind: "files", files: [...event.files] };
  if (event.image) {
    const bytes = Buffer.from(event.image.rgba, "base64");
    return { kind: "image", width: event.image.width, height: event.image.height, rgba: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  }
  return undefined;
}

/**
 * Routes a native event addressed to an element id to the handlers its node
 * declared. `handlersOf` resolves other nodes (drop targets).
 */
export function createElementDispatcher(invoke: InvokeHandler, handlersOf: (id: string) => Handlers | undefined): (event: ElementEvent, handlers: Handlers | undefined) => DispatchResult {
  /** Last known pointer position and drop target per in-flight drag source. */
  const drags = new Map<string, { x: number; y: number; over: string | null }>();

  function dispatchDrag(event: Extract<NativeEvent, { type: "dragStart" | "dragMove" | "drop" | "dragCancel" }>, handlers: Handlers | undefined): DispatchResult {
    let handled = false;
    let succeeded = true;
    const call = (name: string, id: string, handler: ((...args: never[]) => void) | undefined, arg?: unknown) => {
      if (!handler) return;
      handled = true;
      succeeded = invoke(name, id, handler, arg as never) && succeeded;
    };
    const source = event.id;
    if (event.type === "dragStart") {
      drags.set(source, { x: event.x, y: event.y, over: null });
      call("dragStart", source, handlers?.onDragStart as never, { x: event.x, y: event.y });
      return { handled, succeeded };
    }
    const state = drags.get(source) ?? { x: 0, y: 0, over: null };
    if (event.type === "dragMove") {
      drags.set(source, { x: event.x, y: event.y, over: event.over });
      if (state.over !== event.over) {
        if (state.over) call("dragLeave", state.over, handlersOf(state.over)?.onDragLeave as never, source);
        if (event.over) call("dragEnter", event.over, handlersOf(event.over)?.onDragEnter as never, source);
      }
      call("dragMove", source, handlers?.onDragMove as never, { x: event.x, y: event.y, over: event.over });
      return { handled, succeeded };
    }
    drags.delete(source);
    const dropped = event.type === "drop" ? event.target : null;
    const x = event.type === "drop" ? event.x : state.x;
    const y = event.type === "drop" ? event.y : state.y;
    if (state.over && state.over !== dropped) call("dragLeave", state.over, handlersOf(state.over)?.onDragLeave as never, source);
    if (dropped) call("drop", dropped, handlersOf(dropped)?.onDrop as never, { source, x, y });
    call("dragEnd", source, handlers?.onDragEnd as never, { target: dropped, x, y, cancelled: event.type === "dragCancel" });
    return { handled, succeeded };
  }

  return (event, handlers) => {
    let handled = false;
    let succeeded = true;
    const run = (name: string, handler: ((...args: never[]) => void) | undefined, ...args: unknown[]): void => {
      if (!handler) return;
      handled = true;
      succeeded = invoke(name, event.id, handler, ...(args as never[])) && succeeded;
    };
    switch (event.type) {
      case "click": run("click", handlers?.onClick); break;
      case "markdownLink": run("markdownLink", handlers?.onMarkdownLink as never, event.href); break;
      case "diffToggleFile": run("diffToggleFile", handlers?.onDiffToggleFile as never, event.path); break;
      case "diffShowMore": run("diffShowMore", handlers?.onDiffShowMore as never, event.hidden, event.path ?? undefined); break;
      case "diffLineClick": run("diffLineClick", handlers?.onDiffLineClick as never, { text: event.text, path: event.path ?? undefined, oldLine: event.oldLine ?? undefined, newLine: event.newLine ?? undefined }); break;
      case "highlight": run("highlight", handlers?.onHighlight as never, { matchCount: event.matchCount, query: event.query, caseSensitive: event.caseSensitive, wholeWord: event.wholeWord }); break;
      case "context": run("context", handlers?.onContextMenu as never, { x: event.x, y: event.y }); break;
      case "longPress": run("longPress", handlers?.onLongPress); break;
      case "outside": run("outside", handlers?.onOutsideClick); break;
      case "submit": run("submit", handlers?.onSubmit as never, event.value); break;
      case "paste": {
        const payload = pastePayload(event);
        if (payload) run("paste", handlers?.onPaste as never, payload);
        break;
      }
      case "change": run("change", handlers?.onChange as never, event.value); break;
      case "valueChange": run("valueChange", handlers?.onValueChange as never, event.value); break;
      case "scroll":
        run("scroll", handlers?.onScroll as never, event.offset, event.max, { source: event.source ?? "user" });
        run("scrollPosition", handlers?.onScrollPosition as never, {
          x: event.offsetX ?? 0,
          y: event.offsetY ?? event.offset,
          maxX: event.maxX ?? 0,
          maxY: event.maxY ?? event.max,
          source: event.source ?? "user",
        });
        break;
      case "virtualListLayout": run("virtualListLayout", handlers?.onVirtualListLayout as never, event.items); break;
      case "size": run("size", handlers?.onSize as never, { width: event.width, height: event.height }); break;
      case "pointerMove": run("pointerMove", handlers?.onPointerMove as never, { x: event.x, y: event.y }); break;
      case "pointerLeave": run("pointerLeave", handlers?.onPointerLeave as never); break;
      case "virtualListScrollToItem": run("virtualListScrollToItem", handlers?.onVirtualListScrollToItem as never, event.index, event.offset, event.smooth === true); break;
      case "virtualListFocus": run("virtualListFocus", handlers?.onVirtualListFocus as never, event.key); break;
      case "dragStart": case "dragMove": case "drop": case "dragCancel": {
        const result = dispatchDrag(event, handlers);
        handled = result.handled;
        succeeded = result.succeeded && succeeded;
        break;
      }
      case "fileDragEnter": run("fileDragEnter", handlers?.onFileDragEnter as never, [...event.paths]); break;
      case "fileDragLeave": run("fileDragLeave", handlers?.onFileDragLeave); break;
      case "fileDrop": run("fileDrop", handlers?.onFileDrop as never, { paths: [...event.paths], x: event.x, y: event.y }); break;
      case "hover": run("hover", handlers?.onHover as never, event.entered); break;
      case "key": run("key", handlers?.onKeyDown as never, event.key); break;
      case "blur": run("blur", handlers?.onBlur); break;
      case "imageError": run("imageError", handlers?.onError as never, { src: event.src, message: event.message }); break;
      case "motionComplete": run("motionComplete", handlers?.onTransitionEnd as never, { property: event.property }); break;
    }
    return { handled, succeeded };
  };
}
