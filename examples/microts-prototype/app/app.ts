// Model of examples/counter/counter.tsx. Dialogs, hotkeys and close requests have no MicroTS host API yet.
import { createSignal } from "solid-js";
import type { i32 } from "@pocketjs/framework/solid/std";

export const [count, setCount] = createSignal<i32>(0);
export const [protectClose, setProtectClose] = createSignal<boolean>(true);
export const [status, setStatus] = createSignal<string>("MicroTS compiled model + native view");

export function increase(): void {
  setCount(count() + 1);
}

export function decrease(): void {
  setCount(count() - 1);
}

export function toggleProtect(): void {
  const next = !protectClose();
  setProtectClose(next);
  setStatus(next ? "Window close protection enabled" : "Window may now be closed");
}
