import type { AppHandle } from "@tarve/core";
import type { NativeEvent } from "@tarve/core/protocol";
import { documentInstance, isFocusable, moveFocus, layout, restyleAll, scheduleIntersections, setFocusHook, setMediaHook, TEvent, windowInstance, type TElement } from "./dom";
import { resizeRestyles } from "./css";
import { elementForNativeId, nativeIdOf, setPointerPosition } from "./render";

const BUTTONS = [1, 4, 2, 8, 16];
const SHORTCUTS: Record<string, string> = { b: "bold", i: "italic", u: "underline" };
let buttons = 0;

/** Native events that are not one element's handler: keys, focus, the window size. */
export function connectNativeEvents(app: AppHandle): () => void {
  setFocusHook(element => { if (element) app.focus(nativeIdOf(element)); });
  setMediaHook((element, action, value) => {
    const media = app.media(nativeIdOf(element));
    if (action === "seek") media.seek(value ?? 0); else media[action]();
  });
  const off = app.onEvent((event: NativeEvent) => {
    switch (event.type) {
      case "keyboard": {
        const focused = elementForNativeId(event.id) ?? null;
        // Native names the focused node with every key: script focus follows it.
        if (focused !== documentInstance.activeElement && (focused === null || isFocusable(focused))) moveFocus(focused, true);
        const target: TElement = documentInstance.activeElement ?? documentInstance.body;
        const proceed = target.dispatchEvent(new TEvent(event.phase === "down" ? "keydown" : "keyup", {
          bubbles: true, cancelable: true, composed: true,
          key: event.key, code: event.code, repeat: event.repeat,
          ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
          isComposing: false, location: 0,
          getModifierState: (key: string) => ({ Control: event.ctrlKey, Alt: event.altKey, Shift: event.shiftKey, Meta: event.metaKey } as Record<string, boolean>)[key] ?? false,
        }));
        // A contenteditable's formatting shortcuts, unless a keydown handler cancelled them.
        const shortcut = SHORTCUTS[event.key.toLowerCase()];
        if (proceed && shortcut && event.phase === "down" && (event.ctrlKey || event.metaKey) && !event.altKey && target.isContentEditable) documentInstance.execCommand(shortcut);
        break;
      }
      case "pointer": {
        setPointerPosition(event.x, event.y);
        const target: TElement = elementForNativeId(event.id) ?? documentInstance.body;
        const position = { clientX: event.x, clientY: event.y, pageX: event.x, pageY: event.y, screenX: event.x, screenY: event.y, offsetX: event.x - (target._box?.x ?? 0), offsetY: event.y - (target._box?.y ?? 0) };
        const modifiers = { ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey };
        if (event.phase === "wheel") {
          target.dispatchEvent(new TEvent("wheel", { bubbles: true, cancelable: true, ...position, ...modifiers, deltaX: event.deltaX ?? 0, deltaY: event.deltaY ?? 0, deltaZ: 0, deltaMode: 0, buttons }));
          break;
        }
        const button = event.button ?? 0;
        if (event.phase === "down") buttons |= BUTTONS[button] ?? 0; else buttons &= ~(BUTTONS[button] ?? 0);
        const init = { bubbles: true, cancelable: true, composed: true, ...position, ...modifiers, button, buttons, pointerId: 1, pointerType: "mouse", isPrimary: true };
        const kind = event.phase === "down" ? "down" : "up";
        target.dispatchEvent(new TEvent(`pointer${kind}`, init));
        target.dispatchEvent(new TEvent(`mouse${kind}`, init));
        // Other buttons click as auxclick; the primary click comes from native activation.
        if (kind === "up" && button === 1) target.dispatchEvent(new TEvent("auxclick", init));
        break;
      }
      case "size": {
        elementForNativeId(event.id)?._sized(event);
        break;
      }
      case "blur": {
        const element = elementForNativeId(event.id);
        if (element && element === documentInstance.activeElement) moveFocus(null, true);
        break;
      }
      case "click": case "change": case "submit": case "valueChange": {
        // Clicking or editing a control focuses it natively.
        const element = elementForNativeId(event.id);
        if (element && isFocusable(element) && element !== documentInstance.activeElement) moveFocus(element, true);
        break;
      }
    }
  });
  return () => { off(); setFocusHook(undefined); setMediaHook(undefined); };
}

/** The window's content size changed: `window.innerWidth`, `bind:innerWidth`, `onresize`. */
export function windowResized(size: { width: number; height: number }): void {
  if (windowInstance.innerWidth === size.width && windowInstance.innerHeight === size.height) return;
  const before = { width: windowInstance.innerWidth, height: windowInstance.innerHeight };
  windowInstance.innerWidth = size.width;
  windowInstance.innerHeight = size.height;
  layout.epoch++;
  // @media width queries and vw/vh: restyle once a threshold is crossed.
  if (resizeRestyles(before, size)) restyleAll(documentInstance);
  windowInstance.dispatchEvent(new TEvent("resize"));
  scheduleIntersections();
}
