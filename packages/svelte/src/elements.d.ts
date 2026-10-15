/**
 * Tarve's attributes and elements for Svelte's markup types (svelte-check, the
 * Svelte language server). Applies wherever `@tarve/svelte` is part of the program.
 */
import type { HTMLAttributes } from "svelte/elements";

type Flag = boolean | "true" | "false" | "" | undefined | null;

interface TitleBarAttributes extends HTMLAttributes<HTMLElement> {
  title?: string | undefined | null;
  height?: number | string | undefined | null;
  glass?: Flag | "regular" | "clear";
  appearance?: "light" | "dark" | undefined | null;
  "show-minimize"?: Flag;
  "show-maximize"?: Flag;
  "show-close"?: Flag;
}

declare module "svelte/elements" {
  export interface HTMLAttributes<T extends EventTarget> {
    /** Drag the window by this element (a custom title bar, a widget body). */
    "drag-region"?: Flag;
    /** Make this element a window control. */
    "window-action"?: "minimize" | "toggleMaximize" | "close" | undefined | null;
  }

  export interface SvelteHTMLElements {
    /** Tarve layout: a flex row. */
    row: HTMLAttributes<HTMLElement>;
    /** Tarve layout: a flex column. */
    column: HTMLAttributes<HTMLElement>;
    /** Tarve's plain box. */
    view: HTMLAttributes<HTMLElement>;
    /** Tarve's scroll container. */
    scroll: HTMLAttributes<HTMLElement>;
    /** Tarve's rendered Markdown (`source`). */
    markdown: HTMLAttributes<HTMLElement> & { source?: string | undefined | null };
    /** Tarve's custom title bar; prefer the `TitleBar` component. */
    titlebar: TitleBarAttributes;
  }
}

export {};
