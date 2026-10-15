# @tarve/svelte

Svelte 5 components in native Tarve windows. `.svelte` files compile with Svelte's own
compiler (client output, runes, snippets, bindings, transitions' timing) and run on
Svelte's own runtime against a small retained DOM. Each element of that DOM is a
memoized Tarve subtree keyed by its identity and version, so a Svelte update re-renders
only the elements it touched and their ancestors. Every other compiled subtree is
reused without rendering or diffing, and native receives one `patch`/`mutate` per flush.

```svelte
<!-- App.svelte -->
<script lang="ts">
  let count = $state(0);
</script>

<svelte:head><title>Clicked {count}</title></svelte:head>
<div class="p-6 gap-3">
  <button onclick={() => count++}>Clicked {count}</button>
</div>
```

```ts
// main.ts
import { mount } from "@tarve/svelte";
import App from "./App.svelte";
mount(App, { window: { title: "Counter", width: 480, height: 320 } });
```

`tarve run|dev|build` (Bun, Node.js and txiki) compile `.svelte` imports when @tarve/svelte is installed.
Plain `bun main.ts` needs `preload = ["@tarve/svelte/bun-preload"]` in `bunfig.toml`.

- Other bundlers (esbuild, `Bun.build`): `sveltePlugin()` from `@tarve/svelte/plugin`.

Types: `drag-region`, `window-action` and Tarve's elements (`<row>`, `<column>`, `<view>`, `<scroll>`, `<markdown>`, `<titlebar>`) are declared for svelte-check and the Svelte language server (`src/elements.d.ts`, included through `@tarve/svelte`).

## What maps to what

| Svelte | Tarve |
| --- | --- |
| HTML elements | Tarve's HTML intrinsics (`div`, `p`, `button`, `input`, `select`, `form`, `ul`, `audio`…); unknown tags are `div` |
| `<row>`, `<column>`, `<view>`, `<scroll>`, `<text>`, `<markdown>`, `<code>` | the Tarve components of that name |
| `class="…"` | Tailwind utilities, except names the component's `<style>` selects |
| `<style>` | compound, descendant, child and sibling selectors, `:not/:is/:where/:has`, `:nth-child`, `:first/last-child`, `:checked`, `:hover/:focus/:active`, `::before/::after` (`content` with strings and `attr()`), `@media`, `@keyframes` + `animation`, `var()`, `em/rem/vw/vh`, `transform` |
| events | click, dblclick, auxclick, mousedown/up, pointerdown/up, mouse/pointer enter/leave/move, wheel, contextmenu, scroll, submit, input/change, focus/blur/focusin/focusout, keydown/keyup (every key), drag/dragstart/dragenter/dragover/dragleave/drop/dragend with `dataTransfer` — on elements, `<svelte:window>` and `<svelte:document>` |
| `contenteditable` | rich text: `<b>`, `<em>`, `<u>`, `<s>`, `<span style>`… style the text in a native text area; typing stays in the element it happened in; `window.getSelection()`, `document.execCommand` (`bold`, `italic`, `underline`, `strikeThrough`, `insertText`, `insertLineBreak`, `delete`, `forwardDelete`), `queryCommandState`, Ctrl+B/I/U |
| bindings | `value` (inputs, `<select>` with any values), `checked`, `group`, `textContent/innerHTML` (`contenteditable`), `clientWidth/Height`, `contentRect`, `innerWidth/innerHeight`, `<audio>` `paused/currentTime/duration/volume/muted` |
| layout reads | `getBoundingClientRect` (after ancestor scroll offsets), `offsetTop/Left/Width/Height`, `ResizeObserver`, `IntersectionObserver` (`root`, `rootMargin`, `threshold`; clipped by scroll ancestors and the window), `input.selectionStart/End`. Reads are synchronous like a browser's forced layout: after a change (or in `onMount`) native lays out and answers in ~1 ms |
| `transition:`, `in:`, `out:`, `animate()` | keyframes played at 60 fps, interpolated, with easing, iterations and direction |
| `querySelector(All)`, `matches`, `closest`, `MutationObserver` | over the Svelte DOM |
| `element.focus()`, `<svelte:head><title>` | native focus, the window title (updated live) |
| `<TitleBar>` (`import { TitleBar } from "@tarve/svelte"`) or `mount(App, { window: { titleBar: true } })` | Tarve's custom title bar instead of the native frame, showing the `<svelte:head><title>`; props `title`, `height`, `glass`, `appearance`, `showMinimize/Maximize/Close`, children replace the title. `window-action="minimize\|toggleMaximize\|close"` makes any element a window control, `drag-region` a drag handle |

Not drawn: `<video>` frames (Tarve has no video decoder; the element lays out as a box).

`bun run smoke:svelte-input` drives a built app with real Windows input (cursor, clicks, wheel, keys)
and checks what the components saw; it moves the mouse while it runs.
