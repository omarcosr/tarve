// `toast()`: a message in the corner of the app's window that dismisses itself, without the
// app owning a toast array. Every open app (not the windows it opened) draws the same queue
// through a Toaster appended to its Window; `<Toaster toasts>` stays for apps that own their list.
import { jsx, type Child, type VNode } from "./jsx-runtime";
import { Window } from "./components/window";
import { Toaster, type ToastAction, type ToastItem, type ToasterPosition } from "./extra-controls";

export type ToastTone = "default" | "ok" | "error";

export interface ToastOptions {
  /** Second line under the title. */
  description?: string;
  /** "ok" (success accent), "error" (destructive accent) or "default". */
  tone?: ToastTone;
  /** Milliseconds on screen; `null` keeps it until dismissed. Default 4000, 6000 for "error". */
  duration?: number | null;
  /** One button; pressing it also dismisses the toast. */
  action?: ToastAction;
  /** Replaces the toast with this id if it is still shown (a progress message updated in place). */
  id?: string;
}

export interface ToastHandle {
  readonly id: string;
  dismiss(): void;
}

const TONES: Record<ToastTone, ToastItem["variant"]> = { default: "default", ok: "success", error: "destructive" };
let shown: ToastItem[] = [];
let position: ToasterPosition = "bottom-right";
let nextId = 1;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of [...listeners]) listener();
}

/** Shows `title` in every open app's window; returns a handle that dismisses it early. */
export function toast(title: string, options: ToastOptions = {}): ToastHandle {
  if (typeof title !== "string") throw new TypeError("toast() takes the message as a string");
  const id = options.id ?? `toast-${nextId++}`;
  const tone = options.tone ?? "default";
  if (!(tone in TONES)) throw new TypeError(`Unknown toast tone: ${String(tone)}`);
  const action = options.action && { label: options.action.label, onClick: () => { dismissToast(id); options.action!.onClick(); } };
  const item: ToastItem = {
    id, title,
    ...(options.description ? { description: options.description } : {}),
    variant: TONES[tone],
    ...(action ? { action } : {}),
  };
  const index = shown.findIndex(existing => existing.id === id);
  shown = index < 0 ? [...shown, item] : shown.map(existing => existing.id === id ? item : existing);
  clearTimeout(timers.get(id));
  timers.delete(id);
  const duration = options.duration === undefined ? (tone === "error" ? 6000 : 4000) : options.duration;
  if (duration !== null) {
    if (!Number.isFinite(duration) || duration < 0) throw new RangeError("toast duration must be a non-negative number of milliseconds or null");
    const timer = setTimeout(() => dismissToast(id), duration);
    // A toast never keeps a closing process alive.
    (timer as { unref?(): void }).unref?.();
    timers.set(id, timer);
  }
  changed();
  return { id, dismiss: () => dismissToast(id) };
}

/** Removes a toast shown with `toast()`; unknown ids are ignored. */
export function dismissToast(id: string): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const next = shown.filter(item => item.id !== id);
  if (next.length === shown.length) return;
  shown = next;
  changed();
}

/** Corner the toasts stack in (default "bottom-right"). */
export function setToastPosition(next: ToasterPosition): void {
  if (next === position) return;
  position = next;
  if (shown.length) changed();
}

/** The toasts `toast()` shows now, oldest first. */
export function activeToasts(): readonly ToastItem[] {
  return shown;
}

/** createApp re-renders when the queue changes. */
export function onToastsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const TOASTER_ID = "tarve-toaster";

/** The view with the toast queue drawn over its Window, when there is one. */
export function withToasts(view: VNode): VNode {
  if (!shown.length) return view;
  for (let depth = 0; typeof view.type === "function" && view.type !== Window && depth < 32; depth++) {
    const expanded = (view.type as (props: Record<string, unknown>) => unknown)(view.props);
    if (!expanded || typeof expanded !== "object" || Array.isArray(expanded)) return view;
    view = expanded as VNode;
  }
  if (view.type !== Window) return view;
  const raw = view.props.children as Child;
  const children: Child[] = Array.isArray(raw) ? [...raw] : raw === undefined ? [] : [raw];
  children.push(jsx(Toaster, { id: TOASTER_ID, toasts: [...shown], position, onDismiss: dismissToast }));
  return { ...view, props: { ...view.props, children } };
}
