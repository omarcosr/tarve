/// <reference path="./elements.d.ts" />
import "./install";
import { createApp, TitleBar as NativeTitleBar, Window, type AppHandle, type AppOptions, type TitleBarProps, type WindowProps } from "@tarve/core";
import type { Component } from "svelte";
import { flushSync, mount as mountSvelte, unmount as unmountSvelte } from "./svelte-client";
import { beginRender, documentInstance, endRender, restyle, setLayoutReader, setScheduler, type TElement } from "./dom";
import { elementForNativeId, nativeIdOf, rootChildren } from "./render";
import { setSelectionReader, textOfEditable, utf16Offset } from "./editable";
import { connectNativeEvents, windowResized } from "./events";

export { installDom, TEvent } from "./dom";
export { default as TitleBar } from "./TitleBar.svelte";
export { registerCss, parseCss, cssStyle } from "./css";
export type { CssRule } from "./css";

export interface MountOptions<Props extends Record<string, any>> extends AppOptions {
  props?: Props;
  context?: Map<any, any>;
  /** The native window: title, size, theme… `<svelte:head><title>` overrides the title. */
  window?: Omit<WindowProps, "children"> & {
    /**
     * Draw Tarve's title bar instead of the native frame, showing the
     * `<svelte:head><title>`: `true`, or its options. For a bar with your own
     * content, use the `TitleBar` component instead.
     */
    titleBar?: boolean | Omit<TitleBarProps, "children" | "title">;
  };
}

export interface SvelteApp<Exports> {
  app: AppHandle;
  component: Exports;
  /** The element the component renders into (Svelte's mount target). */
  target: TElement;
  unmount(): Promise<void>;
}

let mounted = false;

/**
 * Mounts a Svelte 5 component in a native Tarve window. Svelte keeps its own
 * fine-grained updates; each update re-renders only the elements it touched.
 */
export function mount<Props extends Record<string, any>, Exports extends Record<string, any>>(
  component: Component<Props, Exports>,
  options: MountOptions<Props> = {},
): SvelteApp<Exports> {
  if (mounted) throw new Error("@tarve/svelte mounts one app per process.");
  const { props, context, window: windowProps = {}, ...appOptions } = options;
  // Until native reports the content size, the window's requested size stands in (Window's defaults).
  windowResized({ width: windowProps.width ?? 1120, height: windowProps.height ?? 820 });
  const target = documentInstance.createElement("tarve-root");
  documentInstance.body.appendChild(target);
  const { titleBar, ...windowOptions } = windowProps;
  // Options are camelCase like every other one (`minWidth`): `titlebar` would be silently ignored.
  for (const key of Object.keys(windowOptions)) {
    if (key.toLowerCase() === "titlebar") console.warn(`[tarve/svelte] window.${key} is not an option; did you mean window.titleBar?`);
  }
  let app: AppHandle | undefined;
  let disconnect: () => void = () => {};
  /** The native window, created from the mounted DOM: after the first flush, or at the first layout read. */
  const start = (): AppHandle => {
    if (app) return app;
    app = createApp(() => {
      const title = documentInstance.title || windowOptions.title;
      beginRender();
      let content;
      try { content = rootChildren(target); } finally { endRender(); }
      return Window({
        ...windowOptions,
        title,
        onSize: windowResized,
        // A window has one title bar: a <TitleBar> in the component wins over the option's.
        children: titleBar && !target.querySelector("titlebar") ? [NativeTitleBar({ ...(titleBar === true ? {} : titleBar), title }), content] : content,
      });
    }, { keyboardEvents: true, pointerEvents: true, ...appOptions });
    disconnect = connectNativeEvents(app);
    return app;
  };
  setScheduler(() => app?.update());
  // A layout read (getBoundingClientRect, offsetWidth…) is answered by native synchronously;
  // one in onMount opens the window first.
  setLayoutReader(elements => {
    const ids = elements.map(nativeIdOf);
    const boxes = start().layout(ids);
    if (!boxes) return false;
    elements.forEach((element, index) => { const box = boxes[ids[index]!]; if (box) element._sized(box); });
    return true;
  });
  // window.getSelection(), execCommand and input.selectionStart read the native selection.
  setSelectionReader(() => {
    const selection = app?.textSelection();
    const element = selection && elementForNativeId(selection.id);
    if (!selection || !element) return undefined;
    const text = textOfEditable(element);
    return { element, anchor: utf16Offset(text, selection.anchor), focus: utf16Offset(text, selection.focus) };
  });
  documentInstance.onTitle = () => {
    // A title bar without its own title shows the document's: it renders again.
    for (const bar of target.querySelectorAll("titlebar")) if (!bar.hasAttribute("title")) restyle(bar);
    app?.update();
  };
  const instance = mountSvelte(component, { target: target as unknown as Element, props: (props ?? {}) as Props, ...(context ? { context } : {}) });
  mounted = true;
  // Effects (<svelte:head>, onMount) run here: the window opens with their title.
  flushSync();
  const handle = start();
  return {
    app: handle,
    component: instance,
    target,
    async unmount() {
      // The window closes with the app as it was: tearing the component down renders nothing.
      setScheduler(undefined);
      setLayoutReader(undefined);
      setSelectionReader(undefined);
      documentInstance.onTitle = undefined;
      await unmountSvelte(instance);
      disconnect();
      documentInstance.onTitle = undefined;
      target.remove();
      mounted = false;
      handle.close();
    },
  };
}
