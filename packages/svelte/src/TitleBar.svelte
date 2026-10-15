<!--
  Tarve's custom title bar: the window drops its native frame and draws this bar,
  with the minimize/maximize/close controls. Without `title` it shows the
  `<svelte:head><title>`; children replace the title.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title,
    height,
    glass,
    appearance,
    showMinimize,
    showMaximize,
    showClose,
    class: className,
    style,
    children,
  }: {
    title?: string;
    height?: number;
    glass?: boolean | "regular" | "clear";
    appearance?: "light" | "dark";
    showMinimize?: boolean;
    showMaximize?: boolean;
    showClose?: boolean;
    class?: string;
    style?: string;
    children?: Snippet;
  } = $props();
</script>

<titlebar
  {title}
  {height}
  {appearance}
  {style}
  class={className}
  glass={glass === true ? "" : glass || undefined}
  show-minimize={showMinimize}
  show-maximize={showMaximize}
  show-close={showClose}
>{@render children?.()}</titlebar>
